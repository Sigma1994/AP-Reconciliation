import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import type {
  AuditEntry,
  Currency,
  ExtractedInvoiceFields,
  InvoiceRecord,
  ParsedRemittanceFields,
  PaymentRecord,
  PolicyEvaluation,
  PurchaseOrder,
  ReconciliationThread,
  TaxRuleApplied,
  WorkbenchState,
} from "./src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = "gemini-4-hydrogen";

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in environment secrets.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// --- Deterministic Kenyan & USD AP Seed Data ---
function buildInitialState(): {
  purchase_orders: PurchaseOrder[];
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  threads: ReconciliationThread[];
  audit_log: AuditEntry[];
  nextAuditId: number;
  telemetryRuns: { latency_ms: number; human_override: boolean }[];
} {
  const purchase_orders: PurchaseOrder[] = [
    {
      po_number: "PO-4410",
      vendor_name: "Acacia Hardware Ltd",
      kra_pin: "P051234987K",
      currency: "KES",
      authorized_amount: 116000,
      status: "open",
    },
    {
      po_number: "PO-4412",
      vendor_name: "Mombasa Logistics Ltd",
      kra_pin: "P051883210M",
      currency: "KES",
      authorized_amount: 232000,
      status: "open",
    },
    {
      po_number: "PO-4415",
      vendor_name: "Rift Valley Cloud Services",
      kra_pin: "P051449012R",
      currency: "USD",
      authorized_amount: 1450,
      status: "open",
    },
    {
      po_number: "PO-4418",
      vendor_name: "Savannah Steel Works Ltd",
      kra_pin: "P051774509S",
      currency: "KES",
      authorized_amount: 58000,
      status: "open",
    },
  ];

  const invoices: InvoiceRecord[] = [
    {
      invoice_number: "INV-9001",
      po_number: "PO-4410",
      vendor_name: "ACACIA HDW",
      currency: "KES",
      subtotal: 100000,
      vat: 16000,
      total: 116000,
      etims_cu: "KRA-CU-01948271",
      invoice_date: "14/11/2026",
      status: "held",
      sha256: sha("INV-9001|PO-4410|116000"),
    },
    {
      invoice_number: "INV-9002",
      po_number: "PO-4415",
      vendor_name: "Rift Valley Cloud Services",
      currency: "USD",
      subtotal: 1450,
      vat: 0,
      total: 1450,
      etims_cu: "KRA-CU-01948399",
      invoice_date: "15/11/2026",
      status: "held",
      sha256: sha("INV-9002|PO-4415|1450"),
    },
    {
      invoice_number: "INV-9004",
      po_number: "PO-4412",
      vendor_name: "Mombasa Logistics Ltd",
      currency: "KES",
      subtotal: 200000,
      vat: 32000,
      total: 232000,
      etims_cu: "KRA-CU-01948504",
      invoice_date: "12/11/2026",
      status: "open",
      sha256: sha("INV-9004|PO-4412|232000"),
    },
    {
      invoice_number: "INV-9006",
      po_number: "PO-4418",
      vendor_name: "Savannah Steel Works Ltd",
      currency: "KES",
      subtotal: 50000,
      vat: 8000,
      total: 58000,
      etims_cu: "KRA-CU-01948611",
      invoice_date: "10/11/2026",
      status: "reconciled",
      sha256: sha("INV-9006|PO-4418|58000"),
    },
  ];

  const payments: PaymentRecord[] = [
    {
      payment_ref: "MPESA-QKL8821",
      vendor_name: "Acacia Hardware",
      invoice_number: "INV-9001",
      currency: "KES",
      amount: 114000, // 2% WHVAT withheld (2,000 KES)
      channel: "M-Pesa",
      paid_at: "16/11/2026",
      status: "unmatched",
    },
    {
      payment_ref: "WIRE-USD-441",
      vendor_name: "Rift Valley Cloud",
      invoice_number: "INV-9002",
      currency: "USD",
      amount: 1450,
      channel: "Wire",
      paid_at: "16/11/2026",
      status: "unmatched",
    },
    {
      payment_ref: "EFT-77319",
      vendor_name: "Mombasa Logistics Ltd",
      invoice_number: "INV-9004",
      currency: "KES",
      amount: 215000, // Short paid by 17,000 KES (outside tolerance)
      channel: "EFT",
      paid_at: "17/11/2026",
      status: "unmatched",
    },
    {
      payment_ref: "MPESA-RZP1104",
      vendor_name: "Savannah Steel Works Ltd",
      invoice_number: "INV-9006",
      currency: "KES",
      amount: 58000,
      channel: "M-Pesa",
      paid_at: "11/11/2026",
      status: "reconciled",
    },
  ];

  const threads: ReconciliationThread[] = [
    {
      thread_id: "thr-inv9001-whvat",
      created_at: "2026-11-16T09:14:00Z",
      source_type: "remittance_text",
      raw_summary: "Tumelipa Acacia HDW invoice 9001 via Mpesa QKL8821 baada ya 2% WHVAT.",
      invoice_number: "INV-9001",
      vendor_name: "ACACIA HDW",
      po_number: "PO-4410",
      payment_refs: ["MPESA-QKL8821"],
      currency: "KES",
      invoice_amount: 116000,
      paid_amount: 114000,
      variance_amount: 2000,
      variance_pct: 1.72,
      status: "pending_approval",
      reviewer: null,
      review_note: null,
      evaluation: {
        arithmetic_ok: true,
        arithmetic_diff: 0,
        etims_valid: true,
        duplicate_hash: false,
        vendor_match_score: 79,
        vendor_match_label: "Low Confidence",
        po_found: true,
        payment_count: 1,
        invoice_amount: 116000,
        paid_amount: 114000,
        variance_amount: 2000,
        variance_pct: 1.72,
        tax_rule_applied: "whvat_2pct",
        expected_withheld_amount: 2000,
        high_value_flag: false,
        outcome: "pending_approval",
        reasons: [
          "2% Kenyan WHVAT deduction detected (KES 2,000 on KES 100,000 net): confirm WHT certificate before clearing.",
          "Fuzzy vendor match 'ACACIA HDW' vs PO 'Acacia Hardware Ltd' scored 79% (below 82% auto-clear threshold).",
        ],
      },
      extraction_meta: {
        model: MODEL_NAME,
        latency_ms: 412,
      },
    },
    {
      thread_id: "thr-inv9002-wire",
      created_at: "2026-11-16T11:30:00Z",
      source_type: "remittance_text",
      raw_summary: "Confirm Rift Valley Cloud USD wire WIRE-USD-441 against INV-9002.",
      invoice_number: "INV-9002",
      vendor_name: "Rift Valley Cloud Services",
      po_number: "PO-4415",
      payment_refs: ["WIRE-USD-441"],
      currency: "USD",
      invoice_amount: 1450,
      paid_amount: 1450,
      variance_amount: 0,
      variance_pct: 0,
      status: "pending_approval",
      reviewer: null,
      review_note: null,
      evaluation: {
        arithmetic_ok: true,
        arithmetic_diff: 0,
        etims_valid: true,
        duplicate_hash: false,
        vendor_match_score: 100,
        vendor_match_label: "Exact",
        po_found: true,
        payment_count: 1,
        invoice_amount: 1450,
        paid_amount: 1450,
        variance_amount: 0,
        variance_pct: 0,
        tax_rule_applied: "none",
        expected_withheld_amount: 0,
        high_value_flag: true,
        outcome: "pending_approval",
        reasons: [
          "High-value USD invoice ($1,450.00 >= $1,000.00 threshold) requires supervisor sign-off.",
        ],
      },
      extraction_meta: {
        model: "deterministic",
        latency_ms: 4,
      },
    },
    {
      thread_id: "thr-inv9006-clear",
      created_at: "2026-11-11T14:05:00Z",
      source_type: "remittance_text",
      raw_summary: "Reconcile INV-9006 with MPESA-RZP1104 KES",
      invoice_number: "INV-9006",
      vendor_name: "Savannah Steel Works Ltd",
      po_number: "PO-4418",
      payment_refs: ["MPESA-RZP1104"],
      currency: "KES",
      invoice_amount: 58000,
      paid_amount: 58000,
      variance_amount: 0,
      variance_pct: 0,
      status: "reconciled",
      reviewer: "Policy Engine (Auto)",
      review_note: "Zero variance within tolerance; eTIMS verified.",
      evaluation: {
        arithmetic_ok: true,
        arithmetic_diff: 0,
        etims_valid: true,
        duplicate_hash: false,
        vendor_match_score: 100,
        vendor_match_label: "Exact",
        po_found: true,
        payment_count: 1,
        invoice_amount: 58000,
        paid_amount: 58000,
        variance_amount: 0,
        variance_pct: 0,
        tax_rule_applied: "none",
        expected_withheld_amount: 0,
        high_value_flag: false,
        outcome: "auto_reconciled",
        reasons: [
          "All deterministic checks passed: arithmetic, eTIMS CU, PO match, exact payment.",
        ],
      },
      extraction_meta: {
        model: "deterministic",
        latency_ms: 3,
      },
    },
  ];

  const audit_log: AuditEntry[] = [
    {
      id: 1,
      thread_id: "thr-inv9006-clear",
      step_name: "ledger_finalizer",
      decision: "reconciled",
      summary: "INV-9006 cleared automatically with MPESA-RZP1104 (KES 58,000).",
      created_at: "2026-11-11T14:05:02Z",
      details: { invoice_number: "INV-9006", variance: 0, currency: "KES" },
    },
    {
      id: 2,
      thread_id: "thr-inv9001-whvat",
      step_name: "policy_critic",
      decision: "pending_approval",
      summary: "INV-9001 held for 2% WHVAT confirmation and 79% fuzzy vendor match.",
      created_at: "2026-11-16T09:14:01Z",
      details: { tax_rule_applied: "whvat_2pct", vendor_match_score: 79 },
    },
    {
      id: 3,
      thread_id: "thr-inv9002-wire",
      step_name: "policy_critic",
      decision: "pending_approval",
      summary: "INV-9002 held for supervisor approval (USD 1,450 >= USD 1,000 limit).",
      created_at: "2026-11-16T11:30:01Z",
      details: { high_value_flag: true, amount: 1450, currency: "USD" },
    },
  ];

  return {
    purchase_orders,
    invoices,
    payments,
    threads,
    audit_log,
    nextAuditId: 4,
    telemetryRuns: [
      { latency_ms: 412, human_override: false },
      { latency_ms: 4, human_override: false },
      { latency_ms: 3, human_override: false },
    ],
  };
}

function sha(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

let store = buildInitialState();

// --- Deterministic Utility Functions ---
function normalizeVendor(name: string): string[] {
  const stop = new Set(["ltd", "limited", "inc", "co", "kenya", "ke", "plc"]);
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
  return /^(KRA-)?CU-\d{6,12}$/i.test(cu.trim()) || /^CU\d{6,12}$/i.test(cu.trim());
}

function regexParseRemittance(raw: string): ParsedRemittanceFields {
  const invMatch = raw.match(/\b(INV-\d{3,6})\b/i);
  const payMatch = raw.match(/\b((?:MPESA|EFT|WIRE)-[A-Z0-9-]+)\b/i);
  const curMatch = raw.match(/\b(KES|USD)\b/i);
  return {
    invoice_number: invMatch ? invMatch[1].toUpperCase() : null,
    payment_ref: payMatch ? payMatch[1].toUpperCase() : null,
    vendor_name: null,
    currency: curMatch ? (curMatch[1].toUpperCase() as Currency) : null,
    wht_mentioned: /\b(whvat|wht|withholding)\b/i.test(raw),
  };
}

function evaluateDeterministicPolicy(params: {
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
}): PolicyEvaluation {
  const reasons: string[] = [];
  const arithmetic_diff = Number((params.subtotal + params.vat - params.total).toFixed(2));
  const arithmetic_ok = Math.abs(arithmetic_diff) <= 1.0 && params.total > 0;
  if (!arithmetic_ok) {
    reasons.push(
      `Arithmetic check failed: subtotal (${params.subtotal}) + VAT (${params.vat}) != total (${params.total}).`
    );
  }

  const etims_valid = isValidEtims(params.etims_cu);
  if (!etims_valid) {
    reasons.push("Missing or malformed KRA eTIMS Control Unit number (expected KRA-CU-XXXXXXXX).");
  }

  if (params.duplicate_hash) {
    reasons.push("Duplicate document SHA-256 hash detected in ledger.");
  }
  if (params.already_reconciled) {
    reasons.push(`Invoice ${params.invoice_number} is already reconciled; monotonic ledger rule blocks re-posting.`);
  }

  const po = params.po_number
    ? store.purchase_orders.find((p) => p.po_number.toUpperCase() === params.po_number?.toUpperCase())
    : undefined;
  const po_found = Boolean(po);
  if (!po_found) {
    reasons.push("No matching Purchase Order found in ledger.");
  }

  const vendorScore = po
    ? scoreVendorMatch(params.vendor_name, po.vendor_name)
    : { score: params.vendor_name ? 50 : 0, label: (params.vendor_name ? "Low Confidence" : "Missing") as PolicyEvaluation["vendor_match_label"] };

  if (po && vendorScore.score < 82) {
    reasons.push(
      `Vendor match '${params.vendor_name ?? "unknown"}' vs PO '${po.vendor_name}' scored ${vendorScore.score}% (below 82% threshold).`
    );
  }

  const variance_amount = Number((params.total - params.paid_amount).toFixed(2));
  const variance_pct = params.total > 0 ? Number(((Math.abs(variance_amount) / params.total) * 100).toFixed(2)) : 0;

  const expectedWhvat = Number((params.subtotal * 0.02).toFixed(2));
  const expectedWht = Number((params.subtotal * 0.05).toFixed(2));
  const tolTax = params.currency === "KES" ? 5 : 0.5;

  let tax_rule_applied: TaxRuleApplied = "none";
  let expected_withheld_amount = 0;

  if (params.payment_count > 0 && params.subtotal > 0) {
    if (Math.abs(variance_amount - expectedWhvat) <= tolTax) {
      tax_rule_applied = "whvat_2pct";
      expected_withheld_amount = expectedWhvat;
      reasons.push(
        `2% Kenyan WHVAT deduction detected (${params.currency} ${expectedWhvat.toLocaleString()}): confirm WHT certificate before clearing.`
      );
    } else if (Math.abs(variance_amount - expectedWht) <= tolTax) {
      tax_rule_applied = "wht_5pct";
      expected_withheld_amount = expectedWht;
      reasons.push(
        `5% Resident WHT deduction detected (${params.currency} ${expectedWht.toLocaleString()}): confirm WHT certificate before clearing.`
      );
    }
  }

  const absTol = params.currency === "KES" ? 500 : 5;
  const withinTolerance =
    params.payment_count > 0 &&
    (Math.abs(variance_amount) <= absTol || variance_pct <= 1.5);

  if (params.payment_count === 0) {
    reasons.push("No matching payment found in bank/M-Pesa settlement table.");
  } else if (!withinTolerance && tax_rule_applied === "none") {
    reasons.push(
      `Payment variance of ${params.currency} ${Math.abs(variance_amount).toLocaleString()} (${variance_pct}%) exceeds policy tolerance (1.5% or ${params.currency} ${absTol}).`
    );
  }

  const highValueThreshold = params.currency === "KES" ? 150000 : 1000;
  const high_value_flag = params.total >= highValueThreshold;
  if (high_value_flag) {
    reasons.push(
      `High-value invoice (${params.currency} ${params.total.toLocaleString()} >= ${params.currency} ${highValueThreshold.toLocaleString()}) requires supervisor approval.`
    );
  }

  let outcome: PolicyEvaluation["outcome"] = "auto_reconciled";
  if (!arithmetic_ok || params.duplicate_hash || params.already_reconciled) {
    outcome = "blocked";
  } else if (
    !etims_valid ||
    !po_found ||
    params.payment_count === 0 ||
    vendorScore.score < 82 ||
    high_value_flag ||
    tax_rule_applied !== "none" ||
    !withinTolerance
  ) {
    outcome = "pending_approval";
  } else {
    reasons.push("All deterministic checks passed: arithmetic, eTIMS CU, PO match, vendor match, and payment tolerance.");
  }

  return {
    arithmetic_ok,
    arithmetic_diff,
    etims_valid,
    duplicate_hash: params.duplicate_hash,
    vendor_match_score: vendorScore.score,
    vendor_match_label: vendorScore.label,
    po_found,
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

function appendAudit(
  thread_id: string,
  step_name: string,
  decision: string,
  summary: string,
  details: Record<string, unknown>
) {
  store.audit_log.unshift({
    id: store.nextAuditId++,
    thread_id,
    step_name,
    decision,
    summary,
    created_at: new Date().toISOString(),
    details,
  });
}

function buildPublicState(): WorkbenchState {
  const total_runs = store.telemetryRuns.length;
  const avg_latency_ms = total_runs
    ? Math.round(store.telemetryRuns.reduce((s, r) => s + r.latency_ms, 0) / total_runs)
    : 0;
  return {
    purchase_orders: store.purchase_orders,
    invoices: store.invoices,
    payments: store.payments,
    threads: store.threads,
    audit_log: store.audit_log,
    telemetry: {
      total_runs,
      avg_latency_ms,
      auto_cleared_count: store.threads.filter((t) => t.status === "reconciled").length,
      pending_count: store.threads.filter((t) => t.status === "pending_approval" || t.status === "held").length,
      blocked_or_rejected_count: store.threads.filter((t) => t.status === "blocked" || t.status === "rejected").length,
      human_override_count: store.telemetryRuns.filter((r) => r.human_override).length,
    },
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "12mb" }));

  app.get("/api/workbench", (_req, res) => {
    res.json(buildPublicState());
  });

  app.post("/api/workbench/reset", (_req, res) => {
    store = buildInitialState();
    res.json(buildPublicState());
  });

  // Step 1A: Extract structured invoice fields from image or raw text via Gemini
  app.post("/api/extract-invoice", async (req, res) => {
    const t0 = performance.now();
    try {
      const { base64Data, mimeType, documentText, fileName } = req.body as {
        base64Data?: string;
        mimeType?: string;
        documentText?: string;
        fileName?: string;
      };

      if (!base64Data && !documentText?.trim()) {
        res.status(400).json({ error: "Provide either an invoice file (image/PDF) or invoice text." });
        return;
      }

      const ai = getGeminiClient();
      const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = [];
      if (base64Data && mimeType) {
        parts.push({ inlineData: { mimeType, data: base64Data } });
      }
      parts.push({
        text:
          "Extract supplier invoice fields into strict JSON. " +
          "Use null if a field is missing; never invent numbers or invoice IDs.\n" +
          (documentText ? `Document text:\n${documentText}` : "Extract from the attached invoice document."),
      });

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: { parts },
        config: {
          systemInstruction:
            "You are a precision Accounts Payable invoice extractor for Kenyan and USD B2B invoices. " +
            "Extract invoice_number, po_number, vendor_name, currency (KES or USD), invoice_date (DD/MM/YYYY), " +
            "etims_cu (KRA Control Unit number like KRA-CU-01948271), subtotal, vat, and total. Return JSON only.",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              invoice_number: { type: Type.STRING, nullable: true },
              po_number: { type: Type.STRING, nullable: true },
              vendor_name: { type: Type.STRING, nullable: true },
              currency: { type: Type.STRING, nullable: true },
              invoice_date: { type: Type.STRING, nullable: true },
              etims_cu: { type: Type.STRING, nullable: true },
              subtotal: { type: Type.NUMBER, nullable: true },
              vat: { type: Type.NUMBER, nullable: true },
              total: { type: Type.NUMBER, nullable: true },
            },
          },
        },
      });

      const latency_ms = Math.round(performance.now() - t0);
      const parsed = JSON.parse((response.text ?? "{}").trim()) as ExtractedInvoiceFields;
      const currency: Currency = parsed.currency?.toUpperCase() === "USD" ? "USD" : "KES";
      const subtotal = Number(parsed.subtotal ?? 0);
      const vat = Number(parsed.vat ?? 0);
      const total = Number(parsed.total ?? 0);

      const docHash = sha(base64Data ? base64Data.slice(0, 512) : documentText || fileName || String(Date.now()));
      const duplicate_hash = store.invoices.some((inv) => inv.sha256 === docHash);
      const existingInv = parsed.invoice_number
        ? store.invoices.find((i) => i.invoice_number.toUpperCase() === parsed.invoice_number?.toUpperCase())
        : undefined;
      const already_reconciled = existingInv?.status === "reconciled";

      const matchedPayments = parsed.invoice_number
        ? store.payments.filter(
            (p) => p.invoice_number?.toUpperCase() === parsed.invoice_number?.toUpperCase()
          )
        : [];
      const paid_amount = matchedPayments.reduce((s, p) => s + p.amount, 0);

      const evaluation = evaluateDeterministicPolicy({
        invoice_number: parsed.invoice_number,
        po_number: parsed.po_number,
        vendor_name: parsed.vendor_name,
        currency,
        subtotal,
        vat,
        total,
        etims_cu: parsed.etims_cu,
        paid_amount,
        payment_count: matchedPayments.length,
        duplicate_hash,
        already_reconciled,
      });

      const thread_id = `thr-doc-${Date.now().toString(36)}`;
      const threadStatus =
        evaluation.outcome === "auto_reconciled"
          ? "reconciled"
          : evaluation.outcome === "blocked"
          ? "blocked"
          : "pending_approval";

      const thread: ReconciliationThread = {
        thread_id,
        created_at: new Date().toISOString(),
        source_type: "invoice_document",
        raw_summary: fileName ? `Uploaded document: ${fileName}` : "Extracted supplier invoice document",
        invoice_number: parsed.invoice_number,
        vendor_name: parsed.vendor_name,
        po_number: parsed.po_number,
        payment_refs: matchedPayments.map((p) => p.payment_ref),
        currency,
        invoice_amount: total,
        paid_amount,
        variance_amount: evaluation.variance_amount,
        variance_pct: evaluation.variance_pct,
        status: threadStatus,
        reviewer: threadStatus === "reconciled" ? "Policy Engine (Auto)" : null,
        review_note: threadStatus === "reconciled" ? evaluation.reasons[0] : null,
        evaluation,
        extraction_meta: {
          model: MODEL_NAME,
          latency_ms,
          llm_parsed: parsed,
        },
      };

      store.threads.unshift(thread);
      store.telemetryRuns.push({ latency_ms, human_override: false });

      if (threadStatus === "reconciled" && existingInv) {
        existingInv.status = "reconciled";
        matchedPayments.forEach((p) => (p.status = "reconciled"));
      }

      appendAudit(
        thread_id,
        "intake_validator",
        threadStatus,
        `Document ${parsed.invoice_number || fileName || "intake"} extracted via ${MODEL_NAME} (${latency_ms}ms) -> ${threadStatus}.`,
        { parsed, evaluation }
      );

      res.json({ extracted: parsed, thread, state: buildPublicState() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Extraction failed";
      res.status(500).json({ error: msg });
    }
  });

  // Step 1B: Parse messy English / Swahili / Sheng remittance text + compare regex vs Gemini
  app.post("/api/reconcile", async (req, res) => {
    const t0 = performance.now();
    try {
      const { rawInput } = req.body as { rawInput?: string };
      if (!rawInput?.trim()) {
        res.status(400).json({ error: "Please enter a remittance note or payment message." });
        return;
      }

      const regexBaseline = regexParseRemittance(rawInput);
      const ai = getGeminiClient();

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: rawInput,
        config: {
          systemInstruction:
            "Extract Accounts Payable reconciliation references from English, Swahili, Sheng, or mixed business text. " +
            "Normalize invoice numbers like '9001' or 'inv 9004' to 'INV-9001' / 'INV-9004' if clearly an invoice number, " +
            "payment references (MPESA-*, EFT-*, WIRE-*), vendor_name if mentioned, currency (KES or USD), and wht_mentioned (boolean if WHVAT/WHT/withholding tax is mentioned).",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              invoice_number: { type: Type.STRING, nullable: true },
              payment_ref: { type: Type.STRING, nullable: true },
              vendor_name: { type: Type.STRING, nullable: true },
              currency: { type: Type.STRING, nullable: true },
              wht_mentioned: { type: Type.BOOLEAN },
            },
            required: ["wht_mentioned"],
          },
        },
      });

      const latency_ms = Math.round(performance.now() - t0);
      const llmParsed = JSON.parse((response.text ?? "{}").trim()) as ParsedRemittanceFields;

      const invKey = llmParsed.invoice_number || regexBaseline.invoice_number;
      const inv = invKey
        ? store.invoices.find((i) => i.invoice_number.toUpperCase() === invKey.toUpperCase())
        : undefined;

      const matchedPayments = inv
        ? store.payments.filter(
            (p) =>
              p.invoice_number?.toUpperCase() === inv.invoice_number.toUpperCase() ||
              (llmParsed.payment_ref && p.payment_ref.toUpperCase() === llmParsed.payment_ref.toUpperCase())
          )
        : llmParsed.payment_ref
        ? store.payments.filter((p) => p.payment_ref.toUpperCase() === llmParsed.payment_ref?.toUpperCase())
        : [];

      const currency: Currency =
        inv?.currency ?? (llmParsed.currency?.toUpperCase() === "USD" ? "USD" : "KES");
      const paid_amount = matchedPayments.reduce((s, p) => s + p.amount, 0);

      const evaluation = inv
        ? evaluateDeterministicPolicy({
            invoice_number: inv.invoice_number,
            po_number: inv.po_number,
            vendor_name: inv.vendor_name,
            currency,
            subtotal: inv.subtotal,
            vat: inv.vat,
            total: inv.total,
            etims_cu: inv.etims_cu,
            paid_amount,
            payment_count: matchedPayments.length,
            duplicate_hash: false,
            already_reconciled: inv.status === "reconciled",
          })
        : evaluateDeterministicPolicy({
            invoice_number: invKey,
            po_number: null,
            vendor_name: llmParsed.vendor_name,
            currency,
            subtotal: 0,
            vat: 0,
            total: 0,
            etims_cu: null,
            paid_amount,
            payment_count: matchedPayments.length,
            duplicate_hash: false,
            already_reconciled: false,
          });

      const thread_id = `thr-rem-${Date.now().toString(36)}`;
      const threadStatus =
        evaluation.outcome === "auto_reconciled"
          ? "reconciled"
          : evaluation.outcome === "blocked"
          ? "blocked"
          : "pending_approval";

      const thread: ReconciliationThread = {
        thread_id,
        created_at: new Date().toISOString(),
        source_type: "remittance_text",
        raw_summary: rawInput.trim(),
        invoice_number: inv?.invoice_number ?? invKey,
        vendor_name: inv?.vendor_name ?? llmParsed.vendor_name,
        po_number: inv?.po_number ?? null,
        payment_refs: matchedPayments.map((p) => p.payment_ref),
        currency,
        invoice_amount: inv?.total ?? 0,
        paid_amount,
        variance_amount: evaluation.variance_amount,
        variance_pct: evaluation.variance_pct,
        status: threadStatus,
        reviewer: threadStatus === "reconciled" ? "Policy Engine (Auto)" : null,
        review_note: threadStatus === "reconciled" ? evaluation.reasons[0] : null,
        evaluation,
        extraction_meta: {
          model: MODEL_NAME,
          latency_ms,
          regex_baseline: regexBaseline,
          llm_parsed: llmParsed,
        },
      };

      store.threads.unshift(thread);
      store.telemetryRuns.push({ latency_ms, human_override: false });

      if (threadStatus === "reconciled" && inv) {
        inv.status = "reconciled";
        matchedPayments.forEach((p) => (p.status = "reconciled"));
      }

      appendAudit(
        thread_id,
        "policy_critic",
        threadStatus,
        `Remittance parsed (${latency_ms}ms) -> ${inv?.invoice_number || "unmatched"}: ${threadStatus}.`,
        { regexBaseline, llmParsed, evaluation }
      );

      res.json({ thread, state: buildPublicState() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Reconciliation failed";
      res.status(500).json({ error: msg });
    }
  });

  // Step 3: Human-in-the-loop approval decision
  app.post("/api/threads/:threadId/decision", (req, res) => {
    const { threadId } = req.params;
    const { action, reviewer, note } = req.body as {
      action?: "approve" | "hold" | "reject";
      reviewer?: string;
      note?: string;
    };

    const thread = store.threads.find((t) => t.thread_id === threadId);
    if (!thread) {
      res.status(404).json({ error: "Reconciliation thread not found." });
      return;
    }
    if (thread.status === "reconciled" || thread.status === "blocked") {
      res.status(409).json({
        error: `Thread ${threadId} is already finalized as '${thread.status}'.`,
      });
      return;
    }
    if (!action || !["approve", "hold", "reject"].includes(action)) {
      res.status(400).json({ error: "Action must be approve, hold, or reject." });
      return;
    }
    if (!reviewer?.trim()) {
      res.status(400).json({ error: "Reviewer name is required." });
      return;
    }

    const nextStatus =
      action === "approve" ? "reconciled" : action === "hold" ? "held" : "rejected";

    if (action === "approve" && thread.invoice_number) {
      const alreadyCleared = store.threads.some(
        (t) =>
          t.thread_id !== thread.thread_id &&
          t.invoice_number === thread.invoice_number &&
          t.status === "reconciled"
      );
      if (alreadyCleared) {
        res.status(409).json({
          error: `Invoice ${thread.invoice_number} is already reconciled on another thread.`,
        });
        return;
      }
      const inv = store.invoices.find((i) => i.invoice_number === thread.invoice_number);
      if (inv) inv.status = "reconciled";
      thread.payment_refs.forEach((ref) => {
        const pay = store.payments.find((p) => p.payment_ref === ref);
        if (pay) pay.status = "reconciled";
      });
    } else if (thread.invoice_number) {
      const inv = store.invoices.find((i) => i.invoice_number === thread.invoice_number);
      if (inv && inv.status !== "reconciled") {
        inv.status = action === "hold" ? "held" : "rejected";
      }
    }

    thread.status = nextStatus;
    thread.reviewer = reviewer.trim();
    thread.review_note = note?.trim() || `${action} by ${reviewer.trim()}`;

    if (action === "approve") {
      store.telemetryRuns.push({ latency_ms: 0, human_override: true });
    }

    appendAudit(
      thread.thread_id,
      "human_approval",
      nextStatus,
      `${reviewer.trim()} marked ${thread.invoice_number || thread.thread_id} as ${nextStatus}.`,
      { reviewer: thread.reviewer, note: thread.review_note, action }
    );

    res.json({ thread, state: buildPublicState() });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
