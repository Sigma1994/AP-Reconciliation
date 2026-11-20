import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import { WorkbenchDB, sha16 } from "./src/db.ts";
import { buildLedgerSnapshot, renderLedgerCsv, renderLedgerPdf, type LedgerFilter } from "./src/ledgerExport.ts";
import { PolicyVectorStore } from "./src/vectorStore.ts";
import type {
  Currency,
  ExtractedDocument,
  InvestigationBrief,
  PolicyCategory,
  PolicyEvaluation,
  ReconciliationThread,
  RetrievedPolicyHit,
  TaxRuleApplied,
} from "./src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = "gemini-4-hydrogen";
const db = new WorkbenchDB();

function getOptionalGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function requireGeminiClient(): GoogleGenAI {
  const client = getOptionalGeminiClient();
  if (!client) {
    throw new Error("GEMINI_API_KEY is not configured in environment secrets.");
  }
  return client;
}

const vectorStore = new PolicyVectorStore(db, getOptionalGeminiClient);

// --- Deterministic Kenyan Policy & Math Guardrails ---
function normalizeVendor(name: string): string[] {
  const stop = new Set(["ltd", "limited", "inc", "co", "kenya", "ke", "plc", "llp"]);
  const aliases: Record<string, string> = {
    hdw: "hardware",
    svcs: "services",
    svc: "services",
    log: "logistics",
    intl: "international",
  };
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => aliases[t] || t)
    .filter((t) => !stop.has(t));
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function scoreVendorMatch(a: string | null, b: string | null): {
  score: number;
  label: PolicyEvaluation["vendor_match_label"];
} {
  if (!a || !b) return { score: 0, label: "Missing" };
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) {
    return { score: 100, label: "Exact" };
  }
  const ta = normalizeVendor(a);
  const tb = normalizeVendor(b);
  const sa = ta.sort().join(" ");
  const sb = tb.sort().join(" ");
  if (!sa || !sb) return { score: 0, label: "Missing" };
  if (sa === sb) return { score: 96, label: "Fuzzy Match" };
  const dist = levenshtein(sa, sb);
  const maxLen = Math.max(sa.length, sb.length);
  const ratio = Math.max(0, Math.round((1 - dist / maxLen) * 100));
  if (ratio >= 82) return { score: ratio, label: "Fuzzy Match" };
  return { score: ratio, label: "Low Confidence" };
}

function isValidEtims(cu: string | null): boolean {
  if (!cu) return false;
  return /^(KRA-)?CU-?\d{6,14}$/i.test(cu.trim());
}

function evaluateDeterministicGuardrails(params: {
  invoice_number: string | null;
  po_number: string | null;
  vendor_name: string | null;
  currency: Currency;
  subtotal: number;
  vat: number;
  total: number;
  etims_cu: string | null;
  paid_amount: number;
  payment_count: number;
  duplicate_hash: boolean;
  already_reconciled: boolean;
  is_receipt: boolean;
}): PolicyEvaluation {
  const reasons: string[] = [];
  const purchaseOrders = db.getPurchaseOrders();

  let arithmetic_diff = 0;
  let arithmetic_ok = params.total > 0;
  if (!params.is_receipt && (params.subtotal > 0 || params.vat > 0)) {
    arithmetic_diff = Number((params.subtotal + params.vat - params.total).toFixed(2));
    arithmetic_ok = Math.abs(arithmetic_diff) <= 1.0 && params.total > 0;
  }
  if (!arithmetic_ok) {
    reasons.push(
      `Arithmetic guardrail triggered: subtotal (${params.subtotal}) + VAT (${params.vat}) != total (${params.total}), diff = ${arithmetic_diff}.`
    );
  }

  const etims_valid = isValidEtims(params.etims_cu);
  if (!params.is_receipt && params.currency === "KES" && !etims_valid) {
    reasons.push("Missing or malformed KRA eTIMS Control Unit number (POL-TAX-007).");
  }

  if (params.duplicate_hash) {
    reasons.push("Duplicate document SHA-256 hash already present in SQLite intake_documents (POL-CTRL-003).");
  }
  if (params.already_reconciled) {
    reasons.push(`Invoice ${params.invoice_number} is already reconciled; monotonic ledger lock prevents re-posting.`);
  }

  const po = params.po_number
    ? purchaseOrders.find((p) => p.po_number.toUpperCase() === params.po_number?.toUpperCase())
    : undefined;
  const po_found = Boolean(po);
  const goods_received = Boolean(po && po.goods_received === 1);
  if (!po_found) {
    reasons.push("No matching Purchase Order found in ledger (POL-CTRL-005).");
  } else if (!goods_received) {
    reasons.push(`Purchase Order ${po?.po_number} has not recorded goods receipt (POL-MATCH-001).`);
  }

  const vendorScore = po
    ? scoreVendorMatch(params.vendor_name, po.vendor_name)
    : {
        score: params.vendor_name ? 50 : 0,
        label: (params.vendor_name ? "Low Confidence" : "Missing") as PolicyEvaluation["vendor_match_label"],
      };

  if (po && vendorScore.score < 82) {
    reasons.push(
      `Vendor match '${params.vendor_name ?? "unknown"}' vs PO '${po.vendor_name}' scored ${vendorScore.score}% (below 82% threshold, POL-MATCH-008).`
    );
  }

  const variance_amount = Number((params.total - params.paid_amount).toFixed(2));
  const variance_pct = params.total > 0 ? Number(((Math.abs(variance_amount) / params.total) * 100).toFixed(2)) : 0;

  const netSubtotal = params.subtotal > 0 ? params.subtotal : Number((params.total / 1.16).toFixed(2));
  const expectedWhvat = Number((netSubtotal * 0.02).toFixed(2));
  const expectedWht5 = Number((netSubtotal * 0.05).toFixed(2));
  const expectedWht3 = Number((netSubtotal * 0.03).toFixed(2));
  const tolTax = params.currency === "KES" ? 5 : 0.5;

  let tax_rule_applied: TaxRuleApplied = "none";
  let expected_withheld_amount = 0;

  if (params.payment_count > 0 && netSubtotal > 0) {
    if (Math.abs(variance_amount - expectedWhvat) <= tolTax) {
      tax_rule_applied = "whvat_2pct";
      expected_withheld_amount = expectedWhvat;
      reasons.push(
        `2% Kenyan WHVAT deduction detected (${params.currency} ${expectedWhvat.toLocaleString()} on net ${netSubtotal.toLocaleString()}): confirm WHT certificate (POL-TAX-003).`
      );
    } else if (Math.abs(variance_amount - expectedWht5) <= tolTax) {
      tax_rule_applied = "wht_5pct";
      expected_withheld_amount = expectedWht5;
      reasons.push(
        `5% Resident WHT deduction detected (${params.currency} ${expectedWht5.toLocaleString()} on net ${netSubtotal.toLocaleString()}): confirm WHT certificate (POL-TAX-004).`
      );
    } else if (Math.abs(variance_amount - expectedWht3) <= tolTax) {
      tax_rule_applied = "wht_3pct";
      expected_withheld_amount = expectedWht3;
      reasons.push(
        `3% Contractual WHT deduction detected (${params.currency} ${expectedWht3.toLocaleString()} on net ${netSubtotal.toLocaleString()}): confirm WHT certificate (POL-TAX-005).`
      );
    }
  }

  const absTol = params.currency === "KES" ? 500 : 5;
  const withinTolerance =
    params.payment_count > 0 && (Math.abs(variance_amount) <= absTol || variance_pct <= 1.5);

  if (params.payment_count === 0) {
    reasons.push("No settled payment found in SQLite payments table.");
  } else if (!withinTolerance && tax_rule_applied === "none") {
    reasons.push(
      `Payment variance of ${params.currency} ${Math.abs(variance_amount).toLocaleString()} (${variance_pct}%) exceeds policy tolerance (1.5% or ${params.currency} ${absTol}).`
    );
  }

  const highValueThreshold = params.currency === "KES" ? 150000 : 1000;
  const high_value_flag = params.total >= highValueThreshold;
  if (high_value_flag) {
    reasons.push(
      `High-value amount (${params.currency} ${params.total.toLocaleString()} >= ${params.currency} ${highValueThreshold.toLocaleString()}) requires supervisor sign-off (POL-CTRL-001).`
    );
  }

  let outcome: PolicyEvaluation["outcome"] = "auto_reconciled";
  if (!arithmetic_ok || params.duplicate_hash || params.already_reconciled) {
    outcome = "blocked";
  } else if (
    (!params.is_receipt && params.currency === "KES" && !etims_valid) ||
    !po_found ||
    !goods_received ||
    params.payment_count === 0 ||
    vendorScore.score < 82 ||
    high_value_flag ||
    tax_rule_applied !== "none" ||
    !withinTolerance
  ) {
    outcome = "pending_approval";
  } else {
    reasons.push("All deterministic guardrails passed: arithmetic, eTIMS CU, 3-way PO match, vendor match, and tolerance.");
  }

  return {
    arithmetic_ok,
    arithmetic_diff,
    etims_valid: params.is_receipt || params.currency === "USD" ? true : etims_valid,
    duplicate_hash: params.duplicate_hash,
    already_reconciled: params.already_reconciled,
    vendor_match_score: vendorScore.score,
    vendor_match_label: vendorScore.label,
    po_found,
    goods_received,
    payment_count: params.payment_count,
    invoice_amount: params.total,
    paid_amount: params.paid_amount,
    variance_amount,
    variance_pct,
    tax_rule_applied,
    expected_withheld_amount,
    high_value_flag,
    outcome,
    reasons,
  };
}

async function extractWithOllama(params: {
  base64Data?: string;
  mimeType?: string;
  documentText?: string;
}): Promise<{
  extracted: ExtractedDocument;
  engine: string;
  responseId: string | null;
  tokens: { prompt: number; output: number; total: number } | null;
}> {
  const baseUrl = process.env.OLLAMA_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "Local Ollama is not configured (OLLAMA_BASE_URL is unset in this cloud environment). Switch to Gemini Cloud or configure OLLAMA_BASE_URL locally."
    );
  }

  const isImage = Boolean(params.base64Data && params.mimeType?.startsWith("image/"));
  const model = isImage
    ? process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:3b"
    : process.env.OLLAMA_MODEL || "qwen3:4b";

  const prompt =
    "Extract supplier invoice or payment receipt fields into JSON with keys: document_type ('invoice'|'receipt'), " +
    "invoice_number, po_number, payment_ref, vendor_name, kra_pin, currency ('KES'|'USD'), invoice_date (YYYY-MM-DD), " +
    "etims_cu, subtotal, vat, total, line_items ([{description, quantity, unit_price, tax_rate, line_total}]), extraction_notes.";

  const msg: Record<string, unknown> = {
    role: "user",
    content: params.documentText ? `${prompt}\n\nDocument:\n${params.documentText}` : prompt,
  };
  if (isImage && params.base64Data) {
    msg.images = [params.base64Data];
  }

  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [msg],
      stream: false,
      format: "json",
      options: { temperature: 0 },
    }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama returned HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    message?: { content?: string };
    created_at?: string;
    prompt_eval_count?: number;
    eval_count?: number;
  };
  const parsed = JSON.parse(data.message?.content || "{}") as ExtractedDocument;
  const pTok = Number(data.prompt_eval_count ?? 0);
  const oTok = Number(data.eval_count ?? 0);
  return {
    extracted: { ...parsed, line_items: parsed.line_items || [] },
    engine: `ollama:${model}`,
    responseId: data.created_at ? `ollama-${data.created_at}` : null,
    tokens: pTok || oTok ? { prompt: pTok, output: oTok, total: pTok + oTok } : null,
  };
}

async function extractWithGemini(params: {
  base64Data?: string;
  mimeType?: string;
  documentText?: string;
}): Promise<{
  extracted: ExtractedDocument;
  engine: string;
  responseId: string | null;
  tokens: { prompt: number; output: number; total: number } | null;
}> {
  const ai = requireGeminiClient();
  const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];
  if (params.base64Data && params.mimeType) {
    parts.push({ inlineData: { mimeType: params.mimeType, data: params.base64Data } });
  }
  parts.push({
    text:
      "Read this supplier invoice or payment receipt. Classify document_type as 'invoice' or 'receipt'. " +
      "Extract all header fields and every line item exactly as printed without fixing arithmetic errors.\n" +
      (params.documentText ? `Document text:\n${params.documentText}` : "Extract from the attached document."),
  });

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: { parts },
    config: {
      systemInstruction:
        "You are a precision Accounts Payable document extractor for Kenyan and USD B2B invoices and payment receipts. " +
        "Copy numbers verbatim—never recalculate or fix a mismatched total. Normalize Kenyan DD/MM/YYYY dates to YYYY-MM-DD. " +
        "Set null for absent fields and include brief extraction_notes on abbreviations or anomalies.",
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          document_type: { type: Type.STRING },
          invoice_number: { type: Type.STRING, nullable: true },
          po_number: { type: Type.STRING, nullable: true },
          payment_ref: { type: Type.STRING, nullable: true },
          vendor_name: { type: Type.STRING, nullable: true },
          kra_pin: { type: Type.STRING, nullable: true },
          currency: { type: Type.STRING, nullable: true },
          invoice_date: { type: Type.STRING, nullable: true },
          etims_cu: { type: Type.STRING, nullable: true },
          subtotal: { type: Type.NUMBER, nullable: true },
          vat: { type: Type.NUMBER, nullable: true },
          total: { type: Type.NUMBER, nullable: true },
          line_items: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                description: { type: Type.STRING },
                quantity: { type: Type.NUMBER, nullable: true },
                unit_price: { type: Type.NUMBER, nullable: true },
                tax_rate: { type: Type.STRING, nullable: true },
                line_total: { type: Type.NUMBER, nullable: true },
              },
              required: ["description"],
            },
          },
          extraction_notes: { type: Type.STRING, nullable: true },
        },
        required: ["document_type", "line_items"],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? "{}").trim()) as ExtractedDocument;
  const usage = response.usageMetadata;
  return {
    extracted: {
      ...parsed,
      document_type: parsed.document_type === "receipt" ? "receipt" : "invoice",
      line_items: parsed.line_items || [],
    },
    engine: MODEL_NAME,
    responseId: response.responseId ?? null,
    tokens: usage
      ? {
          prompt: Number(usage.promptTokenCount ?? 0),
          output: Number(usage.candidatesTokenCount ?? 0),
          total: Number(usage.totalTokenCount ?? 0),
        }
      : null,
  };
}

async function synthesizeInvestigation(params: {
  extracted: ExtractedDocument;
  po: Record<string, unknown> | null;
  payments: Record<string, unknown>[];
  evaluation: PolicyEvaluation;
  retrievedPolicies: RetrievedPolicyHit[];
  engineChoice?: "gemini" | "ollama";
}): Promise<{
  brief: InvestigationBrief;
  engine: string;
  responseId: string | null;
  tokens: { prompt: number; output: number; total: number } | null;
}> {
  const promptPayload = {
    extracted_document: params.extracted,
    matched_purchase_order: params.po,
    matched_payments: params.payments,
    deterministic_guardrails: params.evaluation,
    retrieved_company_policies: params.retrievedPolicies.map((p) => ({
      policy_id: p.policy_id,
      title: p.title,
      vendor_scope: p.vendor_scope,
      similarity_score: p.similarity_score,
      rule_text: p.rule_text,
    })),
  };

  const systemInstruction =
    "You are a Senior Accounts Payable Investigation Agent for a Kenyan enterprise. " +
    "Given the extracted invoice/receipt, SQLite PO & payment records, deterministic guardrail results, and the retrieved company policies, " +
    "diagnose the root cause in plain accountant language, cite ONLY policy_id values present in retrieved_company_policies, " +
    "recommend 'approve', 'hold', or 'reject' (note: if deterministic outcome is 'blocked', you MUST recommend 'reject'), " +
    "and draft a concise audit note ready for the reviewer.";

  let brief: InvestigationBrief;
  let usedEngine = MODEL_NAME;
  let responseId: string | null = null;
  let tokens: { prompt: number; output: number; total: number } | null = null;

  if (params.engineChoice === "ollama" && process.env.OLLAMA_BASE_URL) {
    const model = process.env.OLLAMA_MODEL || "qwen3:4b";
    const resp = await fetch(`${process.env.OLLAMA_BASE_URL.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: JSON.stringify(promptPayload, null, 2) },
        ],
        stream: false,
        format: "json",
        options: { temperature: 0 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama synthesis returned HTTP ${resp.status}`);
    const data = (await resp.json()) as {
      message?: { content?: string };
      created_at?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    brief = JSON.parse(data.message?.content || "{}") as InvestigationBrief;
    usedEngine = `ollama:${model}`;
    responseId = data.created_at ? `ollama-${data.created_at}` : null;
    const pTok = Number(data.prompt_eval_count ?? 0);
    const oTok = Number(data.eval_count ?? 0);
    tokens = pTok || oTok ? { prompt: pTok, output: oTok, total: pTok + oTok } : null;
  } else {
    const ai = requireGeminiClient();
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: JSON.stringify(promptPayload, null, 2),
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            root_cause: { type: Type.STRING },
            explanation: { type: Type.STRING },
            recommended_action: { type: Type.STRING },
            confidence_label: { type: Type.STRING },
            cited_policies: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  policy_id: { type: Type.STRING },
                  title: { type: Type.STRING },
                  relevance_reason: { type: Type.STRING },
                },
                required: ["policy_id", "title", "relevance_reason"],
              },
            },
            draft_audit_note: { type: Type.STRING },
          },
          required: [
            "root_cause",
            "explanation",
            "recommended_action",
            "confidence_label",
            "cited_policies",
            "draft_audit_note",
          ],
        },
      },
    });
    brief = JSON.parse((response.text ?? "{}").trim()) as InvestigationBrief;
    responseId = response.responseId ?? null;
    const usage = response.usageMetadata;
    tokens = usage
      ? {
          prompt: Number(usage.promptTokenCount ?? 0),
          output: Number(usage.candidatesTokenCount ?? 0),
          total: Number(usage.totalTokenCount ?? 0),
        }
      : null;
  }

  const validAction =
    params.evaluation.outcome === "blocked"
      ? "reject"
      : brief.recommended_action === "approve" || brief.recommended_action === "hold" || brief.recommended_action === "reject"
      ? brief.recommended_action
      : "hold";
  const validConf =
    brief.confidence_label === "High" || brief.confidence_label === "Medium" || brief.confidence_label === "Low"
      ? brief.confidence_label
      : "Medium";

  return {
    brief: {
      ...brief,
      recommended_action: validAction,
      confidence_label: validConf,
      cited_policies: brief.cited_policies || [],
    },
    engine: usedEngine,
    responseId,
    tokens,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "20mb" }));

  // Warm vector index asynchronously on boot without blocking server startup
  vectorStore.syncEmbeddings().catch((err) => {
    console.warn("Initial policy vector sync skipped:", err instanceof Error ? err.message : err);
  });

  app.get("/api/workbench", (_req, res) => {
    res.json(db.getState());
  });

  app.get("/api/ledger/export", (req, res) => {
    const rawFormat = String(req.query.format || "csv").toLowerCase();
    const rawFilter = String(req.query.filter || "all").toLowerCase();
    const filter: LedgerFilter =
      rawFilter === "reconciled" || rawFilter === "open" ? rawFilter : "all";

    if (rawFormat !== "csv" && rawFormat !== "pdf") {
      res.status(400).json({ error: "Export format must be 'csv' or 'pdf'." });
      return;
    }

    const snapshot = buildLedgerSnapshot(db.getState(), filter);
    const stamp = snapshot.exportedAt.slice(0, 10);
    res.setHeader("X-Ledger-Sha256", snapshot.digestSha256);

    if (rawFormat === "csv") {
      const csv = renderLedgerCsv(snapshot);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="ap-immutable-ledger-${filter}-${stamp}.csv"`
      );
      res.send(csv);
      return;
    }

    const pdfBuf = renderLedgerPdf(snapshot);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ap-audit-report-${filter}-${stamp}.pdf"`
    );
    res.send(pdfBuf);
  });

  app.post("/api/workbench/reset", async (_req, res) => {
    db.reset();
    try {
      await vectorStore.syncEmbeddings();
    } catch {
      // Non-fatal; lexical fallback still operates
    }
    res.json(db.getState());
  });

  // Policy Vector Store Endpoints
  app.post("/api/policies/search", async (req, res) => {
    try {
      const { query, topK } = req.body as { query?: string; topK?: number };
      if (!query?.trim()) {
        res.status(400).json({ error: "Provide a search query." });
        return;
      }
      const result = await vectorStore.search(query.trim(), Math.min(20, Math.max(1, Number(topK || 6))));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Vector search failed" });
    }
  });

  app.post("/api/policies", async (req, res) => {
    try {
      const { policy_id, category, title, vendor_scope, rule_text, effective_date } = req.body as {
        policy_id?: string;
        category?: PolicyCategory;
        title?: string;
        vendor_scope?: string | null;
        rule_text?: string;
        effective_date?: string;
      };
      if (!policy_id?.trim() || !title?.trim() || !rule_text?.trim() || !category) {
        res.status(400).json({ error: "policy_id, category, title, and rule_text are required." });
        return;
      }
      const saved = db.upsertPolicy({
        policy_id,
        category,
        title,
        vendor_scope: vendor_scope ?? null,
        rule_text,
        effective_date: effective_date || new Date().toISOString().slice(0, 10),
      });
      const syncInfo = await vectorStore.syncEmbeddings();
      res.json({ policy: saved, sync: syncInfo, state: db.getState() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Could not save policy" });
    }
  });

  app.post("/api/policies/reindex", async (_req, res) => {
    try {
      const sync = await vectorStore.syncEmbeddings();
      res.json({ sync, state: db.getState() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Reindex failed" });
    }
  });

  // Full 4-Stage AI Investigation Pipeline
  app.post("/api/investigate", async (req, res) => {
    const t0 = performance.now();
    try {
      const { base64Data, mimeType, documentText, fileName, engine } = req.body as {
        base64Data?: string;
        mimeType?: string;
        documentText?: string;
        fileName?: string;
        engine?: "gemini" | "ollama";
      };

      if (!base64Data && !documentText?.trim()) {
        res.status(400).json({ error: "Upload a receipt/invoice file or select a supplier document." });
        return;
      }

      // Stage 1: Multimodal / Structured Document Extraction
      const extractRes =
        engine === "ollama"
          ? await extractWithOllama({ base64Data, mimeType, documentText })
          : await extractWithGemini({ base64Data, mimeType, documentText });
      const { extracted, engine: extractionEngine } = extractRes;

      const isReceipt = extracted.document_type === "receipt";
      const currency: Currency = extracted.currency?.toUpperCase() === "USD" ? "USD" : "KES";
      const docHash = sha16(base64Data ? base64Data : documentText || fileName || String(Date.now()));
      const duplicate_hash = db.hasDocumentHash(docHash);

      const allInvoices = db.getInvoices();
      const allPayments = db.getPayments();
      const allPOs = db.getPurchaseOrders();

      let matchedInvoice = extracted.invoice_number
        ? db.getInvoiceByNumber(extracted.invoice_number)
        : undefined;
      if (isReceipt && !matchedInvoice && extracted.vendor_name) {
        matchedInvoice = allInvoices.find(
          (i) => i.status !== "reconciled" && scoreVendorMatch(extracted.vendor_name, i.vendor_name).score >= 75
        );
      }

      const effectiveInvoiceNo = matchedInvoice?.invoice_number || extracted.invoice_number;
      const effectivePoNo = matchedInvoice?.po_number || extracted.po_number;
      const effectiveVendor = extracted.vendor_name || matchedInvoice?.vendor_name || null;

      const matchedPO = effectivePoNo
        ? allPOs.find((p) => p.po_number.toUpperCase() === effectivePoNo.toUpperCase()) ?? null
        : null;

      const subtotal = Number(extracted.subtotal ?? matchedInvoice?.subtotal ?? 0);
      const vat = Number(extracted.vat ?? matchedInvoice?.vat ?? 0);
      const docTotal = Number(extracted.total ?? 0);
      const invoiceTotal = matchedInvoice ? matchedInvoice.total : docTotal;

      let matchedPayments = effectiveInvoiceNo
        ? allPayments.filter((p) => p.invoice_number?.toUpperCase() === effectiveInvoiceNo.toUpperCase())
        : [];

      const generatedRef =
        extracted.payment_ref || (isReceipt ? `RCPT-${docHash.slice(0, 8).toUpperCase()}` : null);

      if (isReceipt && generatedRef && docTotal > 0 && !duplicate_hash) {
        db.upsertReceiptPayment({
          payment_ref: generatedRef,
          vendor_name: effectiveVendor || "Unknown Vendor",
          invoice_number: effectiveInvoiceNo || null,
          currency,
          amount: docTotal,
          channel: generatedRef.startsWith("MPESA") ? "M-Pesa" : generatedRef.startsWith("WIRE") ? "Wire" : "EFT",
          paid_at: extracted.invoice_date || new Date().toISOString().slice(0, 10),
          status: "unmatched",
        });
        matchedPayments = [
          {
            payment_ref: generatedRef,
            vendor_name: effectiveVendor || "Unknown Vendor",
            invoice_number: effectiveInvoiceNo || null,
            currency,
            amount: docTotal,
            channel: "M-Pesa",
            paid_at: extracted.invoice_date || "",
            status: "unmatched",
          },
        ];
      }

      const paid_amount = isReceipt
        ? matchedPayments.reduce((s, p) => s + p.amount, 0) || docTotal
        : matchedPayments.reduce((s, p) => s + p.amount, 0);

      const already_reconciled = Boolean(matchedInvoice && matchedInvoice.status === "reconciled");

      // Stage 2: Deterministic Financial Guardrails
      const evaluation = evaluateDeterministicGuardrails({
        invoice_number: effectiveInvoiceNo,
        po_number: effectivePoNo,
        vendor_name: effectiveVendor,
        currency,
        subtotal,
        vat,
        total: invoiceTotal > 0 ? invoiceTotal : docTotal,
        etims_cu: extracted.etims_cu || matchedInvoice?.etims_cu || null,
        paid_amount,
        payment_count: matchedPayments.length,
        duplicate_hash,
        already_reconciled,
        is_receipt: isReceipt,
      });

      // Stage 3: Vector DB Policy RAG Retrieval (gemini-embedding-2 + SQLite)
      const ragQuery = [
        `Document type: ${extracted.document_type}`,
        effectiveVendor ? `Vendor: ${effectiveVendor}` : "",
        matchedPO ? `PO Vendor: ${matchedPO.vendor_name} ${matchedPO.po_number}` : "No PO",
        `Currency: ${currency}, Invoice total: ${invoiceTotal || docTotal}, Paid: ${paid_amount}, Variance: ${evaluation.variance_amount} (${evaluation.variance_pct}%)`,
        `Tax rule: ${evaluation.tax_rule_applied}`,
        evaluation.etims_valid ? "eTIMS valid" : "Missing or invalid eTIMS CU",
        evaluation.arithmetic_ok ? "Arithmetic valid" : "Arithmetic mismatch error",
        extracted.line_items.map((l) => l.description).join("; "),
        evaluation.reasons.join(" "),
      ]
        .filter(Boolean)
        .join("\n");

      const ragResult = await vectorStore.search(ragQuery, 6);

      // Stage 4: AI Investigation Agent Synthesis grounded in SQL + Vector DB Policies
      const synthRes = await synthesizeInvestigation({
        extracted,
        po: matchedPO as unknown as Record<string, unknown> | null,
        payments: matchedPayments as unknown as Record<string, unknown>[],
        evaluation,
        retrievedPolicies: ragResult.hits,
        engineChoice: engine,
      });
      const investigation = synthRes.brief;

      const latency_ms = Math.round(performance.now() - t0);
      const thread_id = `thr-${isReceipt ? "rcpt" : "inv"}-${Date.now().toString(36)}`;
      const threadStatus =
        evaluation.outcome === "auto_reconciled"
          ? "reconciled"
          : evaluation.outcome === "blocked"
          ? "blocked"
          : "pending_approval";

      if (!isReceipt && effectiveInvoiceNo && !duplicate_hash && !matchedInvoice) {
        db.upsertExtractedInvoice({
          invoice_number: effectiveInvoiceNo.toUpperCase(),
          po_number: effectivePoNo,
          vendor_name: effectiveVendor || "Unknown Vendor",
          currency,
          subtotal,
          vat,
          total: docTotal,
          etims_cu: extracted.etims_cu,
          invoice_date: extracted.invoice_date || new Date().toISOString().slice(0, 10),
          status: threadStatus === "reconciled" ? "reconciled" : threadStatus === "blocked" ? "rejected" : "held",
          sha256: docHash,
        });
      }

      if (!duplicate_hash) {
        db.recordDocumentHash(
          docHash,
          fileName || `${extracted.document_type}_${effectiveInvoiceNo || "upload"}`,
          extracted.document_type,
          thread_id
        );
      }

      const verifiedLive = Boolean(
        (extractRes.responseId || extractRes.tokens) && (synthRes.responseId || synthRes.tokens)
      );

      const thread: ReconciliationThread = {
        thread_id,
        created_at: new Date().toISOString(),
        source_type: isReceipt ? "receipt_document" : "invoice_document",
        raw_summary: fileName || `${extracted.document_type} ${effectiveInvoiceNo || ""}`.trim(),
        invoice_number: effectiveInvoiceNo,
        vendor_name: effectiveVendor,
        po_number: effectivePoNo,
        payment_refs: matchedPayments.map((p) => p.payment_ref),
        currency,
        invoice_amount: invoiceTotal > 0 ? invoiceTotal : docTotal,
        paid_amount,
        variance_amount: evaluation.variance_amount,
        variance_pct: evaluation.variance_pct,
        status: threadStatus,
        reviewer: threadStatus === "reconciled" ? "Policy Engine (Auto)" : null,
        review_note: threadStatus === "reconciled" ? investigation.draft_audit_note : null,
        extracted,
        retrieved_policies: ragResult.hits,
        evaluation,
        investigation,
        engine_meta: {
          provider: engine === "ollama" ? "Local Ollama" : "Gemini Cloud",
          verified_live: verifiedLive,
          extraction_engine: extractionEngine,
          extraction_role: `Parsed ${extracted.document_type} header & ${extracted.line_items.length} line item(s) via strict JSON schema`,
          extraction_response_id: extractRes.responseId,
          extraction_tokens: extractRes.tokens,
          embedding_engine: ragResult.embedding_engine,
          embedding_role: `Embedded query & ranked ${ragResult.total_searched} policies (${ragResult.dense_hits_count} dense cosine hits)`,
          vector_dimension: ragResult.vector_dimension,
          dense_hits_count: ragResult.dense_hits_count,
          synthesis_engine: synthRes.engine,
          synthesis_role: `Diagnosed root cause & cited ${investigation.cited_policies.length} Policy ID(s) from Vector DB`,
          synthesis_response_id: synthRes.responseId,
          synthesis_tokens: synthRes.tokens,
          latency_ms,
          vector_count_searched: ragResult.total_searched,
        },
      };

      db.insertThreadAndTelemetry(
        thread,
        latency_ms,
        "ai_investigator",
        `${effectiveInvoiceNo || fileName || "Document"} investigated (${latency_ms}ms) via ${synthRes.engine} -> cited ${investigation.cited_policies.map((c) => c.policy_id).join(", ") || "none"} -> ${threadStatus}.`,
        {
          engine_meta: thread.engine_meta,
          extracted,
          retrieved_policy_ids: ragResult.hits.map((h) => ({ id: h.policy_id, score: h.similarity_score })),
          evaluation,
          investigation,
        }
      );

      res.json({ thread, state: db.getState() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Investigation pipeline failed";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/threads/:threadId/decision", (req, res) => {
    const { threadId } = req.params;
    const { action, reviewer, note } = req.body as {
      action?: "approve" | "hold" | "reject";
      reviewer?: string;
      note?: string;
    };

    if (!action || !["approve", "hold", "reject"].includes(action)) {
      res.status(400).json({ error: "Action must be approve, hold, or reject." });
      return;
    }
    if (!reviewer?.trim()) {
      res.status(400).json({ error: "Reviewer name is required." });
      return;
    }

    const result = db.applyDecision(
      threadId,
      action,
      reviewer.trim(),
      note?.trim() || `${action} by ${reviewer.trim()}`
    );

    if (!result.ok) {
      res.status(result.code).json({ error: result.error });
      return;
    }

    res.json({ thread: result.thread, state: db.getState() });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AP Reconciliation Workbench running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
