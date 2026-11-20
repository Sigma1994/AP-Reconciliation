import { useState } from "react";
import { ChevronDown, ChevronRight, Download, FileText, Loader2, RotateCcw, Search, X } from "lucide-react";
import type { WorkbenchState } from "../types";
import { formatMoney, formatTimestamp, statusDisplay } from "./Formatters";

interface StepLedgerProps {
  state: WorkbenchState;
}

export function StepLedger({ state }: StepLedgerProps) {
  const [filter, setFilter] = useState<"all" | "reconciled" | "open">("all");
  const [vendorQuery, setVendorQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [expandedAuditId, setExpandedAuditId] = useState<number | null>(null);
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const parsedMin = minAmount.trim() !== "" ? Number(minAmount) : null;
  const parsedMax = maxAmount.trim() !== "" ? Number(maxAmount) : null;
  const vendorNeedle = vendorQuery.trim().toLowerCase();

  const hasDetailFilters = Boolean(
    vendorNeedle ||
      dateFrom ||
      dateTo ||
      (parsedMin !== null && Number.isFinite(parsedMin)) ||
      (parsedMax !== null && Number.isFinite(parsedMax))
  );
  const hasAnyFilter = filter !== "all" || hasDetailFilters;

  const filteredInvoices = state.invoices.filter((inv) => {
    if (filter === "reconciled" && inv.status !== "reconciled") return false;
    if (filter === "open" && inv.status === "reconciled") return false;
    if (vendorNeedle) {
      const hay = `${inv.vendor_name} ${inv.invoice_number} ${inv.po_number || ""} ${inv.etims_cu || ""}`.toLowerCase();
      if (!hay.includes(vendorNeedle)) return false;
    }
    if (dateFrom && inv.invoice_date < dateFrom) return false;
    if (dateTo && inv.invoice_date > dateTo) return false;
    if (parsedMin !== null && Number.isFinite(parsedMin) && inv.total < parsedMin) return false;
    if (parsedMax !== null && Number.isFinite(parsedMax) && inv.total > parsedMax) return false;
    return true;
  });

  function resetFilters() {
    setFilter("all");
    setVendorQuery("");
    setDateFrom("");
    setDateTo("");
    setMinAmount("");
    setMaxAmount("");
  }

  async function handleExport(format: "csv" | "pdf") {
    setExporting(format);
    setExportError(null);
    setExportNotice(null);
    try {
      const qs = new URLSearchParams({ format, filter });
      if (vendorQuery.trim()) qs.set("vendor", vendorQuery.trim());
      if (dateFrom) qs.set("dateFrom", dateFrom);
      if (dateTo) qs.set("dateTo", dateTo);
      if (minAmount.trim() !== "" && parsedMin !== null && Number.isFinite(parsedMin)) {
        qs.set("minAmount", minAmount.trim());
      }
      if (maxAmount.trim() !== "" && parsedMax !== null && Number.isFinite(parsedMax)) {
        qs.set("maxAmount", maxAmount.trim());
      }

      const res = await fetch(`/api/ledger/export?${qs.toString()}`);
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Export failed (${res.status})`);
      }
      const digest = res.headers.get("X-Ledger-Sha256") || "";
      const disposition = res.headers.get("Content-Disposition") || "";
      const nameMatch = /filename="([^"]+)"/.exec(disposition);
      const fileName =
        nameMatch?.[1] || `ap-ledger-${hasDetailFilters ? "filtered" : filter}-${new Date().toISOString().slice(0, 10)}.${format}`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setExportNotice(
        `Downloaded ${fileName}${digest ? ` · Snapshot SHA-256: ${digest.slice(0, 16)}...` : ""}`
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Could not export ledger.");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl space-y-1.5">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
            SQLite Ledger and Append-Only Audit Trail
          </h1>
          <p className="text-sm leading-relaxed text-slate-400">
            Live operational ledger in <code className="text-slate-300">data/workbench.db</code> (WAL mode). Cleared invoices are locked monotonically, and <code className="text-slate-300">audit_log</code> is protected by SQLite update/delete abort triggers.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start">
          <button
            type="button"
            disabled={exporting !== null}
            onClick={() => handleExport("csv")}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#111A2E] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {exporting === "csv" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            Export CSV ({hasDetailFilters ? "Filtered" : filter === "all" ? "Full Ledger" : filter === "reconciled" ? "Cleared" : "Open / Held"})
          </button>
          <button
            type="button"
            disabled={exporting !== null}
            onClick={() => handleExport("pdf")}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {exporting === "pdf" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileText className="h-3.5 w-3.5" />
            )}
            Export Audit PDF
          </button>
        </div>
      </div>

      {exportError && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {exportError}
        </div>
      )}
      {exportNotice && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-4 py-2.5 text-xs font-mono text-emerald-200">
          {exportNotice}
        </div>
      )}

      {/* Telemetry Summary Strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-6">
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Pipeline Runs</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-100 tabular-nums">
            {state.telemetry.total_runs}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Cleared</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-emerald-400 tabular-nums">
            {state.telemetry.auto_cleared_count}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Pending Review</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-amber-400 tabular-nums">
            {state.telemetry.pending_count}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Policies</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-100 tabular-nums">
            {state.telemetry.policy_count}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Dense Vectors</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-blue-400 tabular-nums">
            {state.telemetry.dense_vector_count}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Avg Latency</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-100 tabular-nums">
            {state.telemetry.avg_latency_ms} ms
          </div>
        </div>
      </div>

      {/* Invoice Ledger Table */}
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-800 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Accounts Payable Invoices
            </h2>
            <span className="text-xs font-mono text-slate-400 tabular-nums">
              Showing {filteredInvoices.length} of {state.invoices.length}
            </span>
          </div>
          <div className="inline-flex rounded-lg border border-slate-800 bg-[#0B1120] p-1 self-start">
            {(["all", "reconciled", "open"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setFilter(tab)}
                className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filter === tab
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {tab === "all" ? "All" : tab === "reconciled" ? "Cleared" : "Open / Held"}
              </button>
            ))}
          </div>
        </div>

        {/* Search & Filter Bar */}
        <div className="border-b border-slate-800 bg-[#0B1120]/60 px-5 py-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-4">
              <label htmlFor="ledger-vendor-search" className="block text-[11px] font-medium text-slate-400 mb-1">
                Vendor Name or Reference
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  id="ledger-vendor-search"
                  type="text"
                  value={vendorQuery}
                  onChange={(e) => setVendorQuery(e.target.value)}
                  placeholder="Search vendor, invoice #, PO, or eTIMS..."
                  className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] py-1.5 pl-8 pr-8 text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                />
                {vendorQuery && (
                  <button
                    type="button"
                    aria-label="Clear vendor search"
                    onClick={() => setVendorQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:text-slate-200 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <div className="lg:col-span-2">
              <label htmlFor="ledger-date-from" className="block text-[11px] font-medium text-slate-400 mb-1">
                Date From
              </label>
              <input
                id="ledger-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:border-blue-500 focus:outline-none [color-scheme:dark]"
              />
            </div>

            <div className="lg:col-span-2">
              <label htmlFor="ledger-date-to" className="block text-[11px] font-medium text-slate-400 mb-1">
                Date To
              </label>
              <input
                id="ledger-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:border-blue-500 focus:outline-none [color-scheme:dark]"
              />
            </div>

            <div className="lg:col-span-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="ledger-min-amount" className="block text-[11px] font-medium text-slate-400 mb-1">
                    Min Amount
                  </label>
                  <input
                    id="ledger-min-amount"
                    type="number"
                    min="0"
                    step="any"
                    value={minAmount}
                    onChange={(e) => setMinAmount(e.target.value)}
                    placeholder="0"
                    className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="ledger-max-amount" className="block text-[11px] font-medium text-slate-400 mb-1">
                    Max Amount
                  </label>
                  <input
                    id="ledger-max-amount"
                    type="number"
                    min="0"
                    step="any"
                    value={maxAmount}
                    onChange={(e) => setMaxAmount(e.target.value)}
                    placeholder="Any"
                    className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-2.5 py-1.5 text-xs font-mono text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none tabular-nums"
                  />
                </div>
              </div>
            </div>

            <div className="lg:col-span-1 flex lg:justify-end">
              <button
                type="button"
                disabled={!hasAnyFilter}
                onClick={resetFilters}
                className="inline-flex w-full lg:w-auto items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-[#111A2E] px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap cursor-pointer"
                title="Reset all filters"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-800 bg-[#0B1120] text-xs font-medium text-slate-400">
              <tr>
                <th className="px-5 py-3">Invoice</th>
                <th className="px-5 py-3">Vendor</th>
                <th className="px-5 py-3">Invoice Date</th>
                <th className="px-5 py-3">PO Ref</th>
                <th className="px-5 py-3">eTIMS CU</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 tabular-nums">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-8 text-center text-sm text-slate-400">
                    <div>No invoices match the active search or filter criteria.</div>
                    {hasAnyFilter && (
                      <button
                        type="button"
                        onClick={resetFilters}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-[#0B1120] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => {
                  const st = statusDisplay(inv.status);
                  return (
                    <tr key={inv.invoice_number} className="hover:bg-slate-800/30">
                      <td className="px-5 py-3 font-mono text-xs font-semibold text-slate-100">
                        {inv.invoice_number}
                      </td>
                      <td className="px-5 py-3 text-slate-200">{inv.vendor_name}</td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-400">
                        {inv.invoice_date}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-400">
                        {inv.po_number || "—"}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-slate-400">
                        {inv.etims_cu || "Missing"}
                      </td>
                      <td className="px-5 py-3 text-right font-mono text-slate-100">
                        {formatMoney(inv.total, inv.currency)}
                      </td>
                      <td className={`px-5 py-3 text-right text-xs font-medium ${st.textClass}`}>
                        {st.label}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Purchase Orders & Settled Payments Reference */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden">
          <div className="border-b border-slate-800 px-5 py-3.5">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Purchase Orders ({state.purchase_orders.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-[#0B1120] text-slate-400">
                <tr>
                  <th className="px-4 py-2.5">PO</th>
                  <th className="px-4 py-2.5">Supplier</th>
                  <th className="px-4 py-2.5 text-right">Authorized</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 tabular-nums">
                {state.purchase_orders.map((po) => (
                  <tr key={po.po_number}>
                    <td className="px-4 py-2.5 font-mono font-semibold text-slate-200">{po.po_number}</td>
                    <td className="px-4 py-2.5 text-slate-300">{po.vendor_name}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200">
                      {formatMoney(po.authorized_amount, po.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden">
          <div className="border-b border-slate-800 px-5 py-3.5">
            <h2 className="font-display text-sm font-semibold text-slate-100">
              Bank & M-Pesa Payments ({state.payments.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-[#0B1120] text-slate-400">
                <tr>
                  <th className="px-4 py-2.5">Payment Ref</th>
                  <th className="px-4 py-2.5">Invoice</th>
                  <th className="px-4 py-2.5 text-right">Amount</th>
                  <th className="px-4 py-2.5 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 tabular-nums">
                {state.payments.map((pay) => {
                  const st = statusDisplay(pay.status);
                  return (
                    <tr key={pay.payment_ref}>
                      <td className="px-4 py-2.5 font-mono font-semibold text-slate-200">{pay.payment_ref}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-400">{pay.invoice_number || "Unallocated"}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-200">
                        {formatMoney(pay.amount, pay.currency)}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-medium ${st.textClass}`}>{st.label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Immutable Append-Only Audit Log */}
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Append-Only Audit Log
          </h2>
        </div>

        <div className="divide-y divide-slate-800">
          {state.audit_log.map((entry) => {
            const isOpen = expandedAuditId === entry.id;
            return (
              <div key={entry.id} className="px-5 py-3.5">
                <button
                  type="button"
                  onClick={() => setExpandedAuditId(isOpen ? null : entry.id)}
                  className="flex w-full items-start justify-between gap-4 text-left cursor-pointer"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="font-mono text-slate-300">{entry.step_name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{entry.thread_id}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{formatTimestamp(entry.created_at)}</span>
                    </div>
                    <div className="text-sm text-slate-200">{entry.summary}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-400 shrink-0 pt-0.5">
                    <span>JSON</span>
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </div>
                </button>
                {isOpen && (
                  <pre className="mt-3 rounded-lg border border-slate-800 bg-[#0B1120] p-3 text-xs text-slate-300 overflow-x-auto">
                    {JSON.stringify(entry.details, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
