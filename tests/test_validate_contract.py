import copy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

from scripts.validate_contract import load_contract, validate_contract


def fixture():
    return {"roles": ["REVIEWER"], "machines": {"sample": {
        "initial": "NEW", "terminal": ["DONE"],
        "states": {"NEW": {}, "WORK": {}, "DONE": {}},
        "transitions": [
            {"id": "T1", "from": "NEW", "to": "WORK", "event": "START", "guards": ["ready"], "roles": ["REVIEWER"]},
            {"id": "T2", "from": "WORK", "to": "DONE", "event": "FINISH", "guards": ["checked"], "roles": ["SYSTEM"]},
        ],
    }}}


class ContractValidationTests(unittest.TestCase):
    def test_valid_small_fixture(self):
        self.assertEqual(validate_contract(fixture()), [])

    def test_current_contract_regression(self):
        doc = load_contract("docs/state-machines.yaml")
        self.assertEqual(validate_contract(doc), [])
        self.assertEqual(len(doc["machines"]), 20)
        self.assertEqual(sum(len(m["transitions"]) for m in doc["machines"].values()), 173)

    def assert_invalid(self, mutate, phrase):
        doc = fixture(); mutate(doc)
        self.assertTrue(any(phrase in e for e in validate_contract(doc)))

    def test_missing_initial(self):
        self.assert_invalid(lambda d: d["machines"]["sample"].pop("initial"), "initial")

    def test_invalid_initial_and_terminal(self):
        self.assert_invalid(lambda d: d["machines"]["sample"].update(initial="NOPE"), "initial")
        self.assert_invalid(lambda d: d["machines"]["sample"].update(terminal=["NOPE"]), "terminal")

    def test_terminal_is_optional_and_empty_is_valid(self):
        d = fixture(); d["machines"]["sample"].pop("terminal")
        self.assertEqual(validate_contract(d), [])
        d["machines"]["sample"]["terminal"] = []
        self.assertEqual(validate_contract(d), [])

    def test_malformed_terminal_rejected(self):
        for value in ("DONE", [None], [{}]):
            d = fixture(); d["machines"]["sample"]["terminal"] = value
            self.assertTrue(any("terminal" in e for e in validate_contract(d)))

    def test_invalid_from_and_to(self):
        self.assert_invalid(lambda d: d["machines"]["sample"]["transitions"][0].update(**{"from": "NOPE"}), "from")
        self.assert_invalid(lambda d: d["machines"]["sample"]["transitions"][0].update(to="NOPE"), "to")

    def test_duplicate_transition_ids_global(self):
        d = fixture(); d["machines"]["other"] = copy.deepcopy(d["machines"]["sample"])
        self.assertTrue(any("duplicate transition id" in e for e in validate_contract(d)))

    def test_unreachable_state(self):
        self.assert_invalid(lambda d: d["machines"]["sample"]["states"].update(ORPHAN={}), "unreachable")

    def test_unknown_role_but_system_allowed(self):
        self.assert_invalid(lambda d: d["machines"]["sample"]["transitions"][0].update(roles=["ALIEN"]), "role")
        self.assertEqual(validate_contract(fixture()), [])

    def test_nested_roles_diagnosed_without_crash(self):
        for roles in ([[]], [{}]):
            d = fixture(); d["machines"]["sample"]["transitions"][0]["roles"] = roles
            self.assertTrue(validate_contract(d))

    def test_event_and_identifiers_must_be_nonblank_strings(self):
        for key, value, phrase in (("event", "", "event"), ("event", None, "event"),
                                   ("event", 2, "event"), ("id", " ", "id"),
                                   ("from", "", "from"), ("to", " ", "to"),
                                   ("roles", [""], "role")):
            d = fixture(); d["machines"]["sample"]["transitions"][0][key] = value
            self.assertTrue(any(phrase in e for e in validate_contract(d)), (key, value))

    def test_malformed_transition_endpoints_and_roles_are_diagnostics(self):
        for key, value in (("from", [[]]), ("to", []), ("roles", [["REVIEWER"]])):
            d = fixture(); d["machines"]["sample"]["transitions"][0][key] = value
            self.assertTrue(validate_contract(d))

    def test_duplicate_yaml_keys_rejected(self):
        with self.assertRaises((ValueError, yaml.YAMLError)):
            load_contract_text("machines: {}\nmachines: {}\n")

    def test_unhashable_yaml_mapping_key_is_yaml_error(self):
        with self.assertRaises(yaml.YAMLError):
            load_contract_text("? [complex, key]\n: value\n")

    def test_cli_malformed_file_fails_closed_without_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.yaml"
            path.write_text("? [complex, key]\n: value\n", encoding="utf-8")
            result = subprocess.run([sys.executable, "scripts/validate_contract.py", str(path)],
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Traceback", result.stderr + result.stdout)

    def test_empty_guards_permitted(self):
        d = fixture(); d["machines"]["sample"]["transitions"][0]["guards"] = []
        self.assertEqual(validate_contract(d), [])

    def test_malformed_structures_diagnosed_not_crashed(self):
        for value in (None, [], {"machines": []}, {"machines": {"x": {"states": [], "transitions": [None]}}}):
            with self.subTest(value=value):
                self.assertTrue(validate_contract(value))


def load_contract_text(text):
    from scripts.validate_contract import load_contract_text as load
    return load(text)


if __name__ == "__main__":
    unittest.main()
