"""Coverage-plan integrity; no runtime transition coverage is claimed."""
import copy
from pathlib import Path
import re
import unittest

from scripts.validate_coverage import validate_manifest
from scripts.validate_contract import load_contract


ROOT = Path(__file__).resolve().parents[1]


def fixtures():
    contract = {"version": "1.2", "machines": {"M": {"states": {"A": {}, "B": {}},
                "transitions": [{"id": "T1", "from": "A", "to": "B",
                                 "roles": ["REVIEWER"], "guards": ["valid", "scoped"]}]}}}
    backlog = {"tasks": [{"id": "BUILD-X", "kind": "implementation"}]}
    manifest = {"version": "1.0", "contract_version": "1.2",
                "source": "docs/state-machines.yaml", "runtime_coverage": "not_implemented",
                "templates": {key: {"description": "Planned behavior"} for key in (
                    "positive", "illegal_from", "illegal_role", "guard_false", "guard_unknown", "rollback", "dual_control")},
                "transitions": [{"machine": "M", "id": "T1", "guard_false": ["valid", "scoped"],
                                 "guard_unknown": ["valid", "scoped"], "from_states": ["A"],
                                 "allowed_roles": ["REVIEWER"]}],
                "global_cases": [{"id": "G1", "requirement": "I1", "given": "a fact",
                                  "when": "command", "then": "blocked", "owner_task": "BUILD-X"}]}
    return manifest, contract, backlog


class CoverageManifestTests(unittest.TestCase):
    def test_valid_fixture(self):
        self.assertEqual(validate_manifest(*fixtures()), [])

    def test_mutations_are_rejected(self):
        mutations = [
            lambda m: m.update(contract_version="old"),
            lambda m: m.update(runtime_coverage="100%"),
            lambda m: m["transitions"].clear(),
            lambda m: m["transitions"].append(copy.deepcopy(m["transitions"][0])),
            lambda m: m["transitions"][0].update(id="UNKNOWN"),
            lambda m: m["transitions"][0].update(machine="WRONG"),
            lambda m: m["transitions"][0].update(guard_false=["valid"]),
            lambda m: m["transitions"][0].update(guard_unknown=[]),
            lambda m: m["transitions"][0].update(from_states=["B"]),
            lambda m: m["transitions"][0].update(allowed_roles=["ADMIN"]),
            lambda m: m["templates"].pop("dual_control"),
            lambda m: m["global_cases"][0].update(owner_task="UNKNOWN"),
            lambda m: m["global_cases"].append(copy.deepcopy(m["global_cases"][0])),
            lambda m: m["global_cases"][0].update(accidental_unquoted_prose=None),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                manifest, contract, backlog = fixtures()
                mutate(manifest)
                self.assertTrue(validate_manifest(manifest, contract, backlog))

    def test_malformed_fields_fail_closed(self):
        for value in (None, [], {"transitions": "wrong"}):
            _, contract, backlog = fixtures()
            self.assertTrue(validate_manifest(value, contract, backlog))
        for key, value in (("id", []), ("guard_false", [{}]), ("allowed_roles", None)):
            manifest, contract, backlog = fixtures()
            manifest["transitions"][0][key] = value
            self.assertTrue(validate_manifest(manifest, contract, backlog))

    def test_current_manifest_matches_all_declared_transitions(self):
        manifest = load_contract(ROOT / "docs/execution/coverage-manifest.yaml")
        contract = load_contract(ROOT / "docs/state-machines.yaml")
        backlog = load_contract(ROOT / "docs/execution/backlog.yaml")
        self.assertEqual(validate_manifest(manifest, contract, backlog), [])
        self.assertEqual(len(manifest["transitions"]), 173)
        self.assertEqual(len({row["machine"] for row in manifest["transitions"]}), 20)
        requirements = " ".join(case["requirement"] for case in manifest["global_cases"])
        self.assertTrue({f"I{i}" for i in range(1, 16)}.issubset(
            set(re.findall(r"\bI(?:1[0-5]|[1-9])\b", requirements))))
        self.assertTrue({f"GAP-{i:02}" for i in range(1, 11)}.issubset(
            set(re.findall(r"\bGAP-\d{2}\b", requirements))))


if __name__ == "__main__":
    unittest.main()
