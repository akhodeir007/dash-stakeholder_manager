# BUILD-001 CI contract report

## Scope and implementation

Added `.github/workflows/ci.yml` and `tests/test_ci_contract.py`. The workflow
runs on pushes and pull requests with only `contents: read`, Node.js 22 and
Python 3.12. It caches npm using `package-lock.json`, installs the declared
Python development requirements, and runs every local command in the
BUILD-001 contract. `NEXT_TELEMETRY_DISABLED: '1'` is set for the job. The
workflow contains no deployment, secrets, services, remote fonts, client-data
integrations, or outbound application integration steps. It uses the known
major tags checkout@v4, setup-node@v4, and setup-python@v5; no unverifiable
immutable SHAs were guessed.

## TDD and verification evidence

- **RED (missing workflow):** `python3 -m unittest tests.test_ci_contract -v`
  exited 1 with `FileNotFoundError` for `.github/workflows/ci.yml` (0 tests
  ran).
- **GREEN (CI slice):** `python3 -m unittest tests.test_ci_contract -v`
  exited 0; 4 tests passed.
- **Behavioral command mutation:** temporarily removed the `npm run test`
  workflow step. Its contract test exited 1 with the expected missing-command
  assertion. The workflow command was restored.
- **Behavioral permission mutation:** temporarily changed `contents: read` to
  `contents: write`. The permission test exited 1 with the expected mismatch.
  Read-only permission was restored.
- **Python regression:** `python3 -m unittest discover -s tests -v` exited 0;
  52 tests passed.

The workflow itself was not executed on GitHub. The Node install/test/typecheck/
lint/build steps and the three contract CLI invocations were not run as part of
this CI-slice assignment; the lead runs combined workspace checks. This report
does not claim a GitHub Actions run or application/runtime integration
coverage.

## Lead-review repair

Replaced raw-text command/action checks with structural checks over the parsed
YAML. The contract permits exactly one `validate` job, its specific allowlisted
actions and configuration, exact executable `run` commands, and no job/step
conditionals or local env overrides. It rejects secret expressions, extra jobs,
services, and job-level permission overrides. The checkout step now sets
`persist-credentials: false`.

**RED mutation evidence:** the parsed-workflow contract test exited 1 for each
of these temporary workflow mutations, which were restored: replacing the test
command with a comment; adding `if: false` to that step; adding job-level
`contents: write`; and adding an extra `deploy` job. Dedicated malformed-model
tests also verify rejection of service definitions and secrets expressions.
**GREEN:** `python3 -m unittest tests.test_ci_contract -v` exited 0; 7 tests
passed. These are local structural checks, not a GitHub Actions run.
