"""Structural contract checks for the local-only BUILD-001 CI workflow."""

from copy import deepcopy
from pathlib import Path
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
REQUIRED_COMMANDS = [
    "pip install -r requirements-dev.txt",
    "npm ci",
    "npm run test",
    "npm run test:tooling",
    "npm run test:database",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
    "node --test tests/smoke/scaffold.test.mjs",
    "python3 -m unittest discover -s tests -v",
    "python3 scripts/validate_contract.py --format json",
    "python3 scripts/validate_coverage.py --format json",
    "python3 scripts/execution_queue.py --format json",
]
EXPECTED_ACTIONS = {
    "actions/checkout@v4": {"persist-credentials": "false"},
    "actions/setup-node@v4": {
        "node-version": "22",
        "cache": "npm",
        "cache-dependency-path": "package-lock.json",
    },
    "actions/setup-python@v5": {"python-version": "3.12"},
}


def load_workflow(text):
    # BaseLoader preserves `on` as a string (PyYAML's default YAML 1.1
    # resolver otherwise treats it as a boolean).
    return yaml.load(text, Loader=yaml.BaseLoader)


def assert_workflow_contract(testcase, workflow):
    def strings(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for key, item in value.items():
                yield from strings(key)
                yield from strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)

    testcase.assertFalse(
        any("${{ secrets." in value for value in strings(workflow)),
        "secrets expressions are forbidden",
    )
    testcase.assertIsInstance(workflow, dict)
    testcase.assertEqual(set(workflow), {"name", "on", "permissions", "env", "jobs"})
    testcase.assertEqual(set(workflow["on"]), {"push", "pull_request"})
    testcase.assertEqual(workflow["permissions"], {"contents": "read"})
    testcase.assertEqual(workflow["env"], {"NEXT_TELEMETRY_DISABLED": "1"})
    testcase.assertEqual(set(workflow["jobs"]), {"validate"})

    job = workflow["jobs"]["validate"]
    testcase.assertEqual(set(job), {"runs-on", "steps"})
    testcase.assertNotIn("if", job)
    if "permissions" in job:
        testcase.assertEqual(job["permissions"], {"contents": "read"})
    testcase.assertNotIn("env", job)
    testcase.assertEqual(job["runs-on"], "ubuntu-latest")

    actual_commands = []
    actual_actions = {}
    for step in job["steps"]:
        testcase.assertNotIn("if", step)
        testcase.assertNotIn("env", step)
        testcase.assertNotIn("uses", step) if "run" in step else None
        if "run" in step:
            testcase.assertEqual(set(step), {"name", "run"})
            actual_commands.append(step["run"])
        else:
            testcase.assertIn("uses", step)
            testcase.assertIn(step["uses"], EXPECTED_ACTIONS)
            testcase.assertEqual(set(step), {"name", "uses", "with"})
            testcase.assertNotIn(step["uses"], actual_actions)
            actual_actions[step["uses"]] = step["with"]

    testcase.assertEqual(actual_commands, REQUIRED_COMMANDS)
    testcase.assertEqual(actual_actions, EXPECTED_ACTIONS)


class CIContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = load_workflow(WORKFLOW.read_text(encoding="utf-8"))

    def test_workflow_structure_and_executable_contract(self):
        assert_workflow_contract(self, self.workflow)

    def test_comment_cannot_substitute_for_missing_executable_command(self):
        original = WORKFLOW.read_text(encoding="utf-8")
        mutated_text = original.replace("        run: npm run test\n", "        # run: npm run test\n")
        mutated = load_workflow(mutated_text)
        with self.assertRaises(AssertionError):
            assert_workflow_contract(self, mutated)

    def test_conditionals_are_rejected(self):
        mutated = deepcopy(self.workflow)
        mutated["jobs"]["validate"]["steps"][0]["if"] = "false"
        with self.assertRaises(AssertionError):
            assert_workflow_contract(self, mutated)

    def test_job_permission_override_is_rejected(self):
        mutated = deepcopy(self.workflow)
        mutated["jobs"]["validate"]["permissions"] = {"contents": "write"}
        with self.assertRaises(AssertionError):
            assert_workflow_contract(self, mutated)

    def test_extra_job_is_rejected(self):
        mutated = deepcopy(self.workflow)
        mutated["jobs"]["deploy"] = {"runs-on": "ubuntu-latest", "steps": []}
        with self.assertRaises(AssertionError):
            assert_workflow_contract(self, mutated)

    def test_services_are_rejected(self):
        mutated = deepcopy(self.workflow)
        mutated["jobs"]["validate"]["services"] = {"db": {"image": "example"}}
        with self.assertRaises(AssertionError):
            assert_workflow_contract(self, mutated)

    def test_secrets_expressions_are_rejected(self):
        mutated = deepcopy(self.workflow)
        mutated["jobs"]["validate"]["steps"][0].setdefault("with", {})["token"] = "${{ secrets.X }}"
        with self.assertRaises(AssertionError):
            assert_workflow_contract(self, mutated)


if __name__ == "__main__":
    unittest.main()
