import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("execution_queue", ROOT / "scripts" / "execution_queue.py")
queue = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(queue)


def valid_data():
    return {
        "version": "1.0",
        "gates": [{"id": "g1", "status": "satisfied", "description": "approved"}],
        "tasks": [
            {"id": "a", "title": "A", "status": "done", "depends_on": [], "gates": [], "kind": "x", "owner": "x", "write_scope": [], "acceptance": []},
            {"id": "b", "title": "B", "status": "queued", "depends_on": ["a"], "gates": ["g1"], "kind": "x", "owner": "x", "write_scope": [], "acceptance": []},
        ],
    }


class ExecutionQueueTests(unittest.TestCase):
    def test_dependency_and_gate_readiness(self):
        data = valid_data()
        rows = queue.evaluate(data)["tasks"]
        self.assertEqual(rows[1]["readiness"], "ready")
        data["tasks"][0]["status"] = "queued"
        rows = queue.evaluate(data)["tasks"]
        self.assertEqual(rows[1]["readiness"], "blocked")
        self.assertTrue(any("a" in reason for reason in rows[1]["reasons"]))

    def test_pending_gate_blocks(self):
        data = valid_data()
        data["gates"][0]["status"] = "pending"
        row = queue.evaluate(data)["tasks"][1]
        self.assertEqual(row["readiness"], "blocked")
        self.assertTrue(any("g1" in reason for reason in row["reasons"]))

    def test_done_never_rerun(self):
        row = queue.evaluate(valid_data())["tasks"][0]
        self.assertEqual(row["readiness"], "done")

    def test_manual_block_and_active_states(self):
        data = valid_data()
        for status, expected in (("blocked", "blocked"), ("in_progress", "in_progress"), ("review", "review")):
            data["tasks"][1]["status"] = status
            self.assertEqual(queue.evaluate(data)["tasks"][1]["readiness"], expected)

    def test_cycle_rejected(self):
        data = valid_data()
        data["tasks"][0]["depends_on"] = ["b"]
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)

    def test_unknown_references_rejected(self):
        data = valid_data()
        data["tasks"][1]["depends_on"] = ["missing"]
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)

    def test_malformed_types_rejected(self):
        data = valid_data()
        data["tasks"][1]["acceptance"] = "not a list"
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)

    def test_duplicate_yaml_keys_rejected(self):
        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as f:
            f.write("version: '1.0'\nversion: '1.0'\ngates: []\ntasks: []\n")
            f.flush()
            with self.assertRaises(queue.QueueError):
                queue.load_file(f.name)

    def test_malformed_status_rejected(self):
        data = valid_data()
        data["tasks"][1]["status"] = "waiting"
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)

    def test_duplicate_ids_rejected(self):
        data = valid_data()
        data["tasks"].append(dict(data["tasks"][1]))
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)

    def test_cli_json_output(self):
        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as f:
            import yaml
            yaml.safe_dump(valid_data(), f)
            f.flush()
            out = io.StringIO()
            with redirect_stdout(out):
                code = queue.main([f.name, "--format", "json"])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(out.getvalue())["summary"]["ready"], 1)

    def test_actual_backlog_valid_and_summary(self):
        data = queue.load_file(ROOT / "docs/execution/backlog.yaml")
        report = queue.evaluate(data)
        self.assertTrue(report["valid"])
        self.assertEqual(report["summary"]["total"], len(data["tasks"]))
        self.assertEqual(sum(report["summary"][key] for key in
                             ("ready", "blocked", "in_progress", "review", "done")),
                         len(data["tasks"]))
        self.assertEqual({row["id"]: row["status"] for row in report["tasks"] if row["status"] in {"queued", "in_progress", "review", "done", "blocked"}},
                         {task["id"]: task["status"] for task in data["tasks"] if task["status"] in {"queued", "in_progress", "review", "done", "blocked"}})

    def test_unhashable_yaml_key_is_queue_error_not_traceback(self):
        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as f:
            f.write("? [complex, key]\n: value\nversion: '1.0'\ngates: []\ntasks: []\n")
            f.flush()
            with self.assertRaises(queue.QueueError):
                queue.load_file(f.name)

    def test_blank_required_text_and_references_rejected(self):
        for collection, field in (("tasks", "id"), ("tasks", "title"), ("tasks", "kind"), ("tasks", "owner"), ("gates", "id"), ("gates", "description")):
            with self.subTest(collection=collection, field=field):
                data = valid_data()
                target = data[collection][0]
                target[field] = "  "
                with self.assertRaises(queue.QueueError):
                    queue.evaluate(data)
        data = valid_data()
        data["tasks"][1]["depends_on"] = [" "]
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)

    def test_duplicate_references_rejected(self):
        data = valid_data()
        data["tasks"][1]["depends_on"] = ["a", "a"]
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)
        data = valid_data()
        data["tasks"][1]["gates"] = ["g1", "g1"]
        with self.assertRaises(queue.QueueError):
            queue.evaluate(data)

    def test_done_dependency_does_not_override_unsatisfied_gate(self):
        data = valid_data()
        data["gates"][0]["status"] = "pending"
        row = queue.evaluate(data)["tasks"][1]
        self.assertEqual(row["readiness"], "blocked")
        self.assertIn("unsatisfied gate: g1", row["reasons"])

    def test_invalid_json_cli_reports_machine_readable_stdout(self):
        with tempfile.NamedTemporaryFile("w", encoding="utf-8") as f:
            f.write("not: [valid")
            f.flush()
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = queue.main([f.name, "--format", "json"])
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(out.getvalue())["valid"], False)
            self.assertTrue(json.loads(out.getvalue())["errors"])
            self.assertEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
