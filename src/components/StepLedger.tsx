import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { WorkbenchState } from "../types";
import { formatMoney, formatTimestamp, statusDisplay } from "./Formatters";

interface StepLedgerProps {
  state: WorkbenchState;
}

export function StepLedger({ state }: StepLedgerProps) {
  const [filter, setFilter] = useState<"all" | "reconciled" | "open">("all");
  const [expandedAuditId, setExpandedAuditId] = useState<number | null>(null);

  const filteredInvoices = state.invoices.filter((inv) => {
    if (filter === "all") return true;
    if (filter === "reconciled") return inv.status === "reconciled";
    return inv.status !== "reconciled";
  });

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Step 4. Ledger and Audit Trail
        </h1>
        <p className="text-sm leading-relaxed text-slate-400">
          Every cleared invoice, open balance, and append-only audit decision is recorded here. Reconciled invoices are locked against duplicate posting.
        </p>
      </div>

      {/* Telemetry Summary Strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Total Runs</div>
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
          <div className="text-xs text-slate-400">Human Overrides</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-100 tabular-nums">
            {state.telemetry.human_override_count}
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-4">
          <div className="text-xs text-slate-400">Avg Extraction</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-slate-100 tabular-nums">
            {state.telemetry.avg_latency_ms} ms
          </div>
        </div>
      </div>

      {/* Invoice Ledger Table */}
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-800 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Accounts Payable Invoices
          </h2>
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

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-800 bg-[#0B1120] text-xs font-medium text-slate-400">
              <tr>
                <th className="px-5 py-3">Invoice</th>
                <th className="px-5 py-3">Vendor</th>
                <th className="px-5 py-3">PO Ref</th>
                <th className="px-5 py-3">eTIMS CU</th>
                <th className="px-5 py-3 text-right">Total</th>
                <th className="px-5 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 tabular-nums">
              {filteredInvoices.map((inv) => {
                const st = statusDisplay(inv.status);
                return (
                  <tr key={inv.invoice_number} className="hover:bg-slate-800/30">
                    <td className="px-5 py-3 font-mono text-xs font-semibold text-slate-100">
                      {inv.invoice_number}
                    </td>
                    <td className="px-5 py-3 text-slate-200">{inv.vendor_name}</td>
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
              })}
            </tbody>
          </table>
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
