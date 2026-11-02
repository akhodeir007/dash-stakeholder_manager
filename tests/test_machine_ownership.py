"""Specification traceability, not runtime implementation coverage."""
from pathlib import Path
import unittest

from scripts.validate_contract import load_contract
from scripts.execution_queue import load_file


ROOT = Path(__file__).resolve().parents[1]


class MachineOwnershipTests(unittest.TestCase):
    def test_every_machine_has_one_existing_implementation_task(self):
        contract = load_contract(ROOT / "docs/state-machines.yaml")
        backlog = load_file(ROOT / "docs/execution/backlog.yaml")
        ownership = backlog.get("machine_ownership", {})
        self.assertEqual(set(ownership), set(contract["machines"]))
        tasks = {task["id"]: task for task in backlog["tasks"]}
        for machine, entry in ownership.items():
            with self.subTest(machine=machine):
                self.assertIn(entry["task"], tasks)
                task = tasks[entry["task"]]
                self.assertEqual(task["kind"], "implementation")
                self.assertTrue(task["acceptance"])
                self.assertTrue(entry["tests"])
                for artifact in entry["tests"]:
                    self.assertTrue(any(
                        artifact == scope or artifact.startswith(scope.rstrip("/") + "/")
                        for scope in task["write_scope"]
                    ), f"{artifact} outside {task['id']} write scope")


if __name__ == "__main__":
    unittest.main()
