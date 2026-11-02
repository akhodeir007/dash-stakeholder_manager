# BUILD-001 — scaffold integration acceptance

**Date:** 2 November 2026  
**Outcome:** accepted for **local scaffold development only**. Production regulatory, hosting and release gates remain pending.

## Delivered

- Next.js **15.5.28**, React **19.3.1**, TypeScript **5.9.3**, pinned direct dependencies and reproducible npm lockfile.
- Minimal development notice, root layout and `GET /api/health` with exact liveness-only output: `workflowReady: false`, DREX `"OFF"`, no MEPS write-back or hosted document processing.
- Frozen nested runtime defaults; request/environment input cannot enable integrations. No authentication stub, workflow endpoint, database connection, credential or live adapter.
- Loopback-bound dev/start scripts and disabled framework telemetry.
- Vitest checks, TypeScript/ESLint/build scripts, read-only CI definition, parsed-workflow contract tests and bounded production-artifact HTTP smoke checks.
- Local setup guide: [`../DEVELOPMENT.md`](../DEVELOPMENT.md).

Original source documents were not edited or moved into public assets. No Git repository, remote or deployment was created.

## Delegation and review

Two Luna implementers owned disjoint foundation and CI paths. Each received one repair round. A third read-only Luna reviewer independently approved the CI definition and the completed local scaffold. Lead reviewed the files and ran combined verification. No worker recursively delegated.

Lead-integrated improvements included actual HTTP checks under `tests/smoke/scaffold.test.mjs` and their CI step. The CI contract first failed RED when the smoke command was required but absent; adding the executable workflow step restored GREEN. The smoke server runs with a minimal environment, loopback binding, bounded startup wait and cleanup of its own child process.

Worker red/green and deliberate unsafe-mutation evidence is recorded separately:

- [`TDD_BUILD_001_REPORT.md`](./TDD_BUILD_001_REPORT.md): fixed health/default behavior, immutability, loopback scripts and hostile environment tests.
- [`TDD_BUILD_001_CI_REPORT.md`](./TDD_BUILD_001_CI_REPORT.md): missing workflow, removed command, comment-only command, disabled step and widened permissions tests.

The first CI draft's text checks were rejected because comments or disabled commands could appear green. The final tests inspect parsed executable jobs/steps and reject override permissions, extra jobs, services and secret expressions. Checkout does not persist credentials.

## Actual lead verification

Environment: Node **22.23.4**, npm **10.9.9**, Python **3.14.8**, PyYAML **6.0.3**. CI targets Node 22/Python 3.12; that remote environment has not been executed.

| Command | Actual result |
|---|---|
| `npm ci` | Pass; fresh lockfile installation |
| `npm run test` | **4 Vitest tests passed** |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass, including lead-added smoke test |
| `npm run build` | Pass; `/`, framework not-found page and `/api/health` compiled |
| `node --test tests/smoke/scaffold.test.mjs` | **4 HTTP tests passed** against a temporary loopback production server; child stopped afterward |
| `python3 -m unittest discover -s tests -v` | **55 Python tests passed**, including 7 CI-contract tests |
| `python3 scripts/validate_contract.py --format json` | Pass; v1.2 remains structurally valid |
| `python3 scripts/validate_coverage.py --format json` | Pass; 173 transitions, 20 machines, 287 planned false and 287 planned unknown local-guard occurrences, 34 planned global cases |
| `npm ls next react @types/node @eslint/eslintrc postcss` | Pass; versions match lockfile and override |
| `npm audit --json` | Exit 1; **14 moderate, 0 high, 0 critical** findings |

Application checks ran serially to avoid `.next` generation/typecheck races. An additional clean-artifact, non-incremental typecheck passed during lead review; the generated build cache was restored. No source directory was deleted.

HTTP checks prove only this scaffold's behavior: fixed non-sensitive health/no request echo; POST returns 405; root explicitly says permitting is unimplemented; two representative workspace PDF/XLSX paths return 404; powered-by header absent. This is not comprehensive penetration testing or a browser/accessibility audit.

## Dependency/security disposition

The initial dependency tree had 16 findings including one high PostCSS advisory. Repair pinned Node 22 typings instead of Node 26 typings, declared the directly imported `@eslint/eslintrc`, and added a narrow Next-only PostCSS **8.5.23** override. `npm ls` and build verified the override; parent npm audit confirmed high/critical counts are now zero.

**Fourteen moderate ESLint/minimatch-chain findings remain.** ESLint **9.39.5** is registry-deprecated. They are not silently ignored or force-fixed across majors. Local scaffold acceptance does not waive production security/maintenance review; release signoff explicitly requires it. No vulnerability-free or production-ready claim is made. Revalidate the override and advisories before future dependency changes.

Actions use known major-version tags, not immutable commit SHAs. GitHub Actions has **not run**; this workspace remains outside Git. Local equivalents passing do not establish remote CI execution. A brief ephemeral-port reservation/startup race is possible in smoke checks; these local checks are not a process-isolation or security proof.

## Continuation

BUILD-001 is done; BUILD-002 persistence/atomic commands and BUILD-003 authorization are ready for **bounded contract review and dispatch**, potentially in parallel. Package/config changes remain lead-owned to prevent shared-file races. PostgreSQL transaction proofs require a real disposable database; Docker is installed, but daemon/database readiness remains unverified.

The `src/app` scaffold writer is closed. UI-001 may take ownership only after lead handoff; prior agents must not perform concurrent edits there.

No domain state machine or guard is implemented by this task. The 173-transition manifest is still a **plan**, not executed runtime coverage. Source conflicts, 24-condition Attachment 1, named validator/approver assignments, scope/ENOC/appointment evidence and live hosting/AI decisions remain unresolved. Actual model costs were not supplied; no measured dollar-savings claim is made.
