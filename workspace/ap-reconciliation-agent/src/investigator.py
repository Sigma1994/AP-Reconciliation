"""AI Investigation Agent: grounds reconciliation variances in SQLite ledger data + Policy Vector DB citations."""
import json
import os
from pathlib import Path
import re
from typing import Any

from src.vector_store import PolicyVectorStore

INVESTIGATOR_PROMPT_VERSION = "ap-investigator-v1"


def build_rag_query(report: dict[str, Any]) -> str:
    inv = report.get("invoice") or {}
    po = report.get("purchase_order") or {}
    parts = [
        f"Vendor: {inv.get('vendor_name') or 'unknown'}",
        f"PO: {po.get('po_number')} {po.get('vendor_name')}" if po else "Missing PO",
        (
            f"Currency: {inv.get('currency')}, Invoice: {report.get('invoice_amount')}, "
            f"Paid: {report.get('paid_amount')}, Variance: {report.get('variance_amount')} ({report.get('variance_pct')}%)"
        ),
        f"Tax rule: {report.get('tax_rule_applied') or 'none'}",
        " ".join(report.get("blocking_flags") or []),
        " ".join(report.get("flags") or []),
    ]
    return "\n".join(p for p in parts if p)


def _deterministic_brief(report: dict[str, Any], retrieved: list[dict[str, Any]]) -> dict[str, Any]:
    """Policy-grounded deterministic synthesis used when USE_DETERMINISTIC_LLM=1 or LLM is offline."""
    inv = report.get("invoice") or {}
    inv_no = inv.get("invoice_number") or "Unknown"
    currency = inv.get("currency") or "KES"
    variance = report.get("variance_amount", 0)
    tax_rule = report.get("tax_rule_applied")
    blocking = report.get("blocking_flags") or []
    flags = report.get("flags") or []
    retrieved_ids = {p["policy_id"]: p for p in retrieved}

    cited: list[dict[str, str]] = []
    for p in retrieved[:4]:
        cited.append(
            {
                "policy_id": p["policy_id"],
                "title": p["title"],
                "relevance_reason": f"Retrieved via Vector DB (score {p['similarity_score']}) for {inv.get('vendor_name') or 'transaction'}.",
            }
        )

    if blocking:
        root_cause = f"Hard guardrail block: {blocking[0]}"
        explanation = " ".join(blocking)
        rec_action = "reject"
        confidence = "High"
        note = f"Blocked {inv_no}: {blocking[0]}"
    elif tax_rule == "whvat_2pct":
        root_cause = f"Valid 2% Withholding VAT deduction ({currency} {report.get('expected_withheld_amount')})"
        explanation = (
            f"Settled payments are short by {currency} {variance}, matching 2% Kenyan WHVAT on the net taxable subtotal. "
            "Confirm the KRA iTax WHVAT certificate before approving."
        )
        rec_action = "approve"
        confidence = "High"
        note = f"Verified 2% WHVAT deduction on {inv_no} per {', '.join(c['policy_id'] for c in cited[:2])}."
    elif tax_rule == "wht_5pct":
        root_cause = f"Valid 5% Resident WHT deduction ({currency} {report.get('expected_withheld_amount')})"
        explanation = (
            f"Settled payments are short by {currency} {variance}, matching mandatory 5% Resident WHT on professional/legal fees. "
            "Confirm WHT certificate before approving."
        )
        rec_action = "approve"
        confidence = "High"
        note = f"Verified 5% Resident WHT deduction on {inv_no} per {', '.join(c['policy_id'] for c in cited[:2])}."
    elif tax_rule == "wht_3pct":
        root_cause = f"Valid 3% Contractual WHT deduction ({currency} {report.get('expected_withheld_amount')})"
        explanation = f"Short-payment of {currency} {variance} matches 3% engineering/contractual WHT on net value."
        rec_action = "approve"
        confidence = "High"
        note = f"Verified 3% Contractual WHT deduction on {inv_no}."
    elif not flags:
        root_cause = "Clean 3-way match within policy tolerance"
        explanation = f"Invoice {inv_no}, PO, and settled payments match within Kenyan AP tolerance controls."
        rec_action = "approve"
        confidence = "High"
        note = f"Auto-cleared {inv_no} after passing all deterministic checks."
    else:
        root_cause = flags[0]
        explanation = " ".join(flags)
        rec_action = "hold"
        confidence = "Medium"
        note = f"Held {inv_no} for review: {flags[0]}"

    # Ensure cited list always contains valid retrieved policy IDs
    cited = [c for c in cited if c["policy_id"] in retrieved_ids]
    return {
        "root_cause": root_cause,
        "explanation": explanation,
        "recommended_action": rec_action,
        "confidence_label": confidence,
        "cited_policies": cited,
        "draft_audit_note": note,
        "engine": "deterministic_policy_synthesizer",
    }


def _extract_json_obj(text: str) -> dict[str, Any]:
    cleaned = re.sub(r"```(?:json)?", "", text or "").strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        return {}
    try:
        obj = json.loads(cleaned[start : end + 1])
        return obj if isinstance(obj, dict) else {}
    except json.JSONDecodeError:
        return {}


def investigate_variance(
    report: dict[str, Any],
    db_path: Path | None = None,
    top_k: int = 6,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Run Stage 3 (Vector DB Policy Retrieval) + Stage 4 (AI Investigation Brief synthesis).

    Returns (rag_result, investigation_brief).
    """
    store = PolicyVectorStore(db_path)
    rag_query = build_rag_query(report)
    rag_result = store.search(rag_query, top_k=top_k)
    retrieved = rag_result["hits"]

    if os.getenv("USE_DETERMINISTIC_LLM", "0").strip().lower() in {"1", "true", "yes"}:
        return rag_result, _deterministic_brief(report, retrieved)

    payload = {
        "invoice": report.get("invoice"),
        "purchase_order": report.get("purchase_order"),
        "payments": report.get("payments"),
        "variance_amount": report.get("variance_amount"),
        "variance_pct": report.get("variance_pct"),
        "tax_rule_applied": report.get("tax_rule_applied"),
        "vendor_match_score": report.get("vendor_match_score"),
        "flags": report.get("flags"),
        "blocking_flags": report.get("blocking_flags"),
        "retrieved_company_policies": [
            {
                "policy_id": p["policy_id"],
                "title": p["title"],
                "vendor_scope": p["vendor_scope"],
                "similarity_score": p["similarity_score"],
                "rule_text": p["rule_text"],
            }
            for p in retrieved
        ],
    }

    system_msg = (
        "You are a Senior Kenyan B2B Accounts Payable Investigation Agent. "
        "Synthesize an InvestigationBrief JSON object with keys: "
        "root_cause (string), explanation (string), recommended_action ('approve'|'hold'|'reject'), "
        "confidence_label ('High'|'Medium'|'Low'), cited_policies ([{policy_id, title, relevance_reason}]), "
        "draft_audit_note (string). Cite ONLY policy_id values present in retrieved_company_policies. "
        "If blocking_flags is non-empty, recommended_action MUST be 'reject'."
    )

    raw_text = ""
    used_engine = "deterministic_policy_synthesizer"
    engine_pref = os.getenv("AP_AI_ENGINE", "ollama").strip().lower()

    try:
        if engine_pref == "gemini" and os.getenv("GEMINI_API_KEY"):
            from google import genai  # type: ignore

            client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
            model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
            resp = client.models.generate_content(
                model=model,
                contents=f"{system_msg}\n\nCase payload:\n{json.dumps(payload, default=str)}",
                config={"response_mime_type": "application/json", "temperature": 0},
            )
            raw_text = resp.text or ""
            used_engine = f"gemini:{model}"
        elif os.getenv("OLLAMA_BASE_URL"):
            from langchain_ollama import ChatOllama  # type: ignore

            model = os.getenv("OLLAMA_MODEL", "qwen3:4b")
            llm = ChatOllama(
                model=model,
                base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
                temperature=0,
                format="json",
                client_kwargs={"timeout": float(os.getenv("OLLAMA_TEXT_TIMEOUT", "90"))},
            )
            raw_text = str(llm.invoke([("system", system_msg), ("human", json.dumps(payload, default=str))]).content)
            used_engine = f"ollama:{model}"
    except Exception:
        raw_text = ""

    parsed = _extract_json_obj(raw_text)
    if not parsed:
        return rag_result, _deterministic_brief(report, retrieved)

    valid_ids = {p["policy_id"]: p["title"] for p in retrieved}
    raw_cited = parsed.get("cited_policies") if isinstance(parsed.get("cited_policies"), list) else []
    clean_cited = [
        {
            "policy_id": c["policy_id"],
            "title": c.get("title") or valid_ids[c["policy_id"]],
            "relevance_reason": c.get("relevance_reason") or "Cited by investigation agent.",
        }
        for c in raw_cited
        if isinstance(c, dict) and c.get("policy_id") in valid_ids
    ]

    if report.get("blocking_flags"):
        action = "reject"
    elif parsed.get("recommended_action") in {"approve", "hold", "reject"}:
        action = parsed["recommended_action"]
    else:
        action = "hold"

    conf = parsed.get("confidence_label") if parsed.get("confidence_label") in {"High", "Medium", "Low"} else "Medium"
    fallback = _deterministic_brief(report, retrieved)
    return rag_result, {
        "root_cause": str(parsed.get("root_cause") or fallback["root_cause"]),
        "explanation": str(parsed.get("explanation") or fallback["explanation"]),
        "recommended_action": action,
        "confidence_label": conf,
        "cited_policies": clean_cited or fallback["cited_policies"],
        "draft_audit_note": str(parsed.get("draft_audit_note") or fallback["draft_audit_note"]),
        "engine": used_engine,
    }
