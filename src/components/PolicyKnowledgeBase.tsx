import { useEffect, useState } from "react";
import { Database, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import type { PolicyCategory, PolicyDocument, RetrievedPolicyHit } from "../types";

interface PolicyKnowledgeBaseProps {
  policies: PolicyDocument[];
  denseVectorCount: number;
  highlightPolicyId: string | null;
  onSavePolicy: (payload: {
    policy_id: string;
    category: PolicyCategory;
    title: string;
    vendor_scope: string | null;
    rule_text: string;
  }) => Promise<boolean>;
  onReindexVectors: () => Promise<void>;
}

const CATEGORY_LABELS: Record<PolicyCategory, string> = {
  tax_etims: "Tax & eTIMS",
  matching_tolerance: "Matching & Tolerance",
  controls_fraud: "Controls & Fraud",
  supplier_sop: "Supplier SOPs",
};

export function PolicyKnowledgeBase({
  policies,
  denseVectorCount,
  highlightPolicyId,
  onSavePolicy,
  onReindexVectors,
}: PolicyKnowledgeBaseProps) {
  const [categoryFilter, setCategoryFilter] = useState<PolicyCategory | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RetrievedPolicyHit[] | null>(null);
  const [searchEngine, setSearchEngine] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const [editing, setEditing] = useState<{
    policy_id: string;
    category: PolicyCategory;
    title: string;
    vendor_scope: string;
    rule_text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (highlightPolicyId) {
      setCategoryFilter("all");
      setSearchResults(null);
    }
  }, [highlightPolicyId]);

  async function handleVectorSearch() {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const res = await fetch("/api/policies/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, topK: 8 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Vector search failed.");
      setSearchResults(data.hits);
      setSearchEngine(data.embedding_engine);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vector search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setError(null);
    const ok = await onSavePolicy({
      policy_id: editing.policy_id,
      category: editing.category,
      title: editing.title,
      vendor_scope: editing.vendor_scope.trim() || null,
      rule_text: editing.rule_text,
    });
    setSaving(false);
    if (ok) {
      setEditing(null);
    }
  }

  async function handleReindex() {
    setReindexing(true);
    await onReindexVectors();
    setReindexing(false);
  }

  const visiblePolicies = policies.filter(
    (p) => categoryFilter === "all" || p.category === categoryFilter
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl space-y-1">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
            Firm AP Policies & Supplier SOPs (SQLite + Vector DB)
          </h1>
          <p className="text-sm text-slate-400">
            All {policies.length} Kenyan tax rules, matching thresholds, and vendor SOPs live in SQLite (<code className="text-slate-300">ap_policies</code>) and are embedded with <code className="text-slate-300">gemini-embedding-2</code> into <code className="text-slate-300">policy_vectors</code> for RAG citations.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start">
          <button
            type="button"
            disabled={reindexing}
            onClick={handleReindex}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-[#111A2E] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            {reindexing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Sync Vectors ({denseVectorCount}/{policies.length})
          </button>
          <button
            type="button"
            onClick={() =>
              setEditing({
                policy_id: `POL-CUSTOM-${policies.length + 1}`,
                category: "supplier_sop",
                title: "",
                vendor_scope: "",
                rule_text: "",
              })
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-500 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Policy
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      {/* Semantic Vector Search Tester */}
      <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleVectorSearch();
              }}
              placeholder="Test semantic vector search (e.g. 'hardware vendor paid short by 2% VAT' or 'demurrage credit note')..."
              className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] pl-10 pr-4 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={searching}
            onClick={handleVectorSearch}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
          >
            {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
            Search Vector DB
          </button>
          {searchResults && (
            <button
              type="button"
              onClick={() => {
                setSearchResults(null);
                setSearchQuery("");
              }}
              className="rounded-lg border border-slate-700 px-3.5 py-2.5 text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0"
            >
              Clear
            </button>
          )}
        </div>

        {searchResults && (
          <div className="space-y-3 border-t border-slate-800 pt-4">
            <div className="text-xs text-slate-400">
              Top {searchResults.length} semantic matches · Engine:{" "}
              <span className="font-mono text-slate-200">{searchEngine}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {searchResults.map((hit) => (
                <div
                  key={hit.policy_id}
                  className="rounded-lg border border-blue-500/30 bg-[#0B1120] p-4 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono font-semibold text-blue-400">{hit.policy_id}</span>
                    <span className="font-mono tabular-nums text-emerald-400">
                      similarity {hit.similarity_score.toFixed(3)} ({hit.retrieval_mode})
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-slate-100">{hit.title}</div>
                  <p className="text-xs leading-relaxed text-slate-300">{hit.rule_text}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Add / Edit Policy Form */}
      {editing && (
        <div className="rounded-xl border border-blue-500/40 bg-[#111A2E] p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Save Policy Clause & Re-Embed Vector
            </h2>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="text-xs text-slate-400 hover:text-white cursor-pointer"
            >
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Policy ID</label>
              <input
                type="text"
                value={editing.policy_id}
                onChange={(e) => setEditing({ ...editing, policy_id: e.target.value })}
                className="w-full rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Category</label>
              <select
                value={editing.category}
                onChange={(e) => setEditing({ ...editing, category: e.target.value as PolicyCategory })}
                className="w-full rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 text-xs text-slate-100"
              >
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Vendor Scope (optional)</label>
              <input
                type="text"
                value={editing.vendor_scope}
                onChange={(e) => setEditing({ ...editing, vendor_scope: e.target.value })}
                placeholder="e.g. Acacia Hardware Ltd"
                className="w-full rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 text-xs text-slate-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Title</label>
            <input
              type="text"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 text-sm text-slate-100"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Policy / SOP Rule Text</label>
            <textarea
              rows={3}
              value={editing.rule_text}
              onChange={(e) => setEditing({ ...editing, rule_text: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-[#0B1120] px-3 py-2 text-sm text-slate-100"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={saving || !editing.policy_id.trim() || !editing.title.trim() || !editing.rule_text.trim()}
              onClick={handleSave}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save to SQLite & Embed Vector
            </button>
          </div>
        </div>
      )}

      {/* Category Tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCategoryFilter("all")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
            categoryFilter === "all"
              ? "bg-blue-600 text-white"
              : "bg-[#111A2E] text-slate-300 border border-slate-800 hover:text-white"
          }`}
        >
          All ({policies.length})
        </button>
        {(Object.keys(CATEGORY_LABELS) as PolicyCategory[]).map((cat) => (
          <button
            key={cat}
            type="button"
            onClick={() => setCategoryFilter(cat)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
              categoryFilter === cat
                ? "bg-blue-600 text-white"
                : "bg-[#111A2E] text-slate-300 border border-slate-800 hover:text-white"
            }`}
          >
            {CATEGORY_LABELS[cat]} ({policies.filter((p) => p.category === cat).length})
          </button>
        ))}
      </div>

      {/* Policy Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {visiblePolicies.map((p) => {
          const isHighlighted = highlightPolicyId === p.policy_id;
          return (
            <div
              key={p.policy_id}
              className={`rounded-xl border p-5 space-y-2.5 transition-colors ${
                isHighlighted
                  ? "border-blue-500 bg-[#15213A]"
                  : "border-slate-800 bg-[#111A2E]"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-semibold text-blue-400">{p.policy_id}</span>
                  <span aria-hidden="true" className="text-slate-600">·</span>
                  <span className="text-slate-400">{CATEGORY_LABELS[p.category]}</span>
                  {p.vendor_scope && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">·</span>
                      <span className="text-slate-300">{p.vendor_scope}</span>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setEditing({
                      policy_id: p.policy_id,
                      category: p.category,
                      title: p.title,
                      vendor_scope: p.vendor_scope || "",
                      rule_text: p.rule_text,
                    })
                  }
                  className="text-xs text-slate-400 hover:text-white underline shrink-0 cursor-pointer"
                >
                  Edit
                </button>
              </div>
              <h3 className="font-display text-sm font-semibold text-slate-100">{p.title}</h3>
              <p className="text-xs leading-relaxed text-slate-300">{p.rule_text}</p>
              <div className="flex items-center justify-between pt-1 text-xs text-slate-500">
                <span>Effective {p.effective_date}</span>
                <span className="font-mono">
                  {p.has_dense_vector ? "Dense vector indexed" : "Lexical ready"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
