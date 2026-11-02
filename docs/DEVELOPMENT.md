# Local development

The application is a **development scaffold**, not an operational permitting dashboard. Its liveness endpoint must report `workflowReady: false`; it does not establish authentication, database readiness, regulatory compliance or authority approval.

## Prerequisites

- Node.js 22 and npm 10
- Python 3.12 or newer and PyYAML for specification checks
- No SSO, database, object-storage, authority-system or AI credentials are required for the scaffold

Run commands from the project root. Install packages only from approved registries; do not upload the source documents to hosted services.

```bash
npm ci
python3 -m pip install -r requirements-dev.txt
```

PyYAML is already installed in the current workspace. If the operating system manages Python packages, use a local virtual environment rather than bypassing its package protections. The installer accesses package registries; tests and scaffold behavior must not call live integrations.

## Verification

For the local development notice, run `npm run dev` and open `http://127.0.0.1:3000`. The script binds loopback and disables telemetry. After a production build, `npm run start` uses the same loopback-only default. Stop your own foreground server with Ctrl+C. The HTTP smoke test starts and cleans up its own ephemeral loopback server; it does not need a separately running dev server.

```bash
npm run test
npm run typecheck
npm run lint
NEXT_TELEMETRY_DISABLED=1 npm run build
node --test tests/smoke/scaffold.test.mjs
python3 -m unittest discover -s tests -v
python3 scripts/validate_contract.py --format json
python3 scripts/validate_coverage.py --format json
python3 scripts/execution_queue.py --format json
```

The coverage manifest describes **planned** tests for 20 machines/173 transitions; it is not a report of implemented transition behavior. Read `docs/validation/` for actual results and limitations from each accepted task. A CI workflow definition is not proof that GitHub Actions has executed; this workspace is not currently a Git repository.

## Safe operating boundary

- DREX remains literal string `"OFF"`; hosted document processing and MEPS write-back are disabled.
- Source PDFs, XLSX and PPTX remain private workspace inputs, not public web assets.
- Do not add real credentials to source or tests. Future live services require the pending hosting/evidence gates and reviewed configuration.
- Liveness is a fixed, non-sensitive scaffold response, not a way to bypass downstream regulatory gates.
- The minimal root page is a development notice only. Visual dashboard design and production user journeys belong to later tasks.

Use the dependency queue to select the next bounded task; never mark a human approval or external gate satisfied merely because local tests are green.

## Dependency review

BUILD-001 verification found **14 moderate, 0 high/critical** npm audit findings in the ESLint/minimatch tooling chain. Next's PostCSS is narrowly overridden to pinned `8.5.23`; do not remove the override without checking current advisories and rebuilding. ESLint 9.39.5 is registry-deprecated. Do not use `npm audit fix --force` or silently upgrade framework/tooling majors to make the audit look green. These findings require maintenance/security review before production; this scaffold is accepted locally, not certified vulnerability-free.

## Next foundation tasks

After BUILD-001 is accepted, BUILD-002 (persistence/atomic commands) and BUILD-003 (authorization) may run in parallel under separate reviewed contracts and disjoint write scopes. The command engine's rollback/concurrency acceptance requires **real PostgreSQL**, not SQLite or mocks. Docker is installed in this workspace, but daemon availability and a disposable test database have not yet been verified; those are preconditions for the database task, not scaffold requirements.
