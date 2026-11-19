"""Generate synthetic Kenyan B2B supplier invoice PNGs + JSON labels for scripts.eval_vision."""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"

CASES = [
    {
        "stem": "clean_kes",
        "lines": [
            "ACACIA HARDWARE LTD | KRA PIN: P051234987K",
            "TAX INVOICE: INV-9101",
            "PO Number: PO-4410",
            "Date: 14/11/2026",
            "eTIMS CU: KRA-CU-01948271",
            "1. Galvanized fittings (100 pcs)     KES 65,000.00",
            "2. Heavy-duty site valves (35 pcs)   KES 35,000.00",
            "Subtotal: KES 100,000.00",
            "VAT (16%): KES 16,000.00",
            "TOTAL PAYABLE: KES 116,000.00",
        ],
        "label": {
            "invoice_number": "INV-9101",
            "po_number": "PO-4410",
            "vendor_name": "ACACIA HARDWARE LTD",
            "currency": "KES",
            "invoice_date": "2026-11-14",
            "etims_cu": "KRA-CU-01948271",
            "subtotal": 100000.0,
            "vat": 16000.0,
            "total": 116000.0,
        },
        "blur": False,
        "size": (1000, 680),
    },
    {
        "stem": "tiny_print",
        "lines": [
            "ACACIA HDW NAIROBI",
            "Invoice: INV-9102 | PO: PO-4410",
            "Date: 15/11/2026",
            "eTIMS CU: KRA-CU-01948288",
            "Subtotal: KSh 25,000.00",
            "VAT 16%: KSh 4,000.00",
            "Total: KSh 29,000.00",
        ],
        "label": {
            "invoice_number": "INV-9102",
            "po_number": "PO-4410",
            "vendor_name": "ACACIA HDW NAIROBI",
            "currency": "KES",
            "invoice_date": "2026-11-15",
            "etims_cu": "KRA-CU-01948288",
            "subtotal": 25000.0,
            "vat": 4000.0,
            "total": 29000.0,
        },
        "blur": False,
        "size": (720, 480),
    },
    {
        "stem": "skewed_blur",
        "lines": [
            "NAIROBI LEGAL & ADVISORY LLP",
            "TAX INVOICE INV-9105 | PO-4424",
            "Date: 13/11/2026",
            "eTIMS CU: KRA-CU-01948588",
            "Subtotal: KES 100,000.00",
            "VAT (16%): KES 16,000.00",
            "Total: KES 116,000.00",
        ],
        "label": {
            "invoice_number": "INV-9105",
            "po_number": "PO-4424",
            "vendor_name": "NAIROBI LEGAL & ADVISORY LLP",
            "currency": "KES",
            "invoice_date": "2026-11-13",
            "etims_cu": "KRA-CU-01948588",
            "subtotal": 100000.0,
            "vat": 16000.0,
            "total": 116000.0,
        },
        "blur": True,
        "size": (960, 620),
    },
    {
        "stem": "usd_invoice",
        "lines": [
            "RIFT VALLEY CLOUD SERVICES",
            "INVOICE: INV-9109 | PO: PO-4415",
            "Date: 15/11/2026",
            "Subtotal: USD 1,450.00",
            "VAT: USD 0.00",
            "Total Payable: USD 1,450.00",
        ],
        "label": {
            "invoice_number": "INV-9109",
            "po_number": "PO-4415",
            "vendor_name": "RIFT VALLEY CLOUD SERVICES",
            "currency": "USD",
            "invoice_date": "2026-11-15",
            "etims_cu": None,
            "subtotal": 1450.0,
            "vat": 0.0,
            "total": 1450.0,
        },
        "blur": False,
        "size": (960, 560),
    },
]


def main() -> None:
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for c in CASES:
        w, h = c["size"]
        im = Image.new("RGB", (w, h), "white")
        draw = ImageDraw.Draw(im)
        y = 40
        for line in c["lines"]:
            draw.text((40, y), line, fill="black")
            y += 42
        if c["blur"]:
            im = im.rotate(2.2, expand=True, fillcolor="white").filter(ImageFilter.GaussianBlur(radius=0.8))
        im.save(SAMPLES_DIR / f"{c['stem']}.png")
        (SAMPLES_DIR / f"{c['stem']}.json").write_text(json.dumps(c["label"], indent=2))
    print(f"Generated {len(CASES)} synthetic Kenyan invoice samples in {SAMPLES_DIR}")


if __name__ == "__main__":
    main()
