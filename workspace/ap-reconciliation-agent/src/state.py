"""LangGraph state and Pydantic structured schemas for AP reconciliation."""
from typing import Any
from pydantic import BaseModel
from typing_extensions import TypedDict


class ReconciliationInput(BaseModel):
    invoice_number: str | None = None
    payment_ref: str | None = None
    currency: str | None = None
    notes: str | None = None


class ReconciliationState(TypedDict, total=False):
    thread_id: str
    idempotency_key: str | None
    raw_input: str
    parsed: dict[str, Any]
    parse_source: str
    match_report: dict[str, Any]
    route: str  # auto_reconcile | needs_human | hard_block
    retrieved_policies: list[dict[str, Any]]
    embedding_engine: str
    investigation: dict[str, Any]
    human_action: str | None  # approve | hold | reject
    reviewer: str | None
    review_note: str | None
    reconciliation_id: int | None
    outcome_status: str
    final_response: str
