import { useState, type ChangeEvent } from "react";
import { ArrowRight, FileText, Loader2, MessageSquareText, Upload } from "lucide-react";
import type { ExtractedInvoiceFields, ReconciliationThread } from "../types";
import { formatMoney, statusDisplay } from "./Formatters";

interface StepIntakeProps {
  onReconcileText: (rawInput: string) => Promise<ReconciliationThread | null>;
  onExtractInvoice: (payload: {
    base64Data?: string;
    mimeType?: string;
    documentText?: string;
    fileName?: string;
  }) => Promise<{ extracted: ExtractedInvoiceFields; thread: ReconciliationThread } | null>;
  onInspectThread: (threadId: string) => void;
  onGoToApprovals: () => void;
  busy: boolean;
  error: string | null;
}

const REMITTANCE_PRESETS = [
  {
    label: "Swahili + 2% WHVAT",
    text: "Tumelipa Acacia HDW invoice 9001 via MPESA-QKL8821 baada ya kukata 2% WHVAT.",
  },
  {
    label: "Short-paid EFT",
    text: "Paid Mombasa Logistics INV-9004 by EFT-77319 in KES, balance disputed on delivery.",
  },
  {
    label: "High-value USD wire",
    text: "Please clear Rift Valley Cloud INV-9002 against WIRE-USD-441 USD.",
  },
  {
    label: "Clean M-Pesa match",
    text: "Reconcile INV-9006 MPESA-RZP1104 KES",
  },
];

const SAMPLE_INVOICE_TEXT = `ACACIA HARDWARE LTD
KRA PIN: P051234987K
Tax Invoice: INV-9001
Purchase Order: PO-4410
Control Unit No: KRA-CU-01948271
Date: 14/11/2026
Currency: KES

Hardware & Site Fittings: 100,000.00
VAT (16%): 16,000.00
Total Payable: 116,000.00`;

export function StepIntake({
  onReconcileText,
  onExtractInvoice,
  onInspectThread,
  onGoToApprovals,
  busy,
  error,
}: StepIntakeProps) {
  const [mode, setMode] = useState<"remittance" | "document">("remittance");
  const [rawInput, setRawInput] = useState(REMITTANCE_PRESETS[0].text);
  const [docText, setDocText] = useState(SAMPLE_INVOICE_TEXT);
  const [uploadedFile, setUploadedFile] = useState<{
    name: string;
    mimeType: string;
    base64Data: string;
    previewUrl: string | null;
  } | null>(null);
  const [lastThread, setLastThread] = useState<ReconciliationThread | null>(null);
  const [lastExtracted, setLastExtracted] = useState<ExtractedInvoiceFields | null>(null);

  async function handleRunRemittance() {
    const res = await onReconcileText(rawInput);
    if (res) {
      setLastThread(res);
      setLastExtracted(null);
    }
  }

  async function handleRunDocument() {
    const res = await onExtractInvoice(
      uploadedFile
        ? {
            base64Data: uploadedFile.base64Data,
            mimeType: uploadedFile.mimeType,
            fileName: uploadedFile.name,
          }
        : {
            documentText: docText,
            fileName: "Acacia_Hardware_INV-9001.txt",
          }
    );
    if (res) {
      setLastThread(res.thread);
      setLastExtracted(res.extracted);
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64Data = result.includes(",") ? result.split(",")[1] : result;
      setUploadedFile({
        name: file.name,
        mimeType: file.type || "image/png",
        base64Data,
        previewUrl: file.type.startsWith("image/") ? result : null,
      });
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl space-y-1.5">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">
            Step 1. Intake and Extract
          </h1>
          <p className="text-sm leading-relaxed text-slate-400">
            Bring in a remittance note or supplier invoice. The model extracts structured fields only, then deterministic rules verify arithmetic, eTIMS, tax, and payment balances.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Intake source mode"
          className="inline-flex rounded-lg border border-slate-800 bg-[#111A2E] p-1 self-start"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "remittance"}
            onClick={() => setMode("remittance")}
            className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              mode === "remittance"
                ? "bg-blue-600 text-white"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <MessageSquareText className="h-3.5 w-3.5" />
            Payment Note
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "document"}
            onClick={() => setMode("document")}
            className={`inline-flex items-center gap-2 rounded-md px-3.5 py-2 text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
              mode === "document"
                ? "bg-blue-600 text-white"
                : "text-slate-300 hover:text-white"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            Invoice Document
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-sm text-rose-200"
        >
          {error}
        </div>
      )}

      {mode === "remittance" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-5">
            <div className="space-y-1">
              <h2 className="font-display text-base font-semibold text-slate-100">
                Remittance or Finance Email Note
              </h2>
              <p className="text-xs text-slate-400">
                Test English, Swahili, or mixed payment messages. Try a preset below or enter your own note.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              {REMITTANCE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => setRawInput(preset.text)}
                  className="rounded-md border border-slate-700/80 bg-[#0B1120] px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div>
              <label htmlFor="remittance-input" className="sr-only">
                Remittance message
              </label>
              <textarea
                id="remittance-input"
                rows={4}
                value={rawInput}
                onChange={(e) => setRawInput(e.target.value)}
                placeholder="Paste M-Pesa confirmation, email snippet, or Swahili/English note..."
                className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-4 pt-1">
              <span className="text-xs text-slate-400">
                Runs deterministic regex baseline alongside structured AI extraction.
              </span>
              <button
                type="button"
                disabled={busy || !rawInput.trim()}
                onClick={handleRunRemittance}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Checking...
                  </>
                ) : (
                  <>
                    Extract and Check Match
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-4">
            <h2 className="font-display text-base font-semibold text-slate-100">
              How This Step Works
            </h2>
            <ol className="space-y-3 text-sm text-slate-300">
              <li className="flex gap-3">
                <span className="font-mono text-xs text-blue-400 pt-0.5">01</span>
                <span>
                  <strong className="font-medium text-slate-100">Parser reads messy text:</strong>{" "}
                  Extracts invoice ID, payment reference, vendor name, and currency into a strict schema.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-xs text-blue-400 pt-0.5">02</span>
                <span>
                  <strong className="font-medium text-slate-100">Ledger lookup:</strong>{" "}
                  Matches the invoice, its Purchase Order, and settled M-Pesa/EFT/Wire payments.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="font-mono text-xs text-blue-400 pt-0.5">03</span>
                <span>
                  <strong className="font-medium text-slate-100">Deterministic policy gate:</strong>{" "}
                  Checks 1.5% tolerance, Kenyan 2% WHVAT / 5% WHT deductions, and high-value thresholds.
                </span>
              </li>
            </ol>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7 rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="font-display text-base font-semibold text-slate-100">
                  Upload Invoice Image or Paste Invoice Text
                </h2>
                <p className="text-xs text-slate-400">
                  Upload a PNG/JPG/PDF invoice scan, or test with the pre-filled Kenyan supplier tax invoice text.
                </p>
              </div>
              {uploadedFile && (
                <button
                  type="button"
                  onClick={() => setUploadedFile(null)}
                  className="text-xs text-slate-400 hover:text-white underline whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Clear file
                </button>
              )}
            </div>

            <label className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-700 bg-[#0B1120] px-4 py-5 text-center hover:border-blue-500/70 transition-colors cursor-pointer">
              <Upload className="h-5 w-5 text-slate-400" />
              <span className="text-sm font-medium text-slate-200">
                {uploadedFile ? uploadedFile.name : "Choose an invoice image or PDF"}
              </span>
              <span className="text-xs text-slate-500">
                PNG, JPG, WEBP, or PDF up to 10 MB
              </span>
              <input
                type="file"
                accept="image/*,application/pdf"
                onChange={handleFileChange}
                className="sr-only"
              />
            </label>

            {!uploadedFile && (
              <div>
                <label htmlFor="doc-text-input" className="block text-xs font-medium text-slate-400 mb-2">
                  Or inspect / edit sample Kenyan invoice text
                </label>
                <textarea
                  id="doc-text-input"
                  rows={8}
                  value={docText}
                  onChange={(e) => setDocText(e.target.value)}
                  className="w-full rounded-lg border border-slate-700/80 bg-[#0B1120] px-4 py-3 font-mono text-xs leading-relaxed text-slate-200 focus:border-blue-500 focus:outline-none"
                />
              </div>
            )}

            <div className="flex items-center justify-end">
              <button
                type="button"
                disabled={busy || (!uploadedFile && !docText.trim())}
                onClick={handleRunDocument}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Extracting...
                  </>
                ) : (
                  <>
                    Extract Document Fields
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="lg:col-span-5 rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-4">
            <h2 className="font-display text-base font-semibold text-slate-100">
              Document Preview
            </h2>
            {uploadedFile?.previewUrl ? (
              <img
                src={uploadedFile.previewUrl}
                alt="Uploaded supplier invoice preview"
                referrerPolicy="no-referrer"
                className="max-h-80 w-full rounded-lg border border-slate-800 object-contain bg-[#0B1120]"
              />
            ) : (
              <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-5 font-mono text-xs text-slate-300 space-y-3">
                <div className="flex items-start justify-between border-b border-slate-800 pb-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-100">ACACIA HARDWARE LTD</div>
                    <div className="text-slate-400">Nairobi, Kenya · KRA PIN P051234987K</div>
                  </div>
                  <div className="text-right">
                    <div className="text-slate-100 font-semibold">TAX INVOICE</div>
                    <div className="text-slate-400">INV-9001</div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-slate-400">
                  <div>PO Ref: <span className="text-slate-200">PO-4410</span></div>
                  <div>Date: <span className="text-slate-200">14/11/2026</span></div>
                  <div className="col-span-2">eTIMS CU: <span className="text-slate-200">KRA-CU-01948271</span></div>
                </div>
                <div className="border-t border-slate-800 pt-3 space-y-1 tabular-nums">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Subtotal</span>
                    <span>KES 100,000.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">VAT (16%)</span>
                    <span>KES 16,000.00</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-800 pt-1.5 font-semibold text-slate-100">
                    <span>Total Payable</span>
                    <span>KES 116,000.00</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Result Banner from latest run */}
      {lastThread && (
        <div className="rounded-xl border border-slate-800 bg-[#111A2E] p-6 space-y-5">
          <div className="flex flex-col gap-3 border-b border-slate-800 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="font-mono">{lastThread.thread_id}</span>
                <span aria-hidden="true">·</span>
                <span className={statusDisplay(lastThread.status).textClass + " font-medium"}>
                  {statusDisplay(lastThread.status).label}
                </span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{lastThread.extraction_meta.latency_ms} ms</span>
              </div>
              <h3 className="font-display text-lg font-semibold text-slate-100">
                {lastThread.invoice_number || "Unidentified Invoice"}{" "}
                <span className="text-slate-400 font-normal">
                  {lastThread.vendor_name ? `— ${lastThread.vendor_name}` : ""}
                </span>
              </h3>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onInspectThread(lastThread.thread_id)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Inspect Policy Checks
              </button>
              {lastThread.status === "pending_approval" && (
                <button
                  type="button"
                  onClick={onGoToApprovals}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Open in Approval Queue
                </button>
              )}
            </div>
          </div>

          {/* Side-by-side Regex vs AI comparison for remittance notes */}
          {lastThread.extraction_meta.regex_baseline && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 space-y-2">
                <div className="text-xs font-medium text-slate-400">
                  Regex Baseline Output
                </div>
                <pre className="text-xs text-slate-300 overflow-x-auto">
                  {JSON.stringify(lastThread.extraction_meta.regex_baseline, null, 2)}
                </pre>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 space-y-2">
                <div className="text-xs font-medium text-blue-400">
                  Structured AI Output ({lastThread.extraction_meta.model})
                </div>
                <pre className="text-xs text-slate-200 overflow-x-auto">
                  {JSON.stringify(lastThread.extraction_meta.llm_parsed, null, 2)}
                </pre>
              </div>
            </div>
          )}

          {lastExtracted && (
            <div className="rounded-lg border border-slate-800 bg-[#0B1120] p-4 space-y-2">
              <div className="text-xs font-medium text-blue-400">
                Extracted Document Schema ({lastThread.extraction_meta.model})
              </div>
              <pre className="text-xs text-slate-200 overflow-x-auto">
                {JSON.stringify(lastExtracted, null, 2)}
              </pre>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 text-sm tabular-nums">
            <div>
              <div className="text-xs text-slate-400">Invoice Total</div>
              <div className="font-mono font-medium text-slate-100">
                {formatMoney(lastThread.invoice_amount, lastThread.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Paid Amount</div>
              <div className="font-mono font-medium text-slate-100">
                {formatMoney(lastThread.paid_amount, lastThread.currency)}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Variance</div>
              <div className="font-mono font-medium text-slate-100">
                {formatMoney(lastThread.variance_amount, lastThread.currency)} ({lastThread.variance_pct}%)
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Vendor Match</div>
              <div className="font-mono font-medium text-slate-100">
                {lastThread.evaluation.vendor_match_score}% ({lastThread.evaluation.vendor_match_label})
              </div>
            </div>
          </div>

          <ul className="space-y-1.5 text-sm text-slate-300 border-t border-slate-800 pt-4">
            {lastThread.evaluation.reasons.map((reason, idx) => (
              <li key={idx}>• {reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
