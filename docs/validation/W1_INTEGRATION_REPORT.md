# W1 integration report — specification-driven execution

**Date:** 2 November 2026  
**Outcome:** SPEC-001–SPEC-004 accepted for local/synthetic development. **Application implementation has not started.**

## Accepted artifacts

| Task | Artifact | Acceptance |
|---|---|---|
| SPEC-001 | [`SPEC_DECISIONS.md`](../execution/SPEC_DECISIONS.md), plan/YAML v1.2, `tests/test_sdd_contract.py` | Ten audit gaps have conservative software dispositions and named unresolved human inputs; topology stays 20 machines / 173 transitions |
| SPEC-002 | [`coverage-manifest.yaml`](../execution/coverage-manifest.yaml), coverage validator/tests | Exact transition/from/role/guard mapping; original I1–I15 retained; GAP-01–10 mapped to implementation owners |
| SPEC-003 | [`COMMAND_SCHEMA_SPEC.md`](../execution/COMMAND_SCHEMA_SPEC.md) | Atomic schema/commands, idempotency, epochs, scope variants, event registry and 27 planned CS acceptance cases |
| SPEC-004 | [`IMPORT_EVIDENCE_RBAC_SPEC.md`](../execution/IMPORT_EVIDENCE_RBAC_SPEC.md) | Two-sheet import/evidence contract, seven-role policy intersection and 40 planned IE acceptance cases |

`TECH_SPEC` is satisfied **only for local/synthetic development**. `LIVE_EVIDENCE`, `HOSTING_POLICY` and `RELEASE_SIGNOFF` remain pending. A ready queue row is not production authority or automatic dispatch permission.

## Delegation and independent review

- Three GPT-6 Luna specification agents owned disjoint manifest/schema/import-policy files.
- Each received one bounded repair round after lead review; no recursive delegation or application changes.
- A separate Luna reviewer approved the initial conservative software decisions for further specification, subject to verified named validator assignments.
- Another read-only Luna review checked the completed command/schema contract and lead coverage checker. Its idempotency-key and producer-emission findings were integrated by the lead.
- Final integration remained lead-owned. Maximum agent concurrency was three. Dollar/token totals were not supplied by the active provider; no measured savings claim is made.

## Review corrections integrated

1. Dependency epochs and current eligibility are distinct from authority history; stale state cannot grant a new action, and software cannot legally revoke an issued permit.
2. Regulated evidence requires a different eligible named validator with verified scope. Signer, recorder, uploader, issuer and validator fields are separate.
3. All ten dual-control transitions have explicit permitted role pairs. One person with two roles never qualifies; risk acceptance's existing single-role/two-person requirement needs two different eligible executives.
4. Package gate bindings are immutable and complete. Project facts and pre-project plot intake use explicit non-gate scope variants, never dummy package IDs or inferred applicability.
5. Preparatory fallback remains disabled; full permit is coordinated-only pending a separately reviewed ADM-directed contract.
6. Bare YAML `OFF`/`yes`/`no` were quoted to preserve typed DREX strings rather than booleans.
7. The manifest's draft redefinitions of invariant IDs were rejected. All I1–I15 now retain the plan's meanings. YAML prose is quoted to avoid comma-induced extra/null keys; the checker rejects unexpected global-case fields.
8. Idempotency uniqueness is consistently `(tenant_id,actor_id,idempotency_key)`; command name is hashed, so cross-command reuse conflicts. Replay returns stored semantic results, not a new eligibility token.
9. Multiple outbox events use an event sequence per aggregate version, not a uniqueness constraint that would forbid them. Immutable assertions/evidence versions are separate from current reliance/lifecycle projections.
10. All 17 orchestration event names have reviewed producer mappings. The registry explicitly defines conditional internal emissions; non-ENOC receipts cannot emit ENOC approval. No event grants MEPS/authority communication rights.
11. The legacy broad RBAC table was replaced with command-specific policy. Inspector technical review is not comment closure; contractor material supply is not comment lifecycle permission. Minimal denial audit remains allowed without success-side writes.

## TDD evidence

These are local specification/tooling tests, not domain runtime tests:

- `python3 -m unittest discover -s tests -p 'test_sdd_contract.py' -v` ran RED: seven failures covering missing policies and the YAML boolean coercion. Policies/quoted enums then made those tests green.
- `python3 -m unittest tests.test_sdd_contract.SDDContractTests.test_every_dual_control_transition_has_explicit_eligible_pairs -v` ran RED on absent participant mappings; adding all ten mappings made it green.
- Coverage-checker RED used a permissive placeholder: 13 mutation assertions plus malformed-input rejection failed, and the not-yet-created real manifest produced a missing-file error. Implementing the checker made synthetic cases pass; real-manifest checks later detected invariant-ID traceability errors before manifest repair.
- A subsequent RED mutation inserted an unexpected null key like that caused by unquoted flow-YAML prose; the checker initially accepted it. Strict global-case fields made that mutation test green.
- No generated TypeScript transition/guard case, CS/IE runtime case, PostgreSQL race, live import, hosted AI evaluation or deployment was executed.

## Final combined-workspace results

| Command / check | Actual result |
|---|---|
| `python3 -m unittest discover -s tests -v` | **48 tests passed**: 18 structural validator, 17 readiness queue, 1 machine ownership, 8 SDD declaration/enum/participant checks, 4 coverage-manifest integrity tests |
| `python3 scripts/validate_contract.py --format json` | Exit 0; no structural errors |
| `python3 scripts/validate_coverage.py --format json` | Exit 0; exact mapping for 173 transitions / 20 machines; 287 planned false-guard occurrences, 287 planned unknown-guard occurrences, 34 planned global cases |
| `python3 scripts/execution_queue.py` | Exit 0; **23 tasks: 8 done, 1 ready, 14 blocked** |
| Markdown fence/table check over existing `docs/**/*.md` | Balanced code fences and consistent table columns |

The 287 counts are local guard occurrences **before** expansion across role/from-state fixtures, not executed tests or mutation totals. Runtime coverage is explicitly `not_implemented`. Planned test paths do not imply files exist. Structural reachability does not prove guard satisfiability or legal correctness.

## Next bounded dispatch

`BUILD-001` is ready for consideration: a local application/CI scaffold with a reviewed dispatch contract, no live credentials, no hosted document processing and no external writes. Before that dispatch, confirm its exact file scope and red/green command. Downstream broad implementation slices must be split into bounded contracts before parallel agents write code.

Human S0 inputs remain unchanged: full DMP Attachment 1, AOR identity, clearance reference lineage, Water/ADSSC evidence, Package I scope, ENOC stage/owner, formal appointment evidence, named approvers/validators, live dates/extract and hosting/AI policy. Synthetic fixtures may test missing-input failure, never fill those legal gaps.
