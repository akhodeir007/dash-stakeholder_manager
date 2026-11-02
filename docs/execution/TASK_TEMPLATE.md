# Task contract — <ID>: <behavior>

## Scope

- Wave / parent sprint:
- Spec owner / implementer / independent reviewer:
- Exact requirement anchors:
- Goal:
- Non-goals:
- Read paths:
- Exclusive write paths:

## Interface and invariants

- Input/output types and schema:
- Authorization and scope:
- Preconditions / guards:
- Success and failure results:
- Atomicity / idempotency / concurrency:
- Evidence, provenance and retention:
- Clock and external services (mock/local/live):
- Unknowns and responsible human decision owner:

## Acceptance scenarios

| ID | Given | When | Then | Test type |
|---|---|---|---|---|
| <ID>-A01 | Valid input and authorized actor | Command executes | Expected result and immutable evidence | Positive |
| <ID>-A02 | Missing/invalid prerequisite | Same command | Fail closed; no state/ledger/outbox partial write | Negative |
| <ID>-A03 | Unauthorized/out-of-scope actor | Same command | Denied server-side | Security |
| <ID>-A04 | Duplicate/stale request | Retry/race | Idempotent result or explicit conflict | Concurrency |

Add behavior-specific boundaries, source-conflict, expiry/revocation and cross-package cases; remove irrelevant generic rows with a documented reason, not to reduce coverage.

## Verification and TDD record

- RED command and actual failure:
- GREEN command and actual result:
- Regression command and result:
- Mutation/negative-test sensitivity:
- Fixtures: synthetic vs source-derived vs verified live:
- Coverage: requirements/guards proven and remaining unknown:

## Review and integration

- Reviewer findings:
- Repair count (maximum one before escalation):
- Out-of-scope changes: none, or explicit lead approval:
- Integration verification:
- Unresolved blockers:
- Lead acceptance and queue status update:

No task is DONE without independent review and combined-workspace verification. Test results cannot substitute for Client/AOR approval.
