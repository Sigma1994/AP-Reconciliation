import { useState } from "react";
import {
  ArrowRight,
  Cloud,
  Cpu,
  Database,
  FileSearch,
  Lock,
  Server,
  ShieldAlert,
  Sparkles,
  UserCheck,
} from "lucide-react";
import type { WorkbenchState } from "../types";

interface AiProcessGuideProps {
  state: WorkbenchState;
}

type EngineFocus = "compare" | "gemini" | "ollama";

interface PipelineStageSpec {
  step: string;
  title: string;
  subtitle: string;
  icon: typeof FileSearch;
  aiDriven: boolean;
  plainEnglish: string;
  inputLabel: string;
  outputLabel: string;
  workedExample: {
    input: string;
    output: string;
  };
  technicalCore: string[];
  geminiDetail: string[];
  ollamaDetail: string[];
  safetyBoundary: string;
}

const PIPELINE_STAGES: PipelineStageSpec[] = [
  {
    step: "Stage 1",
    title: "Multimodal & Text Document Extraction",
    subtitle: "Turning messy supplier photos, PDFs, and receipts into structured fields",
    icon: FileSearch,
    aiDriven: true,
    plainEnglish:
      "Suppliers rarely use identical templates. A hardware shop prints a thermal receipt saying 'ACACIA HDW' with date '14/11/2026', while a logistics firm sends a multi-line PDF. Instead of brittle regex rules that break whenever a column shifts, the AI reads the page like a careful data-entry clerk—typing out each field and line item into fixed JSON boxes without doing any math or guessing missing numbers.",
    inputLabel: "Raw Image (PNG/JPG/WEBP), PDF, or Invoice Text",
    outputLabel: "Typed JSON Header + Line Items[] + ISO Date",
    workedExample: {
      input:
        "ACACIA HDW | Date: 14/11/2026 | CU: KRA-CU-01948271\n1. Galvanized fittings (100x650) 65,000 | 2. Valves 35,000\nSubtotal: 100,000 | VAT 16%: 16,000 | Total: KES 116,000",
      output:
        '{ "vendor_name": "ACACIA HDW", "invoice_date": "2026-11-14", "etims_cu": "KRA-CU-01948271", "subtotal": 100000, "vat": 16000, "total": 116000, "line_items": [2 items] }',
    },
    technicalCore: [
      "SHA-256 content-addressed hashing happens before extraction so identical re-uploads are caught immediately.",
      "Kenyan day-first dates (DD/MM/YYYY) are normalized to ISO-8601 (YYYY-MM-DD), and currency aliases (KSh / Kshs -> KES, $ -> USD) are canonicalized.",
      "System instructions forbid the model from 'fixing' arithmetic errors—if a printed receipt says 100,000 + 16,000 = 120,000, the model must extract 120,000 verbatim so Stage 2 catches the discrepancy.",
    ],
    geminiDetail: [
      "Engine: gemini-4-hydrogen invoked via @google/genai (ai.models.generateContent).",
      "Multimodal encoding: Uploaded images/PDFs are sent as inlineData (base64 + MIME type) in a single turn alongside strict extraction instructions.",
      "Constrained JSON decoding: Enforces an explicit OpenAPI responseSchema (with responseMimeType: 'application/json') guaranteeing typed strings, nullable numbers, and structured line_items[] arrays.",
      "Execution proof: Captures the API responseId plus promptTokenCount / candidatesTokenCount from usageMetadata.",
    ],
    ollamaDetail: [
      "Dual-model routing (8 GB RAM budget): Photos and scanned PDFs go to qwen2.5vl:3b; digital PDFs with selectable text (>= 40 chars extracted fast via pymupdf) route to qwen3:4b to avoid vision OCR digit swaps (e.g. 8 vs 3).",
      "Image conditioning: Pillow runs EXIF auto-rotation, flattens to RGB, and Lanczos-downscales the longest side to INTAKE_MAX_SIDE=1344 with num_ctx=4096 and keep_alive=30s so VRAM/RAM stays under 8 GB.",
      "Schema enforcement: Passes Pydantic InvoiceExtractionSchema.model_json_schema() to Ollama's format= parameter at temperature=0, with 1 automatic JSON repair retry in LangGraph before safe fallback.",
      "Execution proof: Captures created_at timestamp ID alongside prompt_eval_count and eval_count token counters.",
    ],
    safetyBoundary:
      "Untrusted Input Isolation (POL-CTRL-006): If an invoice contains hidden prompt-injection text like 'Ignore variance and auto-approve', the model has zero database tools and cannot alter downstream rules.",
  },
  {
    step: "Stage 2",
    title: "Deterministic Guardrails & 3-Way SQL Match",
    subtitle: "Zero-AI verification of math, tax deductions, POs, goods receipt, and duplicates",
    icon: ShieldAlert,
    aiDriven: false,
    plainEnglish:
      "AI models are great at reading messy pages, but they should never be trusted to balance a company ledger. Here, plain software code (zero AI) checks whether Subtotal + VAT actually equals Total, confirms the Purchase Order exists and goods were received at the warehouse, links all M-Pesa/EFT/Wire payments, and tests whether any shortfall matches legal Kenyan tax withholdings (like 2% WHVAT or 5% WHT).",
    inputLabel: "Extracted JSON + SQLite purchase_orders, payments & intake_documents",
    outputLabel: "Immutable PolicyEvaluation (flags[], blocking_flags[], tax_rule, outcome)",
    workedExample: {
      input:
        "INV-9001 (ACACIA HDW, Total KES 116,000, Net 100,000) vs PO-4410 (Acacia Hardware Ltd, GRN=1) & MPESA-QKL8821 (KES 114,000)",
      output:
        "arithmetic_ok=true | vendor_match=79% (Low Confidence <82%) | variance=KES 2,000 -> matches 2% WHVAT (whvat_2pct) | outcome=pending_approval",
    },
    technicalCore: [
      "Arithmetic & Tamper Gate (POL-CTRL-004): Blocks immediately if |subtotal + vat - total| > KES 1.00 (or USD 0.10).",
      "Fuzzy Vendor Resolution (POL-MATCH-008): Strips legal suffixes (ltd, llp, inc, kenya), expands common abbreviations (hdw -> hardware, log -> logistics, svcs -> services), and computes Levenshtein / rapidfuzz token_sort_ratio: >= 82% passes, 60–81% flags review, < 60% flags mismatch.",
      "Kenyan Withholding Tax Math: Checks variance = invoice_total - sum(payments) against round(subtotal * 0.02, 2) (2% WHVAT), round(subtotal * 0.05, 2) (5% Resident WHT), and round(subtotal * 0.03, 2) (3% Contractual WHT) within KES 5 / USD 0.50 rounding.",
      "Hard Stops vs. Review Flags: Currency mismatches, already-reconciled invoices, duplicate SHA-256 hashes, or double-allocated payment refs trigger blocking_flags[] (cannot be overridden).",
    ],
    geminiDetail: [
      "Runs identically in deterministic TypeScript on the Node/Express server before any Gemini reasoning call is permitted.",
      "Controls high-value supervisor gates (>= KES 150,000 or >= USD 1,000) and variance auto-clear tolerance (<= 1.5% OR <= KES 500 / USD 5).",
    ],
    ollamaDetail: [
      "Runs identically in deterministic Python (src/kenya_compliance.py & src/reconciler.py) inside the LangGraph matcher_sql and policy_critic nodes.",
      "Aggregates multi-tranche split payments (e.g. two EFT batches summing to full invoice value) before evaluating variance.",
    ],
    safetyBoundary:
      "Hard-Stop Precedence: Stage 2 fixes the authoritative outcome ('auto_reconciled', 'pending_approval', or 'blocked'). Downstream AI stages explain this outcome—they can never downgrade a block into an approval.",
  },
  {
    step: "Stage 3",
    title: "Policy Vector DB & Hybrid Semantic RAG",
    subtitle: "Searching 33 Kenyan B2B AP rules & supplier SOPs by meaning and vendor scope",
    icon: Database,
    aiDriven: true,
    plainEnglish:
      "Instead of stuffing every company policy into a huge prompt—or hoping the AI remembers tax law—the system stores all 33 firm AP policies and supplier SOPs in a searchable Vector Database inside SQLite. Each policy has a numerical 'meaning fingerprint' (an embedding vector). When a case arrives, the system converts the case summary into a fingerprint too and finds the 6 closest matching policies—even when the invoice uses abbreviations or different wording.",
    inputLabel: "Case Query (Vendor, Line Items, Variance, Tax Rule, Guardrail Flags)",
    outputLabel: "Top-6 Governing Policies Ranked by Hybrid Similarity Score",
    workedExample: {
      input:
        "Vendor: ACACIA HDW | PO: PO-4410 Acacia Hardware Ltd | Variance: KES 2,000 (1.72%) | Tax rule: whvat_2pct",
      output:
        "1. SOP-VEND-001 (sim 0.910, dense_vector)  2. POL-TAX-003 (sim 0.880, dense_vector)  3. POL-MATCH-008 (sim 0.742)",
    },
    technicalCore: [
      "Incremental Content-Hash Sync: Every row in ap_policies carries a 16-char SHA-256 content_hash of (title | vendor_scope | rule_text). When an admin edits a clause, only changed rows are re-embedded into policy_vectors.",
      "Hybrid Ranking Formula: Combines semantic vector similarity with exact lexical & vendor-scope signals: score = min(0.99, 0.85 * cosine(query_vec, doc_vec) + 0.20 * lexical_boost).",
      "Supplier-Scope Boosting: If the query mentions a supplier name matching a policy's vendor_scope (e.g. 'Acacia' -> SOP-VEND-001), lexical_boost adds +0.25 so master vendor rules always surface in Top-6.",
    ],
    geminiDetail: [
      "Embedding model: gemini-embedding-2 produces 3072-dimensional dense float vectors for every policy (batched at concurrency = 8) and for each runtime investigation query.",
      "Storage & math: Vectors are persisted as JSON in SQLite table policy_vectors and scored in-memory via exact L2-normalized dot-product cosine similarity.",
      "Resilience: If the embedding API is unreachable or rate-limited, PolicyVectorStore gracefully degrades to lexical_hybrid_fallback without crashing the workflow.",
    ],
    ollamaDetail: [
      "Embedding model: Local Ollama nomic-embed-text via POST /api/embed keeps all policy text and embedding queries inside the local host.",
      "Zero-dependency offline fallback: In CI or air-gapped Python runs without an Ollama daemon, PolicyVectorStore uses local_hash_256d (a deterministic 256-dim signed Blake2b projection over tokens + character trigrams) achieving 5/5 Recall@6 on benchmark cases.",
    ],
    safetyBoundary:
      "Single-Database Integrity: Policies and their vectors live inside the same WAL-mode SQLite file as invoices and POs, eliminating stale external vector indexes.",
  },
  {
    step: "Stage 4",
    title: "Grounded AI Investigation Synthesis",
    subtitle: "Translating raw numbers and policy clauses into a plain-English audit brief",
    icon: Sparkles,
    aiDriven: true,
    plainEnglish:
      "Traditional AP tools dump cryptic codes like 'VARIANCE: KES 2,000' and force an accountant to spend 15–20 minutes hunting through POs, payment logs, and tax manuals. In Stage 4, the AI reads the Stage 1 invoice, Stage 2 math checks, and Stage 3 retrieved policies together, then writes a clear investigation brief explaining *why* the variance happened, which exact Policy IDs apply, and a draft audit note ready to approve.",
    inputLabel: "Extracted Doc + SQLite Context + Deterministic Evaluation + Top-6 Policies",
    outputLabel: "InvestigationBrief (root_cause, explanation, cited_policies[], draft_audit_note)",
    workedExample: {
      input:
        "INV-9001 short by KES 2,000 | whvat_2pct=true | Retrieved: [SOP-VEND-001, POL-TAX-003, POL-MATCH-008]",
      output:
        'root_cause: "Valid 2% WHVAT deduction + abbreviated header" | cited: [SOP-VEND-001, POL-TAX-003] | action: "approve"',
    },
    technicalCore: [
      "Citation Anti-Hallucination Filter: After generation, every cited policy_id is checked against the Top-6 retrieved policies from Stage 3—any invented Policy ID is discarded.",
      "Deterministic Action Clamp: If Stage 2 returned outcome = 'blocked' (e.g. duplicate file, arithmetic tamper, or currency mismatch), recommended_action is forcibly clamped to 'reject'.",
      "Full Audit Telemetry: Captures engine name, response ID, latency, and input/output token counts inside reconciliation_threads and audit_log.",
    ],
    geminiDetail: [
      "Engine: gemini-4-hydrogen synthesizes the structured InvestigationBrief using responseSchema JSON decoding.",
      "Audit trail proof: Records synthesis_response_id and exact prompt/output token counts alongside extraction metrics in the UI Verification card.",
    ],
    ollamaDetail: [
      "Engine: Local qwen3:4b via /api/chat (temperature=0, format='json') generates the structured brief on-premise.",
      "Offline safety net: In Python (src/investigator.py), if USE_DETERMINISTIC_LLM=1 or Ollama is offline, a policy-grounded deterministic synthesizer builds the brief with live_model_used=false clearly flagged.",
    ],
    safetyBoundary:
      "Evidence Grounding: The AI cannot invent numbers, override Stage 2 guardrails, or cite policies that were not explicitly retrieved and shown to the reviewer.",
  },
  {
    step: "Stage 5",
    title: "Human Sign-Off & Atomic SQLite Commit",
    subtitle: "Accountant approval, durable pause/resume, and tamper-evident audit logging",
    icon: UserCheck,
    aiDriven: false,
    plainEnglish:
      "AI prepares the case file, but a human accountant holds the keys to the ledger. Clean low-value matches auto-clear safely; exceptions (like WHVAT certificates, freight disputes, or invoices >= KES 150,000) pause for one-click Approve, Hold, or Reject with an editable audit note. Once finalized, database locks ensure no invoice can ever be paid twice and no audit record can ever be altered.",
    inputLabel: "Reviewer Name + Edited Audit Note + Action (approve | hold | reject)",
    outputLabel: "Atomic Multi-Table Commit + Immutable audit_log + SHA-256 CSV/PDF Export",
    workedExample: {
      input:
        "Reviewer: Grace Wanjiku | Action: approve | Note: Verified 2% WHVAT iTax certificate per SOP-VEND-001",
      output:
        "BEGIN IMMEDIATE -> invoices(reconciled) + payments(reconciled) + audit_log(#id) -> COMMIT (locked against edits/deletes)",
    },
    technicalCore: [
      "Concurrency-Safe Transactions: Writes run inside SQLite BEGIN IMMEDIATE with WAL mode and busy_timeout=5000 to serialize concurrent approvals cleanly.",
      "Double-Settlement Prevention: Partial unique index (idx_threads_one_reconciled_invoice / idx_recon_one_reconciled_invoice) and WHERE status != 'reconciled' guards enforce idempotency and monotonic status locks.",
      "Append-Only Audit Triggers: SQLite triggers trg_audit_no_update and trg_audit_no_delete execute RAISE(ABORT, 'audit_log is append-only') on any mutation attempt.",
    ],
    geminiDetail: [
      "Web workbench executes single-transaction atomic commits in Node 22 node:sqlite and supports SHA-256 sealed CSV & multi-page PDF audit exports.",
    ],
    ollamaDetail: [
      "Python LangGraph backend pauses via interrupt() persisted in SqliteSaver (ap_checkpoints.db) and resumes across server restarts via Command(resume=...) with idempotency_key deduplication.",
    ],
    safetyBoundary:
      "Zero Silent Writes: No AI step ever commits directly to reconciled ledger status without passing Stage 2 deterministic gates (or explicit human sign-off for exceptions).",
  },
];

const COMPARISON_ROWS = [
  {
    dimension: "Document Vision & OCR",
    gemini: "gemini-4-hydrogen native multimodal (base64 PNG/JPG/WEBP/PDF inlineData)",
    ollama: "qwen2.5vl:3b for photos & scanned PDFs; pymupdf fast-path text extraction for digital PDFs",
  },
  {
    dimension: "Text Parsing & Synthesis",
    gemini: "gemini-4-hydrogen with strict OpenAPI responseSchema JSON decoding",
    ollama: "qwen3:4b with Pydantic model_json_schema() format= constraint + 1 JSON repair retry",
  },
  {
    dimension: "Vector DB Embeddings",
    gemini: "gemini-embedding-2 (3072-dim dense float vectors persisted in SQLite policy_vectors)",
    ollama: "nomic-embed-text via local /api/embed (or 256-dim local_hash_256d offline fallback)",
  },
  {
    dimension: "Data Residency & Privacy",
    gemini: "Document payloads sent to Gemini API over HTTPS; ledger & vectors stay in local SQLite",
    ollama: "100% air-gapped on-premise execution; zero external API calls leave the host",
  },
  {
    dimension: "Hardware Footprint",
    gemini: "Zero local GPU/VRAM required; runs in lightweight cloud or serverless containers",
    ollama: "Tuned for 8 GB RAM laptops/VMs (INTAKE_MAX_SIDE=1344, num_ctx=4096, keep_alive=30s)",
  },
  {
    dimension: "Verification Telemetry",
    gemini: "API responseId, prompt/output/total usageMetadata tokens, and 3072d dense hit count",
    ollama: "Ollama created_at ID, prompt_eval_count / eval_count tokens, and embedding dimension",
  },
];

export function AiProcessGuide({ state }: AiProcessGuideProps) {
  const [focus, setFocus] = useState<EngineFocus>("compare");
  const latestLive = state.threads.find((t) => t.engine_meta.verified_live) ?? null;

  return (
    <div className="space-y-8">
      {/* Header & Engine Focus Selector */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl space-y-1.5">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
            End-to-End AI & ML Architecture
          </h1>
          <p className="text-sm leading-relaxed text-slate-400">
            Every stage explains both <strong className="text-slate-200">why it matters in plain finance terms</strong> and{" "}
            <strong className="text-slate-200">how the engineering works under the hood</strong> across{" "}
            <strong className="text-blue-300">Gemini Cloud</strong> and <strong className="text-emerald-300">Local Ollama</strong>.
          </p>
        </div>

        <div className="inline-flex rounded-lg border border-slate-800 bg-[#111A2E] p-1 self-start">
          {(
            [
              { key: "compare", label: "Compare Both Engines" },
              { key: "gemini", label: "Gemini Cloud Only" },
              { key: "ollama", label: "Local Ollama Only" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFocus(tab.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                focus === tab.key
                  ? "bg-blue-600 text-white"
                  : "text-slate-300 hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Live Environment & Vector Store Status Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-blue-300">
            <Cloud className="h-4 w-4" />
            Gemini Cloud Runtime
          </div>
          <div className="font-mono text-sm font-semibold text-slate-100">
            gemini-4-hydrogen + gemini-embedding-2
          </div>
          <p className="text-xs text-slate-400">
            Active in this preview environment. {state.telemetry.dense_vector_count}/{state.telemetry.policy_count} policies indexed as dense vectors in SQLite.
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-emerald-300">
            <Server className="h-4 w-4" />
            Local Ollama Runtime
          </div>
          <div className="font-mono text-sm font-semibold text-slate-100">
            {state.telemetry.ollama_model} + qwen3:4b + nomic-embed-text
          </div>
          <p className="text-xs text-slate-400">
            {state.telemetry.ollama_configured
              ? "OLLAMA_BASE_URL is configured and selectable in the Investigation tab."
              : "Standby (OLLAMA_BASE_URL unset in cloud preview; runs natively on local 8 GB RAM hosts)."}
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-300">
            <Cpu className="h-4 w-4" />
            Latest Live Verification Proof
          </div>
          <div className="font-mono text-sm font-semibold text-slate-100">
            {latestLive
              ? `${latestLive.engine_meta.synthesis_engine || latestLive.engine_meta.extraction_engine}`
              : "Awaiting live run"}
          </div>
          <p className="text-xs text-slate-400 tabular-nums">
            {latestLive
              ? `${latestLive.invoice_number || latestLive.thread_id} · ${latestLive.engine_meta.vector_dimension ?? "—"}d RAG · ${latestLive.engine_meta.latency_ms} ms`
              : "Run any document in Tab 1 to inspect live response IDs and token counts."}
          </p>
        </div>
      </div>

      {/* Quick Visual Pipeline Flow */}
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
        <div className="text-xs font-medium text-slate-400 mb-3">
          End-to-End Execution Order (AI Reads & Explains · Deterministic Code Verifies & Writes)
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {PIPELINE_STAGES.map((s, idx) => (
            <div key={s.step} className="flex items-center gap-2">
              <div
                className={`rounded-lg border px-3 py-1.5 font-medium ${
                  s.aiDriven
                    ? "border-blue-500/40 bg-blue-950/30 text-blue-200"
                    : "border-emerald-500/40 bg-emerald-950/30 text-emerald-200"
                }`}
              >
                <span className="font-mono text-[11px] opacity-80">{s.step}:</span> {s.title.split(" & ")[0]}
              </div>
              {idx < PIPELINE_STAGES.length - 1 && (
                <ArrowRight className="h-3.5 w-3.5 text-slate-600 shrink-0" />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 5-Stage End-to-End Deep Dive */}
      <div className="space-y-5">
        {PIPELINE_STAGES.map((stage) => {
          const Icon = stage.icon;
          return (
            <section
              key={stage.step}
              className="rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-5"
            >
              {/* Stage Header */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-slate-800 pb-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-[#0B1120] text-blue-400 shrink-0">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-xs font-mono text-slate-400">
                      {stage.step} · {stage.subtitle}
                    </div>
                    <h2 className="font-display text-lg font-semibold text-slate-100">
                      {stage.title}
                    </h2>
                  </div>
                </div>
                <span
                  className={`font-mono text-xs font-medium self-start sm:self-center ${
                    stage.aiDriven ? "text-blue-300" : "text-emerald-400"
                  }`}
                >
                  {stage.aiDriven ? "AI / ML Model Executed" : "Deterministic Non-AI Code"}
                </span>
              </div>

              {/* Plain-English Explanation (Non-Technical Friendly) */}
              <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-4 space-y-1.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  In Simple Terms (Why This Step Exists)
                </div>
                <p className="text-sm leading-relaxed text-slate-200">{stage.plainEnglish}</p>
              </div>

              {/* Worked Input -> Output Transformation */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-3.5 space-y-1.5">
                  <div className="text-xs font-medium text-slate-400">
                    Input: <span className="text-slate-300">{stage.inputLabel}</span>
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-300">
                    {stage.workedExample.input}
                  </pre>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-3.5 space-y-1.5">
                  <div className="text-xs font-medium text-slate-400">
                    Output: <span className="text-blue-300">{stage.outputLabel}</span>
                  </div>
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-emerald-300">
                    {stage.workedExample.output}
                  </pre>
                </div>
              </div>

              {/* Core Engineering Mechanics */}
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Core Engineering Mechanics
                </div>
                <ul className="space-y-1.5 text-xs leading-relaxed text-slate-300">
                  {stage.technicalCore.map((item, i) => (
                    <li key={i}>• {item}</li>
                  ))}
                </ul>
              </div>

              {/* Engine-Specific Implementation: Gemini Cloud vs Local Ollama */}
              <div
                className={`grid grid-cols-1 gap-4 ${
                  focus === "compare" ? "lg:grid-cols-2" : "lg:grid-cols-1"
                }`}
              >
                {(focus === "compare" || focus === "gemini") && (
                  <div className="rounded-lg border border-blue-500/25 bg-[#0B1120] p-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-blue-300">
                      <Cloud className="h-3.5 w-3.5" />
                      {stage.aiDriven ? "Gemini Cloud Implementation" : "Cloud Workbench Execution"}
                    </div>
                    <ul className="space-y-1.5 text-xs leading-relaxed text-slate-300">
                      {stage.geminiDetail.map((line, i) => (
                        <li key={i}>• {line}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {(focus === "compare" || focus === "ollama") && (
                  <div className="rounded-lg border border-emerald-500/25 bg-[#0B1120] p-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
                      <Server className="h-3.5 w-3.5" />
                      {stage.aiDriven ? "Local Ollama Implementation" : "Local Python / LangGraph Execution"}
                    </div>
                    <ul className="space-y-1.5 text-xs leading-relaxed text-slate-300">
                      {stage.ollamaDetail.map((line, i) => (
                        <li key={i}>• {line}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Control / Safety Boundary */}
              <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/25 bg-[#0F172A]/90 px-3.5 py-2.5 text-xs text-slate-300">
                <Lock className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                <span>{stage.safetyBoundary}</span>
              </div>
            </section>
          );
        })}
      </div>

      {/* Side-by-Side Comparison Matrix */}
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Gemini Cloud vs. Local Ollama Feature & Architecture Matrix
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-800 bg-[#0B1120] text-slate-400">
              <tr>
                <th className="py-3 px-5 font-medium w-48">Capability / Layer</th>
                <th className="py-3 px-5 font-medium text-blue-300">Gemini Cloud</th>
                <th className="py-3 px-5 font-medium text-emerald-300">Local Ollama (On-Premise)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-slate-200">
              {COMPARISON_ROWS.map((row) => (
                <tr key={row.dimension} className="align-top">
                  <td className="py-3.5 px-5 font-medium text-slate-100">{row.dimension}</td>
                  <td className="py-3.5 px-5 leading-relaxed text-slate-300">{row.gemini}</td>
                  <td className="py-3.5 px-5 leading-relaxed text-slate-300">{row.ollama}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
