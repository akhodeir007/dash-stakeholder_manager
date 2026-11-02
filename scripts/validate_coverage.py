"""Validate planned test traceability, not implemented runtime coverage."""
import argparse
import json
from pathlib import Path

import yaml

if __package__:
    from .validate_contract import load_contract
else:
    from validate_contract import load_contract


TEMPLATES = {"positive", "illegal_from", "illegal_role", "guard_false",
             "guard_unknown", "rollback", "dual_control"}


def _strings(value):
    return (isinstance(value, list)
            and all(isinstance(item, str) and item.strip() for item in value)
            and len(value) == len(set(value)))


def validate_manifest(manifest, contract, backlog):
    errors = []
    if not all(isinstance(doc, dict) for doc in (manifest, contract, backlog)):
        return ["manifest, contract and backlog must be mappings"]
    machines = contract.get("machines")
    tasks = backlog.get("tasks")
    if not isinstance(machines, dict) or not isinstance(tasks, list):
        return ["invalid source contract or backlog"]
    task_ids = {task["id"] for task in tasks if isinstance(task, dict)
                and isinstance(task.get("id"), str)}
    for key, expected in (("version", "1.0"), ("contract_version", contract.get("version")),
                          ("source", "docs/state-machines.yaml"),
                          ("runtime_coverage", "not_implemented")):
        if manifest.get(key) != expected:
            errors.append(f"{key} must equal {expected!r}")
    templates = manifest.get("templates")
    if not isinstance(templates, dict) or not TEMPLATES.issubset(templates):
        errors.append("required case templates missing")
    elif any(not templates[key] for key in TEMPLATES):
        errors.append("case templates must have definitions")
    declared = {}
    for machine_id, machine in machines.items():
        if not isinstance(machine, dict) or not isinstance(machine.get("transitions"), list):
            return errors + ["malformed source machine"]
        for transition in machine["transitions"]:
            if not isinstance(transition, dict) or not isinstance(transition.get("id"), str):
                return errors + ["malformed source transition"]
            declared[(machine_id, transition["id"])] = transition
    rows = manifest.get("transitions")
    if not isinstance(rows, list):
        return errors + ["transitions must be a list"]
    seen = set()
    for index, row in enumerate(rows):
        label = f"transitions[{index}]"
        if not isinstance(row, dict):
            errors.append(f"{label} must be a mapping")
            continue
        if not all(isinstance(row.get(key), str) and row[key].strip() for key in ("machine", "id")):
            errors.append(f"{label} requires machine and id strings")
            continue
        key = (row["machine"], row["id"])
        if key in seen:
            errors.append(f"{label}: duplicate transition {key}")
        seen.add(key)
        if key not in declared:
            errors.append(f"{label}: unknown transition {key}")
            continue
        transition = declared[key]
        source_from = transition["from"]
        expected = {
            "guard_false": transition["guards"], "guard_unknown": transition["guards"],
            "from_states": source_from if isinstance(source_from, list) else [source_from],
            "allowed_roles": transition["roles"],
        }
        for field, values in expected.items():
            if not _strings(row.get(field)) or set(row[field]) != set(values):
                errors.append(f"{label}: {field} must exactly match source {values!r}")
    missing = set(declared) - seen
    if missing:
        errors.append(f"missing declared transitions: {sorted(missing)!r}")
    cases = manifest.get("global_cases")
    if not isinstance(cases, list) or not cases:
        return errors + ["global_cases must be a non-empty list"]
    case_ids = set()
    for index, case in enumerate(cases):
        label = f"global_cases[{index}]"
        fields = ("id", "requirement", "given", "when", "then", "owner_task")
        if not isinstance(case, dict) or not all(
                isinstance(case.get(key), str) and case[key].strip() for key in fields):
            errors.append(f"{label} requires nonblank case contract fields")
            continue
        if set(case) != set(fields):
            errors.append(f"{label}: unexpected fields; quote prose containing YAML delimiters")
        if case["id"] in case_ids:
            errors.append(f"{label}: duplicate case id {case['id']}")
        case_ids.add(case["id"])
        if case["owner_task"] not in task_ids:
            errors.append(f"{label}: unknown owner task {case['owner_task']}")
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    summary = {}
    try:
        manifest = load_contract(root / "docs/execution/coverage-manifest.yaml")
        contract = load_contract(root / "docs/state-machines.yaml")
        backlog = load_contract(root / "docs/execution/backlog.yaml")
        errors = validate_manifest(manifest, contract, backlog)
        if not errors:
            summary = {
                "planned_transitions": len(manifest["transitions"]),
                "planned_machines": len({row["machine"] for row in manifest["transitions"]}),
                "planned_guard_false_cases": sum(len(row["guard_false"]) for row in manifest["transitions"]),
                "planned_guard_unknown_cases": sum(len(row["guard_unknown"]) for row in manifest["transitions"]),
                "planned_global_cases": len(manifest["global_cases"]),
                "runtime_coverage": "not_implemented",
            }
    except (OSError, yaml.YAMLError, ValueError) as exc:
        errors = [f"cannot load coverage inputs: {exc}"]
    report = {"valid": not errors, "errors": errors, "summary": summary}
    print(json.dumps(report, indent=2) if args.format == "json" else str(report))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
