"""Intake graph: document_extract (image or PDF) -> intake_validator -> [intake_review (interrupt)] -> invoice_writer.

The file bytes are never kept in graph state (checkpoint bloat); state holds the stored file path + sha256.
"""
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt
from typing_extensions import TypedDict

from src import db as db_mod
from src import intake


class IntakeState(TypedDict, total=False):
    thread_id: str
    file_path: str
    sha256: str
    fields: dict[str, Any]
    extraction_error: str | None
    checks: list[dict[str, str]]
    human_action: str | None  # confirm | reject
    reviewer: str | None
    corrections: dict[str, Any] | None
    outcome_status: str  # created | rejected
    final_response: str


def _auto_accept() -> bool:
    return os.getenv("INTAKE_AUTO_ACCEPT", "0").strip().lower() in {"1", "true", "yes"}


def _safe_record_telemetry(
    thread_id: str,
    pipeline: str,
    node_name: str,
    model: str,
    prompt_version: str,
    latency_ms: float,
    *,
    fallback_used: bool = False,
    validation_error: str | None = None,
    human_override: bool = False,
    db_path: Path | None = None,
) -> None:
    fn = getattr(db_mod, "record_telemetry", None)
    if callable(fn):
        fn(
            thread_id,
            pipeline,
            node_name,
            model,
            prompt_version,
            latency_ms,
            fallback_used=fallback_used,
            validation_error=validation_error,
            human_override=human_override,
            db_path=db_path,
        )


def document_extract_node(state: IntakeState, db_path: Path | None = None) -> dict[str, Any]:
    error: str | None = None
    fields = intake.normalize_extraction({})
    t0 = time.perf_counter()
    file_path = Path(state["file_path"])
    model_name = os.getenv("OLLAMA_VISION_MODEL", "qwen2.5vl:3b")
    extraction_mode = "vision"

    try:
        raw_bytes = file_path.read_bytes()
        if file_path.suffix.lower() == ".pdf" or raw_bytes[:4] == b"%PDF":
            pdf_text, pdf_png = intake.extract_pdf_content(raw_bytes)
            if pdf_text is not None:
                extraction_mode = "pdf_text"
                model_name = os.getenv("OLLAMA_MODEL", "qwen3:4b")
                raw = intake.call_text_invoice_model(pdf_text)
            else:
                extraction_mode = "pdf_vision"
                raw = intake.call_vision_model(pdf_png or b"")
        else:
            png = intake.prepare_image(raw_bytes)
            raw = intake.call_vision_model(png)

        parsed = intake.parse_model_output(raw)
        if not parsed:
            error = "Model returned no parseable JSON."
        else:
            fields = intake.normalize_extraction(parsed)
    except Exception as e:
        error = f"{type(e).__name__}: {e}"

    latency_ms = (time.perf_counter() - t0) * 1000.0
    db_mod.log_audit(
        state["thread_id"],
        "document_extract",
        "failed" if error else "extracted",
        {
            "fields": fields,
            "error": error,
            "sha256": state.get("sha256"),
            "mode": extraction_mode,
            "latency_ms": round(latency_ms, 2),
        },
        db_path=db_path,
    )
    _safe_record_telemetry(
        state["thread_id"],
        "intake",
        "document_extract",
        model_name,
        intake.VISION_PROMPT_VERSION,
        latency_ms,
        fallback_used=bool(error),
        validation_error=error,
        db_path=db_path,
    )
    return {"fields": fields, "extraction_error": error}


def intake_validator_node(state: IntakeState, db_path: Path | None = None) -> dict[str, Any]:
    checks = intake.validate_invoice_draft(state.get("fields") or {}, state.get("sha256"), db_path)
    if state.get("extraction_error"):
        checks.insert(
            0,
            intake._chk(
                "EXTRACTION_FAILED",
                "error",
                f"Extraction failed ({state['extraction_error']}). Enter the fields manually or re-upload.",
            ),
        )
    out: dict[str, Any] = {"checks": checks}
    decision = "needs_review"
    if _auto_accept() and not checks:
        out.update(human_action="confirm", reviewer="auto-intake")
        decision = "auto_accepted"
    db_mod.log_audit(state["thread_id"], "intake_validator", decision, {"checks": checks}, db_path=db_path)
    return out


def intake_review_node(state: IntakeState, db_path: Path | None = None) -> dict[str, Any]:
    decision = interrupt(
        {
            "thread_id": state["thread_id"],
            "file_sha256": state.get("sha256"),
            "extracted": state.get("fields"),
            "checks": state.get("checks", []),
            "allowed_actions": ["confirm", "reject"],
            "correctable_fields": intake.FIELDS,
        }
    )
    d = decision if isinstance(decision, dict) else {}
    action = d.get("action") if d.get("action") in {"confirm", "reject"} else "reject"
    reviewer = d.get("reviewer", "ap-clerk")
    corrections = {k: v for k, v in (d.get("corrections") or {}).items() if k in intake.FIELDS}
    db_mod.log_audit(
        state["thread_id"],
        "intake_review",
        action,
        {"reviewer": reviewer, "corrections": corrections},
        db_path=db_path,
    )
    return {"human_action": action, "reviewer": reviewer, "corrections": corrections}


def invoice_writer_node(state: IntakeState, db_path: Path | None = None) -> dict[str, Any]:
    thread_id = state["thread_id"]
    if state.get("human_action") != "confirm":
        msg = f"Intake rejected by {state.get('reviewer') or 'ap-clerk'}; no invoice created."
        db_mod.log_audit(thread_id, "invoice_writer", "rejected", {"message": msg}, db_path=db_path)
        return {"outcome_status": "rejected", "final_response": msg}

    final = intake.normalize_extraction({**(state.get("fields") or {}), **(state.get("corrections") or {})})
    errors = [c for c in intake.validate_invoice_draft(final, state.get("sha256"), db_path) if c["severity"] == "error"]
    if errors:
        msg = "Not created: " + "; ".join(c["message"] for c in errors)
        db_mod.log_audit(thread_id, "invoice_writer", "rejected", {"fields": final, "errors": errors}, db_path=db_path)
        return {"outcome_status": "rejected", "final_response": msg}

    with db_mod.get_conn(db_path) as conn:
        po = conn.execute(
            "SELECT po_number FROM purchase_orders WHERE UPPER(po_number)=UPPER(?)",
            (final.get("po_number") or "",),
        ).fetchone()
        po_number = po["po_number"] if po else None
        conn.execute("BEGIN IMMEDIATE;")
        try:
            conn.execute(
                """
                INSERT INTO invoices (
                    invoice_number, po_number, vendor_name, currency,
                    subtotal, vat, amount, etims_cu, invoice_date, status
                ) VALUES (?,?,?,?,?,?,?,?,?, 'unpaid')
                """,
                (
                    final["invoice_number"],
                    po_number,
                    final["vendor_name"],
                    final["currency"],
                    final.get("subtotal"),
                    final.get("vat"),
                    final["total"],
                    final.get("etims_cu"),
                    final["invoice_date"],
                ),
            )
            conn.execute(
                "INSERT INTO intake_documents (sha256, file_path, thread_id, invoice_number, reviewed_by) VALUES (?,?,?,?,?)",
                (state.get("sha256"), state.get("file_path", ""), thread_id, final["invoice_number"], state.get("reviewer") or "ap-clerk"),
            )
            conn.execute("COMMIT;")
        except sqlite3.IntegrityError as e:
            conn.execute("ROLLBACK;")
            msg = f"Not created: duplicate detected at write time ({e})."
            db_mod.log_audit(thread_id, "invoice_writer", "rejected", {"fields": final, "error": str(e)}, db_path=db_path)
            return {"outcome_status": "rejected", "final_response": msg}
        except Exception:
            conn.execute("ROLLBACK;")
            raise

    _safe_record_telemetry(
        thread_id,
        "intake",
        "intake_review",
        "human",
        "n/a",
        0.0,
        human_override=bool(state.get("corrections")),
        db_path=db_path,
    )
    msg = f"Invoice {final['invoice_number']} created (unpaid). Next: POST /reconcile with this invoice number."
    db_mod.log_audit(thread_id, "invoice_writer", "created", {"fields": final, "po_linked": po_number}, db_path=db_path)
    return {"outcome_status": "created", "final_response": msg}


def _route_after_validation(state: IntakeState) -> str:
    return "invoice_writer" if state.get("human_action") == "confirm" else "intake_review"


def build_intake_graph(checkpointer, db_path: Path | None = None):
    def _wrap(fn):
        def _inner(state: IntakeState):
            return fn(state, db_path=db_path)

        _inner.__name__ = fn.__name__
        return _inner

    b = StateGraph(IntakeState)
    b.add_node("document_extract", _wrap(document_extract_node))
    b.add_node("intake_validator", _wrap(intake_validator_node))
    b.add_node("intake_review", _wrap(intake_review_node))
    b.add_node("invoice_writer", _wrap(invoice_writer_node))
    b.add_edge(START, "document_extract")
    b.add_edge("document_extract", "intake_validator")
    b.add_conditional_edges(
        "intake_validator", _route_after_validation, {"intake_review": "intake_review", "invoice_writer": "invoice_writer"}
    )
    b.add_edge("intake_review", "invoice_writer")
    b.add_edge("invoice_writer", END)
    return b.compile(checkpointer=checkpointer)


def start_intake(graph, raw: bytes, upload_dir: Path, thread_id: str | None = None) -> str:
    """Store the upload (content-addressed) and run the graph until it pauses or finishes."""
    sha, path = intake.store_upload(raw, upload_dir)
    thread_id = thread_id or f"intake-{sha[:8]}-{uuid.uuid4().hex[:6]}"
    graph.invoke({"thread_id": thread_id, "file_path": str(path), "sha256": sha}, {"configurable": {"thread_id": thread_id}})
    return thread_id
