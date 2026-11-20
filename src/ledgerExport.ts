import crypto from "node:crypto";
import type { WorkbenchState } from "./types.ts";

export type LedgerFilter = "all" | "reconciled" | "open";

export interface FilteredLedgerSnapshot {
  exportedAt: string;
  filter: LedgerFilter;
  digestSha256: string;
  state: WorkbenchState;
  invoices: WorkbenchState["invoices"];
  threads: WorkbenchState["threads"];
  auditLog: WorkbenchState["audit_log"];
}

export function buildLedgerSnapshot(state: WorkbenchState, filter: LedgerFilter = "all"): FilteredLedgerSnapshot {
  const exportedAt = new Date().toISOString();
  const invoices = state.invoices.filter((inv) => {
    if (filter === "reconciled") return inv.status === "reconciled";
    if (filter === "open") return inv.status !== "reconciled";
    return true;
  });

  const invSet = new Set(invoices.map((i) => i.invoice_number.toUpperCase()));
  const threads =
    filter === "all"
      ? state.threads
      : state.threads.filter((t) => (t.invoice_number ? invSet.has(t.invoice_number.toUpperCase()) : filter === "open"));

  const threadSet = new Set(threads.map((t) => t.thread_id));
  const auditLog = filter === "all" ? state.audit_log : state.audit_log.filter((a) => threadSet.has(a.thread_id));

  const canonical = JSON.stringify({
    filter,
    purchase_orders: state.purchase_orders,
    invoices,
    payments: state.payments,
    threads: threads.map((t) => ({
      thread_id: t.thread_id,
      invoice_number: t.invoice_number,
      status: t.status,
      variance_amount: t.variance_amount,
      reviewer: t.reviewer,
    })),
    audit_log: auditLog.map((a) => ({
      id: a.id,
      thread_id: a.thread_id,
      step_name: a.step_name,
      decision: a.decision,
      created_at: a.created_at,
    })),
  });
  const digestSha256 = crypto.createHash("sha256").update(canonical).digest("hex");

  return {
    exportedAt,
    filter,
    digestSha256,
    state,
    invoices,
    threads,
    auditLog,
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

export function renderLedgerCsv(snapshot: FilteredLedgerSnapshot): string {
  const lines: string[] = [];

  lines.push(csvRow(["AP RECONCILIATION AI - IMMUTABLE LEDGER & AUDIT EXPORT"]));
  lines.push(csvRow(["Exported At (UTC)", snapshot.exportedAt]));
  lines.push(csvRow(["Scope Filter", snapshot.filter]));
  lines.push(csvRow(["Ledger Snapshot SHA-256", snapshot.digestSha256]));
  lines.push(
    csvRow([
      "Database Guarantees",
      "SQLite WAL Mode | Monotonic Reconciled Status Lock | Append-Only audit_log (UPDATE/DELETE Abort Triggers)",
    ])
  );
  lines.push("");

  // Section 1: Invoices & Reconciliation Outcome
  lines.push(csvRow(["SECTION 1: ACCOUNTS PAYABLE INVOICES"]));
  lines.push(
    csvRow([
      "invoice_number",
      "vendor_name",
      "po_number",
      "invoice_date",
      "etims_cu",
      "currency",
      "subtotal",
      "vat",
      "total",
      "status",
      "document_sha256",
      "latest_thread_id",
      "payment_refs",
      "paid_amount",
      "variance_amount",
      "tax_rule_applied",
      "cited_policy_ids",
      "ai_engine",
      "verified_live",
      "reviewer",
      "review_note",
    ])
  );

  for (const inv of snapshot.invoices) {
    const thread = snapshot.threads.find(
      (t) => t.invoice_number?.toUpperCase() === inv.invoice_number.toUpperCase()
    );
    lines.push(
      csvRow([
        inv.invoice_number,
        inv.vendor_name,
        inv.po_number ?? "",
        inv.invoice_date,
        inv.etims_cu ?? "",
        inv.currency,
        inv.subtotal.toFixed(2),
        inv.vat.toFixed(2),
        inv.total.toFixed(2),
        inv.status,
        inv.sha256,
        thread?.thread_id ?? "",
        thread ? thread.payment_refs.join("; ") : "",
        thread ? thread.paid_amount.toFixed(2) : "",
        thread ? thread.variance_amount.toFixed(2) : "",
        thread?.evaluation.tax_rule_applied ?? "",
        thread ? thread.investigation.cited_policies.map((c) => c.policy_id).join("; ") : "",
        thread ? thread.engine_meta.synthesis_engine || thread.engine_meta.extraction_engine : "",
        thread ? String(Boolean(thread.engine_meta.verified_live)) : "",
        thread?.reviewer ?? "",
        thread?.review_note ?? "",
      ])
    );
  }
  lines.push("");

  // Section 2: Purchase Orders
  lines.push(csvRow(["SECTION 2: PURCHASE ORDERS"]));
  lines.push(csvRow(["po_number", "vendor_name", "kra_pin", "currency", "authorized_amount", "goods_received", "status"]));
  for (const po of snapshot.state.purchase_orders) {
    lines.push(
      csvRow([
        po.po_number,
        po.vendor_name,
        po.kra_pin,
        po.currency,
        po.authorized_amount.toFixed(2),
        po.goods_received === 1 ? "yes" : "no",
        po.status,
      ])
    );
  }
  lines.push("");

  // Section 3: Settled Payments
  lines.push(csvRow(["SECTION 3: BANK & M-PESA PAYMENTS"]));
  lines.push(csvRow(["payment_ref", "vendor_name", "invoice_number", "channel", "currency", "amount", "paid_at", "status"]));
  for (const pay of snapshot.state.payments) {
    lines.push(
      csvRow([
        pay.payment_ref,
        pay.vendor_name,
        pay.invoice_number ?? "",
        pay.channel,
        pay.currency,
        pay.amount.toFixed(2),
        pay.paid_at,
        pay.status,
      ])
    );
  }
  lines.push("");

  // Section 4: Immutable Append-Only Audit Log
  lines.push(csvRow(["SECTION 4: APPEND-ONLY AUDIT LOG"]));
  lines.push(csvRow(["audit_id", "created_at", "thread_id", "step_name", "decision", "summary", "details_json"]));
  for (const entry of snapshot.auditLog) {
    lines.push(
      csvRow([
        entry.id,
        entry.created_at,
        entry.thread_id,
        entry.step_name,
        entry.decision,
        entry.summary,
        JSON.stringify(entry.details),
      ])
    );
  }

  // Prefix UTF-8 BOM for clean Excel opening
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// --- Zero-Dependency Spec-Compliant Multi-Page PDF-1.4 Audit Report Builder ---
function pdfSanitize(text: string): string {
  return text
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/\u00b7/g, "|")
    .replace(/[^\x20-\x7E]/g, " ");
}

function pdfEscape(text: string): string {
  return pdfSanitize(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(text: string, maxChars: number): string[] {
  const clean = pdfSanitize(text).replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const words = clean.split(" ");
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) {
      line = w.length > maxChars ? w.slice(0, maxChars) : w;
    } else if (line.length + 1 + w.length <= maxChars) {
      line += " " + w;
    } else {
      out.push(line);
      line = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (line) out.push(line);
  return out;
}

function fmtNum(val: number, cur: string): string {
  return `${cur} ${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function renderLedgerPdf(snapshot: FilteredLedgerSnapshot): Buffer {
  const PAGE_W = 595.28; // A4 width pt
  const PAGE_H = 841.89; // A4 height pt
  const MARGIN = 40;
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const BOTTOM_Y = 52;

  const pages: string[][] = [];
  let ops: string[] = [];
  let y = PAGE_H - 48;

  const newPage = (continuation = false) => {
    if (ops.length > 0) pages.push(ops);
    ops = [];
    // Header bar on every page
    ops.push("0.06 0.09 0.16 rg");
    ops.push(`0 ${PAGE_H - 34} ${PAGE_W} 34 re f`);
    ops.push("1 1 1 rg");
    ops.push("BT /F2 9.5 Tf 40 " + (PAGE_H - 22).toFixed(2) + " Td (AP RECONCILIATION AI - EXTERNAL AUDIT LEDGER REPORT) Tj ET");
    if (continuation) {
      ops.push("0.75 0.80 0.88 rg");
      ops.push("BT /F1 8 Tf 440 " + (PAGE_H - 22).toFixed(2) + " Td (Continued) Tj ET");
    }
    ops.push("0 0 0 rg");
    y = PAGE_H - 54;
  };

  const ensureSpace = (needed: number) => {
    if (y - needed < BOTTOM_Y) {
      newPage(true);
    }
  };

  const drawText = (x: number, yy: number, text: string, font: "F1" | "F2" | "F3" = "F1", size = 9, rgb = "0.10 0.14 0.22") => {
    ops.push(`${rgb} rg`);
    ops.push(`BT /${font} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${pdfEscape(text)}) Tj ET`);
  };

  const drawRule = (yy: number, rgb = "0.82 0.85 0.90", width = 0.6) => {
    ops.push(`${rgb} RG ${width} w ${MARGIN} ${yy.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${yy.toFixed(2)} l S`);
  };

  const drawSectionHeader = (title: string) => {
    ensureSpace(34);
    y -= 8;
    ops.push("0.93 0.95 0.98 rg");
    ops.push(`${MARGIN} ${(y - 5).toFixed(2)} ${CONTENT_W} 19 re f`);
    drawText(MARGIN + 6, y + 1, title, "F2", 10, "0.08 0.14 0.28");
    y -= 20;
  };

  // Start Page 1
  newPage(false);

  // Title & Integrity Metadata Block
  drawText(MARGIN, y, "Immutable Accounts Payable Ledger & Audit Export", "F2", 15, "0.06 0.10 0.18");
  y -= 16;
  drawText(MARGIN, y, `Generated (UTC): ${snapshot.exportedAt}   |   Scope Filter: ${snapshot.filter.toUpperCase()}`, "F1", 8.5, "0.32 0.38 0.48");
  y -= 13;
  drawText(MARGIN, y, `Integrity Seal (SHA-256): ${snapshot.digestSha256}`, "F3", 7.8, "0.10 0.28 0.52");
  y -= 12;
  drawText(
    MARGIN,
    y,
    "Storage Guarantees: SQLite WAL Mode | Monotonic Reconciled Lock | Append-Only audit_log (UPDATE/DELETE Abort Triggers)",
    "F1",
    7.8,
    "0.32 0.38 0.48"
  );
  y -= 10;
  drawRule(y, "0.70 0.76 0.85", 0.8);
  y -= 14;

  // KPI Strip
  const tel = snapshot.state.telemetry;
  drawText(
    MARGIN,
    y,
    `Runs: ${tel.total_runs}   |   Cleared: ${tel.auto_cleared_count}   |   Pending: ${tel.pending_count}   |   Blocked/Rejected: ${tel.blocked_or_rejected_count}   |   Policies Indexed: ${tel.dense_vector_count}/${tel.policy_count}`,
    "F2",
    8.8,
    "0.12 0.18 0.28"
  );
  y -= 16;

  // Section 1: Invoices
  drawSectionHeader(`1. ACCOUNTS PAYABLE INVOICES (${snapshot.invoices.length})`);
  drawText(MARGIN, y, "INV NO.", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 64, y, "SUPPLIER", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 206, y, "PO REF", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 262, y, "eTIMS CU", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 362, y, "TOTAL", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 455, y, "STATUS", "F2", 8, "0.35 0.40 0.48");
  y -= 6;
  drawRule(y);
  y -= 12;

  for (const inv of snapshot.invoices) {
    ensureSpace(16);
    drawText(MARGIN, y, inv.invoice_number, "F3", 8);
    drawText(MARGIN + 64, y, inv.vendor_name.slice(0, 26), "F1", 8);
    drawText(MARGIN + 206, y, inv.po_number || "-", "F3", 8);
    drawText(MARGIN + 262, y, (inv.etims_cu || "Missing").slice(0, 18), "F3", 7.8);
    drawText(MARGIN + 362, y, fmtNum(inv.total, inv.currency), "F3", 8);
    drawText(
      MARGIN + 455,
      y,
      inv.status.toUpperCase(),
      "F2",
      7.8,
      inv.status === "reconciled" ? "0.06 0.45 0.25" : inv.status === "rejected" ? "0.68 0.12 0.16" : "0.60 0.38 0.04"
    );
    y -= 14;
  }

  // Section 2: Purchase Orders
  drawSectionHeader(`2. PURCHASE ORDERS (${snapshot.state.purchase_orders.length})`);
  drawText(MARGIN, y, "PO NO.", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 64, y, "SUPPLIER", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 230, y, "KRA PIN", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 320, y, "GRN", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 362, y, "AUTHORIZED", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 465, y, "STATUS", "F2", 8, "0.35 0.40 0.48");
  y -= 6;
  drawRule(y);
  y -= 12;

  for (const po of snapshot.state.purchase_orders) {
    ensureSpace(16);
    drawText(MARGIN, y, po.po_number, "F3", 8);
    drawText(MARGIN + 64, y, po.vendor_name.slice(0, 28), "F1", 8);
    drawText(MARGIN + 230, y, po.kra_pin, "F3", 8);
    drawText(MARGIN + 320, y, po.goods_received === 1 ? "YES" : "NO", "F1", 8);
    drawText(MARGIN + 362, y, fmtNum(po.authorized_amount, po.currency), "F3", 8);
    drawText(MARGIN + 465, y, po.status.toUpperCase(), "F1", 8);
    y -= 14;
  }

  // Section 3: Bank & M-Pesa Payments
  drawSectionHeader(`3. SETTLED PAYMENTS (${snapshot.state.payments.length})`);
  drawText(MARGIN, y, "PAYMENT REF", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 100, y, "SUPPLIER", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 230, y, "INVOICE", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 296, y, "CHANNEL", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 362, y, "AMOUNT", "F2", 8, "0.35 0.40 0.48");
  drawText(MARGIN + 455, y, "STATUS", "F2", 8, "0.35 0.40 0.48");
  y -= 6;
  drawRule(y);
  y -= 12;

  for (const pay of snapshot.state.payments) {
    ensureSpace(16);
    drawText(MARGIN, y, pay.payment_ref, "F3", 8);
    drawText(MARGIN + 100, y, pay.vendor_name.slice(0, 22), "F1", 8);
    drawText(MARGIN + 230, y, pay.invoice_number || "Unlinked", "F3", 8);
    drawText(MARGIN + 296, y, pay.channel, "F1", 8);
    drawText(MARGIN + 362, y, fmtNum(pay.amount, pay.currency), "F3", 8);
    drawText(MARGIN + 455, y, pay.status.toUpperCase(), "F2", 7.8);
    y -= 14;
  }

  // Section 4: Reconciliation Threads & Cited Policies
  drawSectionHeader(`4. AI INVESTIGATIONS & REVIEW DECISIONS (${snapshot.threads.length})`);
  for (const t of snapshot.threads) {
    const cited = t.investigation.cited_policies.map((c) => c.policy_id).join(", ") || "None";
    const engineLabel = t.engine_meta.synthesis_engine || t.engine_meta.extraction_engine;
    const liveLabel = t.engine_meta.verified_live ? "LIVE API VERIFIED" : "SEEDED SNAPSHOT";
    const summaryLines = wrapText(
      `Root Cause: ${t.investigation.root_cause} | Cited: ${cited} | Reviewer: ${t.reviewer || "Pending"}`,
      96
    );
    ensureSpace(22 + summaryLines.length * 11);
    drawText(
      MARGIN,
      y,
      `${t.invoice_number || t.thread_id} (${t.status.toUpperCase()}) - Variance: ${fmtNum(t.variance_amount, t.currency)} | Engine: ${engineLabel} [${liveLabel}]`,
      "F2",
      8.3
    );
    y -= 11;
    for (const line of summaryLines) {
      drawText(MARGIN + 8, y, line, "F1", 7.8, "0.28 0.34 0.44");
      y -= 10.5;
    }
    y -= 4;
  }

  // Section 5: Append-Only Audit Log
  drawSectionHeader(`5. APPEND-ONLY AUDIT LOG (${snapshot.auditLog.length})`);
  for (const a of snapshot.auditLog) {
    const wrapped = wrapText(`[#${a.id}] ${a.created_at} | ${a.step_name} (${a.decision}) | ${a.thread_id} - ${a.summary}`, 100);
    ensureSpace(wrapped.length * 10.5 + 4);
    for (const line of wrapped) {
      drawText(MARGIN, y, line, "F3", 7.5, "0.18 0.22 0.30");
      y -= 10.5;
    }
    y -= 2;
  }

  if (ops.length > 0) pages.push(ops);

  // Add page footer with Page X of Y + truncated digest on every page
  const totalPages = pages.length;
  for (let i = 0; i < totalPages; i++) {
    const pOps = pages[i];
    pOps.push("0.82 0.85 0.90 RG 0.5 w 40 36 m 555.28 36 l S");
    pOps.push("0.40 0.45 0.55 rg");
    pOps.push(
      `BT /F1 7.5 Tf 40 24 Td (${pdfEscape(`AP Reconciliation AI | SHA-256: ${snapshot.digestSha256.slice(0, 24)}...`)}) Tj ET`
    );
    pOps.push(`BT /F1 7.5 Tf 490 24 Td (${pdfEscape(`Page ${i + 1} of ${totalPages}`)}) Tj ET`);
  }

  // Assemble PDF objects
  // 1: Catalog, 2: Pages, 3: F1 Helvetica, 4: F2 Helvetica-Bold, 5: F3 Courier
  // Then for each page i: (6 + i*2) Page object, (7 + i*2) Content stream object
  const objects: string[] = [];
  const pageObjNums: number[] = [];
  for (let i = 0; i < totalPages; i++) {
    pageObjNums.push(6 + i * 2);
  }

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${totalPages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  objects[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";

  for (let i = 0; i < totalPages; i++) {
    const pageNum = 6 + i * 2;
    const streamNum = pageNum + 1;
    const streamBody = pages[i].join("\n");
    const streamLen = Buffer.byteLength(streamBody, "latin1");
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${streamNum} 0 R >>`;
    objects[streamNum] = `<< /Length ${streamLen} >>\nstream\n${streamBody}\nendstream`;
  }

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf, "latin1");
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < objects.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}
