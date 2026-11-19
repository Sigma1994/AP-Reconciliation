"""Score the local vision model on labelled invoice images (samples/*.png|jpg with sibling .json).

    ollama pull qwen2.5vl:3b
    python -m scripts.make_sample_invoices
    python -m scripts.eval_vision
    OLLAMA_VISION_MODEL=minicpm-v python -m scripts.eval_vision     # compare models

Reports per-field exact-match, numeric-field accuracy, latency (avg/p95), arithmetic catch rate,
and a Markdown table ready to paste into README.md.
"""
import json
import os
import statistics
import time
from pathlib import Path

from src import intake

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
NUMERIC = {"subtotal", "vat", "total"}
EVAL_FIELDS = [f for f in intake.FIELDS if f != "etims_cu"]  # compatible with existing sample .json files


def same(field: str, got, exp) -> bool:
    if exp is None:
        return got is None
    if field in NUMERIC:
        return got is not None and abs(float(got) - float(exp)) < 0.01
    if field == "vendor_name":
        return bool(got) and got.strip().lower() == str(exp).strip().lower()
    return got == exp


def main() -> None:
    images = sorted(p for p in SAMPLES.glob("*") if p.suffix in {".png", ".jpg", ".jpeg", ".webp"})
    if not images:
        raise SystemExit("No samples found. Run: python -m scripts.make_sample_invoices")
    model = os.getenv("OLLAMA_VISION_MODEL", "qwen2.5vl:3b")
    print(f"Model: {model}   max_side={os.getenv('INTAKE_MAX_SIDE', '1344')}\n")

    hits = {f: 0 for f in EVAL_FIELDS}
    n = failures = caught = misread_total = 0
    times: list[float] = []

    for img in images:
        expected = json.loads(img.with_suffix(".json").read_text())
        fields_in_sample = [f for f in EVAL_FIELDS if f in expected]
        t0 = time.perf_counter()
        try:
            got = intake.normalize_extraction(
                intake.parse_model_output(
                    intake.call_vision_model(intake.prepare_image(img.read_bytes()))
                )
            )
        except Exception as e:
            print(f"{img.name:<26} FAILED: {type(e).__name__}: {str(e)[:80]}")
            failures += 1
            continue
        dt = time.perf_counter() - t0
        times.append(dt)
        n += 1
        wrong = [f for f in fields_in_sample if not same(f, got.get(f), expected[f])]
        for f in fields_in_sample:
            hits[f] += f not in wrong
        if any(f in NUMERIC for f in wrong):
            misread_total += 1
            s, v, t = got.get("subtotal"), got.get("vat"), got.get("total")
            if None in (s, v, t) or abs(s + v - t) > 1.0:
                caught += 1
        print(
            f"{img.name:<26} {dt:5.1f}s  "
            f"{'all fields OK' if not wrong else 'WRONG: ' + ', '.join(f'{f}={got.get(f)!r} (exp {expected[f]!r})' for f in wrong)}"
        )

    if not n:
        raise SystemExit("\nNo images processed (is Ollama running and the model pulled?)")

    print("\nField accuracy:")
    for f in EVAL_FIELDS:
        print(f"  {f:<15} {hits[f]}/{n}")

    total_field_hits = sum(hits.values())
    total_fields = n * len(EVAL_FIELDS)
    overall_acc = total_field_hits / total_fields
    num_hits = sum(hits[f] for f in NUMERIC)
    num_acc = num_hits / (n * len(NUMERIC))
    avg_s = sum(times) / len(times)
    p95_s = sorted(times)[max(0, int(0.95 * len(times)) - 1)]
    catch_str = f"{caught}/{misread_total} ({caught / misread_total:.0%})" if misread_total else "n/a (0 misreads)"

    print(f"\nOverall field exact: {total_field_hits}/{total_fields} = {overall_acc:.1%}")
    print(f"Numeric fields exact: {num_hits}/{n * len(NUMERIC)} = {num_acc:.1%}")
    print(f"Misread invoices caught by arithmetic check: {catch_str}")
    print(f"Latency: avg={avg_s:.1f}s  p50={statistics.median(times):.1f}s  p95={p95_s:.1f}s  (failures: {failures})")

    print("\n-- Markdown row for README.md --")
    print("| Model | Field Accuracy | Numeric Accuracy | Avg Latency (s/img) | Misreads Caught by Arithmetic Check |")
    print("|---|---:|---:|---:|---:|")
    print(f"| `{model}` | {overall_acc:.1%} | {num_acc:.1%} | {avg_s:.1f}s | {catch_str} |")


if __name__ == "__main__":
    main()
