"""Kenyan AP compliance helpers: fuzzy vendor matching, eTIMS CU & KRA PIN checks, and WHVAT / WHT detection."""
import re

try:
    from rapidfuzz import fuzz as _rapidfuzz
except ImportError:  # pragma: no cover - fallback when rapidfuzz isn't installed yet
    _rapidfuzz = None
    from difflib import SequenceMatcher

_STOPWORDS = {"ltd", "limited", "inc", "co", "kenya", "ke", "plc", "corp", "company", "llp"}
_ALIASES = {
    "hdw": "hardware",
    "svcs": "services",
    "svc": "services",
    "log": "logistics",
    "intl": "international",
    "ent": "enterprises",
}


def normalize_vendor(name: str) -> str:
    tokens = re.sub(r"[^a-z0-9\s]", " ", (name or "").lower()).split()
    cleaned = [_ALIASES.get(t, t) for t in tokens if t not in _STOPWORDS]
    return " ".join(cleaned)


def vendor_similarity(invoice_vendor: str | None, po_vendor: str | None) -> tuple[int, str]:
    """Return (0..100 score, 'match' | 'low_confidence' | 'mismatch' | 'missing')."""
    if not invoice_vendor or not po_vendor:
        return 0, "missing"
    a = normalize_vendor(invoice_vendor)
    b = normalize_vendor(po_vendor)
    if not a or not b:
        return 0, "missing"
    if _rapidfuzz is not None:
        score = int(_rapidfuzz.token_sort_ratio(a, b))
    else:
        sa = " ".join(sorted(a.split()))
        sb = " ".join(sorted(b.split()))
        score = int(round(SequenceMatcher(None, sa, sb).ratio() * 100))
    if score >= 82:
        return score, "match"
    if score >= 60:
        return score, "low_confidence"
    return score, "mismatch"


def is_valid_etims_cu(cu: str | None) -> bool:
    """Validate KRA eTIMS Control Unit invoice number format (e.g. KRA-CU-01948271 or CU01948271)."""
    if not cu:
        return False
    cleaned = cu.strip()
    return bool(re.fullmatch(r"(?:KRA-)?CU-?\d{6,14}", cleaned, re.IGNORECASE))


def is_valid_kra_pin(pin: str | None) -> bool:
    """Validate Kenyan KRA PIN format (P051234987K for corporates, A... for individuals)."""
    if not pin:
        return False
    return bool(re.fullmatch(r"[PA]\d{9}[A-Z]", pin.strip().upper()))


def detect_kenyan_withholding(
    subtotal: float,
    invoice_total: float,
    paid_amount: float,
    currency: str,
) -> tuple[str | None, float]:
    """Check if (invoice_total - paid_amount) matches Kenya 2% WHVAT, 5% Resident WHT, or 3% Contractual WHT.

    Returns ('whvat_2pct' | 'wht_5pct' | 'wht_3pct' | None, expected_deduction).
    """
    if subtotal <= 0 or paid_amount <= 0:
        return None, 0.0
    diff = round(invoice_total - paid_amount, 2)
    if diff <= 0:
        return None, 0.0
    tol = 5.0 if currency == "KES" else 0.5
    whvat_2 = round(subtotal * 0.02, 2)
    wht_5 = round(subtotal * 0.05, 2)
    wht_3 = round(subtotal * 0.03, 2)
    if abs(diff - whvat_2) <= tol:
        return "whvat_2pct", whvat_2
    if abs(diff - wht_5) <= tol:
        return "wht_5pct", wht_5
    if abs(diff - wht_3) <= tol:
        return "wht_3pct", wht_3
    return None, 0.0
