# Execution queue readiness CLI — TDD report

Implemented `scripts/execution_queue.py`, a local, read-only readiness report for `docs/execution/backlog.yaml` (or an optional positional path). It validates the backlog schema and references, rejects duplicate YAML keys/IDs and dependency cycles, and reports each task's readiness and blocking reasons. JSON output is available with `--format json`. Invalid input exits 2; a valid queue exits 0 regardless of blocked work.

The tool only reads the backlog. It does not modify files, launch agents, or make model/network calls; actual orchestration remains with the parent harness after scope review.

## TDD evidence

RED was run after adding tests and before implementation:

```text
python -m unittest tests/test_execution_queue.py
ERROR: module import failed because scripts/execution_queue.py did not exist yet
```

GREEN, after implementation:

```text
python -m unittest discover -s tests -p 'test_execution_queue.py' -v
Ran 11 tests in 0.004s
OK
```

Coverage includes dependency readiness, pending gates, completed-task non-rerun, manual blocked and active statuses, cycles, unknown references, malformed types/statuses, duplicate YAML keys/IDs, and JSON CLI output.

## Lead review: one repair round

Added behavioral regression tests before changing the implementation. The RED command was:

```text
python -m unittest discover -s tests -p 'test_execution_queue.py' -v
Ran 17 tests
FAILED (failures=6, errors=2)
```

The failing assertions exposed blank text acceptance, duplicate references accepted, wrong expectations for the actual backlog summary, and missing JSON error output; two errors exposed an uncaught `TypeError` from an unhashable YAML key and the resulting non-JSON invalid-input behavior. The backlog behavior assertion was corrected to its observed current state: 23 tasks (4 in progress and 19 blocked by pending dependencies), with no ready tasks.

After the repair, the same command completed with `Ran 17 tests ... OK`. The actual backlog was included in these tests. Valid JSON reports now include `valid: true`; invalid JSON reports write `{ "valid": false, "errors": [...] }` to stdout and exit 2. Optional relative paths resolve from the caller's current working directory; the default backlog path resolves from the script's repository root.
