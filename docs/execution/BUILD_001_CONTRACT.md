# BUILD-001 — Local application and CI scaffold

**Status:** approved for bounded local/synthetic implementation, subject to independent review and combined verification.  
**Wave:** W2 foundation; no domain workflow is implemented by this task.  
**Lead:** integration/review; implementers: Luna foundation and Luna CI agents, disjoint paths.

## Requirement anchors and boundaries

Execution plan §1.1, W1 `COMMAND_SCHEMA_SPEC.md` and `IMPORT_EVIDENCE_RBAC_SPEC.md`, YAML v1.2, backlog BUILD-001. Preserve Next.js 15 + TypeScript. Select a current stable 15.x patch from npm metadata and pin direct dependencies; generate a reproducible lockfile. Record dependency/security findings, not unverified promises of vulnerability-free software.

Only a development placeholder page, application root layout, non-sensitive liveness route, offline defaults, test tooling and CI are in scope. This is not the production dashboard or its visual-design implementation. No auth/session stub may imply a verified human identity. No database, authority adapter, workflow engine, hosted AI, document upload or real client data is connected. Never send source documents to external services. Package registry access is permitted for installing tooling only.

## File ownership

| Worker | Exclusive write scope during dispatch |
|---|---|
| Luna foundation | `package.json`, `package-lock.json`, `tsconfig.json`, `next-env.d.ts`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore`, `src/app/**`, `src/config/**`, `tests/unit/scaffold/**`, `docs/validation/TDD_BUILD_001_REPORT.md` |
| Luna CI | `.github/workflows/ci.yml`, `tests/test_ci_contract.py`, `docs/validation/TDD_BUILD_001_CI_REPORT.md` |
| Lead | This contract, backlog/handoff, development guide, `tests/smoke/scaffold.test.mjs`, final integration report and integration-only fixes after workers finish |

Foundation must not edit CI/Python tests. CI must not edit package/config/app files. The CI agent uses the command contract below without inspecting partially written foundation files. No recursive delegation. One repair round per worker; escalate ambiguous requirements rather than expanding scope.

`src/app` ownership passes to UI-001 only after this scaffold task closes and lead records the handoff. Generated `.next`, `node_modules`, test caches and coverage are build artifacts, not source ownership expansion. Never delete original documents or existing Python tooling.

## Interfaces and safe defaults

- `GET /api/health`: non-sensitive liveness only, HTTP 200; body exactly `{status: "scaffold", workflowReady: false, integrations: {mepsWriteback: false, hostedDocumentProcessing: false, drexMode: "OFF"}}`. No project IDs, personal data, paths, secrets, request echo or environment values. This is not a regulatory/DB/readiness probe.
- `src/config/runtime.ts`: immutable, typed scaffold defaults matching that response; caller mutation must not alter subsequent responses. No environment flag can silently enable a live integration in this scaffold.
- Root page: accessible plain-text development notice explicitly saying the permitting workflow is not implemented. No invented approvals, statuses, counts or working controls.
- No mutating API route, outbound fetch, auth bypass, AI model call, authority communication, secret value or environment credential placeholder.
- Disable Next telemetry (`NEXT_TELEMETRY_DISABLED=1`) in local/CI verification. Do not use network-fetched fonts or data. Any smoke server binds loopback only; installing packages from npm is the sole expected external setup traffic.
- Page/layout compile under Next 15; server code and tests have explicit TypeScript settings. Ignore generated files/artifacts only, not source documents.

## Required scripts and local verification

From repository root:

```bash
npm ci
npm run test
npm run typecheck
npm run lint
npm run build
node --test tests/smoke/scaffold.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/validate_contract.py --format json
python3 scripts/validate_coverage.py --format json
python3 scripts/execution_queue.py --format json
```

`test` means deterministic `vitest run`, not a watch process. `typecheck` means `tsc --noEmit`; `lint` uses ESLint with Next/TypeScript-compatible configuration, not removed/deprecated CLI behavior. Build does not require live env/SSO/database/AI secrets. No test may touch original documents or call hosted integrations.

## Acceptance cases

| ID | Given | When | Then |
|---|---|---|---|
| B001-01 | Local scaffold, no credentials | Invoke health GET | Exact fixed liveness schema and safe OFF/false defaults |
| B001-02 | A caller tries to change defaults/previous response | Read configuration and invoke health again | No shared-state mutation can enable an integration |
| B001-03 | Valid source tree | Run Vitest, TypeScript, ESLint and production build | All pass without live services; root page/layout/route compile |
| B001-04 | Runtime or CI config | Inspect routes, dependency scripts and workflow | No mutating route, secret, hosted-processing or deployment step |
| B001-05 | Fresh dependency install | Run `npm ci` with lockfile | Reproducible install; direct versions pinned; dependency findings recorded |
| B001-06 | CI workflow | Validate triggers/steps and run local equivalents | Node 22, Python setup/PyYAML, npm scripts, Python tests and all spec CLIs; read-only repository token; no deploy/secrets |
| B001-07 | Existing W1 tooling/specs | Run full Python regression | No contract, source, ownership or queue regression |
| B001-08 | Built local production artifact | Run bounded loopback HTTP smoke checks | Fixed health response; POST rejected; development notice visible; workspace source PDFs/XLSX not served; server cleaned up |

## TDD evidence and exit criteria

Foundation writes health/default safety behavior tests first, runs RED, then minimal implementation and GREEN. CI writes workflow-contract tests first, runs RED against missing workflow, then GREEN. Import/module-not-found failure proves scaffold absence; supplement it with a behavioral mutation that makes an unsafe liveness/default configuration fail, and record the actual test output. Do not claim runtime permitting, security, role or transition coverage from these scaffold tests.

Report commands, exit results, dependency versions/findings, test counts, actual red/green evidence and remaining limitations. Lead independently reviews changed files, runs the combined workspace checks, and only then marks BUILD-001 done. CI definition passing local checks is not proof that GitHub Actions ran.
