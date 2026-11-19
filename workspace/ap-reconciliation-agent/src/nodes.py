"""LangGraph reconciliation nodes: ingest_parser -> matcher_sql -> policy_critic -> ai_investigator -> human_approval -> ledger_finalizer."""
import json
import os
from pathlib import Path
import re
import time
from typing import Any

from langgraph.types import interrupt

from src import db as db_mod
from src import investigator, reconciler
from src.state import ReconciliationInput

PARSER_PROMPT_VERSION = "remittance-parser-v2"


def _llm():
    from langchain_ollama import ChatOllama

    return ChatOllama(
        model=os.getenv("OLLAMA_MODEL", "qwen3:4b"),
        base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
        temperature=0,
        client_kwargs={"timeout": float(os.getenv("OLLAMA_TEXT_TIMEOUT", "60"))},
    )


def extract_input(raw_text: str) -> ReconciliationInput:
    """Deterministic regex baseline extractor for invoice_number, payment_ref, and currency."""
    text = (raw_text or "").strip()

    inv_match = re.search(r"\b(INV[- ]?\d{3,8})\b", text, re.IGNORECASE)
    if not inv_match:
        inv_match = re.search(r"(?:inv(?:oice)?|bill|ankara)\s*(?:no\.?|number|#|:)?\s*(\d{3,8})\b", text, re.IGNORECASE)
    inv_num = None
    if inv_match:
        token = inv_match.group(1).upper().replace(" ", "-")
        inv_num = token if token.startswith("INV") else f"INV-{token}"

    pay_ref = None
    mpesa = re.search(r"\bM-?PESA[- ]?(?:ref|code)?[- :#]*([A-Z0-9]{5,12})\b", text, re.IGNORECASE)
    eft = re.search(r"\bEFT[- ]?(?:ref)?[- :#]*(\d{4,8})\b", text, re.IGNORECASE)
    wire = re.search(r"\bWIRE[- ]?(?:USD[- ]?)?(\d{2,8})\b", text, re.IGNORECASE)
    if mpesa:
        code = mpesa.group(1).upper()
        pay_ref = code if code.startswith("MPESA-") else f"MPESA-{code}"
    elif eft:
        pay_ref = f"EFT-{eft.group(1)}"
    elif wire:
        pay_ref = f"WIRE-USD-{wire.group(1)}"

    currency = None
    if re.search(r"\bUSD\b|\$|US\s*dollars?", text, re.IGNORECASE):
        currency = "USD"
    elif re.search(r"\bKES\b|\bKSHS?\b|\bshillings?\b|\bsh\s+\d", text, re.IGNORECASE):
        currency = "KES"

    return ReconciliationInput(invoice_number=inv_num, payment_ref=pay_ref, currency=currency, notes=text)


def _llm_extract(raw_text: str) -> tuple[ReconciliationInput, str, bool]:
    """Schema-constrained LLM extraction with 1 repair retry before regex fallback."""
    if os.getenv("USE_DETERMINISTIC_LLM", "0").strip().lower() in {"1", "true", "yes"}:
        return extract_input(raw_text), "deterministic", False

    schema = ReconciliationInput.model_json_schema()
    sys_msg = (
        "Extract invoice_number (e.g. INV-9001), payment_ref (e.g. MPESA-QKL8821, EFT-77319, WIRE-USD-441), "
        "and currency ('KES' or 'USD') from AP text. Reply with JSON only."
    )
    for attempt in range(2):
        try:
            if os.getenv("AP_AI_ENGINE", "ollama").strip().lower() == "gemini" and os.getenv("GEMINI_API_KEY"):
                from google import genai  # type: ignore

                client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
                resp = client.models.generate_content(
                    model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
                    contents=f"{sys_msg}\nText: {raw_text}",
                    config={"response_mime_type": "application/json", "temperature": 0},
                )
                raw = resp.text or "{}"
                src = "gemini"
            else:
                llm = _llm().bind(format=schema)
                prompt = raw_text if attempt == 0 else f"Fix JSON formatting only for: {raw_text}"
                raw = str(llm.invoke([("system", sys_msg), ("human", prompt)]).content)
                src = "ollama"
            cleaned = re.sub(r"```(?:json)?", "", raw).strip()
            obj = json.loads(cleaned[cleaned.find("{") : cleaned.rfind("}") + 1])
            parsed = ReconciliationInput.model_validate({**obj, "notes": raw_text})
            if parsed.invoice_number or parsed.payment_ref:
                return parsed, src, False
        except Exception:
            continue
    return extract_input(raw_text), "deterministic_fallback", True


def ingest_parser_node(state: dict[str, Any], db_path: Path | None = None) -> dict[str, Any]:
    t0 = time.perf_counter()
    parsed, source, fb = _llm_extract(state.get("raw_input", ""))
    latency_ms = (time.perf_counter() - t0) * 1000.0
    parsed_dict = parsed.model_dump()
    db_mod.log_audit(
        state["thread_id"],
        "ingest_parser",
        f"parsed:{source}",
        {**parsed_dict, "latency_ms": round(latency_ms, 2)},
        db_path=db_path,
    )
    db_mod.record_telemetry(
        state["thread_id"],
        "reconcile",
        "ingest_parser",
        source,
        PARSER_PROMPT_VERSION,
        latency_ms,
        fallback_used=fb,
        db_path=db_path,
    )
    return {"parsed": parsed_dict, "parse_source": source}


def matcher_sql_node(state: dict[str, Any], db_path: Path | None = None) -> dict[str, Any]:
    parsed = state.get("parsed") or {}
    inv_no = parsed.get("invoice_number") or state.get("raw_input", "").strip()
    pay_ref = parsed.get("payment_ref")
    report = reconciler.evaluate_match(inv_no, pay_ref, db_path=db_path)
    if "error" in report:
        report = {
            "invoice": {"invoice_number": inv_no, "currency": parsed.get("currency") or "KES", "amount": 0.0, "status": "open"},
            "payments": [],
            "purchase_order": None,
            "invoice_amount": 0.0,
            "paid_amount": 0.0,
            "variance_amount": 0.0,
            "variance_pct": 0.0,
            "tax_rule_applied": None,
            "expected_withheld_amount": 0.0,
            "vendor_match_score": 0,
            "flags": [],
            "blocking_flags": [report["error"]],
        }
    db_mod.log_audit(
        state["thread_id"],
        "matcher_sql",
        "matched",
        {
            "invoice_number": inv_no,
            "paid_amount": report["paid_amount"],
            "variance_amount": report["variance_amount"],
            "payment_count": len(report.get("payments") or []),
        },
        db_path=db_path,
    )
    return {"match_report": report}


def policy_critic_node(state: dict[str, Any], db_path: Path | None = None) -> dict[str, Any]:
    report = state["match_report"]
    blocking = report.get("blocking_flags") or []
    flags = report.get("flags") or []
    if blocking:
        route = "hard_block"
        decision = "blocked"
    elif flags:
        route = "needs_human"
        decision = "needs_human"
    else:
        route = "auto_reconcile"
        decision = "auto_clear"

    db_mod.log_audit(
        state["thread_id"],
        "policy_critic",
        decision,
        {"flags": len(flags), "blocking_flags": len(blocking), "tax_rule": report.get("tax_rule_applied")},
        db_path=db_path,
    )
    return {"route": route}


def ai_investigator_node(state: dict[str, Any], db_path: Path | None = None) -> dict[str, Any]:
    """Retrieve Top-6 Kenyan AP policies from the Vector DB and synthesize an Investigation Brief."""
    t0 = time.perf_counter()
    report = state["match_report"]
    rag_result, brief = investigator.investigate_variance(report, db_path=db_path, top_k=6)
    latency_ms = (time.perf_counter() - t0) * 1000.0
    cited_ids = [c["policy_id"] for c in brief.get("cited_policies") or []]
    db_mod.log_audit(
        state["thread_id"],
        "ai_investigator",
        brief.get("recommended_action", "hold"),
        {
            "embedding_engine": rag_result.get("embedding_engine"),
            "investigator_engine": brief.get("engine"),
            "cited_policies": cited_ids,
            "root_cause": brief.get("root_cause"),
            "latency_ms": round(latency_ms, 2),
        },
        db_path=db_path,
    )
    db_mod.record_telemetry(
        state["thread_id"],
        "reconcile",
        "ai_investigator",
        str(brief.get("engine") or "unknown"),
        investigator.INVESTIGATOR_PROMPT_VERSION,
        latency_ms,
        db_path=db_path,
    )
    return {
        "retrieved_policies": rag_result["hits"],
        "embedding_engine": rag_result["embedding_engine"],
        "investigation": brief,
    }


def human_approval_node(state: dict[str, Any], db_path: Path | None = None) -> dict[str, Any]:
    report = state["match_report"]
    brief = state.get("investigation") or {}
    decision = interrupt(
        {
            "thread_id": state["thread_id"],
            "evidence": {
                "invoice": report.get("invoice"),
                "payments": report.get("payments"),
                "purchase_order": report.get("purchase_order"),
                "variance_amount": report.get("variance_amount"),
                "variance_pct": report.get("variance_pct"),
                "tax_rule_applied": report.get("tax_rule_applied"),
                "vendor_match_score": report.get("vendor_match_score"),
                "flags": report.get("flags", []),
                "blocking_flags": report.get("blocking_flags", []),
            },
            "retrieved_policies": state.get("retrieved_policies", []),
            "investigation": brief,
            "allowed_actions": ["approve", "hold", "reject"],
        }
    )
    d = decision if isinstance(decision, dict) else {}
    action = d.get("action") if d.get("action") in {"approve", "hold", "reject"} else "hold"
    reviewer = str(d.get("reviewer") or "ap-supervisor")
    note = str(d.get("note") or brief.get("draft_audit_note") or f"{action} by {reviewer}")
    db_mod.log_audit(
        state["thread_id"],
        "human_approval",
        action,
        {"reviewer": reviewer, "note": note},
        db_path=db_path,
    )
    return {"human_action": action, "reviewer": reviewer, "review_note": note}


def ledger_finalizer_node(state: dict[str, Any], db_path: Path | None = None) -> dict[str, Any]:
    thread_id = state["thread_id"]
    report = state["match_report"]
    route = state.get("route")
    brief = state.get("investigation") or {}
    retrieved = state.get("retrieved_policies") or []

    if route == "hard_block":
        status = "rejected"
        reason = "; ".join(report.get("blocking_flags") or ["Blocked by deterministic policy control."])
    elif route == "auto_reconcile":
        status = "reconciled"
        reason = brief.get("draft_audit_note") or "Auto-reconciled within Kenyan AP tolerance and 3-way match rules."
    else:
        act = state.get("human_action")
        status = {"approve": "reconciled", "hold": "held", "reject": "rejected"}.get(act or "hold", "held")
        reason = state.get("review_note") or brief.get("draft_audit_note") or f"Human decision: {act}"

    rec_id = reconciler.persist_reconciliation(
        thread_id=thread_id,
        report=report,
        status=status,
        reason_summary=reason,
        idempotency_key=state.get("idempotency_key"),
        retrieved_policies=retrieved,
        investigation=brief,
        db_path=db_path,
    )
    db_mod.log_audit(
        thread_id,
        "ledger_finalizer",
        status,
        {"reconciliation_id": rec_id, "reason": reason},
        db_path=db_path,
    )
    return {
        "reconciliation_id": rec_id,
        "outcome_status": status,
        "final_response": f"Reconciliation {status} (id={rec_id}): {reason}",
    }
