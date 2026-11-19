export type Currency = "KES" | "USD";

export type ThreadStatus =
  | "reconciled"
  | "pending_approval"
  | "held"
  | "rejected"
  | "blocked";

export type TaxRuleApplied = "none" | "whvat_2pct" | "wht_5pct" | "wht_3pct";

export type PolicyCategory =
  | "tax_etims"
  | "matching_tolerance"
  | "controls_fraud"
  | "supplier_sop";

export interface PolicyDocument {
  policy_id: string;
  category: PolicyCategory;
  title: string;
  vendor_scope: string | null;
  rule_text: string;
  effective_date: string;
  updated_at: string;
  has_dense_vector?: boolean;
}

export interface RetrievedPolicyHit {
  policy_id: string;
  category: PolicyCategory;
  title: string;
  vendor_scope: string | null;
  rule_text: string;
  similarity_score: number;
  retrieval_mode: "dense_vector" | "lexical_hybrid";
}

export interface InvoiceLineItem {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  tax_rate: string | null;
  line_total: number | null;
}

export interface PurchaseOrder {
  po_number: string;
  vendor_name: string;
  kra_pin: string;
  currency: Currency;
  authorized_amount: number;
  goods_received: number;
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

export interface ExtractedDocument {
  document_type: "invoice" | "receipt";
  invoice_number: string | null;
  po_number: string | null;
  payment_ref: string | null;
  vendor_name: string | null;
  kra_pin: string | null;
  currency: Currency | null;
  invoice_date: string | null;
  etims_cu: string | null;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
  line_items: InvoiceLineItem[];
  extraction_notes: string | null;
}

export interface PolicyEvaluation {
  arithmetic_ok: boolean;
  arithmetic_diff: number;
  etims_valid: boolean;
  duplicate_hash: boolean;
  already_reconciled: boolean;
  vendor_match_score: number;
  vendor_match_label: "Exact" | "Fuzzy Match" | "Low Confidence" | "Missing";
  po_found: boolean;
  goods_received: boolean;
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

export interface CitedPolicy {
  policy_id: string;
  title: string;
  relevance_reason: string;
}

export interface InvestigationBrief {
  root_cause: string;
  explanation: string;
  recommended_action: "approve" | "hold" | "reject";
  confidence_label: "High" | "Medium" | "Low";
  cited_policies: CitedPolicy[];
  draft_audit_note: string;
}

export interface ReconciliationThread {
  thread_id: string;
  created_at: string;
  source_type: "invoice_document" | "receipt_document";
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
  extracted: ExtractedDocument | null;
  retrieved_policies: RetrievedPolicyHit[];
  evaluation: PolicyEvaluation;
  investigation: InvestigationBrief;
  engine_meta: {
    extraction_engine: string;
    embedding_engine: string;
    latency_ms: number;
    vector_count_searched: number;
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
  policy_count: number;
  dense_vector_count: number;
  ollama_configured: boolean;
  ollama_model: string;
}

export interface WorkbenchState {
  purchase_orders: PurchaseOrder[];
  invoices: InvoiceRecord[];
  payments: PaymentRecord[];
  threads: ReconciliationThread[];
  policies: PolicyDocument[];
  audit_log: AuditEntry[];
  telemetry: TelemetryStats;
}
