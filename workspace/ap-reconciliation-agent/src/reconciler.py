"""Deterministic reconciliation engine: 3-way match, Kenyan tax rules, fuzzy vendor match, transactional persistence."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from typing import Any

from src.db import get_conn
from src.kenya_compliance import detect_kenyan_withholding, is_valid_etims_cu, vendor_similarity


# ---------- policy knobs (env-configurable) ----------
def tolerance_pct() -> float:
    try:
        return float(os.getenv("RECON_MAX_VARIANCE_PCT", "1.5"))
    except ValueError:
        return 1.5


def tolerance_abs(currency: str) -> float:
    key, default = ("RECON_ABS_TOL_USD", "5") if currency == "USD" else ("RECON_ABS_TOL_KES", "500")
    try:
        return float(os.getenv(key, default))
    except ValueError:
        return float(default)


def high_value_threshold(currency: str) -> float:
    if currency == "USD":
        return float(os.getenv("HIGH_VALUE_USD", "1000.0"))
    return float(os.getenv("HIGH_VALUE_KES", "150000.0"))


def within_tolerance(variance_amount: float, variance_pct: float, currency: str) -> bool:
    """Auto-clear if variance is within the % tolerance OR the absolute rounding/FX tolerance."""
    return variance_pct <= tolerance_pct() or abs(variance_amount) <= tolerance_abs(currency)


# ---------- matching ----------
def evaluate_match(
    invoice_number: str,
    payment_ref: str | None = None,
    db_path: Path | None = None,
) -> dict[str, Any]:
    """3-way match of invoice <-> PO/goods receipt <-> payments.

    Sign convention: variance = invoice - paid. Positive = underpaid, negative = overpaid.
    `flags` need a human; `blocking_flags` are hard stops no human can override.
    """
    with get_conn(db_path) as conn:
        inv_row = conn.execute(
            "SELECT * FROM invoices WHERE UPPER(invoice_number) = UPPER(?)",
            (invoice_number.strip(),),
        ).fetchone()
        if not inv_row:
            return {"error": f"Invoice '{invoice_number}' not found in ledger."}
        inv = dict(inv_row)

        po = None
        if inv.get("po_number"):
            po_row = conn.execute(
                "SELECT * FROM purchase_orders WHERE po_number = ?", (inv["po_number"],)
            ).fetchone()
            po = dict(po_row) if po_row else None

        payments = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM payments WHERE UPPER(invoice_number) = UPPER(?) ORDER BY id",
                (inv["invoice_number"],),
            ).fetchall()
        ]

        flags: list[str] = []
        blocking: list[str] = []

        if payment_ref:
            ref_row = conn.execute(
                "SELECT * FROM payments WHERE UPPER(payment_ref) = UPPER(?)", (payment_ref.strip(),)
            ).fetchone()
            if not ref_row:
                flags.append(f"Payment reference '{payment_ref}' not found in payment ledger.")
            else:
                ref = dict(ref_row)
                if ref["invoice_number"] and ref["invoice_number"].upper() != inv["invoice_number"].upper():
                    blocking.append(
                        f"Payment {ref['payment_ref']} is already allocated to {ref['invoice_number']}, not {inv['invoice_number']} (POL-MATCH-004)."
                    )
                elif not ref["invoice_number"]:
                    payments.append(ref)

    paid_amount = round(sum(float(p["amount_paid"]) for p in payments), 2)
    inv_amount = float(inv["amount"])
    variance_amount = round(inv_amount - paid_amount, 2)
    variance_pct = round(abs(variance_amount) / inv_amount * 100.0, 2) if inv_amount > 0 else 0.0

    # ---- blocking controls ----
    if inv["status"] == "reconciled" or any(p["status"] == "reconciled" for p in payments):
        blocking.append("Invoice or payment already reconciled — monotonic ledger lock (POL-CTRL-003).")
    if not payments:
        blocking.append("No settled payment record found for invoice.")
    elif any(p["currency"] != inv["currency"] for p in payments):
        bad = sorted({p["currency"] for p in payments if p["currency"] != inv["currency"]})
        blocking.append(
            f"Currency mismatch: invoice is {inv['currency']} but payment(s) in {', '.join(bad)} (POL-MATCH-005)."
        )

    # ---- arithmetic & eTIMS integrity ----
    subtotal_val = inv.get("subtotal")
    vat_val = inv.get("vat")
    if subtotal_val is not None and vat_val is not None:
        arith_diff = round(float(subtotal_val) + float(vat_val) - inv_amount, 2)
        if abs(arith_diff) > 1.0:
            blocking.append(
                f"Arithmetic integrity failure: subtotal {subtotal_val} + VAT {vat_val} != {inv_amount} (POL-CTRL-004)."
            )

    if inv["currency"] == "KES" and not is_valid_etims_cu(inv.get("etims_cu")):
        flags.append("Missing or malformed KRA eTIMS Control Unit number (POL-TAX-007).")

    # ---- Kenyan WHVAT / WHT detection ----
    net_subtotal = float(subtotal_val) if subtotal_val else round(inv_amount / 1.16, 2)
    tax_rule, expected_withheld = detect_kenyan_withholding(net_subtotal, inv_amount, paid_amount, inv["currency"])

    # ---- human-review controls ----
    vendor_score = 100
    if not po:
        flags.append("Missing linked Purchase Order (POL-CTRL-005).")
    else:
        vendor_score, vendor_band = vendor_similarity(inv.get("vendor_name"), po.get("vendor_name"))
        if vendor_band in {"low_confidence", "mismatch"}:
            flags.append(
                f"Fuzzy vendor match '{inv.get('vendor_name')}' vs PO '{po.get('vendor_name')}' scored {vendor_score}% (<82% threshold, POL-MATCH-008)."
            )
        if int(po.get("goods_received", 0)) != 1:
            flags.append(f"PO {po['po_number']} has not recorded goods receipt yet (POL-MATCH-001).")
        if inv_amount > float(po["authorized_amount"]) + 1e-9:
            flags.append(
                f"Invoice {inv_amount} exceeds PO authorized amount {po['authorized_amount']} {inv['currency']} (POL-MATCH-001)."
            )

    if payments and tax_rule == "whvat_2pct":
        flags.append(
            f"2% Kenyan WHVAT deduction detected ({inv['currency']} {expected_withheld} withheld on net {net_subtotal}): confirm iTax WHVAT certificate (POL-TAX-003)."
        )
    elif payments and tax_rule == "wht_5pct":
        flags.append(
            f"5% Resident WHT deduction detected ({inv['currency']} {expected_withheld} withheld on net {net_subtotal}): confirm WHT certificate (POL-TAX-004)."
        )
    elif payments and tax_rule == "wht_3pct":
        flags.append(
            f"3% Contractual WHT deduction detected ({inv['currency']} {expected_withheld} withheld on net {net_subtotal}): confirm WHT certificate (POL-TAX-005)."
        )
    elif payments and not within_tolerance(variance_amount, variance_pct, inv["currency"]):
        if variance_amount < 0:
            flags.append(f"Overpayment of {abs(variance_amount)} {inv['currency']} ({variance_pct}%) (POL-MATCH-004).")
        elif len(payments) > 1 or paid_amount < inv_amount:
            flags.append(
                f"Partial/short settlement: paid {paid_amount} of {inv_amount} {inv['currency']} "
                f"(short {variance_amount}, {variance_pct}%) exceeds tolerance (POL-MATCH-002)."
            )

    if inv_amount >= high_value_threshold(inv["currency"]):
        flags.append(
            f"High-value settlement ({inv_amount} {inv['currency']}) requires supervisor sign-off (POL-CTRL-001)."
        )

    return {
        "invoice": inv,
        "payments": payments,
        "purchase_order": po,
        "invoice_amount": inv_amount,
        "paid_amount": paid_amount,
        "variance_amount": variance_amount,
        "variance_pct": variance_pct,
        "tax_rule_applied": tax_rule,
        "expected_withheld_amount": expected_withheld,
        "vendor_match_score": vendor_score,
        "flags": flags,
        "blocking_flags": blocking,
    }


def find_unmatched_payments(db_path: Path | None = None) -> list[dict[str, Any]]:
    """Payments with no invoice allocation, or pointing at an invoice that doesn't exist."""
    with get_conn(db_path) as conn:
        rows = conn.execute(
            """
            SELECT p.* FROM payments p
            LEFT JOIN invoices i ON UPPER(i.invoice_number) = UPPER(p.invoice_number)
            WHERE p.invoice_number IS NULL OR i.id IS NULL OR p.status = 'unmatched'
            ORDER BY p.id
            """
        ).fetchall()
    return [dict(r) for r in rows]


def derive_idempotency_key(
    thread_id: str,
    invoice_number: str,
    payments: list[dict[str, Any]],
    status: str,
) -> str:
    refs = ",".join(sorted(p["payment_ref"] for p in payments))
    raw = f"{thread_id}|{invoice_number.upper()}|{refs}|{status}"
    return "auto-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


# ---------- persistence ----------
def persist_reconciliation(
    thread_id: str,
    report: dict[str, Any],
    status: str,
    reason_summary: str,
    idempotency_key: str | None = None,
    retrieved_policies: list[dict[str, Any]] | None = None,
    investigation: dict[str, Any] | None = None,
    db_path: Path | None = None,
) -> int | None:
    """Atomically record the outcome. Idempotent on caller key or derived thread key."""
    if "error" in report or not report.get("invoice"):
        return None
    inv = report["invoice"]
    payments = report.get("payments") or []
    po = report.get("purchase_order") or {}
    effective_key = idempotency_key or derive_idempotency_key(
        thread_id, inv["invoice_number"], payments, status
    )

    with get_conn(db_path) as conn:
        existing = conn.execute(
            "SELECT id FROM reconciliations WHERE idempotency_key = ? OR thread_id = ?",
            (effective_key, thread_id),
        ).fetchone()
        if existing:
            return int(existing["id"])

        conn.execute("BEGIN IMMEDIATE;")
        try:
            cur = conn.execute(
                """
                INSERT INTO reconciliations (
                    idempotency_key, thread_id, invoice_number, payment_ref, po_number,
                    currency, invoice_amount, paid_amount, variance_amount, variance_pct,
                    status, reason_summary, retrieved_policies_json, investigation_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    effective_key,
                    thread_id,
                    inv["invoice_number"],
                    ",".join(p["payment_ref"] for p in payments) or None,
                    po.get("po_number") or inv.get("po_number"),
                    inv["currency"],
                    report["invoice_amount"],
                    report["paid_amount"],
                    report["variance_amount"],
                    report["variance_pct"],
                    status,
                    reason_summary,
                    json.dumps(retrieved_policies or [], default=str),
                    json.dumps(investigation or {}, default=str),
                ),
            )
            rec_id = int(cur.lastrowid)

            new_inv_status = {"reconciled": "reconciled", "rejected": "rejected"}.get(status, "held")
            conn.execute(
                "UPDATE invoices SET status = ? WHERE invoice_number = ? AND status != 'reconciled'",
                (new_inv_status, inv["invoice_number"]),
            )
            if status == "reconciled":
                for p in payments:
                    cur_p = conn.execute(
                        """
                        UPDATE payments
                        SET status = 'reconciled', invoice_number = ?
                        WHERE payment_ref = ?
                          AND status != 'reconciled'
                          AND (invoice_number IS NULL OR UPPER(invoice_number) = UPPER(?))
                        """,
                        (inv["invoice_number"], p["payment_ref"], inv["invoice_number"]),
                    )
                    if cur_p.rowcount != 1:
                        raise sqlite3.IntegrityError(
                            f"Payment {p['payment_ref']} already reconciled or allocated to another invoice."
                        )
            conn.execute("COMMIT;")
            return rec_id
        except sqlite3.IntegrityError:
            conn.execute("ROLLBACK;")
            row = conn.execute(
                "SELECT id FROM reconciliations WHERE idempotency_key = ? OR thread_id = ?",
                (effective_key, thread_id),
            ).fetchone()
            if row:
                return int(row["id"])
            raise
        except Exception:
            conn.execute("ROLLBACK;")
            raise
