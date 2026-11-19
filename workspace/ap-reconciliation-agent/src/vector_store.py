"""SQLite-persisted Vector DB for Kenyan AP policies and supplier SOPs.

Supports three embedding backends cleanly with content-hash incremental indexing:
1. Local Ollama (`nomic-embed-text` via OLLAMA_BASE_URL/api/embed)
2. Gemini Cloud (`gemini-embedding-2` via GEMINI_API_KEY)
3. Deterministic 256-d hashed token/trigram dense projection + lexical hybrid fallback (always available offline/CI)
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
from typing import Any
import urllib.error
import urllib.request

from src.db import get_conn, get_policies, utc_now_iso

HASH_DIM = 256


def format_policy_for_embedding(p: dict[str, Any]) -> str:
    scope = p.get("vendor_scope") or "Global AP Policy"
    return (
        f"Policy ID: {p['policy_id']}\n"
        f"Category: {p['category']}\n"
        f"Title: {p['title']}\n"
        f"Supplier Scope: {scope}\n"
        f"Rule: {p['rule_text']}"
    )


def _tokenize(text: str | None) -> list[str]:
    return [t for t in re.sub(r"[^a-z0-9%]+", " ", (text or "").lower()).split() if len(t) >= 2]


def _local_hash_vector(text: str, dim: int = HASH_DIM) -> list[float]:
    """Deterministic L2-normalized 256-dim feature-hashed projection over tokens + char trigrams."""
    vec = [0.0] * dim
    tokens = _tokenize(text)
    for tok in tokens:
        h = int.from_bytes(hashlib.blake2b(tok.encode("utf-8"), digest_size=4).digest(), "little")
        idx = h % dim
        sign = 1.0 if ((h >> 8) & 1) == 0 else -1.0
        vec[idx] += sign * 1.5
        if len(tok) >= 4:
            for i in range(len(tok) - 2):
                tri = tok[i : i + 3]
                th = int.from_bytes(hashlib.blake2b(tri.encode("utf-8"), digest_size=4).digest(), "little")
                vec[th % dim] += (1.0 if ((th >> 8) & 1) == 0 else -1.0) * 0.45
    norm = math.sqrt(sum(v * v for v in vec))
    return [round(v / norm, 6) for v in vec] if norm > 0 else vec


def cosine_similarity(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(a[i] * a[i] for i in range(n)))
    nb = math.sqrt(sum(b[i] * b[i] for i in range(n)))
    denom = na * nb
    return dot / denom if denom > 0 else 0.0


def _lexical_score(query: str, policy: dict[str, Any]) -> float:
    q_tokens = set(_tokenize(query))
    if not q_tokens:
        return 0.0
    doc_text = f"{policy['policy_id']} {policy['title']} {policy.get('vendor_scope') or ''} {policy['rule_text']}"
    d_tokens = set(_tokenize(doc_text))
    hits = len(q_tokens & d_tokens)
    bonus = 0.0
    scope = (policy.get("vendor_scope") or "").strip().lower()
    if scope:
        first_word = scope.split()[0]
        if first_word and first_word in query.lower():
            bonus += 0.25
    return min(0.99, hits / max(4.0, math.sqrt(len(q_tokens) * max(1, len(d_tokens)))) + bonus)


def _ollama_embed(texts: list[str], model: str, base_url: str, timeout: float = 10.0) -> list[list[float]] | None:
    url = f"{base_url.rstrip('/')}/api/embed"
    payload = json.dumps({"model": model, "input": texts}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        embs = data.get("embeddings")
        if isinstance(embs, list) and len(embs) == len(texts):
            return [[float(x) for x in v] for v in embs]
    except Exception:
        return None
    return None


def _gemini_embed(texts: list[str], model: str, api_key: str) -> list[list[float]] | None:
    try:
        from google import genai  # type: ignore

        client = genai.Client(api_key=api_key)
        out: list[list[float]] = []
        for t in texts:
            res = client.models.embed_content(model=model, contents=t)
            vals = list(res.embeddings[0].values)
            out.append([float(x) for x in vals])
        return out
    except Exception:
        return None


class PolicyVectorStore:
    """SQLite-backed Vector DB for AP policy retrieval by Policy ID."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = Path(db_path) if db_path else None

    def _preferred_backend(self) -> str:
        if os.getenv("USE_DETERMINISTIC_LLM", "0").strip().lower() in {"1", "true", "yes"}:
            return "local_hash_256d"
        engine = os.getenv("AP_AI_ENGINE", "ollama").strip().lower()
        if engine == "gemini" and os.getenv("GEMINI_API_KEY"):
            return os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-2")
        if os.getenv("OLLAMA_BASE_URL"):
            return os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
        return "local_hash_256d"

    def _embed_batch(self, texts: list[str]) -> tuple[list[list[float]], str]:
        if not texts:
            return [], self._preferred_backend()
        backend = self._preferred_backend()
        if backend == os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-2") and os.getenv("GEMINI_API_KEY"):
            embs = _gemini_embed(texts, backend, os.environ["GEMINI_API_KEY"])
            if embs:
                return embs, backend
        elif backend != "local_hash_256d":
            embs = _ollama_embed(texts, backend, os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"))
            if embs:
                return embs, f"ollama:{backend}"
        return [_local_hash_vector(t) for t in texts], "local_hash_256d"

    def sync_embeddings(self) -> dict[str, Any]:
        target_model = self._preferred_backend()
        with get_conn(self.db_path) as conn:
            rows = conn.execute(
                """
                SELECT p.policy_id, p.category, p.title, p.vendor_scope, p.rule_text, p.content_hash,
                       v.embedding_model AS cur_model, v.content_hash AS vec_hash
                FROM ap_policies p
                LEFT JOIN policy_vectors v ON v.policy_id = p.policy_id
                ORDER BY p.policy_id
                """
            ).fetchall()

        unindexed = [
            dict(r)
            for r in rows
            if r["vec_hash"] != r["content_hash"]
            or (target_model != "local_hash_256d" and r["cur_model"] == "local_hash_256d")
        ]

        if not unindexed:
            return {
                "indexed": 0,
                "total_policies": len(rows),
                "engine": rows[0]["cur_model"] if rows and rows[0]["cur_model"] else target_model,
            }

        texts = [format_policy_for_embedding(r) for r in unindexed]
        vectors, used_engine = self._embed_batch(texts)
        now = utc_now_iso()

        with get_conn(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE;")
            try:
                for row, vec in zip(unindexed, vectors):
                    conn.execute(
                        """
                        INSERT INTO policy_vectors (policy_id, content_hash, embedding_model, dimension, embedding_json, indexed_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(policy_id) DO UPDATE SET
                            content_hash = excluded.content_hash,
                            embedding_model = excluded.embedding_model,
                            dimension = excluded.dimension,
                            embedding_json = excluded.embedding_json,
                            indexed_at = excluded.indexed_at
                        """,
                        (row["policy_id"], row["content_hash"], used_engine, len(vec), json.dumps(vec), now),
                    )
                conn.execute("COMMIT;")
            except Exception:
                conn.execute("ROLLBACK;")
                raise

        return {"indexed": len(unindexed), "total_policies": len(rows), "engine": used_engine}

    def search(self, query: str, top_k: int = 6) -> dict[str, Any]:
        sync_info = self.sync_embeddings()
        policies = get_policies(db_path=self.db_path)

        with get_conn(self.db_path) as conn:
            vec_rows = conn.execute("SELECT policy_id, embedding_model, embedding_json FROM policy_vectors").fetchall()
        vec_map = {r["policy_id"]: (r["embedding_model"], json.loads(r["embedding_json"])) for r in vec_rows}

        q_vecs, q_engine = self._embed_batch([query])
        q_vec = q_vecs[0] if q_vecs else _local_hash_vector(query)

        hits: list[dict[str, Any]] = []
        for p in policies:
            lex = _lexical_score(query, p)
            stored = vec_map.get(p["policy_id"])
            if stored and len(stored[1]) == len(q_vec):
                cos = cosine_similarity(q_vec, stored[1])
                score = min(0.99, max(0.0, cos * 0.75 + lex * 0.35))
                mode = stored[0]
            else:
                # Dimension mismatch (e.g. neural stored vs offline fallback query) -> re-project locally for comparability
                fallback_vec = _local_hash_vector(format_policy_for_embedding(p))
                cos = cosine_similarity(_local_hash_vector(query), fallback_vec)
                score = min(0.99, max(0.0, cos * 0.65 + lex * 0.45))
                mode = "local_hash_256d"

            hits.append(
                {
                    "policy_id": p["policy_id"],
                    "category": p["category"],
                    "title": p["title"],
                    "vendor_scope": p["vendor_scope"],
                    "rule_text": p["rule_text"],
                    "similarity_score": round(score, 3),
                    "retrieval_mode": mode,
                }
            )

        hits.sort(key=lambda h: h["similarity_score"], reverse=True)
        return {
            "hits": hits[:top_k],
            "embedding_engine": sync_info.get("engine") or q_engine,
            "total_searched": len(policies),
        }
