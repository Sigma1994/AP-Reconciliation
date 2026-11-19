"""SQLite persistence layer: WAL mode, append-only audit triggers, AP policies, vectors, and Kenyan ledger seed."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from typing import Any, Iterator

from src.policies_seed import KENYAN_AP_POLICIES

DEFAULT_DB_PATH = Path(os.getenv("AP_DB_PATH", "data/ap.db"))


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def policy_content_hash(title: str, vendor_scope: str | None, rule_text: str) -> str:
    payload = f"{title.strip()}|{(vendor_scope or '').strip()}|{rule_text.strip()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def configure_connection(conn: sqlite3.Connection) -> sqlite3.Connection:
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


@contextmanager
def get_conn(db_path: Path | None = None) -> Iterator[sqlite3.Connection]:
    path = Path(db_path) if db_path else DEFAULT_DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0, isolation_level=None)
    try:
        configure_connection(conn)
        yield conn
    finally:
        conn.close()


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS ap_policies (
    policy_id TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('tax_etims', 'matching_tolerance', 'controls_fraud', 'supplier_sop')),
    title TEXT NOT NULL,
    vendor_scope TEXT,
    rule_text TEXT NOT NULL,
    effective_date TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_vectors (
    policy_id TEXT PRIMARY KEY REFERENCES ap_policies(policy_id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    embedding_json TEXT NOT NULL,
    indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_orders (
    po_number TEXT PRIMARY KEY,
    vendor_name TEXT NOT NULL,
    kra_pin TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('KES', 'USD')),
    authorized_amount REAL NOT NULL,
    goods_received INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed'))
);

CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL UNIQUE,
    po_number TEXT,
    vendor_name TEXT NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('KES', 'USD')),
    subtotal REAL,
    vat REAL,
    amount REAL NOT NULL,
    etims_cu TEXT,
    invoice_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'unpaid', 'reconciled', 'held', 'rejected'))
);

CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_ref TEXT NOT NULL UNIQUE,
    vendor_name TEXT NOT NULL,
    invoice_number TEXT,
    currency TEXT NOT NULL CHECK (currency IN ('KES', 'USD')),
    amount_paid REAL NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('M-Pesa', 'EFT', 'Wire')),
    paid_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('unmatched', 'reconciled'))
);

CREATE TABLE IF NOT EXISTS intake_documents (
    sha256 TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    invoice_number TEXT,
    reviewed_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL UNIQUE,
    invoice_number TEXT NOT NULL,
    payment_ref TEXT,
    po_number TEXT,
    currency TEXT NOT NULL,
    invoice_amount REAL NOT NULL,
    paid_amount REAL NOT NULL,
    variance_amount REAL NOT NULL,
    variance_pct REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reconciled', 'held', 'rejected', 'pending_approval', 'blocked')),
    reason_summary TEXT NOT NULL,
    retrieved_policies_json TEXT NOT NULL DEFAULT '[]',
    investigation_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_one_reconciled_invoice
    ON reconciliations(invoice_number)
    WHERE status = 'reconciled';

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    node_name TEXT NOT NULL,
    decision TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TABLE IF NOT EXISTS llm_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    pipeline TEXT NOT NULL,
    node_name TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    latency_ms REAL NOT NULL,
    fallback_used INTEGER NOT NULL DEFAULT 0,
    validation_error TEXT,
    human_override INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
"""


def _seed_policies(conn: sqlite3.Connection) -> None:
    cnt = conn.execute("SELECT COUNT(*) AS cnt FROM ap_policies").fetchone()["cnt"]
    if cnt > 0:
        return
    now = utc_now_iso()
    conn.execute("BEGIN IMMEDIATE;")
    try:
        for p in KENYAN_AP_POLICIES:
            ch = policy_content_hash(p["title"], p.get("vendor_scope"), p["rule_text"])
            conn.execute(
                """
                INSERT INTO ap_policies (
                    policy_id, category, title, vendor_scope, rule_text, effective_date, content_hash, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    p["policy_id"],
                    p["category"],
                    p["title"],
                    p.get("vendor_scope"),
                    p["rule_text"],
                    p["effective_date"],
                    ch,
                    now,
                ),
            )
        conn.execute("COMMIT;")
    except Exception:
        conn.execute("ROLLBACK;")
        raise


def _seed_ledger(conn: sqlite3.Connection) -> None:
    cnt = conn.execute("SELECT COUNT(*) AS cnt FROM purchase_orders").fetchone()["cnt"]
    if cnt > 0:
        return
    conn.execute("BEGIN IMMEDIATE;")
    try:
        pos = [
            ("PO-4410", "Acacia Hardware Ltd", "P051234987K", "KES", 116000.0, 1, "open"),
            ("PO-4412", "Mombasa Logistics Ltd", "P051883210M", "KES", 232000.0, 1, "open"),
            ("PO-4415", "Rift Valley Cloud Services", "P051449012R", "USD", 1450.0, 1, "open"),
            ("PO-4418", "Savannah Steel Works Ltd", "P051774509S", "KES", 58000.0, 1, "open"),
            ("PO-4421", "Eldoret Agrovet & Feeds Ltd", "P051992341E", "KES", 74500.0, 1, "open"),
            ("PO-4424", "Nairobi Legal & Advisory LLP", "P051338712N", "KES", 116000.0, 1, "open"),
            ("PO-4440", "Apex Security Systems Ltd", "P051729104A", "KES", 98600.0, 1, "open"),
            ("PO-4442", "Kilimani Print & Stationery", "P051842901P", "KES", 34800.0, 1, "open"),
        ]
        conn.executemany(
            "INSERT INTO purchase_orders (po_number, vendor_name, kra_pin, currency, authorized_amount, goods_received, status) VALUES (?,?,?,?,?,?,?)",
            pos,
        )

        invoices = [
            ("INV-9001", "PO-4410", "ACACIA HDW", "KES", 100000.0, 16000.0, 116000.0, "KRA-CU-01948271", "2026-11-14", "open"),
            ("INV-9002", "PO-4415", "Rift Valley Cloud Services", "USD", 1450.0, 0.0, 1450.0, "KRA-CU-01948399", "2026-11-15", "open"),
            ("INV-9003", "PO-4440", "Apex Security Systems Ltd", "KES", 85000.0, 13600.0, 98600.0, "KRA-CU-01948410", "2026-11-08", "open"),
            ("INV-9004", "PO-4412", "Mombasa Logistics Ltd", "KES", 200000.0, 32000.0, 232000.0, "KRA-CU-01948504", "2026-11-12", "open"),
            ("INV-9005", "PO-4424", "Nairobi Legal & Advisory LLP", "KES", 100000.0, 16000.0, 116000.0, "KRA-CU-01948588", "2026-11-13", "open"),
            ("INV-9006", "PO-4418", "Savannah Steel Works Ltd", "KES", 50000.0, 8000.0, 58000.0, "KRA-CU-01948611", "2026-11-10", "open"),
            ("INV-9007", "PO-4421", "Eldoret Agrovet & Feeds Ltd", "KES", 70000.0, 4500.0, 74500.0, "KRA-CU-01948702", "2026-11-11", "open"),
            ("INV-9008", None, "Coastline Clearing & Forwarding", "KES", 45000.0, 7200.0, 52200.0, "KRA-CU-01948790", "2026-11-14", "open"),
            ("INV-9009", "PO-4442", "Kilimani Print & Stationery", "KES", 30000.0, 4800.0, 34800.0, "KRA-CU-01948815", "2026-11-16", "open"),
        ]
        conn.executemany(
            "INSERT INTO invoices (invoice_number, po_number, vendor_name, currency, subtotal, vat, amount, etims_cu, invoice_date, status) VALUES (?,?,?,?,?,?,?,?,?,?)",
            invoices,
        )

        payments = [
            ("MPESA-QKL8821", "Acacia Hardware", "INV-9001", "KES", 114000.0, "M-Pesa", "2026-11-16", "unmatched"),
            ("WIRE-USD-441", "Rift Valley Cloud", "INV-9002", "USD", 1450.0, "Wire", "2026-11-16", "unmatched"),
            ("EFT-77310", "Apex Security Systems", "INV-9003", "USD", 986.0, "Wire", "2026-11-09", "unmatched"),
            ("EFT-77319", "Mombasa Logistics Ltd", "INV-9004", "KES", 215000.0, "EFT", "2026-11-17", "unmatched"),
            ("EFT-88201", "Nairobi Legal & Advisory", "INV-9005", "KES", 111000.0, "EFT", "2026-11-17", "unmatched"),
            ("MPESA-RZP1104", "Savannah Steel Works Ltd", "INV-9006", "KES", 58000.0, "M-Pesa", "2026-11-11", "unmatched"),
            ("EFT-90110", "Eldoret Agrovet", "INV-9007", "KES", 40000.0, "EFT", "2026-11-14", "unmatched"),
            ("EFT-90111", "Eldoret Agrovet", "INV-9007", "KES", 34500.0, "EFT", "2026-11-15", "unmatched"),
            ("MPESA-CST4401", "Coastline Clearing", "INV-9008", "KES", 50000.0, "M-Pesa", "2026-11-15", "unmatched"),
            ("MPESA-KPS3310", "Kilimani Print", "INV-9009", "KES", 34800.0, "M-Pesa", "2026-11-17", "unmatched"),
        ]
        conn.executemany(
            "INSERT INTO payments (payment_ref, vendor_name, invoice_number, currency, amount_paid, channel, paid_at, status) VALUES (?,?,?,?,?,?,?,?)",
            payments,
        )
        conn.execute("COMMIT;")
    except Exception:
        conn.execute("ROLLBACK;")
        raise


def init_db(db_path: Path | None = None) -> Path:
    path = Path(db_path) if db_path else DEFAULT_DB_PATH
    with get_conn(path) as conn:
        conn.executescript(SCHEMA_SQL)
        _seed_policies(conn)
        _seed_ledger(conn)
    return path


def log_audit(
    thread_id: str,
    node_name: str,
    decision: str,
    details: dict[str, Any],
    db_path: Path | None = None,
) -> None:
    with get_conn(db_path) as conn:
        conn.execute(
            "INSERT INTO audit_log (thread_id, node_name, decision, details_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (thread_id, node_name, decision, json.dumps(details, default=str), utc_now_iso()),
        )


def record_telemetry(
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
    with get_conn(db_path) as conn:
        conn.execute(
            """
            INSERT INTO llm_telemetry (
                thread_id, pipeline, node_name, model, prompt_version,
                latency_ms, fallback_used, validation_error, human_override, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                thread_id,
                pipeline,
                node_name,
                model,
                prompt_version,
                round(float(latency_ms), 2),
                int(fallback_used),
                validation_error,
                int(human_override),
                utc_now_iso(),
            ),
        )


def get_policies(category: str | None = None, db_path: Path | None = None) -> list[dict[str, Any]]:
    with get_conn(db_path) as conn:
        sql = """
            SELECT p.policy_id, p.category, p.title, p.vendor_scope, p.rule_text,
                   p.effective_date, p.content_hash, p.updated_at,
                   CASE WHEN v.policy_id IS NOT NULL AND v.content_hash = p.content_hash THEN 1 ELSE 0 END AS has_dense_vector,
                   v.embedding_model
            FROM ap_policies p
            LEFT JOIN policy_vectors v ON v.policy_id = p.policy_id
        """
        params: tuple[Any, ...] = ()
        if category:
            sql += " WHERE p.category = ?"
            params = (category,)
        sql += " ORDER BY p.policy_id"
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) | {"has_dense_vector": bool(r["has_dense_vector"])} for r in rows]


def upsert_policy(
    policy_id: str,
    category: str,
    title: str,
    rule_text: str,
    vendor_scope: str | None = None,
    effective_date: str | None = None,
    db_path: Path | None = None,
) -> dict[str, Any]:
    pid = policy_id.strip().upper()
    eff = effective_date or utc_now_iso()[:10]
    ch = policy_content_hash(title, vendor_scope, rule_text)
    now = utc_now_iso()
    with get_conn(db_path) as conn:
        conn.execute(
            """
            INSERT INTO ap_policies (policy_id, category, title, vendor_scope, rule_text, effective_date, content_hash, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(policy_id) DO UPDATE SET
                category = excluded.category,
                title = excluded.title,
                vendor_scope = excluded.vendor_scope,
                rule_text = excluded.rule_text,
                effective_date = excluded.effective_date,
                content_hash = excluded.content_hash,
                updated_at = excluded.updated_at
            """,
            (pid, category, title.strip(), (vendor_scope or "").strip() or None, rule_text.strip(), eff, ch, now),
        )
    return next(p for p in get_policies(db_path=db_path) if p["policy_id"] == pid)
