"""Integration tests for LangGraph reconciliation + multimodal intake + FastAPI endpoints."""
import io
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from src import intake, intake_graph
from src.db import get_conn, init_db
from src.graph import get_compiled_reconciliation_graph


def _make_png_bytes() -> bytes:
    im = Image.new("RGB", (320, 200), "white")
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def test_langgraph_reconcile_interrupt_and_resume(tmp_path: Path) -> None:
    os.environ["USE_DETERMINISTIC_LLM"] = "1"
    db = init_db(tmp_path / "ap.db")
    graph, conn = get_compiled_reconciliation_graph(db, tmp_path / "ckpt.db")
    try:
        cfg = {"configurable": {"thread_id": "test-inv9001"}}
        graph.invoke({"thread_id": "test-inv9001", "idempotency_key": None, "raw_input": "INV-9001"}, cfg)
        snap = graph.get_state(cfg)
        assert snap.next  # paused at human_approval
        assert snap.values["match_report"]["tax_rule_applied"] == "whvat_2pct"
        assert len(snap.values["retrieved_policies"]) == 6
        assert snap.values["investigation"]["recommended_action"] == "approve"

        from langgraph.types import Command

        graph.invoke(
            Command(resume={"action": "approve", "reviewer": "grace.m", "note": "WHVAT cert verified"}),
            cfg,
        )
        done = graph.get_state(cfg)
        assert not done.next
        assert done.values["outcome_status"] == "reconciled"
    finally:
        conn.close()


def test_intake_graph_sha256_dedup_and_arithmetic_guard(tmp_path: Path) -> None:
    os.environ["USE_DETERMINISTIC_LLM"] = "1"
    db = init_db(tmp_path / "intake.db")
    from langgraph.checkpoint.sqlite import SqliteSaver
    import sqlite3

    c = sqlite3.connect(str(tmp_path / "intake_ckpt.db"), check_same_thread=False)
    graph = intake_graph.build_intake_graph(SqliteSaver(c), db_path=db)
    png = _make_png_bytes()
    good_json = json.dumps(
        {
            "document_type": "invoice",
            "invoice_number": "INV-9550",
            "po_number": "PO-4410",
            "vendor_name": "ACACIA HDW",
            "kra_pin": "P051234987K",
            "currency": "KES",
            "invoice_date": "18/11/2026",
            "etims_cu": "KRA-CU-09911223",
            "subtotal": 10000,
            "vat": 1600,
            "total": 11600,
            "line_items": [{"description": "Fasteners", "quantity": 10, "unit_price": 1000, "tax_rate": "16%", "line_total": 10000}],
        }
    )

    try:
        with patch("src.intake.call_vision_model", return_value=good_json):
            tid = intake_graph.start_intake(graph, png, tmp_path / "uploads")
        snap = graph.get_state({"configurable": {"thread_id": tid}})
        assert snap.values["fields"]["invoice_date"] == "2026-11-18"

        from langgraph.types import Command

        graph.invoke(Command(resume={"action": "confirm", "reviewer": "clerk.a"}), {"configurable": {"thread_id": tid}})
        assert graph.get_state({"configurable": {"thread_id": tid}}).values["outcome_status"] == "created"

        # Re-uploading exact same bytes must flag DUPLICATE_FILE error
        checks = intake.validate_invoice_draft(snap.values["fields"], snap.values["sha256"], db_path=db)
        assert any(chk["code"] == "DUPLICATE_FILE" and chk["severity"] == "error" for chk in checks)

        with get_conn(db) as conn:
            row = conn.execute("SELECT subtotal, vat, etims_cu FROM invoices WHERE invoice_number='INV-9550'").fetchone()
            assert row["subtotal"] == 10000
            assert row["etims_cu"] == "KRA-CU-09911223"
    finally:
        c.close()
