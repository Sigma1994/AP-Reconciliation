# ap-reconciliation-agent

Accounts Payable & payment reconciliation AI system built for a Kenyan B2B finance workflow:
**supplier invoice photos/PDFs and payment receipts** (with abbreviated supplier names like `ACACIA HDW`, Kenyan day-first dates `DD/MM/YYYY`, line items, and **KRA eTIMS CU** numbers) reconciled against **KES / USD** Purchase Orders and **M-Pesa / EFT / USD Wire** settlements using a **SQLite WAL ledger**, a **Policy Vector DB (`ap_policies` + `policy_vectors`)**, **AI Investigation Briefs citing Policy IDs**, and **LangGraph `interrupt()` + `Command(resume=...)` human sign-off**.

**Design Principle:** *AI handles unstructured document extraction, semantic policy retrieval, and root-cause explanation. Deterministic Python and SQLite enforce arithmetic, tax math (2% WHVAT / 5% WHT / 3% WHT), eTIMS CU format, SHA-256 deduplication, and atomic ledger commits.*

```text
Document Upload (PNG/JPG/WEBP/PDF) or Reconciliation Query
  -> Stage 1: Extract Header + Line Items (qwen2.5vl:3b / qwen3:4b / Gemini / pymupdf)
  -> Stage 2: Deterministic Guardrails & 3-Way SQL Match (arithmetic, eTIMS CU, SHA-256, PO/GRN, WHVAT/WHT)
  -> Stage 3: Policy Vector DB RAG (Top-6 retrieval over 33 Kenyan AP policies & supplier SOPs)
  -> Stage 4: AI Investigation Brief (root cause + Policy ID citations + editable audit note)
       |--(clean)-----------------> ledger_finalizer (BEGIN IMMEDIATE) -> END
       |--(exception)-------------> human_approval (LangGraph interrupt) -> ledger_finalizer
       |--(hard block)------------> ledger_finalizer (rejected, no override)
```

---

## Core Architecture Components

| Module | Role |
|---|---|
| `src/policies_seed.py` | 33 Kenyan B2B AP policy clauses & supplier Master SOPs (`POL-TAX-001`–`008`, `POL-MATCH-001`–`008`, `POL-CTRL-001`–`006`, `SOP-VEND-001`–`011`). |
| `src/db.py` | SQLite `WAL` persistence (`busy_timeout=5000`, `foreign_keys=ON`), `ap_policies`, `policy_vectors`, POs, invoices, payments, SHA-256 `intake_documents`, partial unique index `idx_recon_one_reconciled_invoice`, and append-only `audit_log` triggers (`trg_audit_no_update`, `trg_audit_no_delete`). |
| `src/vector_store.py` | SQLite-persisted Vector DB (`PolicyVectorStore`) supporting Ollama (`nomic-embed-text`), Gemini (`gemini-embedding-2`), and deterministic 256-d hashed dense embeddings with incremental `content_hash` sync + lexical/vendor-scope hybrid scoring. |
| `src/intake.py` & `src/intake_graph.py` | Image/PDF intake (`pymupdf` selectable-text fast path vs `qwen2.5vl:3b` / Gemini vision), DD/MM/YYYY date normalization, SHA-256 deduplication, line-item extraction, and `BEGIN IMMEDIATE` invoice creation. |
| `src/kenya_compliance.py` & `src/reconciler.py` | Fuzzy vendor resolution (`rapidfuzz`, `>= 82%` auto / `< 82%` review), KRA eTIMS CU & PIN validation, `2% WHVAT` / `5% Resident WHT` / `3% Contractual WHT` detection, split-payment aggregation, and monotonic atomic commits. |
| `src/investigator.py` & `src/nodes.py` | Retrieves Top-6 AP policies from `PolicyVectorStore` and synthesizes a grounded `InvestigationBrief` whose `cited_policies` are strictly validated against retrieved `Policy ID`s (`recommended_action` is forced to `reject` on deterministic hard blocks). |
| `src/api.py` | FastAPI service exposing `/intake`, `/reconcile`, `/resume/{thread_id}`, `/policies`, `/policies/search`, `/policies/reindex`, `/ledger`, `/audit/{thread_id}`, and `/metrics`. |

---

## Sample Output (AI Investigation & Audit Trail)

### `POST /reconcile` (`INV-9001` — Paused for Human Approval)
```json
{
  "thread_id": "demo-1",
  "status": "pending_approval",
  "evidence": {
    "invoice_amount": 116000.0,
    "paid_amount": 114000.0,
    "variance_amount": 2000.0,
    "variance_pct": 1.72,
    "tax_rule_applied": "whvat_2pct",
    "vendor_match_score": 100,
    "flags": [
      "2% Kenyan WHVAT deduction detected (KES 2000.0 withheld on net 100000.0): confirm iTax WHVAT certificate (POL-TAX-003)."
    ],
    "blocking_flags": []
  },
  "investigation": {
    "root_cause": "Valid 2% Withholding VAT deduction (KES 2000.0)",
    "recommended_action": "approve",
    "confidence_label": "High",
    "cited_policies": [
      { "policy_id": "SOP-VEND-001", "title": "Acacia Hardware Ltd — Abbreviated Header & 2% WHVAT SOP" },
      { "policy_id": "POL-TAX-003", "title": "2% Withholding VAT (WHVAT) Deduction Rule" }
    ],
    "draft_audit_note": "Verified 2% WHVAT deduction on INV-9001 per SOP-VEND-001, POL-TAX-003."
  }
}
```

---

## Evaluation & Benchmarks

```bash
python -m scripts.evaluate --no-ollama   # parser baseline + Policy Vector DB Recall@6 + routing accuracy
python -m scripts.evaluate               # adds local Ollama (qwen3:4b) extraction comparison
python -m scripts.eval_vision            # compares qwen2.5vl:3b vs minicpm-v on samples/*.png
```

---

## Architecture Decision Records (ADRs)

1. **Why SQLite-backed `PolicyVectorStore` + `ap_policies` alongside transactional ledger tables?**
   Keeping AP policies and their dense vectors (`policy_vectors` keyed by `content_hash`) inside the same WAL-mode SQLite file eliminates cross-service drift, supports instant policy edits with incremental re-embedding, and keeps the deployment single-node and zero-dependency.
2. **Why isolate AI reasoning from ledger writes and policy thresholds?**
   Supplier invoices and PDFs are untrusted external inputs (prompt-injection risk per `POL-CTRL-006`). Models output strict JSON schemas and draft explanations citing retrieved `Policy ID`s, while plain Python arithmetic, `blocking_flags`, `idx_recon_one_reconciled_invoice`, and `BEGIN IMMEDIATE` transactions enforce hard financial controls.
3. **Why LangGraph `interrupt()` + `SqliteSaver`?**
   High-value settlements (`>= KES 150,000` / `USD 1,000`), WHVAT/WHT deductions, and low-confidence vendor matches pause cleanly with full Vector DB evidence and resume via `Command(resume=...)` across worker restarts.

---

## Quickstart

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"        # add ".[dev,gemini]" for Gemini Cloud mode
cp .env.example .env
pytest -v
uvicorn src.api:app --reload
```

Or run the zero-dependency core SQLite + Vector DB + Investigator test suite directly:
```bash
python3 -m unittest discover -s tests -p "test_core.py" -v
```
