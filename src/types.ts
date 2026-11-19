export type Currency = "KES" | "USD";

export type ThreadStatus =
  | "reconciled"
  | "pending_approval"
  | "held"
  | "rejected"
  | "blocked";

export type TaxRuleApplied = "none" | "whvat_2pct" | "wht_5pct";

export interface PurchaseOrder {
  po_number: string;
  vendor_name: string;
  kra_pin: string;
  currency: Currency;
  authorized_amount: number;
  status: "open" | "closed";
}

export interface PaymentRecord {
  payment_ref: string;
  vendor_name: string;
  invoice_number: string | null;
  currency: Currency;
  amount: number;
  channel: "M-Pesa" | "EFT" | "Wire";
  paid_at: string;
  status: "unmatched" | "reconciled";
}

export interface InvoiceRecord {
  invoice_number: string;
  po_number: string | null;
  vendor_name: string;
  currency: Currency;
  subtotal: number;
  vat: number;
  total: number;
  etims_cu: string | null;
  invoice_date: string;
  status: "open" | "reconciled" | "held" | "rejected";
  sha256: string;
}

export interface ExtractedInvoiceFields {
  invoice_number: string | null;
  po_number: string | null;
  vendor_name: string | null;
  currency: Currency | null;
  invoice_date: string | null;
  etims_cu: string | null;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
}

export interface ParsedRemittanceFields {
  invoice_number: string | null;
  payment_ref: string | null;
  vendor_name: string | null;
  currency: Currency | null;
  wht_mentioned: boolean;
}

export interface PolicyEvaluation {
  arithmetic_ok: boolean;
  arithmetic_diff: number;
  etims_valid: boolean;
  duplicate_hash: boolean;
  vendor_match_score: number;
  vendor_match_label: "Exact" | "Fuzzy Match" | "Low Confidence" | "Missing";
  po_found: boolean;
  payment_count: number;
  invoice_amount: number;
  paid_amount: number;
  variance_amount: number;
  variance_pct: number;
  tax_rule_applied: TaxRuleApplied;
  expected_withheld_amount: number;
  high_value_flag: boolean;
  outcome: "auto_reconciled" | "pending_approval" | "blocked";
  reasons: string[];
}

export interface ReconciliationThread {
  thread_id: string;
  created_at: string;
  source_type: "remittance_text" | "invoice_document";
  raw_summary: string;
  invoice_number: string | null;
  vendor_name: string | null;
  po_number: string | null;
  payment_refs: string[];
  currency: Currency;
  invoice_amount: number;
  paid_amount: number;
  variance_amount: number;
  variance_pct: number;
  status: ThreadStatus;
  reviewer: string | null;
  review_note: string | null;
  evaluation: PolicyEvaluation;
  extraction_meta: {
    model: string;
    latency_ms: number;
    regex_baseline?: ParsedRemittanceFields;
    llm_parsed?: ParsedRemittanceFields | ExtractedInvoiceFields;
  };
}

export interface AuditEntry {
  id: number;
  thread_id: string;
  step_name: string;
  decision: string;
  summary: string;
  created_at: string;
  details: Record<string, unknown>;
}

export interface TelemetryStats {
  total_runs: number;
  avg_latency_ms: number;
  auto_cleared_count: number;
  pending_count: number;
  blocked_or_rejected_count: number;
  human_override_count: number;
}

export interface WorkbenchState {
  purchase_orders: PurchaseOrder[];
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  threads: ReconciliationThread[];
  audit_log: AuditEntry[];
  telemetry: TelemetryStats;
}
