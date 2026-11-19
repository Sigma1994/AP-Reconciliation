"""Invoice & receipt intake: prep, local Ollama / Gemini extraction, parsing, deterministic validation.

The model only *reads* the page. Every extracted value is then checked in plain Python
(arithmetic, eTIMS CU, SHA-256 duplicates, fuzzy PO cross-reference) and a human confirms before anything is written.
"""
import base64
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
from typing import Any

from pydantic import BaseModel, Field

from src.db import get_conn
from src.kenya_compliance import is_valid_etims_cu, is_valid_kra_pin, vendor_similarity

FIELDS = [
    "document_type",
    "invoice_number",
    "po_number",
    "payment_ref",
    "vendor_name",
    "kra_pin",
    "currency",
    "invoice_date",
    "etims_cu",
    "subtotal",
    "vat",
    "total",
]
REQUIRED = ["invoice_number", "vendor_name", "currency", "invoice_date", "total"]
ALLOWED_IMAGE_FORMATS = {"PNG", "JPEG", "WEBP"}
ALLOWED_FORMATS = ALLOWED_IMAGE_FORMATS | {"PDF"}
VISION_PROMPT_VERSION = "intake-vision-v3"


class LineItemSchema(BaseModel):
    description: str
    quantity: float | None = None
    unit_price: float | None = None
    tax_rate: str | None = None
    line_total: float | None = None


class InvoiceExtractionSchema(BaseModel):
    document_type: str = "invoice"
    invoice_number: str | None = None
    po_number: str | None = None
    payment_ref: str | None = None
    vendor_name: str | None = None
    kra_pin: str | None = None
    currency: str | None = None
    invoice_date: str | None = None
    etims_cu: str | None = None
    subtotal: float | None = None
    vat: float | None = None
    total: float | None = None
    line_items: list[LineItemSchema] = Field(default_factory=list)
    extraction_notes: str | None = None


PROMPT = """You are reading a Kenyan B2B supplier invoice or payment receipt. Extract the fields below and reply with ONE JSON object and nothing else:
{
  "document_type": "invoice" or "receipt",
  "invoice_number": string or null,
  "po_number": string or null,
  "payment_ref": string or null,
  "vendor_name": string or null,
  "kra_pin": string or null,
  "currency": "KES" or "USD" or null,
  "invoice_date": "YYYY-MM-DD" or null,
  "etims_cu": string or null,
  "subtotal": number or null,
  "vat": number or null,
  "total": number or null,
  "line_items": [{"description": string, "quantity": number or null, "unit_price": number or null, "tax_rate": string or null, "line_total": number or null}],
  "extraction_notes": string or null
}
Rules:
- Copy values verbatim as printed. Never guess, recalculate, or fix a mismatched total; use null if absent.
- "etims_cu" is the KRA eTIMS Control Unit serial if printed (e.g. KRA-CU-01948271); otherwise null.
- "total" is the final amount payable including VAT. "subtotal" is before VAT.
- KSh / Ksh / KES means "KES". $ / USD means "USD".
- Kenyan dates are day-first (DD/MM/YYYY). Output the date as YYYY-MM-DD.
- Numbers must be plain (no currency symbol, no thousands separators)."""


# ---------- image & PDF handling ----------
def sniff_image_format(raw: bytes) -> str | None:
    """Detect PNG, JPEG, WEBP, or PDF from raw upload bytes."""
    if raw[:4] == b"%PDF":
        return "PDF"
    from PIL import Image

    try:
        with Image.open(io.BytesIO(raw)) as im:
            im.verify()
            fmt = (im.format or "").upper()
    except Exception:
        return None
    return fmt if fmt in ALLOWED_IMAGE_FORMATS else None


def store_upload(raw: bytes, upload_dir: Path) -> tuple[str, Path]:
    """Content-addressed storage: identical files map to the same sha256 / path."""
    sha = hashlib.sha256(raw).hexdigest()
    fmt = sniff_image_format(raw) or "PNG"
    ext = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp", "PDF": "pdf"}[fmt]
    upload_dir.mkdir(parents=True, exist_ok=True)
    path = upload_dir / f"{sha}.{ext}"
    if not path.exists():
        path.write_bytes(raw)
    return sha, path


def prepare_image(raw: bytes) -> bytes:
    """Fix EXIF rotation, flatten to RGB and cap the longest side (keeps a 3B VLM inside 8 GB RAM)."""
    from PIL import Image, ImageOps

    max_side = int(os.getenv("INTAKE_MAX_SIDE", "1344"))
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if max(im.size) > max_side:
            scale = max_side / max(im.size)
            im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return buf.getvalue()


def extract_pdf_content(pdf_bytes: bytes) -> tuple[str | None, bytes | None]:
    """Digital PDF -> (selectable_text, None); Scanned PDF -> (None, rasterized_png_bytes)."""
    import fitz  # pymupdf

    max_side = int(os.getenv("INTAKE_MAX_SIDE", "1344"))
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    try:
        chunks = [page.get_text("text").strip() for page in doc]
        full_text = "\n".join(c for c in chunks if c)
        if len(full_text) >= 40:
            return full_text, None
        page = doc[0]
        rect = page.rect
        scale = min(max_side / max(rect.width, rect.height, 1.0), 2.5)
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
        return None, pix.tobytes("png")
    finally:
        doc.close()


# ---------- model calls (patched in tests) ----------
def call_vision_model(png_bytes: bytes) -> str:
    if os.getenv("AP_AI_ENGINE", "ollama").strip().lower() == "gemini" and os.getenv("GEMINI_API_KEY"):
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore

        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        resp = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            contents=[
                types.Part.from_bytes(data=png_bytes, mime_type="image/png"),
                PROMPT,
            ],
            config={"response_mime_type": "application/json", "temperature": 0},
        )
        return resp.text or "{}"

    from langchain_core.messages import HumanMessage
    from langchain_ollama import ChatOllama

    llm = ChatOllama(
        model=os.getenv("OLLAMA_VISION_MODEL", "qwen2.5vl:3b"),
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        temperature=0,
        format=InvoiceExtractionSchema.model_json_schema(),
        num_ctx=int(os.getenv("OLLAMA_VISION_NUM_CTX", "4096")),
        keep_alive=os.getenv("OLLAMA_VISION_KEEP_ALIVE", "30s"),
        client_kwargs={"timeout": float(os.getenv("OLLAMA_VISION_TIMEOUT", "180"))},
    )
    b64 = base64.b64encode(png_bytes).decode()
    msg = HumanMessage(
        content=[
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ]
    )
    return str(llm.invoke([msg]).content)


def call_text_invoice_model(document_text: str) -> str:
    """Fast structured extraction for digital PDFs with selectable text."""
    if os.getenv("AP_AI_ENGINE", "ollama").strip().lower() == "gemini" and os.getenv("GEMINI_API_KEY"):
        from google import genai  # type: ignore

        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        resp = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
            contents=f"{PROMPT}\n\nInvoice text:\n{document_text[:6000]}",
            config={"response_mime_type": "application/json", "temperature": 0},
        )
        return resp.text or "{}"

    from langchain_core.messages import HumanMessage
    from langchain_ollama import ChatOllama

    llm = ChatOllama(
        model=os.getenv("OLLAMA_MODEL", "qwen3:4b"),
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        temperature=0,
        format=InvoiceExtractionSchema.model_json_schema(),
        client_kwargs={"timeout": float(os.getenv("OLLAMA_TEXT_TIMEOUT", "90"))},
    )
    msg = HumanMessage(content=f"{PROMPT}\n\nInvoice text:\n{document_text[:6000]}")
    return str(llm.invoke([msg]).content)


# ---------- parsing / normalisation ----------
def parse_model_output(text: str) -> dict[str, Any]:
    """Tolerate code fences and stray prose around the JSON object."""
    text = re.sub(r"```(?:json)?", "", text or "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        obj = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {}
    return obj if isinstance(obj, dict) else {}


def _to_float(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return round(float(v), 2)
    s = re.sub(r"[^\d.,\-]", "", str(v))
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", "") if re.fullmatch(r"-?\d{1,3}(,\d{3})+", s) else s.replace(",", ".")
    try:
        return round(float(s), 2)
    except ValueError:
        return None


_DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y", "%d/%m/%y"]


def _to_date(v: Any) -> str | None:
    if v is None or not str(v).strip():
        return None
    s = str(v).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return s


def _to_currency(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip().upper().replace(".", "")
    if s in {"KES", "KSH", "KSHS", "KENYAN SHILLING", "KENYA SHILLINGS"}:
        return "KES"
    if s in {"USD", "$", "US$", "US DOLLAR", "US DOLLARS"}:
        return "USD"
    return s or None


def _to_str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return None if s.lower() in {"", "null", "none", "n/a"} else s


def normalize_extraction(d: dict[str, Any]) -> dict[str, Any]:
    raw_items = d.get("line_items") if isinstance(d.get("line_items"), list) else []
    line_items = [
        {
            "description": str(item.get("description") or "").strip(),
            "quantity": _to_float(item.get("quantity")),
            "unit_price": _to_float(item.get("unit_price")),
            "tax_rate": _to_str(item.get("tax_rate")),
            "line_total": _to_float(item.get("line_total")),
        }
        for item in raw_items
        if isinstance(item, dict) and str(item.get("description") or "").strip()
    ]
    doc_type = "receipt" if str(d.get("document_type") or "").strip().lower() == "receipt" else "invoice"
    out: dict[str, Any] = {
        "document_type": doc_type,
        "invoice_number": _to_str(d.get("invoice_number")),
        "po_number": _to_str(d.get("po_number")),
        "payment_ref": _to_str(d.get("payment_ref")),
        "vendor_name": _to_str(d.get("vendor_name")),
        "kra_pin": _to_str(d.get("kra_pin")),
        "currency": _to_currency(d.get("currency")),
        "invoice_date": _to_date(d.get("invoice_date")),
        "etims_cu": _to_str(d.get("etims_cu")),
        "subtotal": _to_float(d.get("subtotal")),
        "vat": _to_float(d.get("vat")),
        "total": _to_float(d.get("total")),
        "line_items": line_items,
        "extraction_notes": _to_str(d.get("extraction_notes")),
    }
    if out["invoice_number"]:
        out["invoice_number"] = out["invoice_number"].upper()
    if out["po_number"]:
        out["po_number"] = out["po_number"].upper()
    if out["payment_ref"]:
        out["payment_ref"] = out["payment_ref"].upper()
    if out["etims_cu"]:
        out["etims_cu"] = out["etims_cu"].upper()
    if out["kra_pin"]:
        out["kra_pin"] = out["kra_pin"].upper()
    return out


# ---------- deterministic validation ----------
def _chk(code: str, severity: str, message: str, policy_id: str | None = None) -> dict[str, str]:
    out = {"code": code, "severity": severity, "message": message}
    if policy_id:
        out["policy_id"] = policy_id
    return out


def validate_invoice_draft(fields: dict[str, Any], sha256: str | None, db_path: Path | None = None) -> list[dict[str, str]]:
    """severity 'error' blocks creation; 'warn' is shown to the reviewer who may still confirm."""
    checks: list[dict[str, str]] = []
    is_receipt = fields.get("document_type") == "receipt"

    for f in REQUIRED:
        if fields.get(f) in (None, ""):
            checks.append(_chk("MISSING_FIELD", "error", f"Required field '{f}' is missing or unreadable."))
    if fields.get("currency") and fields["currency"] not in {"KES", "USD"}:
        checks.append(_chk("BAD_CURRENCY", "error", f"Currency '{fields['currency']}' is not KES or USD."))
    total = fields.get("total")
    if total is not None and total <= 0:
        checks.append(_chk("BAD_AMOUNT", "error", f"Total {total} must be greater than zero."))
    d = fields.get("invoice_date")
    if d and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
        checks.append(_chk("BAD_DATE", "error", f"Date '{d}' could not be read as a valid date.", "POL-MATCH-007"))
    elif d:
        try:
            datetime.strptime(d, "%Y-%m-%d")
        except ValueError:
            checks.append(_chk("BAD_DATE", "error", f"Date '{d}' is not a real calendar date.", "POL-MATCH-007"))

    if not is_receipt and fields.get("currency") == "KES" and not is_valid_etims_cu(fields.get("etims_cu")):
        checks.append(
            _chk(
                "ETIMS_CU_UNVERIFIED",
                "warn",
                "Missing or invalid KRA eTIMS Control Unit number (expected KRA-CU-XXXXXXXX).",
                "POL-TAX-007",
            )
        )

    if fields.get("kra_pin") and not is_valid_kra_pin(fields.get("kra_pin")):
        checks.append(
            _chk("BAD_KRA_PIN", "warn", f"KRA PIN '{fields['kra_pin']}' does not match P/A + 9 digits + letter format.", "POL-TAX-008")
        )

    sub, vat = fields.get("subtotal"), fields.get("vat")
    if not is_receipt and sub is not None and vat is not None and total is not None and abs(sub + vat - total) > 1.0:
        checks.append(
            _chk(
                "TOTAL_MISMATCH",
                "error",
                f"Subtotal {sub} + VAT {vat} = {round(sub + vat, 2)}, but total reads {total} (POL-CTRL-004).",
                "POL-CTRL-004",
            )
        )
    elif not is_receipt and sub is not None and vat is not None and sub > 0 and abs(vat / sub - 0.16) > 0.005 and vat != 0:
        checks.append(
            _chk(
                "UNUSUAL_VAT",
                "warn",
                f"VAT is {round(vat / sub * 100, 1)}% of subtotal (Kenya standard rate is 16%; check mixed exempt lines).",
                "POL-TAX-002",
            )
        )

    with get_conn(db_path) as conn:
        if not is_receipt and fields.get("invoice_number"):
            if conn.execute("SELECT 1 FROM invoices WHERE UPPER(invoice_number)=UPPER(?)", (fields["invoice_number"],)).fetchone():
                checks.append(
                    _chk("DUPLICATE_INVOICE_NUMBER", "error", f"Invoice {fields['invoice_number']} already exists in the ledger.", "POL-CTRL-003")
                )
        if sha256 and conn.execute("SELECT invoice_number FROM intake_documents WHERE sha256=?", (sha256,)).fetchone():
            checks.append(_chk("DUPLICATE_FILE", "error", "This exact file SHA-256 was already ingested.", "POL-CTRL-003"))
        if fields.get("vendor_name") and total and fields.get("currency"):
            dup = conn.execute(
                """SELECT invoice_number FROM invoices
                   WHERE LOWER(vendor_name)=LOWER(?) AND currency=? AND ABS(amount-?)<0.01
                     AND UPPER(invoice_number)!=UPPER(COALESCE(?, ''))""",
                (fields["vendor_name"], fields["currency"], total, fields.get("invoice_number")),
            ).fetchone()
            if dup:
                checks.append(_chk("POSSIBLE_DUPLICATE", "warn", f"Same vendor and amount as existing invoice {dup['invoice_number']}."))

        po_num = fields.get("po_number")
        if not po_num:
            checks.append(_chk("NO_PO_ON_INVOICE", "warn", "No PO number on document; reconciliation will flag as non-PO exception.", "POL-CTRL-005"))
        else:
            po = conn.execute("SELECT * FROM purchase_orders WHERE UPPER(po_number)=UPPER(?)", (po_num,)).fetchone()
            if not po:
                checks.append(_chk("PO_NOT_FOUND", "warn", f"PO {po_num} is not in the ledger; invoice will be saved without a PO link."))
            else:
                v = fields.get("vendor_name")
                score, band = vendor_similarity(v, po["vendor_name"])
                if band == "mismatch":
                    checks.append(
                        _chk("PO_VENDOR_MISMATCH", "warn", f"Invoice vendor '{v}' differs from PO vendor '{po['vendor_name']}' (similarity {score}%).", "POL-MATCH-008")
                    )
                elif band == "low_confidence":
                    checks.append(
                        _chk("PO_VENDOR_LOW_CONFIDENCE", "warn", f"Fuzzy vendor match '{v}' vs PO '{po['vendor_name']}' scored {score}% (<82%); confirm vendor identity.", "POL-MATCH-008")
                    )
                if fields.get("kra_pin") and po["kra_pin"] and fields["kra_pin"] != po["kra_pin"].upper():
                    checks.append(
                        _chk("KRA_PIN_MISMATCH", "warn", f"Invoice KRA PIN {fields['kra_pin']} differs from PO master {po['kra_pin']}.", "POL-TAX-008")
                    )
                if fields.get("currency") and fields["currency"] != po["currency"]:
                    checks.append(_chk("PO_CURRENCY_MISMATCH", "warn", f"Invoice currency {fields['currency']} differs from PO currency {po['currency']}.", "POL-MATCH-005"))
                elif total and total > float(po["authorized_amount"]) + 1e-9:
                    checks.append(_chk("OVER_PO_AMOUNT", "warn", f"Total {total} exceeds PO authorized amount {po['authorized_amount']}.", "POL-MATCH-001"))
    return checks
