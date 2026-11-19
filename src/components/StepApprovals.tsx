import { useState } from "react";
import { Check, Loader2, Pause, X } from "lucide-react";
import type { ReconciliationThread } from "../types";
import { formatMoney, formatTimestamp, statusDisplay } from "./Formatters";

interface StepApprovalsProps {
  threads: ReconciliationThread[];
  onSubmitDecision: (
    threadId: string,
    payload: { action: "approve" | "hold" | "reject"; reviewer: string; note: string }
  ) => Promise<boolean>;
  busy: boolean;
  error: string | null;
}

export function StepApprovals({
  threads,
  onSubmitDecision,
  busy,
  error,
}: StepApprovalsProps) {
  const queue = threads.filter(
    (t) => t.status === "pending_approval" || t.status === "held"
  );
  const [selectedId, setSelectedId] = useState<string | null>(queue[0]?.thread_id ?? null);
  const [reviewer, setReviewer] = useState("Grace Wanjiku (AP Lead)");
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);

  const active = queue.find((t) => t.thread_id === selectedId) ?? queue[0] ?? null;

  async function handleAction(action: "approve" | "hold" | "reject") {
    if (!active) return;
    setFeedback(null);
    const ok = await onSubmitDecision(active.thread_id, {
      action,
      reviewer,
      note: note.trim() || `Confirmed ${action} after reviewing variance evidence.`,
    });
    if (ok) {
      setNote("");
      setFeedback(`Updated ${active.invoice_number || active.thread_id} (${action}).`);
    }
  }

  return (
    <div className="space-y-8">
      <div className="max-w-2xl space-y-1.5">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
          Step 3. Human Approval Queue
        </h1>
        <p className="text-sm leading-relaxed text-slate-400">
          Exceptions pause here with full evidence. Reviewers verify Kenyan WHVAT/WHT certificates, fuzzy vendor matches, or high-value payments before the ledger is updated.
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
        >
          {error}
        </div>
      )}

      {feedback && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-200">
          {feedback}
        </div>
      )}

      {queue.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-10 text-center space-y-2">
          <h2 className="font-display text-base font-semibold text-slate-100">
            Approval queue is clear
          </h2>
          <p className="text-sm text-slate-400">
            All pending exceptions have been reviewed. Run a new invoice or remittance note in Step 1 to generate another item.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Queue List */}
          <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111A2E] overflow-hidden self-start">
            <div className="border-b border-slate-800 px-4 py-3 text-xs font-medium text-slate-400">
              Awaiting Reviewer Decision ({queue.length})
            </div>
            <div className="divide-y divide-slate-800">
              {queue.map((item) => {
                const st = statusDisplay(item.status);
                const isSelected = item.thread_id === active?.thread_id;
                return (
                  <button
                    key={item.thread_id}
                    type="button"
                    onClick={() => setSelectedId(item.thread_id)}
                    className={`w-full px-4 py-4 text-left transition-colors cursor-pointer ${
                      isSelected ? "bg-slate-800/70" : "hover:bg-slate-800/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-100">
                        {item.invoice_number || "Unmatched"}
                      </span>
                      <span className={`text-xs font-medium ${st.textClass}`}>
                        {st.label}
                      </span>
                    </div>
                    <div className="mt-1 text-sm font-medium text-slate-200">
                      {item.vendor_name || "Unknown vendor"}
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-xs text-slate-400 tabular-nums">
                      <span>
                        Invoice {formatMoney(item.invoice_amount, item.currency)} · Paid{" "}
                        {formatMoney(item.paid_amount, item.currency)}
                      </span>
                      <span>{formatTimestamp(item.created_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Active Decision Form */}
          {active && (
            <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-6">
              <div className="border-b border-slate-800 pb-4 space-y-1">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="font-mono">{active.thread_id}</span>
                  <span aria-hidden="true">·</span>
                  <span>{active.po_number || "No PO"}</span>
                  <span aria-hidden="true">·</span>
                  <span>{active.payment_refs.join(", ") || "No payment ref"}</span>
                </div>
                <h2 className="font-display text-lg font-semibold text-slate-100">
                  {active.invoice_number || "Unidentified"} — {active.vendor_name || "Unknown"}
                </h2>
              </div>

              <div className="grid grid-cols-3 gap-4 rounded-lg border border-slate-800 bg-[#0B1120] p-4 text-sm tabular-nums">
                <div>
                  <div className="text-xs text-slate-400">Invoice Total</div>
                  <div className="font-mono font-semibold text-slate-100 mt-0.5">
                    {formatMoney(active.invoice_amount, active.currency)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-400">Settled Payment</div>
                  <div className="font-mono font-semibold text-slate-100 mt-0.5">
                    {formatMoney(active.paid_amount, active.currency)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-400">Difference</div>
                  <div className="font-mono font-semibold text-amber-300 mt-0.5">
                    {formatMoney(active.variance_amount, active.currency)} ({active.variance_pct}%)
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-medium text-slate-400">Why This Needs Human Sign-Off</h3>
                <ul className="space-y-1.5 text-sm text-slate-300">
                  {active.evaluation.reasons.map((r, i) => (
                    <li key={i}>• {r}</li>
                  ))}
                </ul>
              </div>

              <div className="border-t border-slate-800 pt-5 space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="reviewer-name" className="block text-xs font-medium text-slate-400 mb-1.5">
                      Reviewer Name
                    </label>
                    <input
                      id="reviewer-name"
                      type="text"
                      value={reviewer}
                      onChange={(e) => setReviewer(e.target.value)}
                      className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-3 py-2 text-sm text-slate-100 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label htmlFor="review-note" className="block text-xs font-medium text-slate-400 mb-1.5">
                      Audit Note (optional)
                    </label>
                    <input
                      id="review-note"
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Verified KRA WHT cert #4482"
                      className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    type="button"
                    disabled={busy || !reviewer.trim()}
                    onClick={() => handleAction("approve")}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    Approve and Clear
                  </button>
                  <button
                    type="button"
                    disabled={busy || !reviewer.trim()}
                    onClick={() => handleAction("hold")}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#0B1120] px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Pause className="h-4 w-4" />
                    Keep on Hold
                  </button>
                  <button
                    type="button"
                    disabled={busy || !reviewer.trim()}
                    onClick={() => handleAction("reject")}
                    className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/30 px-4 py-2.5 text-sm font-medium text-rose-200 hover:bg-rose-950/60 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <X className="h-4 w-4" />
                    Reject
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
