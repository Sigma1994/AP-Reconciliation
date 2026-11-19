import type { Currency, ThreadStatus } from "../types";

export function formatMoney(amount: number, currency: Currency): string {
  const formatted = new Intl.NumberFormat("en-KE", {
    minimumFractionDigits: currency === "USD" ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${currency} ${formatted}`;
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function statusDisplay(status: ThreadStatus | "open" | "unmatched"): {
  label: string;
  textClass: string;
} {
  switch (status) {
    case "reconciled":
      return { label: "Cleared", textClass: "text-emerald-400" };
    case "pending_approval":
      return { label: "Needs Review", textClass: "text-amber-400" };
    case "held":
      return { label: "On Hold", textClass: "text-amber-300" };
    case "rejected":
      return { label: "Rejected", textClass: "text-rose-400" };
    case "blocked":
      return { label: "Blocked by Policy", textClass: "text-rose-400" };
    case "open":
    case "unmatched":
      return { label: "Open", textClass: "text-slate-300" };
  }
}
