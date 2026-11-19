import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KENYAN_AP_POLICIES } from "./policiesSeed.ts";
import type {
  AuditEntry,
  Currency,
  InvoiceRecord,
  PaymentRecord,
  PolicyCategory,
  PolicyDocument,
  PolicyEvaluation,
  PurchaseOrder,
  ReconciliationThread,
  ThreadStatus,
  WorkbenchState,
} from "./types.ts";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "workbench.db");

export function sha16(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export interface StoredPolicyVector {
  policy_id: string;
  content_hash: string;
  embedding_model: string;
  dimension: number;
  embedding: number[];
}

export class WorkbenchDB {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.configurePragmas();
    this.createSchema();
    this.seedIfEmpty();
  }

  private configurePragmas() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ap_policies (
        policy_id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('tax_etims', 'matching_tolerance', 'controls_fraud', 'supplier_sop')),
        title TEXT NOT NULL,
        vendor_scope TEXT,
        rule_text TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS policy_vectors (
        policy_id TEXT PRIMARY KEY REFERENCES ap_policies(policy_id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        embedding_json TEXT NOT NULL,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS purchase_orders (
        po_number TEXT PRIMARY KEY,
        vendor_name TEXT NOT NULL,
        kra_pin TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency IN ('KES', 'USD')),
        authorized_amount REAL NOT NULL,
        goods_received INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed'))
      );

      CREATE TABLE IF NOT EXISTS invoices (
        invoice_number TEXT PRIMARY KEY,
        po_number TEXT,
        vendor_name TEXT NOT NULL,
        currency TEXT NOT NULL CHECK (currency IN ('KES', 'USD')),
        subtotal REAL NOT NULL,
        vat REAL NOT NULL,
        total REAL NOT NULL,
        etims_cu TEXT,
        invoice_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'reconciled', 'held', 'rejected')),
        sha256 TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payments (
        payment_ref TEXT PRIMARY KEY,
        vendor_name TEXT NOT NULL,
        invoice_number TEXT,
        currency TEXT NOT NULL CHECK (currency IN ('KES', 'USD')),
        amount REAL NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('M-Pesa', 'EFT', 'Wire')),
        paid_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('unmatched', 'reconciled'))
      );

      CREATE TABLE IF NOT EXISTS intake_documents (
        sha256 TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        document_type TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS reconciliation_threads (
        thread_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        source_type TEXT NOT NULL,
        raw_summary TEXT NOT NULL,
        invoice_number TEXT,
        vendor_name TEXT,
        po_number TEXT,
        payment_refs_json TEXT NOT NULL,
        currency TEXT NOT NULL,
        invoice_amount REAL NOT NULL,
        paid_amount REAL NOT NULL,
        variance_amount REAL NOT NULL,
        variance_pct REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reconciled', 'pending_approval', 'held', 'rejected', 'blocked')),
        reviewer TEXT,
        review_note TEXT,
        extracted_json TEXT,
        retrieved_policies_json TEXT NOT NULL,
        evaluation_json TEXT NOT NULL,
        investigation_json TEXT NOT NULL,
        engine_meta_json TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_one_reconciled_invoice
        ON reconciliation_threads(invoice_number)
        WHERE status = 'reconciled' AND invoice_number IS NOT NULL;

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        details_json TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END;

      CREATE TABLE IF NOT EXISTS telemetry_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        latency_ms REAL NOT NULL,
        human_override INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Ensure clean migration if an older workbench.db from earlier step exists without new columns
    const cols = this.db.prepare("PRAGMA table_info(reconciliation_threads)").all() as { name: string }[];
    if (cols.length > 0 && !cols.some((c) => c.name === "investigation_json")) {
      this.db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        const f = `${this.dbPath}${suffix}`;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      this.db = new DatabaseSync(this.dbPath);
      this.configurePragmas();
      this.createSchema();
    }
  }

  private seedIfEmpty() {
    const polCnt = (this.db.prepare("SELECT COUNT(*) AS cnt FROM ap_policies").get() as { cnt: number }).cnt;
    if (polCnt === 0) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const stmt = this.db.prepare(`
          INSERT INTO ap_policies (policy_id, category, title, vendor_scope, rule_text, effective_date, content_hash, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const now = new Date().toISOString();
        for (const p of KENYAN_AP_POLICIES) {
          const hash = sha16(`${p.title}|${p.vendor_scope ?? ""}|${p.rule_text}`);
          stmt.run(p.policy_id, p.category, p.title, p.vendor_scope, p.rule_text, p.effective_date, hash, now);
        }
        this.db.exec("COMMIT;");
      } catch (err) {
        this.db.exec("ROLLBACK;");
        throw err;
      }
    }

    const poCnt = (this.db.prepare("SELECT COUNT(*) AS cnt FROM purchase_orders").get() as { cnt: number }).cnt;
    if (poCnt > 0) return;

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const insertPo = this.db.prepare(
        "INSERT INTO purchase_orders (po_number, vendor_name, kra_pin, currency, authorized_amount, goods_received, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      insertPo.run("PO-4410", "Acacia Hardware Ltd", "P051234987K", "KES", 116000, 1, "open");
      insertPo.run("PO-4412", "Mombasa Logistics Ltd", "P051883210M", "KES", 232000, 1, "open");
      insertPo.run("PO-4415", "Rift Valley Cloud Services", "P051449012R", "USD", 1450, 1, "open");
      insertPo.run("PO-4418", "Savannah Steel Works Ltd", "P051774509S", "KES", 58000, 1, "open");
      insertPo.run("PO-4421", "Eldoret Agrovet & Feeds Ltd", "P051992341E", "KES", 74500, 1, "open");
      insertPo.run("PO-4424", "Nairobi Legal & Advisory LLP", "P051338712N", "KES", 116000, 1, "open");
      insertPo.run("PO-4440", "Apex Security Systems Ltd", "P051729104A", "KES", 98600, 1, "open");
      insertPo.run("PO-4442", "Kilimani Print & Stationery", "P051842901P", "KES", 34800, 1, "open");

      const insertInv = this.db.prepare(
        "INSERT INTO invoices (invoice_number, po_number, vendor_name, currency, subtotal, vat, total, etims_cu, invoice_date, status, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      insertInv.run("INV-9001", "PO-4410", "ACACIA HDW", "KES", 100000, 16000, 116000, "KRA-CU-01948271", "2026-11-14", "held", sha16("INV-9001|PO-4410|116000"));
      insertInv.run("INV-9002", "PO-4415", "Rift Valley Cloud Services", "USD", 1450, 0, 1450, "KRA-CU-01948399", "2026-11-15", "held", sha16("INV-9002|PO-4415|1450"));
      insertInv.run("INV-9004", "PO-4412", "Mombasa Logistics Ltd", "KES", 200000, 32000, 232000, "KRA-CU-01948504", "2026-11-12", "held", sha16("INV-9004|PO-4412|232000"));
      insertInv.run("INV-9005", "PO-4424", "Nairobi Legal & Advisory LLP", "KES", 100000, 16000, 116000, "KRA-CU-01948588", "2026-11-13", "open", sha16("INV-9005|PO-4424|116000"));
      insertInv.run("INV-9006", "PO-4418", "Savannah Steel Works Ltd", "KES", 50000, 8000, 58000, "KRA-CU-01948611", "2026-11-10", "reconciled", sha16("INV-9006|PO-4418|58000"));
      insertInv.run("INV-9007", "PO-4421", "Eldoret Agrovet & Feeds Ltd", "KES", 70000, 4500, 74500, "KRA-CU-01948702", "2026-11-11", "open", sha16("INV-9007|PO-4421|74500"));
      insertInv.run("INV-9009", "PO-4442", "Kilimani Print & Stationery", "KES", 30000, 4800, 34800, "KRA-CU-01948815", "2026-11-16", "open", sha16("INV-9009|PO-4442|34800"));

      const insertPay = this.db.prepare(
        "INSERT INTO payments (payment_ref, vendor_name, invoice_number, currency, amount, channel, paid_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      insertPay.run("MPESA-QKL8821", "Acacia Hardware", "INV-9001", "KES", 114000, "M-Pesa", "2026-11-16", "unmatched");
      insertPay.run("WIRE-USD-441", "Rift Valley Cloud", "INV-9002", "USD", 1450, "Wire", "2026-11-16", "unmatched");
      insertPay.run("EFT-77319", "Mombasa Logistics Ltd", "INV-9004", "KES", 215000, "EFT", "2026-11-17", "unmatched");
      insertPay.run("EFT-88201", "Nairobi Legal & Advisory", "INV-9005", "KES", 111000, "EFT", "2026-11-17", "unmatched");
      insertPay.run("MPESA-RZP1104", "Savannah Steel Works Ltd", "INV-9006", "KES", 58000, "M-Pesa", "2026-11-11", "reconciled");
      insertPay.run("EFT-90110", "Eldoret Agrovet", "INV-9007", "KES", 40000, "EFT", "2026-11-14", "unmatched");
      insertPay.run("EFT-90111", "Eldoret Agrovet", "INV-9007", "KES", 34500, "EFT", "2026-11-15", "unmatched");
      insertPay.run("MPESA-KPS3310", "Kilimani Print", "INV-9009", "KES", 34800, "M-Pesa", "2026-11-17", "unmatched");

      const insertThread = this.db.prepare(`
        INSERT INTO reconciliation_threads (
          thread_id, created_at, source_type, raw_summary, invoice_number, vendor_name, po_number,
          payment_refs_json, currency, invoice_amount, paid_amount, variance_amount, variance_pct,
          status, reviewer, review_note, extracted_json, retrieved_policies_json,
          evaluation_json, investigation_json, engine_meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertThread.run(
        "thr-inv9001-whvat",
        "2026-11-16T09:14:00Z",
        "invoice_document",
        "Supplier Invoice INV-9001 (ACACIA HDW, KES 116,000)",
        "INV-9001",
        "ACACIA HDW",
        "PO-4410",
        JSON.stringify(["MPESA-QKL8821"]),
        "KES",
        116000,
        114000,
        2000,
        1.72,
        "pending_approval",
        null,
        null,
        JSON.stringify({
          document_type: "invoice",
          invoice_number: "INV-9001",
          po_number: "PO-4410",
          payment_ref: null,
          vendor_name: "ACACIA HDW",
          kra_pin: "P051234987K",
          currency: "KES",
          invoice_date: "2026-11-14",
          etims_cu: "KRA-CU-01948271",
          subtotal: 100000,
          vat: 16000,
          total: 116000,
          line_items: [
            { description: "Industrial fasteners & galvanized fittings", quantity: 100, unit_price: 650, tax_rate: "16%", line_total: 65000 },
            { description: "Heavy-duty site valves & brackets", quantity: 35, unit_price: 1000, tax_rate: "16%", line_total: 35000 },
          ],
          extraction_notes: "Abbreviated supplier header 'ACACIA HDW'; day-first date 14/11/2026 normalized to ISO.",
        }),
        JSON.stringify([
          {
            policy_id: "SOP-VEND-001",
            category: "supplier_sop",
            title: "Acacia Hardware Ltd — Abbreviated Header & 2% WHVAT SOP",
            vendor_scope: "Acacia Hardware Ltd",
            rule_text: KENYAN_AP_POLICIES.find((p) => p.policy_id === "SOP-VEND-001")!.rule_text,
            similarity_score: 0.91,
            retrieval_mode: "dense_vector",
          },
          {
            policy_id: "POL-TAX-003",
            category: "tax_etims",
            title: "2% Withholding VAT (WHVAT) Deduction Rule",
            vendor_scope: null,
            rule_text: KENYAN_AP_POLICIES.find((p) => p.policy_id === "POL-TAX-003")!.rule_text,
            similarity_score: 0.88,
            retrieval_mode: "dense_vector",
          },
        ]),
        JSON.stringify({
          arithmetic_ok: true,
          arithmetic_diff: 0,
          etims_valid: true,
          duplicate_hash: false,
          already_reconciled: false,
          vendor_match_score: 79,
          vendor_match_label: "Low Confidence",
          po_found: true,
          goods_received: true,
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
            "Abbreviated header 'ACACIA HDW' vs PO 'Acacia Hardware Ltd' scored 79% (below 82% auto-clear gate).",
          ],
        }),
        JSON.stringify({
          root_cause: "Valid 2% Withholding VAT deduction + abbreviated supplier header",
          explanation:
            "Payment MPESA-QKL8821 settled KES 114,000 against INV-9001 (KES 116,000), leaving a KES 2,000 gap. Per POL-TAX-003 and SOP-VEND-001, KES 2,000 equals exactly 2% WHVAT on the KES 100,000 net subtotal, and 'ACACIA HDW' maps to Acacia Hardware Ltd (PO-4410).",
          recommended_action: "approve",
          confidence_label: "High",
          cited_policies: [
            { policy_id: "SOP-VEND-001", title: "Acacia Hardware Ltd — Abbreviated Header & 2% WHVAT SOP", relevance_reason: "Explains both the 'ACACIA HDW' abbreviation and standard 2% WHVAT deduction." },
            { policy_id: "POL-TAX-003", title: "2% Withholding VAT (WHVAT) Deduction Rule", relevance_reason: "Confirms KES 2,000 = 2% of KES 100,000 net taxable value." },
          ],
          draft_audit_note: "Verified 'ACACIA HDW' against PO-4410 (Acacia Hardware Ltd) and confirmed KES 2,000 deduction matches 2% WHVAT under POL-TAX-003 / SOP-VEND-001.",
        }),
        JSON.stringify({
          extraction_engine: "gemini-4-hydrogen",
          embedding_engine: "gemini-embedding-2",
          latency_ms: 412,
          vector_count_searched: KENYAN_AP_POLICIES.length,
        })
      );

      insertThread.run(
        "thr-inv9004-freight",
        "2026-11-17T10:20:00Z",
        "invoice_document",
        "Supplier Invoice INV-9004 (Mombasa Logistics Ltd, KES 232,000)",
        "INV-9004",
        "Mombasa Logistics Ltd",
        "PO-4412",
        JSON.stringify(["EFT-77319"]),
        "KES",
        232000,
        215000,
        17000,
        7.33,
        "pending_approval",
        null,
        null,
        JSON.stringify({
          document_type: "invoice",
          invoice_number: "INV-9004",
          po_number: "PO-4412",
          payment_ref: null,
          vendor_name: "Mombasa Logistics Ltd",
          kra_pin: "P051883210M",
          currency: "KES",
          invoice_date: "2026-11-12",
          etims_cu: "KRA-CU-01948504",
          subtotal: 200000,
          vat: 32000,
          total: 232000,
          line_items: [
            { description: "Mombasa-Nairobi container haulage (2x40ft)", quantity: 2, unit_price: 88000, tax_rate: "16%", line_total: 176000 },
            { description: "Port detention / demurrage surcharge", quantity: 1, unit_price: 24000, tax_rate: "16%", line_total: 24000 },
          ],
          extraction_notes: "Includes KES 24,000 demurrage surcharge line item.",
        }),
        JSON.stringify([
          {
            policy_id: "SOP-VEND-002",
            category: "supplier_sop",
            title: "Mombasa Logistics Ltd — Freight Short-Delivery & Credit Note SOP",
            vendor_scope: "Mombasa Logistics Ltd",
            rule_text: KENYAN_AP_POLICIES.find((p) => p.policy_id === "SOP-VEND-002")!.rule_text,
            similarity_score: 0.93,
            retrieval_mode: "dense_vector",
          },
          {
            policy_id: "POL-CTRL-001",
            category: "controls_fraud",
            title: "High-Value Supervisor Sign-Off Threshold",
            vendor_scope: null,
            rule_text: KENYAN_AP_POLICIES.find((p) => p.policy_id === "POL-CTRL-001")!.rule_text,
            similarity_score: 0.82,
            retrieval_mode: "dense_vector",
          },
        ]),
        JSON.stringify({
          arithmetic_ok: true,
          arithmetic_diff: 0,
          etims_valid: true,
          duplicate_hash: false,
          already_reconciled: false,
          vendor_match_score: 100,
          vendor_match_label: "Exact",
          po_found: true,
          goods_received: true,
          payment_count: 1,
          invoice_amount: 232000,
          paid_amount: 215000,
          variance_amount: 17000,
          variance_pct: 7.33,
          tax_rule_applied: "none",
          expected_withheld_amount: 0,
          high_value_flag: true,
          outcome: "pending_approval",
          reasons: [
            "Payment variance KES 17,000 (7.33%) exceeds tolerance and does not match 2% WHVAT (KES 4,000) or 5% WHT (KES 10,000).",
            "High-value invoice (KES 232,000 >= KES 150,000 threshold) requires supervisor approval.",
          ],
        }),
        JSON.stringify({
          root_cause: "Unexplained freight/demurrage variance (7.33%) — NOT a statutory tax deduction",
          explanation:
            "EFT-77319 settled KES 215,000 against INV-9004 (KES 232,000). The KES 17,000 gap does not match 2% WHVAT (KES 4,000) or 5% WHT (KES 10,000). Per SOP-VEND-002, freight variances > KES 1,000 on Mombasa Logistics Ltd (including the KES 24,000 demurrage line) must be held for a formal Credit Note.",
          recommended_action: "hold",
          confidence_label: "High",
          cited_policies: [
            { policy_id: "SOP-VEND-002", title: "Mombasa Logistics Ltd — Freight Short-Delivery & Credit Note SOP", relevance_reason: "Prohibits writing off freight/demurrage variances > KES 1,000 without a supplier Credit Note." },
            { policy_id: "POL-CTRL-001", title: "High-Value Supervisor Sign-Off Threshold", relevance_reason: "Invoice total KES 232,000 exceeds KES 150,000 threshold." },
          ],
          draft_audit_note: "Held per SOP-VEND-002: KES 17,000 short-payment on INV-9004 reflects disputed demurrage; awaiting supplier Credit Note.",
        }),
        JSON.stringify({
          extraction_engine: "gemini-4-hydrogen",
          embedding_engine: "gemini-embedding-2",
          latency_ms: 388,
          vector_count_searched: KENYAN_AP_POLICIES.length,
        })
      );

      const insertAudit = this.db.prepare(
        "INSERT INTO audit_log (thread_id, step_name, decision, summary, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)"
      );
      insertAudit.run(
        "thr-inv9001-whvat",
        "ai_investigator",
        "pending_approval",
        "INV-9001 investigated: cited SOP-VEND-001 & POL-TAX-003 (2% WHVAT match).",
        "2026-11-16T09:14:02Z",
        JSON.stringify({ cited_policies: ["SOP-VEND-001", "POL-TAX-003"], variance_amount: 2000 })
      );
      insertAudit.run(
        "thr-inv9004-freight",
        "ai_investigator",
        "pending_approval",
        "INV-9004 investigated: cited SOP-VEND-002 & POL-CTRL-001 (demurrage dispute, hold for Credit Note).",
        "2026-11-17T10:20:02Z",
        JSON.stringify({ cited_policies: ["SOP-VEND-002", "POL-CTRL-001"], variance_amount: 17000 })
      );

      const insertTel = this.db.prepare(
        "INSERT INTO telemetry_runs (latency_ms, human_override) VALUES (?, ?)"
      );
      insertTel.run(412, 0);
      insertTel.run(388, 0);

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  reset() {
    this.db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = `${this.dbPath}${suffix}`;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    this.db = new DatabaseSync(this.dbPath);
    this.configurePragmas();
    this.createSchema();
    this.seedIfEmpty();
  }

  // --- Policy & Vector Store Accessors ---
  getPolicies(): PolicyDocument[] {
    const rows = this.db
      .prepare(`
        SELECT p.policy_id, p.category, p.title, p.vendor_scope, p.rule_text,
               p.effective_date, p.updated_at,
               CASE WHEN v.policy_id IS NOT NULL AND v.content_hash = p.content_hash THEN 1 ELSE 0 END AS has_dense
        FROM ap_policies p
        LEFT JOIN policy_vectors v ON v.policy_id = p.policy_id
        ORDER BY p.policy_id
      `)
      .all() as Record<string, unknown>[];

    return rows.map((r) => ({
      policy_id: String(r.policy_id),
      category: String(r.category) as PolicyCategory,
      title: String(r.title),
      vendor_scope: (r.vendor_scope as string | null) ?? null,
      rule_text: String(r.rule_text),
      effective_date: String(r.effective_date),
      updated_at: String(r.updated_at),
      has_dense_vector: Number(r.has_dense) === 1,
    }));
  }

  upsertPolicy(input: {
    policy_id: string;
    category: PolicyCategory;
    title: string;
    vendor_scope: string | null;
    rule_text: string;
    effective_date: string;
  }): PolicyDocument {
    const content_hash = sha16(`${input.title}|${input.vendor_scope ?? ""}|${input.rule_text}`);
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO ap_policies (policy_id, category, title, vendor_scope, rule_text, effective_date, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET
          category = excluded.category,
          title = excluded.title,
          vendor_scope = excluded.vendor_scope,
          rule_text = excluded.rule_text,
          effective_date = excluded.effective_date,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `)
      .run(
        input.policy_id.trim().toUpperCase(),
        input.category,
        input.title.trim(),
        input.vendor_scope?.trim() || null,
        input.rule_text.trim(),
        input.effective_date,
        content_hash,
        now
      );

    return this.getPolicies().find((p) => p.policy_id === input.policy_id.trim().toUpperCase())!;
  }

  getUnindexedPolicies(): Array<PolicyDocument & { content_hash: string }> {
    const rows = this.db
      .prepare(`
        SELECT p.*
        FROM ap_policies p
        LEFT JOIN policy_vectors v ON v.policy_id = p.policy_id
        WHERE v.policy_id IS NULL OR v.content_hash != p.content_hash
        ORDER BY p.policy_id
      `)
      .all() as Record<string, unknown>[];

    return rows.map((r) => ({
      policy_id: String(r.policy_id),
      category: String(r.category) as PolicyCategory,
      title: String(r.title),
      vendor_scope: (r.vendor_scope as string | null) ?? null,
      rule_text: String(r.rule_text),
      effective_date: String(r.effective_date),
      updated_at: String(r.updated_at),
      content_hash: String(r.content_hash),
    }));
  }

  savePolicyVector(v: StoredPolicyVector) {
    this.db
      .prepare(`
        INSERT INTO policy_vectors (policy_id, content_hash, embedding_model, dimension, embedding_json, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(policy_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          embedding_model = excluded.embedding_model,
          dimension = excluded.dimension,
          embedding_json = excluded.embedding_json,
          indexed_at = excluded.indexed_at
      `)
      .run(
        v.policy_id,
        v.content_hash,
        v.embedding_model,
        v.dimension,
        JSON.stringify(v.embedding),
        new Date().toISOString()
      );
  }

  getAllPolicyVectors(): Map<string, number[]> {
    const rows = this.db
      .prepare("SELECT policy_id, embedding_json FROM policy_vectors")
      .all() as { policy_id: string; embedding_json: string }[];
    const map = new Map<string, number[]>();
    for (const r of rows) {
      map.set(r.policy_id, JSON.parse(r.embedding_json) as number[]);
    }
    return map;
  }

  getDenseVectorCount(): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS cnt
        FROM policy_vectors v
        JOIN ap_policies p ON p.policy_id = v.policy_id
        WHERE v.content_hash = p.content_hash
      `)
      .get() as { cnt: number };
    return Number(row.cnt);
  }

  // --- Ledger Accessors ---
  getPurchaseOrders(): PurchaseOrder[] {
    return this.db.prepare("SELECT * FROM purchase_orders ORDER BY po_number").all() as unknown as PurchaseOrder[];
  }

  getInvoices(): InvoiceRecord[] {
    return this.db.prepare("SELECT * FROM invoices ORDER BY invoice_number").all() as unknown as InvoiceRecord[];
  }

  getPayments(): PaymentRecord[] {
    return this.db.prepare("SELECT * FROM payments ORDER BY payment_ref").all() as unknown as PaymentRecord[];
  }

  getInvoiceByNumber(invoiceNumber: string): InvoiceRecord | undefined {
    return this.db
      .prepare("SELECT * FROM invoices WHERE UPPER(invoice_number) = UPPER(?)")
      .get(invoiceNumber) as unknown as InvoiceRecord | undefined;
  }

  hasDocumentHash(sha256: string): boolean {
    const row = this.db.prepare("SELECT 1 AS hit FROM intake_documents WHERE sha256 = ?").get(sha256) as
      | { hit: number }
      | undefined;
    return Boolean(row);
  }

  recordDocumentHash(sha256: string, fileName: string, documentType: string, threadId: string) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO intake_documents (sha256, file_name, document_type, thread_id) VALUES (?, ?, ?, ?)"
      )
      .run(sha256, fileName, documentType, threadId);
  }

  upsertExtractedInvoice(inv: {
    invoice_number: string;
    po_number: string | null;
    vendor_name: string;
    currency: Currency;
    subtotal: number;
    vat: number;
    total: number;
    etims_cu: string | null;
    invoice_date: string;
    status: InvoiceRecord["status"];
    sha256: string;
  }) {
    const existing = this.getInvoiceByNumber(inv.invoice_number);
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO invoices (invoice_number, po_number, vendor_name, currency, subtotal, vat, total, etims_cu, invoice_date, status, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          inv.invoice_number,
          inv.po_number,
          inv.vendor_name,
          inv.currency,
          inv.subtotal,
          inv.vat,
          inv.total,
          inv.etims_cu,
          inv.invoice_date,
          inv.status,
          inv.sha256
        );
    } else if (existing.status !== "reconciled" && inv.status === "reconciled") {
      this.db
        .prepare("UPDATE invoices SET status = 'reconciled' WHERE invoice_number = ?")
        .run(existing.invoice_number);
    }
  }

  upsertReceiptPayment(payment: {
    payment_ref: string;
    vendor_name: string;
    invoice_number: string | null;
    currency: Currency;
    amount: number;
    channel: PaymentRecord["channel"];
    paid_at: string;
    status: PaymentRecord["status"];
  }) {
    const existing = this.db
      .prepare("SELECT * FROM payments WHERE UPPER(payment_ref) = UPPER(?)")
      .get(payment.payment_ref) as unknown as PaymentRecord | undefined;
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO payments (payment_ref, vendor_name, invoice_number, currency, amount, channel, paid_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          payment.payment_ref,
          payment.vendor_name,
          payment.invoice_number,
          payment.currency,
          payment.amount,
          payment.channel,
          payment.paid_at,
          payment.status
        );
    } else if (existing.status !== "reconciled" && payment.invoice_number && !existing.invoice_number) {
      this.db
        .prepare("UPDATE payments SET invoice_number = ? WHERE payment_ref = ?")
        .run(payment.invoice_number, existing.payment_ref);
    }
  }

  insertThreadAndTelemetry(
    thread: ReconciliationThread,
    latencyMs: number,
    auditStep: string,
    auditSummary: string,
    auditDetails: Record<string, unknown>
  ) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(`
          INSERT INTO reconciliation_threads (
            thread_id, created_at, source_type, raw_summary, invoice_number, vendor_name, po_number,
            payment_refs_json, currency, invoice_amount, paid_amount, variance_amount, variance_pct,
            status, reviewer, review_note, extracted_json, retrieved_policies_json,
            evaluation_json, investigation_json, engine_meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          thread.thread_id,
          thread.created_at,
          thread.source_type,
          thread.raw_summary,
          thread.invoice_number,
          thread.vendor_name,
          thread.po_number,
          JSON.stringify(thread.payment_refs),
          thread.currency,
          thread.invoice_amount,
          thread.paid_amount,
          thread.variance_amount,
          thread.variance_pct,
          thread.status,
          thread.reviewer,
          thread.review_note,
          thread.extracted ? JSON.stringify(thread.extracted) : null,
          JSON.stringify(thread.retrieved_policies),
          JSON.stringify(thread.evaluation),
          JSON.stringify(thread.investigation),
          JSON.stringify(thread.engine_meta)
        );

      if (thread.status === "reconciled" && thread.invoice_number) {
        this.db
          .prepare("UPDATE invoices SET status = 'reconciled' WHERE UPPER(invoice_number) = UPPER(?) AND status != 'reconciled'")
          .run(thread.invoice_number);
        for (const ref of thread.payment_refs) {
          this.db
            .prepare("UPDATE payments SET status = 'reconciled' WHERE UPPER(payment_ref) = UPPER(?) AND status != 'reconciled'")
            .run(ref);
        }
      }

      this.db
        .prepare(
          "INSERT INTO audit_log (thread_id, step_name, decision, summary, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          thread.thread_id,
          auditStep,
          thread.status,
          auditSummary,
          new Date().toISOString(),
          JSON.stringify(auditDetails)
        );

      this.db
        .prepare("INSERT INTO telemetry_runs (latency_ms, human_override) VALUES (?, 0)")
        .run(latencyMs);

      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  getThread(threadId: string): ReconciliationThread | undefined {
    const r = this.db
      .prepare("SELECT * FROM reconciliation_threads WHERE thread_id = ?")
      .get(threadId) as Record<string, unknown> | undefined;
    return r ? this.mapThreadRow(r) : undefined;
  }

  applyDecision(
    threadId: string,
    action: "approve" | "hold" | "reject",
    reviewer: string,
    note: string
  ): { ok: true; thread: ReconciliationThread } | { ok: false; code: number; error: string } {
    const thread = this.getThread(threadId);
    if (!thread) return { ok: false, code: 404, error: "Reconciliation thread not found." };
    if (thread.status === "reconciled" || thread.status === "blocked") {
      return {
        ok: false,
        code: 409,
        error: `Thread ${threadId} is already finalized as '${thread.status}'.`,
      };
    }

    const nextStatus: ThreadStatus =
      action === "approve" ? "reconciled" : action === "hold" ? "held" : "rejected";

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (action === "approve" && thread.invoice_number) {
        const dup = this.db
          .prepare(
            "SELECT thread_id FROM reconciliation_threads WHERE thread_id != ? AND UPPER(invoice_number) = UPPER(?) AND status = 'reconciled'"
          )
          .get(threadId, thread.invoice_number) as { thread_id: string } | undefined;
        if (dup) {
          this.db.exec("ROLLBACK;");
          return {
            ok: false,
            code: 409,
            error: `Invoice ${thread.invoice_number} is already reconciled on thread ${dup.thread_id}.`,
          };
        }
        this.db
          .prepare("UPDATE invoices SET status = 'reconciled' WHERE UPPER(invoice_number) = UPPER(?) AND status != 'reconciled'")
          .run(thread.invoice_number);
        for (const ref of thread.payment_refs) {
          this.db
            .prepare("UPDATE payments SET status = 'reconciled' WHERE UPPER(payment_ref) = UPPER(?) AND status != 'reconciled'")
            .run(ref);
        }
      } else if (thread.invoice_number) {
        const invStatus = action === "hold" ? "held" : "rejected";
        this.db
          .prepare("UPDATE invoices SET status = ? WHERE UPPER(invoice_number) = UPPER(?) AND status != 'reconciled'")
          .run(invStatus, thread.invoice_number);
      }

      this.db
        .prepare("UPDATE reconciliation_threads SET status = ?, reviewer = ?, review_note = ? WHERE thread_id = ?")
        .run(nextStatus, reviewer, note, threadId);

      if (action === "approve") {
        this.db.prepare("INSERT INTO telemetry_runs (latency_ms, human_override) VALUES (0, 1)").run();
      }

      this.db
        .prepare(
          "INSERT INTO audit_log (thread_id, step_name, decision, summary, created_at, details_json) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(
          threadId,
          "human_approval",
          nextStatus,
          `${reviewer} marked ${thread.invoice_number || threadId} as ${nextStatus}.`,
          new Date().toISOString(),
          JSON.stringify({
            reviewer,
            note,
            action,
            cited_policies: thread.investigation.cited_policies.map((c) => c.policy_id),
          })
        );

      this.db.exec("COMMIT;");
      return { ok: true, thread: this.getThread(threadId)! };
    } catch (err) {
      this.db.exec("ROLLBACK;");
      const msg = err instanceof Error ? err.message : "Database update failed";
      return { ok: false, code: 409, error: msg };
    }
  }

  getState(): WorkbenchState {
    const purchase_orders = this.getPurchaseOrders();
    const invoices = this.getInvoices();
    const payments = this.getPayments();
    const policies = this.getPolicies();

    const threadRows = this.db
      .prepare("SELECT * FROM reconciliation_threads ORDER BY created_at DESC")
      .all() as Record<string, unknown>[];
    const threads = threadRows.map((r) => this.mapThreadRow(r));

    const auditRows = this.db
      .prepare("SELECT * FROM audit_log ORDER BY id DESC")
      .all() as Record<string, unknown>[];
    const audit_log: AuditEntry[] = auditRows.map((r) => ({
      id: Number(r.id),
      thread_id: String(r.thread_id),
      step_name: String(r.step_name),
      decision: String(r.decision),
      summary: String(r.summary),
      created_at: String(r.created_at),
      details: JSON.parse(String(r.details_json)) as Record<string, unknown>,
    }));

    const tel = this.db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_ms, COALESCE(SUM(human_override), 0) AS overrides FROM telemetry_runs"
      )
      .get() as { total: number; avg_ms: number; overrides: number };

    return {
      purchase_orders,
      invoices,
      payments,
      threads,
      policies,
      audit_log,
      telemetry: {
        total_runs: Number(tel.total),
        avg_latency_ms: Number(tel.avg_ms),
        auto_cleared_count: threads.filter((t) => t.status === "reconciled").length,
        pending_count: threads.filter((t) => t.status === "pending_approval" || t.status === "held").length,
        blocked_or_rejected_count: threads.filter((t) => t.status === "blocked" || t.status === "rejected").length,
        human_override_count: Number(tel.overrides),
        policy_count: policies.length,
        dense_vector_count: this.getDenseVectorCount(),
        ollama_configured: Boolean(process.env.OLLAMA_BASE_URL),
        ollama_model: process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:3b",
      },
    };
  }

  private mapThreadRow(r: Record<string, unknown>): ReconciliationThread {
    return {
      thread_id: String(r.thread_id),
      created_at: String(r.created_at),
      source_type: String(r.source_type) as ReconciliationThread["source_type"],
      raw_summary: String(r.raw_summary),
      invoice_number: (r.invoice_number as string | null) ?? null,
      vendor_name: (r.vendor_name as string | null) ?? null,
      po_number: (r.po_number as string | null) ?? null,
      payment_refs: JSON.parse(String(r.payment_refs_json)) as string[],
      currency: String(r.currency) as Currency,
      invoice_amount: Number(r.invoice_amount),
      paid_amount: Number(r.paid_amount),
      variance_amount: Number(r.variance_amount),
      variance_pct: Number(r.variance_pct),
      status: String(r.status) as ThreadStatus,
      reviewer: (r.reviewer as string | null) ?? null,
      review_note: (r.review_note as string | null) ?? null,
      extracted: r.extracted_json ? JSON.parse(String(r.extracted_json)) : null,
      retrieved_policies: JSON.parse(String(r.retrieved_policies_json)),
      evaluation: JSON.parse(String(r.evaluation_json)) as PolicyEvaluation,
      investigation: JSON.parse(String(r.investigation_json)),
      engine_meta: JSON.parse(String(r.engine_meta_json)),
    };
  }
}
