import { useCallback, useEffect, useState } from "react";
import { BookOpenCheck, Cpu, Database, RotateCcw, Sparkles } from "lucide-react";
import type { PolicyCategory, ReconciliationThread, WorkbenchState } from "./types";
import { AiProcessGuide } from "./components/AiProcessGuide";
import { InvestigationWorkspace } from "./components/InvestigationWorkspace";
import { PolicyKnowledgeBase } from "./components/PolicyKnowledgeBase";
import { StepLedger } from "./components/StepLedger";

type ViewKey = "investigate" | "policies" | "ledger" | "process";

const NAV_ITEMS: {
  key: ViewKey;
  label: string;
  breadcrumb: string;
  icon: typeof Sparkles;
}[] = [
  {
    key: "investigate",
    label: "1. AI Investigation",
    breadcrumb: "AI Investigation Workspace",
    icon: Sparkles,
  },
  {
    key: "policies",
    label: "2. Policy Vector DB",
    breadcrumb: "Firm AP Policies & Vector Store",
    icon: Database,
  },
  {
    key: "ledger",
    label: "3. Ledger & Audit",
    breadcrumb: "SQLite Ledger & Append-Only Audit",
    icon: BookOpenCheck,
  },
  {
    key: "process",
    label: "4. AI & ML Process",
    breadcrumb: "End-to-End AI & ML Architecture",
    icon: Cpu,
  },
];

export default function App() {
  const [view, setView] = useState<ViewKey>("investigate");
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [highlightPolicyId, setHighlightPolicyId] = useState<string | null>(null);
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
      if (!res.ok) throw new Error("Failed to reset SQLite ledger.");
      const data = (await res.json()) as WorkbenchState;
      setState(data);
      setSelectedThreadId(data.threads[0]?.thread_id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleInvestigate(payload: {
    base64Data?: string;
    mimeType?: string;
    documentText?: string;
    fileName?: string;
    engine: "gemini" | "ollama";
  }): Promise<ReconciliationThread | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Investigation pipeline failed.");
      setState(data.state);
      setSelectedThreadId(data.thread.thread_id);
      return data.thread as ReconciliationThread;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Investigation failed.");
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

  async function handleSavePolicy(payload: {
    policy_id: string;
    category: PolicyCategory;
    title: string;
    vendor_scope: string | null;
    rule_text: string;
  }): Promise<boolean> {
    try {
      const res = await fetch("/api/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save policy.");
      setState(data.state);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save policy.");
      return false;
    }
  }

  async function handleReindexVectors() {
    try {
      const res = await fetch("/api/policies/reindex", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Reindex failed.");
      setState(data.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reindex failed.");
    }
  }

  const activeNav = NAV_ITEMS.find((n) => n.key === view) ?? NAV_ITEMS[0];
  const pendingCount =
    state?.threads.filter((t) => t.status === "pending_approval" || t.status === "held").length ?? 0;

  return (
    <div className="min-h-screen bg-[#0B1120] text-slate-100 flex flex-col lg:flex-row">
      {/* Left Navigation Sidebar */}
      <aside className="lg:w-64 lg:shrink-0 border-b lg:border-b-0 lg:border-r border-slate-800 bg-[#0F172A] flex flex-col justify-between">
        <div>
          <div className="px-5 py-5 border-b border-slate-800">
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setView("investigate");
              }}
              className="font-display text-base font-bold tracking-tight text-slate-100 whitespace-nowrap"
            >
              AP Reconciliation AI
            </a>
          </div>

          <nav aria-label="Primary views" className="p-3 flex lg:flex-col gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = view === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setError(null);
                    setView(item.key);
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
                  {item.key === "investigate" && pendingCount > 0 && (
                    <span className={`font-mono text-xs tabular-nums ${isActive ? "text-blue-100" : "text-amber-400"}`}>
                      {pendingCount}
                    </span>
                  )}
                  {item.key === "policies" && state && (
                    <span className={`font-mono text-xs tabular-nums ${isActive ? "text-blue-100" : "text-slate-400"}`}>
                      {state.policies.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="hidden lg:block border-t border-slate-800 p-5 space-y-2 text-xs text-slate-400">
          <div className="font-medium text-slate-200">Hybrid RAG + Guardrails</div>
          <p className="leading-relaxed">
            AI extracts unstructured invoices and investigates discrepancies against {state?.policies.length ?? 33} vectorized firm policies. SQLite guardrails enforce math, eTIMS, and atomic ledger writes.
          </p>
        </div>
      </aside>

      {/* Main Viewport */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-8 border-b border-slate-800 bg-[#0F172A]/80 px-6 py-4">
          <div className="text-sm text-slate-400 truncate">
            <span>Accounts Payable</span>
            <span className="mx-2 text-slate-600">/</span>
            <span className="font-medium text-slate-100">{activeNav.breadcrumb}</span>
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
          <div className="mx-auto max-w-7xl">
            {loading || !state ? (
              <div className="space-y-4">
                <div className="h-8 w-64 rounded bg-slate-800/80" />
                <div className="h-52 w-full rounded-xl bg-slate-800/50" />
              </div>
            ) : (
              <>
                {view === "investigate" && (
                  <InvestigationWorkspace
                    threads={state.threads}
                    selectedThreadId={selectedThreadId}
                    onSelectThread={setSelectedThreadId}
                    onInvestigate={handleInvestigate}
                    onSubmitDecision={handleDecision}
                    onOpenPolicy={(policyId) => {
                      setHighlightPolicyId(policyId);
                      setView("policies");
                    }}
                    ollamaConfigured={state.telemetry.ollama_configured}
                    ollamaModel={state.telemetry.ollama_model}
                    busy={busy}
                    error={error}
                  />
                )}
                {view === "policies" && (
                  <PolicyKnowledgeBase
                    policies={state.policies}
                    denseVectorCount={state.telemetry.dense_vector_count}
                    highlightPolicyId={highlightPolicyId}
                    onSavePolicy={handleSavePolicy}
                    onReindexVectors={handleReindexVectors}
                  />
                )}
                {view === "ledger" && <StepLedger state={state} />}
                {view === "process" && <AiProcessGuide state={state} />}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
