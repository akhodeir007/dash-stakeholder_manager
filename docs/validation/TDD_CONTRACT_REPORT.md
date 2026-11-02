# State-machine contract validation report

## Scope and result (review repair)

The lead review corrected the schema assumption: `terminal` is optional because long-running workstream machines may omit it. When present, `terminal` must be a list of valid states; an empty list is allowed. No domain YAML was changed. Validation checks YAML shape, machine/state references, globally unique transition IDs, reachability, event names, and declared roles. `SYSTEM` is accepted as an internal role. An empty `guards: []` is accepted: guards are list-shaped metadata and an unconditional transition is structurally meaningful. Duplicate YAML mapping keys are rejected during loading; unhashable mapping keys become YAML constructor errors.

This is not a runtime state-machine implementation, guard evaluator, evidence verifier, authorization enforcement, or proof of invariant correctness. Structural validation cannot establish that guard names are true or that cited evidence exists.

## TDD evidence

Initial implementation history: before the validator existed, `python -m unittest tests.test_validate_contract` was **RED**, exit 1 due to import failure. After the first implementation it was **RED**, 11 tests ran and 1 failed because the implementation incorrectly required `terminal`.

Repair-round RED, before fixes: `python -m unittest tests.test_validate_contract` — **RED**, 18 tests ran: 4 failures and 3 errors. Observed failures included optional/missing terminal and actual-contract regression, absent event validation; observed errors were `TypeError` for nested role values and unhashable YAML mapping keys, plus a CLI traceback for the malformed YAML file.

After repairs: `python -m unittest tests.test_validate_contract` — **GREEN**, 18 tests passed. `python scripts/validate_contract.py --format json` — **GREEN**, exit 0, `{"valid": true, "errors": []}`. Regression asserts 20 machine definitions and 173 transitions and zero structural errors.

Small fixture and mutation tests cover required initial, optional and malformed terminal, from/to, globally duplicate IDs, unreachable states, roles including nested malformed values, `SYSTEM`, duplicate/unhashable YAML keys, event and identifier types/blankness, empty guards, malformed structures, and malformed-file CLI behavior.

## Files

- `scripts/validate_contract.py`
- `tests/test_validate_contract.py`
- `requirements-dev.txt`
- `docs/validation/TDD_CONTRACT_REPORT.md`

PyYAML was already available; no network access or dependency installation was used. CLI defaults to `docs/state-machines.yaml` relative to the repository and supports `--format json`.

## Limits

The validator is structural only. It does not evaluate guard expressions, prove transition completeness or invariant truth, verify evidence, or execute authorization/runtime behavior. Reachability is graph reachability from the declared initial state using declared transitions; it does not establish business correctness.
