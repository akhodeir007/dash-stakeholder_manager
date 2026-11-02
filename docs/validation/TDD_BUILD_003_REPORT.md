# BUILD-003 TDD report

**Scope:** bounded server-side authorization policy with synthetic identity fixtures only. No Azure AD, database assignment loader, login/session endpoint, HTTP route, or deployed access enforcement is implemented.

## TDD evidence

- **Initial BUILD-003 RED:** before the first implementation, the scoped command failed at module resolution (1 suite failed, 0 tests collected).
- **Lead-review RED:** after adding regressions against the existing implementation, `npx vitest run --config vitest.integration.config.ts tests/integration/auth` reported **14 tests: 5 failed, 9 passed**. Failures reproduced unknown/malformed evidence acceptance, evidence validation bypassing dual control, structural validation missing current inspection checks, assignment subject mismatch, and invalid registry acceptance.
- **Lead-review GREEN:** after the bounded review repair, the same scoped command reported **1 test file passed, 21 tests passed**.
- Tests cover all seven roles across the YAML-source transition registry in a labeled local-role/scope REPLAY matrix (not EXECUTE/evidence coverage), all seven roles crossed with global evidence-class policy, identity/session and assignment boundaries, malformed input, stamp subject/recorder rules, all ten YAML dual-control transitions and changed approval facts, and replay after refreshed revocation.

## Boundaries and outstanding work

The verifier and the `AuthorizationContext`/approval facts are trusted server-code inputs. This policy module does not prove that an adapter actually verifies a real credential or that approval facts were loaded atomically from persistence. Named validator/approver assignments, Azure AD integration, persisted assignment and transaction-bound fact loading remain future gated work. Pure policy tests are not evidence of real SSO login or production access control.
