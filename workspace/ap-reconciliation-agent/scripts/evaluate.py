"""Evaluation suite:
1. Supplier document / remittance parsing (Clean Baseline vs Messy OCR/Unstructured Split)
2. Vector DB Policy RAG retrieval recall across Kenyan AP policy scenarios
3. Deterministic policy routing accuracy on the seeded SQLite ledger

Usage:
    python -m scripts.evaluate                # full suite (Ollama if reachable)
    python -m scripts.evaluate --no-ollama    # deterministic + Vector DB RAG + routing eval
"""
import argparse
import json
import os
from pathlib import Path
import re
import statistics
import tempfile
import time

from src.db import init_db
from src.graph import get_compiled_reconciliation_graph
from src.nodes import _llm, extract_input
from src.state import ReconciliationInput
from src.vector_store import PolicyVectorStore

# Clean baseline (10 cases)
PARSE_CASES = [
    ("Reconcile INV-9001 against MPESA-QKL8821 KES", "INV-9001", "MPESA-QKL8821", "KES"),
    ("Tax Invoice INV-9002 settled via WIRE-USD-441 (USD 1,450)", "INV-9002", "WIRE-USD-441", "USD"),
    ("Apex Security Systems INV-9003, wire ref WIRE-USD-986, USD", "INV-9003", None, "USD"),
    ("Check invoice INV-9006 - paid by mpesa-rzp1104, Ksh 58,000", "INV-9006", "MPESA-RZP1104", "KES"),
    ("Split settlement INV-9007: EFT-90110 and EFT-90111 KES", "INV-9007", "EFT-90110", "KES"),
    ("Is INV-9008 settled? Coastline Clearing says KES 50,000 sent", "INV-9008", None, "KES"),
    ("AP batch: INV-9004 / EFT-77319", "INV-9004", "EFT-77319", None),
    ("Legal retainer invoice INV-9005 KES 116,000", "INV-9005", None, "KES"),
    ("Please confirm USD $1,450 cloud invoice INV-9002", "INV-9002", None, "USD"),
    ("Unlabeled supplier statement without invoice or payment ref", None, None, None),
]

# Messy real-world OCR & AP email notes ("Where Regex Breaks" - 15 cases)
MESSY_PARSE_CASES = [
    ("ACACIA HDW tax bill no 9001 cleared on M-Pesa QKL8821 after 2% WHVAT (Ksh)", "INV-9001", "MPESA-QKL8821", "KES"),
    ("Bank advice: Savannah Steel invoice 9006 paid via Mpesa ref RZP1104 in Kenyan shillings.", "INV-9006", "MPESA-RZP1104", "KES"),
    ("Rift Valley Cloud Services USD 1,450 wire USD 441 for bill 9002", "INV-9002", "WIRE-USD-441", "USD"),
    ("Mombasa Logistics Ltd inv#9004, EFT 77319 remitted KES 215,000", "INV-9004", "EFT-77319", "KES"),
    ("Pls verify inv no 9005 — paid via EFT 88201, Kshs 111,000 net of 5% WHT.", "INV-9005", "EFT-88201", "KES"),
    ("Tranche 1 and 2 for bill 9007 settled via EFT 90110 and 90111 in KES", "INV-9007", "EFT-90110", "KES"),
    ("Coastline Clearing remittance advice KES 50,000 for supplier bill 9008", "INV-9008", None, "KES"),
    ("Kilimani Print invoice #9009 settled via Mpesa KPS3310 (KSh 34,800).", "INV-9009", "MPESA-KPS3310", "KES"),
    ("Wire ref USD-441 confirmed by bank for Rift Valley bill #9002 in US dollars.", "INV-9002", "WIRE-USD-441", "USD"),
    ("Fwd: Verify whether invoce 9004 cleared under EFT77319.", "INV-9004", "EFT-77319", None),
    ("Acacia HDW thermal receipt 9001 matched to M-Pesa confirmation QKL8821 (Ksh).", "INV-9001", "MPESA-QKL8821", "KES"),
    ("Legal fee claim #9005 — KES one hundred sixteen thousand, EFT ref 88201.", "INV-9005", "EFT-88201", "KES"),
    ("US dollar wire USD-441 settled Rift Valley invoice 9002.", "INV-9002", "WIRE-USD-441", "USD"),
    ("Split EFT 90110 started settlement for Eldoret Agrovet 9007 in Kenyan Shillings.", "INV-9007", "EFT-90110", "KES"),
    ("Vendor statement inquiry without invoice number or remittance code.", None, None, None),
]

RAG_EVAL_CASES = [
    ("ACACIA HDW invoice INV-9001 short paid by 2% WHVAT via MPESA-QKL8821", {"SOP-VEND-001", "POL-TAX-003"}),
    ("Nairobi Legal & Advisory LLP retainer short paid by 5% Resident WHT", {"SOP-VEND-006", "POL-TAX-004"}),
    ("Mombasa Logistics Ltd port demurrage freight short payment KES 17,000", {"SOP-VEND-002"}),
    ("Rift Valley Cloud Services USD 1,450 wire high value supervisor approval", {"SOP-VEND-003", "POL-CTRL-001"}),
    ("Duplicate file SHA-256 hash or subtotal + VAT arithmetic mismatch", {"POL-CTRL-003", "POL-CTRL-004"}),
]

ROUTE_CASES = {
    "INV-9006": "auto",     # Savannah Steel KES 58,000 exact match
    "INV-9007": "auto",     # Eldoret Agrovet KES 74,500 split EFT match
    "INV-9009": "auto",     # Kilimani Print KES 34,800 exact match
    "INV-9001": "human",    # Acacia 2% WHVAT + abbreviated header
    "INV-9002": "human",    # Rift Valley Cloud >= USD 1,000 high value
    "INV-9004": "human",    # Mombasa Logistics KES 17k demurrage variance + high value
    "INV-9005": "human",    # Nairobi Legal 5% Resident WHT
    "INV-9008": "human",    # Coastline Clearing missing PO + variance
    "INV-9003": "blocked",  # Apex Security KES invoice vs USD payment currency mismatch
    "INV-0000": "blocked",  # Unknown invoice
}

PARSER_SYSTEM_PROMPT = (
    "Extract invoice_number (normalize e.g. '9001' -> 'INV-9001'), "
    "payment_ref (normalize e.g. 'mpesa QKL8821' -> 'MPESA-QKL8821', 'EFT 77319' -> 'EFT-77319', "
    "'wire USD 441' -> 'WIRE-USD-441'), and currency ('KES' or 'USD'). Return JSON only."
)


def _norm(val: str | None) -> str | None:
    return val.strip().upper() if isinstance(val, str) and val.strip() else None


def score(parsed: ReconciliationInput, exp) -> tuple[int, int]:
    got = (_norm(parsed.invoice_number), _norm(parsed.payment_ref), _norm(parsed.currency))
    return sum(g == e for g, e in zip(got, exp[1:])), 3


def _ollama_parse(llm, text: str) -> ReconciliationInput:
    resp = str(llm.invoke([("system", PARSER_SYSTEM_PROMPT), ("human", text)]).content)
    cleaned = re.sub(r"```(?:json)?", "", resp).strip()
    obj = json.loads(cleaned[cleaned.find("{") : cleaned.rfind("}") + 1])
    return ReconciliationInput.model_validate({**obj, "notes": text})


def _hybrid_parse(llm, text: str) -> tuple[ReconciliationInput, bool]:
    try:
        out = _ollama_parse(llm, text)
        if not out.invoice_number and not out.payment_ref:
            return extract_input(text), True
        return out, False
    except Exception:
        return extract_input(text), True


def _run_split(split_name: str, cases: list[tuple], parsers: dict) -> list[dict]:
    print(f"\n== Parser accuracy: {split_name} ({len(cases)} cases, 3 fields/case) ==")
    rows = []
    for name, fn in parsers.items():
        hit = tot = fallbacks = 0
        latencies_ms: list[float] = []
        for case in cases:
            t0 = time.perf_counter()
            used_fb = False
            try:
                res = fn(case[0])
                parsed, used_fb = res if isinstance(res, tuple) else (res, False)
                h, t = score(parsed, case)
            except Exception:
                h, t = 0, 3
                used_fb = True
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)
            hit, tot = hit + h, tot + t
            fallbacks += int(used_fb)

        acc = hit / tot
        p50 = statistics.median(latencies_ms)
        p95 = sorted(latencies_ms)[max(0, int(0.95 * len(latencies_ms)) - 1)]
        fb_rate = fallbacks / len(cases)
        print(
            f"{name:<28} {hit:>2}/{tot:<2} = {acc:>5.1%}  "
            f"p50={p50:>6.1f}ms  p95={p95:>6.1f}ms  fallback={fb_rate:.0%}"
        )
        rows.append(
            {
                "split": split_name,
                "parser": name,
                "accuracy": f"{acc:.1%} ({hit}/{tot})",
                "p50_ms": f"{p50:.1f}",
                "p95_ms": f"{p95:.1f}",
                "fallback": f"{fb_rate:.0%}",
            }
        )
    return rows


def eval_parsers(use_ollama: bool) -> None:
    parsers: dict = {"deterministic (regex)": extract_input}
    if use_ollama:
        model = os.getenv("OLLAMA_MODEL", "qwen3:4b")
        try:
            llm = _llm().bind(format=ReconciliationInput.model_json_schema())
            llm.invoke([("human", "ping INV-1")])
            parsers[f"ollama:{model}"] = lambda t: _ollama_parse(llm, t)
            parsers[f"hybrid:{model}+regex"] = lambda t: _hybrid_parse(llm, t)
        except Exception as e:
            print(f"(Ollama unavailable, skipping LLM parsers: {type(e).__name__})")

    all_rows = _run_split("Clean Baseline", PARSE_CASES, parsers)
    all_rows += _run_split("Messy Real-World (OCR & Email Notes)", MESSY_PARSE_CASES, parsers)

    print("\n-- Markdown table for README.md --")
    print("| Eval Split | Parser | Field Accuracy | p50 (ms) | p95 (ms) | Fallback Rate |")
    print("|---|---|---:|---:|---:|---:|")
    for r in all_rows:
        print(f"| {r['split']} | `{r['parser']}` | {r['accuracy']} | {r['p50_ms']} | {r['p95_ms']} | {r['fallback']} |")


def eval_rag() -> None:
    print("\n== Policy Vector DB Recall@6 on 33 Kenyan AP Policies ==")
    with tempfile.TemporaryDirectory() as d:
        db = init_db(Path(d) / "rag_eval.db")
        store = PolicyVectorStore(db)
        sync = store.sync_embeddings()
        print(f"Indexed {sync['total_policies']} policies via {sync['engine']}")
        hits = 0
        for query, expected_ids in RAG_EVAL_CASES:
            res = store.search(query, top_k=6)
            got_ids = {h["policy_id"] for h in res["hits"]}
            ok = expected_ids.issubset(got_ids)
            hits += int(ok)
            print(f"  expected={sorted(expected_ids)} -> got_top3={[h['policy_id'] for h in res['hits'][:3]]} {'OK' if ok else 'MISS'}")
        print(f"RAG Recall@6: {hits}/{len(RAG_EVAL_CASES)}")


def eval_routing() -> None:
    print("\n== Policy routing accuracy on seeded ledger ==")
    os.environ["USE_DETERMINISTIC_LLM"] = "1"
    with tempfile.TemporaryDirectory() as d:
        db = init_db(Path(d) / "eval.db")
        graph, conn = get_compiled_reconciliation_graph(db, Path(d) / "eval_ckpt.db")
        ok = 0
        for inv, want in ROUTE_CASES.items():
            cfg = {"configurable": {"thread_id": f"eval-{inv}"}}
            graph.invoke({"thread_id": f"eval-{inv}", "idempotency_key": None, "raw_input": inv}, cfg)
            snap = graph.get_state(cfg)
            got = "human" if snap.next else ("auto" if snap.values["outcome_status"] == "reconciled" else "blocked")
            ok += got == want
            print(f"  {inv}  expected={want:<8} got={got:<8} {'OK' if got == want else 'MISMATCH'}")
        conn.close()
    print(f"routing accuracy: {ok}/{len(ROUTE_CASES)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-ollama", action="store_true")
    args = ap.parse_args()
    eval_parsers(use_ollama=not args.no_ollama)
    eval_rag()
    eval_routing()
