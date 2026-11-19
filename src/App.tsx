import { useCallback, useEffect, useState } from "react";
import {
  BookOpenCheck,
  FileSearch,
  RotateCcw,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import type {
  ExtractedInvoiceFields,
  ReconciliationThread,
  WorkbenchState,
} from "./types";
import { StepIntake } from "./components/StepIntake";
import { StepPolicy } from "./components/StepPolicy";
import { StepApprovals } from "./components/StepApprovals";
import { StepLedger } from "./components/StepLedger";

type StepKey = "intake" | "policy" | "approvals" | "ledger";

const NAV_STEPS: {
  key: StepKey;
  label: string;
  shortTitle: string;
  icon: typeof FileSearch;
}[] = [
  {
    key: "intake",
    label: "1. Intake & Extract",
    shortTitle: "Step 1: Intake & Extract",
    icon: FileSearch,
  },
  {
    key: "policy",
    label: "2. Match & Policy",
    shortTitle: "Step 2: Match & Tax Policy",
    icon: ShieldCheck,
  },
  {
    key: "approvals",
    label: "3. Approval Queue",
    shortTitle: "Step 3: Human Approval Queue",
    icon: UserCheck,
  },
  {
    key: "ledger",
    label: "4. Ledger & Audit",
    shortTitle: "Step 4: Ledger & Audit Trail",
    icon: BookOpenCheck,
  },
];

export default function App() {
  const [step, setStep] = useState<StepKey>("intake");
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWorkbench = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/workbench");
      if (!res.ok) throw new Error(`Failed to load workbench (${res.status})`);
      const data = (await res.json()) as WorkbenchState;
      setState(data);
      setSelectedThreadId((prev) => prev ?? data.threads[0]?.thread_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkbench();
  }, [loadWorkbench]);

  async function handleReset() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workbench/reset", { method: "POST" });
      if (!res.ok) throw new Error("Failed to reset demo data.");
      const data = (await res.json()) as WorkbenchState;
      setState(data);
      setSelectedThreadId(data.threads[0]?.thread_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleReconcileText(rawInput: string): Promise<ReconciliationThread | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reconciliation request failed.");
      setState(data.state);
      setSelectedThreadId(data.thread.thread_id);
      return data.thread as ReconciliationThread;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reconciliation failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleExtractInvoice(payload: {
    base64Data?: string;
    mimeType?: string;
    documentText?: string;
    fileName?: string;
  }): Promise<{ extracted: ExtractedInvoiceFields; thread: ReconciliationThread } | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/extract-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Document extraction failed.");
      setState(data.state);
      setSelectedThreadId(data.thread.thread_id);
      return {
        extracted: data.extracted as ExtractedInvoiceFields,
        thread: data.thread as ReconciliationThread,
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Document extraction failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleDecision(
    threadId: string,
    payload: { action: "approve" | "hold" | "reject"; reviewer: string; note: string }
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not record decision.");
      setState(data.state);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decision failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const activeNav = NAV_STEPS.find((s) => s.key === step) ?? NAV_STEPS[0];
  const pendingCount =
    state?.threads.filter((t) => t.status === "pending_approval" || t.status === "held").length ?? 0;

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex flex-col lg:flex-row">
      {/* Desktop Sidebar */}
      <aside className="lg:w-64 lg:shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0F172A] flex flex-col justify-between">
        <div>
          <div className="px-5 py-5 border-b border-slate-800">
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setStep("intake");
              }}
              className="font-display text-base font-bold tracking-tight text-slate-100 whitespace-nowrap"
            >
              AP Reconciliation
            </a>
          </div>

          <nav aria-label="Workflow steps" className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
            {NAV_STEPS.map((item) => {
              const Icon = item.icon;
              const isActive = step === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setError(null);
                    setStep(item.key);
                  }}
                  className={`flex items-center justify-between gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : "text-slate-300 hover:bg-slate-800/70 hover:text-white"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                  {item.key === "approvals" && pendingCount > 0 && (
                    <span
                      className={`font-mono text-xs tabular-nums ${
                        isActive ? "text-blue-100" : "text-amber-400"
                      }`}
                    >
                      {pendingCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="hidden lg:block border-t border-slate-800 p-5 space-y-2 text-xs text-slate-400">
          <div className="font-medium text-slate-300">Architecture Principle</div>
          <p className="leading-relaxed">
            Models read unstructured invoices and notes. Deterministic policy rules verify math, Kenyan WHVAT/WHT, and ledger state.
          </p>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-8 border-b border-slate-800 bg-[#0F172A]/80 px-6 py-4">
          <div className="text-sm text-slate-400 truncate">
            <span>Accounts Payable</span>
            <span className="mx-2 text-slate-600">/</span>
            <span className="font-medium text-slate-100">{activeNav.shortTitle}</span>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={handleReset}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#111A2E] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset Demo Data
          </button>
        </header>

        <main className="flex-1 px-6 py-8 lg:px-10">
          <div className="mx-auto max-w-6xl">
            {loading || !state ? (
              <div className="space-y-4">
                <div className="h-8 w-64 rounded bg-slate-800/80" />
                <div className="h-44 w-full rounded-xl bg-slate-800/50" />
              </div>
            ) : (
              <>
                {step === "intake" && (
                  <StepIntake
                    onReconcileText={handleReconcileText}
                    onExtractInvoice={handleExtractInvoice}
                    onInspectThread={(id) => {
                      setSelectedThreadId(id);
                      setStep("policy");
                    }}
                    onGoToApprovals={() => setStep("approvals")}
                    busy={busy}
                    error={error}
                  />
                )}
                {step === "policy" && (
                  <StepPolicy
                    threads={state.threads}
                    selectedThreadId={selectedThreadId}
                    onSelectThread={setSelectedThreadId}
                    onGoToApprovals={() => setStep("approvals")}
                  />
                )}
                {step === "approvals" && (
                  <StepApprovals
                    threads={state.threads}
                    onSubmitDecision={handleDecision}
                    busy={busy}
                    error={error}
                  />
                )}
                {step === "ledger" && <StepLedger state={state} />}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
