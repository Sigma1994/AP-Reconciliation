"""Core deterministic, SQLite WAL, Vector DB RAG, and AI Investigator tests (stdlib-runnable & pytest-compatible)."""
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

from src.db import get_conn, get_policies, init_db, log_audit, upsert_policy
from src.investigator import investigate_variance
from src.kenya_compliance import detect_kenyan_withholding, is_valid_etims_cu, is_valid_kra_pin, vendor_similarity
from src.reconciler import evaluate_match, persist_reconciliation
from src.vector_store import PolicyVectorStore


class CoreAPReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / "test_ap.db"
        init_db(self.db_path)
        os.environ["USE_DETERMINISTIC_LLM"] = "1"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_sqlite_wal_and_append_only_audit_triggers(self) -> None:
        log_audit("thr-1", "test_node", "ok", {"x": 1}, db_path=self.db_path)
        with get_conn(self.db_path) as conn:
            mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
            self.assertEqual(mode.lower(), "wal")
            with self.assertRaises(sqlite3.DatabaseError):
                conn.execute("UPDATE audit_log SET decision = 'tampered' WHERE thread_id = 'thr-1'")
            with self.assertRaises(sqlite3.DatabaseError):
                conn.execute("DELETE FROM audit_log WHERE thread_id = 'thr-1'")

    def test_33_kenyan_policies_seeded_and_vector_indexed(self) -> None:
        policies = get_policies(db_path=self.db_path)
        self.assertEqual(len(policies), 33)

        store = PolicyVectorStore(self.db_path)
        sync = store.sync_embeddings()
        self.assertEqual(sync["indexed"], 33)
        self.assertEqual(sync["total_policies"], 33)

        # Second sync should be incremental (0 modified)
        sync2 = store.sync_embeddings()
        self.assertEqual(sync2["indexed"], 0)

        # Updating a policy invalidates content_hash and re-embeds only that 1 row
        upsert_policy(
            "POL-TAX-003",
            "tax_etims",
            "2% Withholding VAT (WHVAT) Deduction Rule",
            "Updated WHVAT verification rule requiring iTax certificate attachment.",
            db_path=self.db_path,
        )
        sync3 = store.sync_embeddings()
        self.assertEqual(sync3["indexed"], 1)

    def test_vector_db_retrieves_relevant_policy_ids(self) -> None:
        store = PolicyVectorStore(self.db_path)
        res_whvat = store.search("Abbreviated vendor ACACIA HDW short paid by 2% WHVAT", top_k=6)
        ids_whvat = {h["policy_id"] for h in res_whvat["hits"]}
        self.assertIn("SOP-VEND-001", ids_whvat)
        self.assertIn("POL-TAX-003", ids_whvat)

        res_legal = store.search("Nairobi Legal & Advisory LLP retainer short paid by 5% Resident WHT", top_k=6)
        ids_legal = {h["policy_id"] for h in res_legal["hits"]}
        self.assertIn("SOP-VEND-006", ids_legal)
        self.assertIn("POL-TAX-004", ids_legal)

        res_freight = store.search("Mombasa Logistics Ltd demurrage freight short payment", top_k=6)
        ids_freight = {h["policy_id"] for h in res_freight["hits"]}
        self.assertIn("SOP-VEND-002", ids_freight)

    def test_kenya_compliance_helpers(self) -> None:
        score, band = vendor_similarity("ACACIA HDW", "Acacia Hardware Ltd")
        self.assertGreaterEqual(score, 82)
        self.assertEqual(band, "match")

        self.assertTrue(is_valid_etims_cu("KRA-CU-01948271"))
        self.assertFalse(is_valid_etims_cu("INVALID-123"))
        self.assertTrue(is_valid_kra_pin("P051234987K"))
        self.assertFalse(is_valid_kra_pin("12345"))

        self.assertEqual(detect_kenyan_withholding(100000, 116000, 114000, "KES"), ("whvat_2pct", 2000.0))
        self.assertEqual(detect_kenyan_withholding(100000, 116000, 111000, "KES"), ("wht_5pct", 5000.0))
        self.assertEqual(detect_kenyan_withholding(100000, 116000, 113000, "KES"), ("wht_3pct", 3000.0))

    def test_reconciler_and_ai_investigator_cases(self) -> None:
        # 1) Acacia Hardware 2% WHVAT case -> flags WHVAT, cites SOP-VEND-001 / POL-TAX-003
        rep1 = evaluate_match("INV-9001", db_path=self.db_path)
        self.assertEqual(rep1["tax_rule_applied"], "whvat_2pct")
        self.assertEqual(rep1["blocking_flags"], [])
        rag1, brief1 = investigate_variance(rep1, db_path=self.db_path)
        cited1 = {c["policy_id"] for c in brief1["cited_policies"]}
        retrieved1 = {h["policy_id"] for h in rag1["hits"]}
        self.assertTrue(cited1.issubset(retrieved1))
        self.assertIn("SOP-VEND-001", cited1)
        self.assertEqual(brief1["recommended_action"], "approve")

        # 2) Nairobi Legal 5% WHT case -> flags wht_5pct, cites SOP-VEND-006
        rep5 = evaluate_match("INV-9005", db_path=self.db_path)
        self.assertEqual(rep5["tax_rule_applied"], "wht_5pct")
        _, brief5 = investigate_variance(rep5, db_path=self.db_path)
        self.assertIn("SOP-VEND-006", {c["policy_id"] for c in brief5["cited_policies"]})

        # 3) Eldoret Agrovet split EFT payments -> 0 variance, auto-clearable
        rep7 = evaluate_match("INV-9007", db_path=self.db_path)
        self.assertEqual(rep7["variance_amount"], 0.0)
        self.assertEqual(rep7["flags"], [])
        self.assertEqual(rep7["blocking_flags"], [])

        # 4) Apex Security currency mismatch -> hard block & investigator forced to reject
        rep3 = evaluate_match("INV-9003", db_path=self.db_path)
        self.assertTrue(len(rep3["blocking_flags"]) >= 1)
        _, brief3 = investigate_variance(rep3, db_path=self.db_path)
        self.assertEqual(brief3["recommended_action"], "reject")

    def test_atomic_persistence_idempotency_and_monotonic_lock(self) -> None:
        rep6 = evaluate_match("INV-9006", db_path=self.db_path)
        rec_id_1 = persist_reconciliation("thr-9006", rep6, "reconciled", "Clean 3-way match", db_path=self.db_path)
        rec_id_2 = persist_reconciliation("thr-9006", rep6, "reconciled", "Duplicate call", db_path=self.db_path)
        self.assertIsNotNone(rec_id_1)
        self.assertEqual(rec_id_1, rec_id_2)

        # Subsequent reconciliation attempt on same invoice must hard-block
        rep6_again = evaluate_match("INV-9006", db_path=self.db_path)
        self.assertTrue(any("already reconciled" in f.lower() for f in rep6_again["blocking_flags"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
