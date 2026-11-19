"""Compiled LangGraph reconciliation graph with SqliteSaver checkpointer."""
import os
from pathlib import Path
import sqlite3
from typing import Any

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph

from src import db as db_mod
from src import nodes
from src.state import ReconciliationState

DEFAULT_CKPT_PATH = Path(os.getenv("AP_CHECKPOINT_DB_PATH", "data/ap_checkpoints.db"))


def _route_after_investigator(state: ReconciliationState) -> str:
    route = state.get("route")
    if route == "hard_block":
        return "ledger_finalizer"
    if route == "auto_reconcile":
        return "ledger_finalizer"
    return "human_approval"


def build_reconciliation_graph(checkpointer: Any, db_path: Path | None = None):
    def _wrap(fn):
        def _inner(state: ReconciliationState):
            return fn(state, db_path=db_path)

        _inner.__name__ = fn.__name__
        return _inner

    b = StateGraph(ReconciliationState)
    b.add_node("ingest_parser", _wrap(nodes.ingest_parser_node))
    b.add_node("matcher_sql", _wrap(nodes.matcher_sql_node))
    b.add_node("policy_critic", _wrap(nodes.policy_critic_node))
    b.add_node("ai_investigator", _wrap(nodes.ai_investigator_node))
    b.add_node("human_approval", _wrap(nodes.human_approval_node))
    b.add_node("ledger_finalizer", _wrap(nodes.ledger_finalizer_node))

    b.add_edge(START, "ingest_parser")
    b.add_edge("ingest_parser", "matcher_sql")
    b.add_edge("matcher_sql", "policy_critic")
    b.add_edge("policy_critic", "ai_investigator")
    b.add_conditional_edges(
        "ai_investigator",
        _route_after_investigator,
        {
            "human_approval": "human_approval",
            "ledger_finalizer": "ledger_finalizer",
        },
    )
    b.add_edge("human_approval", "ledger_finalizer")
    b.add_edge("ledger_finalizer", END)
    return b.compile(checkpointer=checkpointer)


def get_compiled_reconciliation_graph(
    db_path: Path | None = None,
    ckpt_path: Path | None = None,
):
    db_mod.init_db(db_path)
    cp = Path(ckpt_path) if ckpt_path else DEFAULT_CKPT_PATH
    cp.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(cp), check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    checkpointer = SqliteSaver(conn)
    return build_reconciliation_graph(checkpointer, db_path=db_path), conn
