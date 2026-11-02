# BUILD-001 foundation TDD and verification report

**Scope:** local Next.js scaffold only; no permitting workflow, live integration, credentials, or external service was added or exercised.

## Implementation

- Pinned Next.js `15.5.28` (stable 15.x patch returned by npm metadata), React/React DOM `19.3.1`, TypeScript `5.9.3`, ESLint `9.39.5`, `eslint-config-next` `15.5.28`, Vitest `5.0.5`, `@types/node` `22.20.5` for the Node 22 runtime target, and direct `@eslint/eslintrc` `3.3.7`; direct dependencies are exact-version pins and `package-lock.json` is generated and locked for reproducible installs.
- Added the plain development notice, root layout, exact fixed liveness response, recursively immutable offline defaults, scaffold tests, and deterministic `test`, `typecheck`, `lint`, and `build` scripts.
- Next telemetry is disabled in `dev`, `build`, and `start` scripts; `dev` and `start` bind explicitly to `127.0.0.1`. No `next/font`, remote fonts, data-bearing tests, or hosted integrations are used. No server smoke test or deployment was performed.

## TDD evidence

- Initial `npm run test` before implementation: **RED**, Vitest reported `Cannot find module '../../../src/app/api/health/route'`; 1 test file failed, 0 tests ran.
- After implementation, a deliberately unsafe behavioral mutation changed health `workflowReady` to `true`. `npm run test`: **RED**, both tests failed, each observing `true` where the contract requires `false` (2 failed, 0 passed).
- Restored the safe implementation with a patch. Final `npm run test`: **GREEN**, 1 test file and 2 tests passed.
- During scaffold bring-up, Vitest initially could not resolve the route's `@/config/runtime` alias; the route was changed to a local relative import. That intermediate failure was tooling resolution, not counted as contract RED evidence.

### Lead review repair TDD

- Added tests first for loopback/telemetry command contracts and for environment escalation resistance (`MEPS_WRITEBACK_ENABLED=true`, `HOSTED_DOCUMENT_PROCESSING_ENABLED=true`, `DREX_MODE=ON`) using `vi.stubEnv`, `vi.resetModules`, and a dynamic runtime import.
- Before fixes, the command contract test produced **RED**: `dev` lacked `--hostname 127.0.0.1` (1 failed, 3 passed). The environment test passed against the existing safe runtime at this point.
- To verify the escalation assertion behaviorally before restoring safe code, temporarily mutated the runtime to read `MEPS_WRITEBACK_ENABLED`. With that deliberately unsafe mutation, the environment test failed with `mepsWriteback: true`; together the four-test run had 2 failed and 2 passed. Restored the immutable safe defaults, and added the loopback flags.

## Verification

| Command | Result |
|---|---|
| `npm ci` | Pass; lockfile install completed; npm reported 14 moderate findings. |
| `npm run test` | Pass; 1 file, 4 tests. |
| `npm run typecheck` | Pass; `tsc --noEmit`. |
| `npm run lint` | Pass; ESLint. |
| `NEXT_TELEMETRY_DISABLED=1 npm run build` | Pass; Next.js 15.5.28 production build, including `/api/health`, with PostCSS override. |
| `npm audit` | Exit 1; 14 moderate, 0 high, 0 critical findings. |

The lead-review commands were run serially after `npm ci` to avoid concurrent `.next` type generation races.

One intermediate typecheck overlapped a concurrent production build, which regenerated `.next` and temporarily removed included generated type files; it failed with TS6053. The serial typecheck above, after the build completed, passed.

## Dependency/security findings

The initial `npm audit` identified Next `15.5.28` resolving its declared PostCSS `8.4.31`, while the installed Vite branch had `postcss@8.5.32`. npm's actual advisory metadata reported PostCSS vulnerable through `8.5.22` (including GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, GHSA-fxqj-rqcc-2cmp, and GHSA-r28c-9q8g-f849), with its suggested automatic fix requiring Next 16. Since `8.5.23` is above the reported vulnerable range, meets the Next package's declared `postcss@8.4.31` semver range (`^8.4.31`), and stays within PostCSS major 8, a narrow `next`-scoped PostCSS `8.5.23` override was added. `npm ls` verified Next uses overridden `postcss@8.5.23` (Vite independently uses `8.5.32`), and the Next 15 production build passed. Subsequent `npm audit` reports **14 moderate, 0 high, 0 critical**; the remaining findings are the ESLint-chain `minimatch <11.0.1` denial-of-service advisory. That chain is not force-fixed or major-overridden. ESLint `9.39.5` also emits a registry deprecation warning. No claim of a vulnerability-free dependency tree is made.

## Limitations

This is only the local foundation scaffold. It does not provide identity/authentication, project workflows, readiness or regulatory checks, data persistence, integrations, or production security assurance. CI and Python/spec regression checks belong to their separate owner and combined integration verification remains pending.
