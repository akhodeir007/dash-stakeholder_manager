"""Executable specification checks; these do not execute domain guards."""
from pathlib import Path
import unittest

from scripts.validate_contract import load_contract


ROOT = Path(__file__).resolve().parents[1]


class SDDContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = load_contract(ROOT / "docs/state-machines.yaml")

    def policy(self):
        self.assertTrue("behavioral_contract" in self.doc,
                        "W1 decisions must be part of the implementation contract")
        return self.doc["behavioral_contract"]

    def test_revocation_never_erases_authority_history(self):
        rule = self.policy()["revalidation"]
        self.assertEqual(rule["default_on_dependency_change"], "REQUIRED")
        self.assertFalse(rule["rewrite_authority_state"])
        self.assertFalse(rule["automatic_legal_revocation"])
        self.assertIn("record_issuance", rule["guarded_actions"])

    def test_scope_requires_exact_immutable_bindings(self):
        binding = self.policy()["scope_binding"]
        self.assertEqual(set(binding["required_fields"]), {
            "project_id", "package_id", "plot_ids", "scope_version",
            "design_revision", "requirement_snapshot_id", "evidence_version_ids"})
        self.assertTrue(binding["unknown_applicability_blocks"])
        self.assertFalse(binding["catalogue_track_activates_requirement"])

    def test_independent_evidence_validation_and_signed_stamp(self):
        rules = self.policy()["evidence_validation"]
        self.assertTrue(rules["regulated_uploader_must_differ_from_validator"])
        self.assertFalse(rules["recording_equals_validation"])
        self.assertTrue(rules["stamp_requires_assigned_credentialed_signer"])
        self.assertTrue(rules["authorization_rechecked_at_commit"])

    def test_review_requires_active_scoped_authorization(self):
        rules = self.policy()["third_party"]
        self.assertEqual(rules["plan_review_required_state"], "INSPECTION_ACTIVE")
        self.assertEqual(rules["inspection_required_state"], "INSPECTION_ACTIVE")
        self.assertFalse(rules["licensing_approval_allows_technical_work"])

    def test_corrections_and_fallback_cannot_bypass_gate(self):
        policy = self.policy()
        self.assertEqual(policy["correction"]["storage"], "append_only_superseding_fact")
        self.assertFalse(policy["correction"]["direct_state_write"])
        self.assertEqual(policy["fallback"]["execution_status"], "DISABLED_PENDING_SEPARATE_CONTRACT")
        self.assertFalse(policy["fallback"]["counts_as_full_permit"])

    def test_stale_outbox_unlock_cannot_win(self):
        policy = self.policy()["events"]
        self.assertEqual(policy["unlock_handler"], "recompute_from_current_committed_facts")
        self.assertTrue(policy["dedupe_required"])
        self.assertTrue(policy["stale_event_cannot_unlock"])
        self.assertFalse(policy["external_authority_writeback"])

    def test_drex_enum_values_are_strings_not_yaml_booleans(self):
        self.assertEqual(self.doc["drex"]["modes"], ["OFF", "SHADOW", "ADVISORY", "ASSISTED"])
        stamp = next(item for item in self.doc["drex"]["decision_types"] if item["id"] == "D3")
        self.assertEqual(stamp["options"], ["yes", "no", "unclear"])

    def test_every_dual_control_transition_has_explicit_eligible_pairs(self):
        transitions = {t["id"]: t for machine in self.doc["machines"].values()
                       for t in machine["transitions"] if t.get("dual_control")}
        rules = self.policy()["evidence_validation"]
        self.assertTrue("dual_control_role_pairs" in rules,
                        "all dual-control commands need explicit participant combinations")
        pairs = rules["dual_control_role_pairs"]
        self.assertEqual(set(pairs), set(transitions))
        for tid, choices in pairs.items():
            self.assertTrue(choices)
            for pair in choices:
                self.assertEqual(len(pair), 2)
                self.assertTrue(set(pair).issubset(transitions[tid]["roles"]))


if __name__ == "__main__":
    unittest.main()
