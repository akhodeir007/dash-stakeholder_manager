#!/usr/bin/env python3
"""Structural checks for the state-machine YAML contract; not a runtime verifier."""
import argparse
import json
from pathlib import Path

import yaml


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def _mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in result
        except TypeError as exc:
            raise yaml.constructor.ConstructorError(None, None, f"unhashable YAML mapping key: {key!r}", key_node.start_mark) from exc
        if duplicate:
            raise yaml.constructor.ConstructorError(None, None, f"duplicate YAML key: {key!r}", key_node.start_mark)
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)


def load_contract_text(text):
    try:
        return yaml.load(text, Loader=UniqueKeyLoader)
    except TypeError as exc:
        # PyYAML may surface constructor/hashability problems as TypeError.
        raise yaml.constructor.ConstructorError(None, None, f"invalid YAML structure: {exc}", None) from exc


def load_contract(path):
    return load_contract_text(Path(path).read_text(encoding="utf-8"))


def validate_contract(doc):
    errors = []
    if not isinstance(doc, dict):
        return ["document must be a mapping"]
    machines = doc.get("machines")
    if not isinstance(machines, dict) or not machines:
        return ["machines must be a non-empty mapping"]
    roles = doc.get("roles", [])
    if not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
        roles = []
        errors.append("roles must be a list of strings")
    known_roles = {r for r in roles if isinstance(r, str) and r.strip()} | {"SYSTEM"}
    ids = set()
    for name, machine in machines.items():
        prefix = f"machine {name}"
        if not isinstance(machine, dict):
            errors.append(f"{prefix}: definition must be a mapping"); continue
        states, transitions = machine.get("states"), machine.get("transitions")
        if not isinstance(states, dict) or not states:
            errors.append(f"{prefix}: states must be a non-empty mapping"); continue
        for state in states:
            if not isinstance(state, str) or not state.strip():
                errors.append(f"{prefix}: state names must be non-empty strings")
        if not isinstance(transitions, list):
            errors.append(f"{prefix}: transitions must be a list"); transitions = []
        initial = machine.get("initial")
        if not isinstance(initial, str) or initial not in states:
            errors.append(f"{prefix}: missing or invalid initial state {initial!r}")
        terminals = machine.get("terminal")
        if "terminal" in machine:
            if not isinstance(terminals, list):
                errors.append(f"{prefix}: terminal must be a list")
            else:
                for state in terminals:
                    if not isinstance(state, str) or not state.strip() or state not in states:
                        errors.append(f"{prefix}: invalid terminal state {state!r}")
        edges = {}
        for index, transition in enumerate(transitions):
            tprefix = f"{prefix} transition[{index}]"
            if not isinstance(transition, dict):
                errors.append(f"{tprefix}: must be a mapping"); continue
            tid = transition.get("id")
            if not isinstance(tid, str) or not tid.strip():
                errors.append(f"{tprefix}: id must be a non-empty string")
            elif tid in ids:
                errors.append(f"{tprefix}: duplicate transition id {tid!r}")
            else:
                ids.add(tid)
            src, dst = transition.get("from"), transition.get("to")
            sources = src if isinstance(src, list) else [src]
            if not sources or any(not isinstance(s, str) or not s.strip() or s not in states for s in sources):
                errors.append(f"{tprefix}: invalid from state {src!r}")
            else:
                for s in sources: edges.setdefault(s, set())
            if not isinstance(dst, str) or not dst.strip() or dst not in states:
                errors.append(f"{tprefix}: invalid to state {dst!r}")
            elif all(isinstance(s, str) and s in states for s in sources):
                for s in sources: edges.setdefault(s, set()).add(dst)
            for field in ("guards", "roles"):
                value = transition.get(field)
                if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
                    errors.append(f"{tprefix}: {field} must be a list of non-empty strings")
            event = transition.get("event")
            if not isinstance(event, str) or not event.strip():
                errors.append(f"{tprefix}: event must be a non-empty string")
            for role in transition.get("roles", []) if isinstance(transition.get("roles", []), list) else []:
                if isinstance(role, str) and role.strip() and role not in known_roles:
                    errors.append(f"{tprefix}: unknown role {role!r}")
        if isinstance(initial, str) and initial in states:
            reached, stack = {initial}, [initial]
            while stack:
                for target in edges.get(stack.pop(), ()):
                    if target not in reached: reached.add(target); stack.append(target)
            for state in states:
                if state not in reached: errors.append(f"{prefix}: unreachable state {state!r}")
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="docs/state-machines.yaml")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    path = Path(args.path)
    if not path.is_absolute(): path = Path(__file__).resolve().parent.parent / path
    try:
        errors = validate_contract(load_contract(path))
    except (OSError, yaml.YAMLError, ValueError) as exc:
        errors = [f"cannot load contract: {exc}"]
    if args.format == "json":
        print(json.dumps({"valid": not errors, "errors": errors}, indent=2))
    elif errors:
        print("Invalid contract:"); print("\n".join(f"- {e}" for e in errors))
    else:
        print("Contract structurally valid.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
