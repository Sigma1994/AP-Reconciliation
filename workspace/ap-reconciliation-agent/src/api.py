"""FastAPI service for Kenyan B2B AP reconciliation, document intake, Policy Vector DB RAG, and audit logs."""
from contextlib import asynccontextmanager
import os
from pathlib import Path
import sqlite3
from typing import Any
import uuid

from fastapi import FastAPI, File, HTTPException, UploadFile
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command
from pydantic import BaseModel

from src import db as db_mod
from src import intake, intake_graph
from src.graph import build_reconciliation_graph
from src.vector_store import PolicyVectorStore

DB_PATH = Path(os.getenv("AP_DB_PATH", "data/ap.db"))
CKPT_PATH = Path(os.getenv("AP_CHECKPOINT_DB_PATH", "data/ap_checkpoints.db"))
UPLOAD_DIR = Path(os.getenv("AP_UPLOAD_DIR", "data/uploads"))


class ReconcileRequest(BaseModel):
    raw_input: str
    thread_id: str | None = None
    idempotency_key: str | None = None


class ResumeDecisionRequest(BaseModel):
    action: str  # approve | hold | reject
    reviewer: str = "ap-supervisor"
    note: str | None = None


class IntakeResumeRequest(BaseModel):
    action: str  # confirm | reject
    reviewer: str = "ap-clerk"
    corrections: dict[str, Any] | None = None


class PolicyUpsertRequest(BaseModel):
    policy_id: str
    category: str
    title: str
    rule_text: str
    vendor_scope: str | None = None
    effective_date: str | None = None


class PolicySearchRequest(BaseModel):
    query: str
    top_k: int = 6


@asynccontextmanager
async def lifespan(app: FastAPI):
    db_mod.init_db(DB_PATH)
    CKPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    ckpt_conn = sqlite3.connect(str(CKPT_PATH), check_same_thread=False)
    ckpt_conn.execute("PRAGMA journal_mode = WAL;")
    ckpt_conn.execute("PRAGMA busy_timeout = 5000;")
    saver = SqliteSaver(ckpt_conn)

    app.state.ckpt_conn = ckpt_conn
    app.state.recon_graph = build_reconciliation_graph(saver, db_path=DB_PATH)
    app.state.intake_graph = intake_graph.build_intake_graph(saver, db_path=DB_PATH)
    app.state.vector_store = PolicyVectorStore(DB_PATH)
    try:
        app.state.vector_store.sync_embeddings()
    except Exception:
        pass
    try:
        yield
    finally:
        ckpt_conn.close()


app = FastAPI(
    title="Kenyan B2B AP Reconciliation & Policy Investigation Agent",
    version="0.2.0",
    lifespan=lifespan,
)


@app.get("/health")
def health() -> dict[str, Any]:
    policies = db_mod.get_policies(db_path=DB_PATH)
    return {
        "status": "ok",
        "policy_count": len(policies),
        "dense_vector_count": sum(1 for p in policies if p["has_dense_vector"]),
        "ai_engine": os.getenv("AP_AI_ENGINE", "ollama"),
    }


@app.get("/ledger")
def get_ledger() -> dict[str, Any]:
    with db_mod.get_conn(DB_PATH) as conn:
        pos = [dict(r) for r in conn.execute("SELECT * FROM purchase_orders ORDER BY po_number").fetchall()]
        invoices = [dict(r) for r in conn.execute("SELECT * FROM invoices ORDER BY invoice_number").fetchall()]
        payments = [dict(r) for r in conn.execute("SELECT * FROM payments ORDER BY payment_ref").fetchall()]
        recons = [dict(r) for r in conn.execute("SELECT * FROM reconciliations ORDER BY id DESC").fetchall()]
    return {
        "purchase_orders": pos,
        "invoices": invoices,
        "payments": payments,
        "reconciliations": recons,
    }


@app.get("/policies")
def list_policies(category: str | None = None) -> dict[str, Any]:
    items = db_mod.get_policies(category=category, db_path=DB_PATH)
    return {"policies": items, "count": len(items)}


@app.post("/policies")
def upsert_policy(req: PolicyUpsertRequest) -> dict[str, Any]:
    if req.category not in {"tax_etims", "matching_tolerance", "controls_fraud", "supplier_sop"}:
        raise HTTPException(status_code=400, detail="Invalid policy category.")
    saved = db_mod.upsert_policy(
        policy_id=req.policy_id,
        category=req.category,
        title=req.title,
        rule_text=req.rule_text,
        vendor_scope=req.vendor_scope,
        effective_date=req.effective_date,
        db_path=DB_PATH,
    )
    sync = app.state.vector_store.sync_embeddings()
    return {"policy": saved, "sync": sync}


@app.post("/policies/search")
def search_policies(req: PolicySearchRequest) -> dict[str, Any]:
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty.")
    top_k = max(1, min(20, req.top_k))
    return app.state.vector_store.search(req.query.strip(), top_k=top_k)


@app.post("/policies/reindex")
def reindex_policies() -> dict[str, Any]:
    return app.state.vector_store.sync_embeddings()


@app.post("/intake")
async def upload_invoice_document(file: UploadFile = File(...), thread_id: str | None = None) -> dict[str, Any]:
    raw = await file.read()
    fmt = intake.sniff_image_format(raw)
    if not fmt:
        raise HTTPException(status_code=400, detail="Supported formats: PNG, JPEG, WEBP, PDF.")
    tid = intake_graph.start_intake(app.state.intake_graph, raw, UPLOAD_DIR, thread_id=thread_id)
    cfg = {"configurable": {"thread_id": tid}}
    snap = app.state.intake_graph.get_state(cfg)
    if snap.next:
        return {
            "thread_id": tid,
            "status": "pending_review",
            "extracted": snap.values.get("fields"),
            "checks": snap.values.get("checks", []),
        }
    return {
        "thread_id": tid,
        "status": snap.values.get("outcome_status", "completed"),
        "final_response": snap.values.get("final_response"),
    }


@app.post("/intake/resume/{thread_id}")
def resume_intake(thread_id: str, req: IntakeResumeRequest) -> dict[str, Any]:
    cfg = {"configurable": {"thread_id": thread_id}}
    app.state.intake_graph.invoke(
        Command(resume={"action": req.action, "reviewer": req.reviewer, "corrections": req.corrections}),
        cfg,
    )
    snap = app.state.intake_graph.get_state(cfg)
    return {
        "thread_id": thread_id,
        "status": snap.values.get("outcome_status"),
        "final_response": snap.values.get("final_response"),
    }


@app.post("/reconcile")
def reconcile(req: ReconcileRequest) -> dict[str, Any]:
    tid = req.thread_id or f"recon-{uuid.uuid4().hex[:8]}"
    cfg = {"configurable": {"thread_id": tid}}
    app.state.recon_graph.invoke(
        {"thread_id": tid, "idempotency_key": req.idempotency_key, "raw_input": req.raw_input},
        cfg,
    )
    snap = app.state.recon_graph.get_state(cfg)
    vals = snap.values
    if snap.next:
        return {
            "thread_id": tid,
            "status": "pending_approval",
            "evidence": vals.get("match_report"),
            "retrieved_policies": vals.get("retrieved_policies", []),
            "investigation": vals.get("investigation", {}),
        }
    return {
        "thread_id": tid,
        "status": vals.get("outcome_status"),
        "reconciliation_id": vals.get("reconciliation_id"),
        "retrieved_policies": vals.get("retrieved_policies", []),
        "investigation": vals.get("investigation", {}),
        "final_response": vals.get("final_response"),
    }


@app.post("/resume/{thread_id}")
def resume_reconciliation(thread_id: str, req: ResumeDecisionRequest) -> dict[str, Any]:
    cfg = {"configurable": {"thread_id": thread_id}}
    snap = app.state.recon_graph.get_state(cfg)
    if not snap.next:
        raise HTTPException(status_code=409, detail=f"Thread '{thread_id}' is not awaiting human approval.")
    app.state.recon_graph.invoke(
        Command(resume={"action": req.action, "reviewer": req.reviewer, "note": req.note}),
        cfg,
    )
    final_snap = app.state.recon_graph.get_state(cfg)
    vals = final_snap.values
    return {
        "thread_id": thread_id,
        "status": vals.get("outcome_status"),
        "reconciliation_id": vals.get("reconciliation_id"),
        "final_response": vals.get("final_response"),
    }


@app.get("/audit/{thread_id}")
def get_audit(thread_id: str) -> list[dict[str, Any]]:
    with db_mod.get_conn(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT id, thread_id, node_name, decision, details_json, created_at FROM audit_log WHERE thread_id = ? ORDER BY id",
            (thread_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/metrics")
def get_metrics() -> dict[str, Any]:
    with db_mod.get_conn(DB_PATH) as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS runs,
                   COALESCE(ROUND(AVG(latency_ms), 2), 0) AS avg_latency_ms,
                   COALESCE(SUM(fallback_used), 0) AS fallbacks,
                   COALESCE(SUM(human_override), 0) AS human_overrides
            FROM llm_telemetry
            """
        ).fetchone()
    return dict(row)
