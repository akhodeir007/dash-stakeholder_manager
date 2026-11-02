#!/usr/bin/env python3
"""Read-only readiness report for the execution backlog."""
import argparse
import json
import pathlib
import sys

import yaml


class QueueError(Exception):
    """Invalid or unsafe backlog specification."""


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def _mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            if key in result:
                raise QueueError(f"duplicate YAML key: {key}")
            result[key] = loader.construct_object(value_node, deep=deep)
        except TypeError as exc:
            raise QueueError("YAML mapping keys must be hashable scalars") from exc
    return result


UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


def load_file(path):
    try:
        with open(path, encoding="utf-8") as stream:
            data = yaml.load(stream, Loader=UniqueKeyLoader)
    except QueueError:
        raise
    except (OSError, yaml.YAMLError, UnicodeError, TypeError, ValueError) as exc:
        raise QueueError(f"cannot read YAML: {exc}") from exc
    return data


def _require(condition, message):
    if not condition:
        raise QueueError(message)


def evaluate(data):
    _require(isinstance(data, dict), "backlog must be a mapping")
    _require(data.get("version") == "1.0", "version must be '1.0'")
    gates, tasks = data.get("gates"), data.get("tasks")
    _require(isinstance(gates, list), "gates must be a list")
    _require(isinstance(tasks, list), "tasks must be a list")
    gate_map, task_map = {}, {}
    gate_fields = {"id": str, "status": str, "description": str}
    task_fields = {"id": str, "title": str, "status": str, "kind": str, "owner": str}
    for gate in gates:
        _require(isinstance(gate, dict), "each gate must be a mapping")
        for field, typ in gate_fields.items():
            _require(field in gate and isinstance(gate[field], typ) and bool(gate[field].strip()), f"gate requires nonblank string {field}")
        _require(gate["status"] in {"pending", "satisfied"}, f"unsupported gate status: {gate['status']}")
        _require(gate["id"] not in gate_map, f"duplicate gate id: {gate['id']}")
        gate_map[gate["id"]] = gate
    allowed = {"queued", "in_progress", "review", "done", "blocked"}
    for task in tasks:
        _require(isinstance(task, dict), "each task must be a mapping")
        for field, typ in task_fields.items():
            _require(field in task and isinstance(task[field], typ) and bool(task[field].strip()), f"task requires nonblank string {field}")
        _require(task["status"] in allowed, f"unsupported task status: {task['status']}")
        for field in ("depends_on", "gates", "write_scope", "acceptance"):
            _require(isinstance(task.get(field), list) and all(isinstance(x, str) for x in task[field]), f"task {task['id']} {field} must be a list of strings")
            if field in ("depends_on", "gates"):
                _require(all(value.strip() for value in task[field]), f"task {task['id']} {field} contains a blank reference")
                _require(len(task[field]) == len(set(task[field])), f"task {task['id']} {field} contains duplicate references")
        _require(task["id"] not in task_map, f"duplicate task id: {task['id']}")
        task_map[task["id"]] = task
    for task in tasks:
        for dep in task["depends_on"]:
            _require(dep in task_map, f"task {task['id']} references unknown dependency: {dep}")
        for gate_id in task["gates"]:
            _require(gate_id in gate_map, f"task {task['id']} references unknown gate: {gate_id}")

    visiting, visited = set(), set()
    def visit(task_id):
        if task_id in visiting:
            raise QueueError(f"dependency cycle involving task: {task_id}")
        if task_id in visited:
            return
        visiting.add(task_id)
        for dep in task_map[task_id]["depends_on"]:
            visit(dep)
        visiting.remove(task_id)
        visited.add(task_id)
    for task_id in task_map:
        visit(task_id)

    rows = []
    for task in tasks:
        status = task["status"]
        reasons = []
        if status == "queued":
            reasons.extend(f"unfinished dependency: {dep}" for dep in task["depends_on"] if task_map[dep]["status"] != "done")
            reasons.extend(f"unsatisfied gate: {gid}" for gid in task["gates"] if gate_map[gid]["status"] != "satisfied")
            readiness = "ready" if not reasons else "blocked"
        elif status == "blocked":
            readiness, reasons = "blocked", ["manual status: blocked"]
        else:
            readiness = status
        rows.append({"id": task["id"], "status": status, "readiness": readiness, "reasons": reasons})
    summary = {key: sum(row["readiness"] == key for row in rows) for key in ("ready", "blocked", "in_progress", "review", "done")}
    summary["total"] = len(rows)
    return {"valid": True, "tasks": rows, "summary": summary}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    default_path = pathlib.Path(__file__).resolve().parents[1] / "docs" / "execution" / "backlog.yaml"
    parser.add_argument("path", nargs="?", default=str(default_path))
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    try:
        report = evaluate(load_file(args.path))
    except Exception as exc:
        message = str(exc) if isinstance(exc, QueueError) else f"invalid backlog data: {exc}"
        if args.format == "json":
            print(json.dumps({"valid": False, "errors": [message]}, indent=2))
        else:
            print(f"invalid backlog: {message}", file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(report, indent=2))
    else:
        for row in report["tasks"]:
            detail = "; ".join(row["reasons"])
            print(f"{row['id']}\t{row['status']}\t{row['readiness']}" + (f"\t{detail}" if detail else ""))
        print("Summary: " + ", ".join(f"{key}={value}" for key, value in report["summary"].items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
