# W2 integration report — foundation persistence, command engine, authorization, and evidence vault

**Date:** 2 November 2026  
**Outcome:** All W2 foundation tasks (`BUILD-001`, `BUILD-002`, `BUILD-003`, and `BUILD-004` including `SM_10_document`) are accepted for local/synthetic development. W3 domain workflow tasks (`DOMAIN-001`, `DOMAIN-002`, `DOMAIN-004`) are now unblocked and ready for specification/dispatch.

## Accepted foundation artifacts

| Task | Artifacts | Verification summary |
|---|---|---|
| `BUILD-001` | Next.js 15 scaffold, health endpoint, runtime env guard, disposable PostgreSQL runner (`scripts/test-foundation.mjs`), CI contract | 4 unit, 4 smoke HTTP, 6 database-runner tooling tests, 7 CI contract Python tests pass |
| `BUILD-002` | `src/db/schema.ts`, `src/db/migrate.ts`, `src/db/migrations/0001_command_foundation.sql`, `src/domain/commands/engine.ts`, `tests/integration/commands/{engine,schema}.test.ts` | 47 command-engine + 6 schema-parity real-PostgreSQL tests pass |
| `BUILD-003` | `src/auth/authorization.ts`, `tests/integration/auth/authorization.test.ts` | 23 authorization policy tests (including 173 transitions × 7 roles matrix and all 10 dual-control transition role-pair rules) pass |
| `BUILD-004` | `src/domain/evidence/{index,vault}.ts`, `tests/integration/evidence/{document,reliance,gate-snapshot,correction,revalidation-overlay}.test.ts` | 14 real-PostgreSQL evidence vault, `SM_10_document`, reliance, gate-snapshot, correction, and revalidation-overlay tests pass |
| Seam | `src/contracts/foundation.ts`, `tests/integration/foundation-seam.test.ts` | 7 real-PostgreSQL seam tests verifying command engine + authorization service composition pass |

## Actual verification

| Check | Result |
|---|---|
| `npm run typecheck` | Pass |
| `npm run lint` | Pass (0 warnings, 0 errors) |
| `npm run test` | 4 Vitest unit tests pass |
| `node --test tests/tooling/database-runner.test.mjs` | 6 tests pass |
| `npm run build` | Pass |
| `node --test tests/smoke/scaffold.test.mjs` | 4 HTTP tests pass |
| `npm run test:database` | **97 integration tests pass** (47 command + 6 schema + 23 authorization + 7 foundation seam + 14 evidence vault) |
| `python3 -m unittest discover -s tests -v` | 55 Python tests pass |
| `python3 scripts/validate_contract.py --format json` | Pass (20 machines, 173 transitions) |
| `python3 scripts/validate_coverage.py --format json` | Pass |

## Scope and limitations

- Technical acceptance covers local/synthetic development only.
- `LIVE_EVIDENCE`, `HOSTING_POLICY`, and `RELEASE_SIGNOFF` gates remain pending human/client inputs.
- Next ready wave: W3 domain lanes (`DOMAIN-001`, `DOMAIN-002`, `DOMAIN-004`, followed by `DOMAIN-003`).
