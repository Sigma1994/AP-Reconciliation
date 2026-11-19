import { GoogleGenAI } from "@google/genai";
import type { WorkbenchDB } from "./db.ts";
import type { PolicyDocument, RetrievedPolicyHit } from "./types.ts";

const EMBEDDING_MODEL = "gemini-embedding-2";

function formatPolicyForEmbedding(p: PolicyDocument): string {
  return [
    `Policy ID: ${p.policy_id}`,
    `Category: ${p.category}`,
    `Title: ${p.title}`,
    p.vendor_scope ? `Supplier Scope: ${p.vendor_scope}` : "Supplier Scope: Global AP Policy",
    `Rule: ${p.rule_text}`,
  ].join("\n");
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function lexicalScore(query: string, policy: PolicyDocument): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const docText = `${policy.policy_id} ${policy.title} ${policy.vendor_scope ?? ""} ${policy.rule_text}`;
  const dTokens = new Set(tokenize(docText));
  let hits = 0;
  for (const qt of qTokens) {
    if (dTokens.has(qt)) hits++;
  }
  let bonus = 0;
  if (policy.vendor_scope && query.toLowerCase().includes(policy.vendor_scope.toLowerCase().split(" ")[0])) {
    bonus += 0.25;
  }
  return Math.min(0.99, hits / Math.max(4, Math.sqrt(qTokens.size * dTokens.size)) + bonus);
}

export class PolicyVectorStore {
  private db: WorkbenchDB;
  private getClient: () => GoogleGenAI | null;

  constructor(db: WorkbenchDB, getClient: () => GoogleGenAI | null) {
    this.db = db;
    this.getClient = getClient;
  }

  /** Embed any new or modified policies using Gemini gemini-embedding-2 and persist vectors in SQLite. */
  async syncEmbeddings(): Promise<{ indexed: number; total_dense: number; engine: string }> {
    const unindexed = this.db.getUnindexedPolicies();
    if (unindexed.length === 0) {
      return {
        indexed: 0,
        total_dense: this.db.getDenseVectorCount(),
        engine: EMBEDDING_MODEL,
      };
    }

    const ai = this.getClient();
    if (!ai) {
      return {
        indexed: 0,
        total_dense: this.db.getDenseVectorCount(),
        engine: "lexical_hybrid (no API key)",
      };
    }

    let indexed = 0;
    const concurrency = 8;
    for (let i = 0; i < unindexed.length; i += concurrency) {
      const chunk = unindexed.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map((p) =>
          ai.models.embedContent({
            model: EMBEDDING_MODEL,
            contents: formatPolicyForEmbedding(p),
          })
        )
      );
      for (let j = 0; j < chunk.length; j++) {
        const values = results[j]?.embeddings?.[0]?.values;
        if (values && values.length > 0) {
          this.db.savePolicyVector({
            policy_id: chunk[j].policy_id,
            content_hash: chunk[j].content_hash,
            embedding_model: EMBEDDING_MODEL,
            dimension: values.length,
            embedding: values,
          });
          indexed++;
        }
      }
    }

    return {
      indexed,
      total_dense: this.db.getDenseVectorCount(),
      engine: EMBEDDING_MODEL,
    };
  }

  /** Semantic Top-K retrieval combining Gemini dense cosine similarity with exact lexical boost. */
  async search(
    query: string,
    topK = 6
  ): Promise<{ hits: RetrievedPolicyHit[]; embedding_engine: string; total_searched: number }> {
    const policies = this.db.getPolicies();
    let embeddingEngine = "lexical_hybrid";
    let queryVector: number[] | null = null;

    try {
      await this.syncEmbeddings();
      const ai = this.getClient();
      if (ai) {
        const res = await ai.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: query,
        });
        const values = res.embeddings?.[0]?.values;
        if (values && values.length > 0) {
          queryVector = values;
          embeddingEngine = EMBEDDING_MODEL;
        }
      }
    } catch {
      // If embedding call fails (e.g. offline/rate-limit), fall back gracefully to lexical hybrid
      embeddingEngine = "lexical_hybrid_fallback";
    }

    const storedVectors = this.db.getAllPolicyVectors();
    const scored: RetrievedPolicyHit[] = policies.map((p) => {
      const lex = lexicalScore(query, p);
      const vec = storedVectors.get(p.policy_id);
      if (queryVector && vec && vec.length === queryVector.length) {
        const cos = cosineSimilarity(queryVector, vec);
        const hybrid = Math.min(0.99, Math.max(0, cos * 0.85 + lex * 0.2));
        return {
          policy_id: p.policy_id,
          category: p.category,
          title: p.title,
          vendor_scope: p.vendor_scope,
          rule_text: p.rule_text,
          similarity_score: Number(hybrid.toFixed(3)),
          retrieval_mode: "dense_vector",
        };
      }
      return {
        policy_id: p.policy_id,
        category: p.category,
        title: p.title,
        vendor_scope: p.vendor_scope,
        rule_text: p.rule_text,
        similarity_score: Number(lex.toFixed(3)),
        retrieval_mode: "lexical_hybrid",
      };
    });

    scored.sort((a, b) => b.similarity_score - a.similarity_score);
    return {
      hits: scored.slice(0, topK),
      embedding_engine: embeddingEngine,
      total_searched: policies.length,
    };
  }
}
