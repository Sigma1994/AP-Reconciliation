import { ArrowRight, CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import type { ReconciliationThread } from "../types";
import { formatMoney, formatTimestamp, statusDisplay } from "./Formatters";

interface StepPolicyProps {
  threads: ReconciliationThread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onGoToApprovals: () => void;
}

function taxRuleLabel(rule: ReconciliationThread["evaluation"]["tax_rule_applied"]): string {
  switch (rule) {
    case "whvat_2pct":
      return "2% Withholding VAT (WHVAT)";
    case "wht_5pct":
      return "5% Resident Withholding Tax (WHT)";
    case "none":
      return "Standard (no WHT deduction matched)";
  }
}

export function StepPolicy({
  threads,
  selectedThreadId,
  onSelectThread,
  onGoToApprovals,
}: StepPolicyProps) {
  const active = threads.find((t) => t.thread_id === selectedThreadId) ?? threads[0] ?? null;

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Step 2. Match and Tax Policy
        </h1>
        <p className="text-sm leading-relaxed text-slate-400">
          Every reconciliation run passes through deterministic checks before touching the ledger. Select any run below to inspect its 3-way match, Kenyan tax deduction check, and policy decision.
        </p>
      </div>

      {!active ? (
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-8 text-center text-sm text-slate-400">
          No reconciliation runs yet. Start in Step 1 to parse a payment note or supplier invoice.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left run selector */}
          <div className="lg:col-span-4 rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden self-start">
            <div className="border-b border-slate-800 px-4 py-3 text-xs font-medium text-slate-400">
              Recent Reconciliation Runs ({threads.length})
            </div>
            <div className="divide-y divide-slate-800">
              {threads.map((t) => {
                const st = statusDisplay(t.status);
                const isSelected = t.thread_id === active.thread_id;
                return (
                  <button
                    key={t.thread_id}
                    type="button"
                    onClick={() => onSelectThread(t.thread_id)}
                    className={`w-full px-4 py-3.5 text-left transition-colors cursor-pointer ${
                      isSelected ? "bg-slate-800/70" : "hover:bg-slate-800/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-100">
                        {t.invoice_number || "Unmatched"}
                      </span>
                      <span className={`text-xs font-medium ${st.textClass}`}>
                        {st.label}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-slate-400">
                      {t.vendor_name || t.raw_summary}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-slate-500 tabular-nums">
                      <span>{formatMoney(t.invoice_amount, t.currency)}</span>
                      <span>{formatTimestamp(t.created_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right deterministic evidence panel */}
          <div className="lg:col-span-8 rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-6">
            <div className="flex flex-col gap-3 border-b border-slate-800 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="font-mono">{active.thread_id}</span>
                  <span aria-hidden="true">·</span>
                  <span>{active.po_number || "No PO"}</span>
                  <span aria-hidden="true">·</span>
                  <span className={statusDisplay(active.status).textClass + " font-medium"}>
                    {statusDisplay(active.status).label}
                  </span>
                </div>
                <h2 className="mt-1 font-display text-lg font-semibold text-slate-100">
                  {active.invoice_number || "Unidentified"} — {active.vendor_name || "Unknown Vendor"}
                </h2>
              </div>

              {active.status === "pending_approval" && (
                <button
                  type="button"
                  onClick={onGoToApprovals}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Review in Approval Queue
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* 4 Deterministic Rule Checks */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400">1. Document & Arithmetic</span>
                  {active.evaluation.arithmetic_ok && active.evaluation.etims_valid ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <XCircle className="h-4 w-4 text-rose-400" />
                  )}
                </div>
                <div className="text-sm text-slate-200 tabular-nums">
                  Subtotal + VAT check:{" "}
                  <strong className="font-medium">
                    {active.evaluation.arithmetic_ok ? "Passed" : "Failed"}
                  </strong>
                </div>
                <div className="text-xs text-slate-400">
                  KRA eTIMS CU: {active.evaluation.etims_valid ? "Valid format" : "Missing or invalid"}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400">2. Fuzzy Vendor & PO Match</span>
                  {active.evaluation.vendor_match_score >= 82 && active.evaluation.po_found ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-amber-400" />
                  )}
                </div>
                <div className="text-sm text-slate-200 tabular-nums">
                  Similarity score:{" "}
                  <strong className="font-medium">
                    {active.evaluation.vendor_match_score}% ({active.evaluation.vendor_match_label})
                  </strong>
                </div>
                <div className="text-xs text-slate-400">
                  Purchase Order: {active.evaluation.po_found ? active.po_number : "Not found in ledger"}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400">3. Payment & Kenyan Tax Rule</span>
                  {active.evaluation.tax_rule_applied !== "none" ? (
                    <ShieldAlert className="h-4 w-4 text-amber-400" />
                  ) : active.evaluation.variance_pct <= 1.5 && active.evaluation.payment_count > 0 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-amber-400" />
                  )}
                </div>
                <div className="text-sm text-slate-200 tabular-nums">
                  Variance:{" "}
                  <strong className="font-medium">
                    {formatMoney(active.variance_amount, active.currency)} ({active.variance_pct}%)
                  </strong>
                </div>
                <div className="text-xs text-slate-400">
                  Tax rule: {taxRuleLabel(active.evaluation.tax_rule_applied)}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400">4. High-Value & Payment Refs</span>
                  {active.evaluation.high_value_flag ? (
                    <ShieldAlert className="h-4 w-4 text-amber-400" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  )}
                </div>
                <div className="text-sm text-slate-200 tabular-nums">
                  {active.evaluation.high_value_flag
                    ? "Supervisor sign-off required"
                    : "Within standard value threshold"}
                </div>
                <div className="font-mono text-xs text-slate-400 truncate">
                  Payments: {active.payment_refs.length ? active.payment_refs.join(", ") : "None matched"}
                </div>
              </div>
            </div>

            <div className="border-t border-slate-800 pt-4 space-y-2">
              <h3 className="text-xs font-medium text-slate-400">Policy Reasons</h3>
              <ul className="space-y-1.5 text-sm text-slate-300">
                {active.evaluation.reasons.map((reason, i) => (
                  <li key={i}>• {reason}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
