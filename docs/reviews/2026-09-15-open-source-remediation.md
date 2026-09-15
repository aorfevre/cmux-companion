# Open-source review remediation

Implements the six findings from [the readiness review](2026-09-15-open-source-readiness.md).
The original review describes the pre-fix source; this report records the resulting
behavior and verification. The implementation branch is `fix/open-source-readiness`,
targeting `main` at `b41e522`. That merge commit has the same source tree as the
reviewed `068c830` and was fast-forwarded without altering the fixes.

## Requirement evidence

| Finding | Resulting behavior | Verification |
| --- | --- | --- |
| OSS-01: metadata aliases | One normalized, case-insensitive protected-component policy applies to requested/canonical paths, enumeration, and writes; Git/HFS ignorable characters are removed before comparison | Real linked-worktree regression exercises all four roles, mixed case, Unicode aliases, nested metadata, ordinary reads/writes, and unchanged Git metadata; macOS check passes |
| OSS-02: WebSocket origin | Cookie-authenticated event upgrades require Origin; supplied origins must match scheme, host, and port; origin-less valid bearer clients remain supported | API fixture rejects foreign-site, same-site/different-port, wrong-scheme, null/missing origins before hub subscription, then verifies legitimate paired-cookie and bearer upgrades |
| OSS-02: proxy trust | Forwarded public host/protocol are used only when the socket peer is loopback; session Secure uses the same origin derivation | Unit tests cover trusted/untrusted peers, scheme/port differences, malformed hosts, and the default HTTPS port; existing HTTP pairing/settings/orchestration tests pass |
| OSS-03: advisory | Updated the npm lockfile to Cloudflare Vite plugin 1.54.9, Wrangler 4.131.2, Miniflare 5.20260911.1-alpha, and sharp 0.35.4 | Full-lockfile audit reports zero vulnerabilities; clean install/build and verification are recorded below |
| OSS-03: monitoring | Weekly full-lockfile advisory workflow fails on high/critical findings; Dependabot checks npm and Actions weekly | The exact audit command succeeds locally; workflow uses read-only repository permission and does not install/run dependency scripts |
| OSS-04: coverage | `verify` runs both coverage suites with enforced 90% line thresholds | Under-covered disposable Node/Vitest fixtures fail specifically for the configured 90% threshold (12.50% and 7.14% respectively) |
| OSS-04: platform/reuse | `verify` depends on the macOS job; proof format v2 requires successful Linux and macOS jobs/steps from the same run attempt | 74 local macOS boundary tests pass; reuse regressions reject missing/failed/skipped/duplicate/stale macOS evidence and old v1 proofs |
| OSS-05: private reporting | SECURITY.md and issue contact links name the existing maintainer email and forbid public disclosure of exploit details/credentials | Repository-local reporting path is present without relying on unavailable GitHub private-reporting configuration; no email was sent |
| OSS-06: fixture isolation | Each selected settings spec owns a separate child harness, frontend, service, database, and worker lifecycle; explicit order is preserved | Both onboarding→updates and updates→onboarding pass; selection regressions cover globs, duplicates, missing/invalid paths and single-spec interactive sessions |

## Additional readiness improvements

- Added a human contributor entry point, sanitized bug-report template, package
  license/repository metadata, and links to the private reporting route.
- Documented supported native versions and CCS 8.10.0/ccsxp support consistently.
- Documented private Tailscale Serve setup, existing-handler checks, pairing,
  validation, and handler-specific removal without Funnel or global reset.
- Clarified provider/GitHub data transmission, local persistence, privileged
  pairing, browser-only terminal protection, shared-token revocation, and limits
  of offline evidence.

These fixes enforce existing security and verification contracts. They do not
change the product plan-approval/publication workflow or introduce a new spec
decision. No migration or persistent data schema change is needed. Per-device
revocation and distribution-specific third-party license compliance remain
separate future work, as identified as such in the review.

## Checks

| Check | Result |
| --- | --- |
| Security, WebSocket, proof reuse, and settings-selection tests | Passed |
| `npm run test:mac` | Passed: 74 tests, no skips |
| `npm run verify` | Passed: 844 backend tests, 1 platform skip; 155 UI tests; lint, types and build; backend/UI lines 97.21% / 95.09% |
| Under-coverage negative fixtures | Passed: both expected threshold-specific failures verified |
| Full `npm audit --json` | Passed: zero advisories |
| `npm audit --package-lock-only --audit-level=high` | Passed: zero advisories |
| Default Chrome Cypress | Passed: 63 tests; six mode-specific cases pending in default mode |
| Settings Chrome Cypress, forward order | Passed: onboarding 2, updates 1 |
| Settings Chrome Cypress, reverse order | Passed: updates 1, onboarding 2 |
| Clean installation/build | Passed: isolated archive of staged source, full `npm ci`, then production build; owned checkout removed |
| Hosted Linux/macOS CI | See the review PR checks for the exact pushed commit; this table records local evidence |

The backend skip covers invalid UTF-8 filenames, which macOS rejects before Git can observe them.

The default Cypress pending cases require settings/orchestration fixture modes;
settings/update cases were separately exercised in both orders. Orchestration's
domain behavior was not modified, and its previously documented real-service
browser evidence remains separate from this change's checks. Its backend and
native-process coverage runs in full verification and the macOS job.

The browser does not let test-page JavaScript override a WebSocket Origin header.
The hostile-origin cases therefore use the actual Fastify upgrade pipeline with
an explicitly modeled loopback proxy socket and a fake event hub; normal browser
pairing/settings journeys run in Cypress. No installed cmux/provider process is
needed to verify these boundaries.

## Failures and interventions

- The original combined settings/update run failed because onboarding left owned
  workers active. That original failure remains in the review evidence. The fix
  isolates whole lifecycles; it does not disable maintenance guards or extend the
  failing assertion timeout.
- The first new WebSocket regression used `injectWS` without a socket peer while
  supplying proxy headers. Forwarded HTTPS was correctly ignored, so its HTTP
  case was accepted. The fixture now supplies the intended loopback peer; the
  complete origin matrix passes. One full verification had already started with
  the earlier fixture and failed; the final full run uses the corrected fixture.
- Existing port owners were preserved. Browser checks used free ports
  33381–33383. Owned harnesses cleaned up their services and workers.
- Native SQLite, Node filesystem globbing, and vinext route-classification notices
  are toolchain warnings; they are not hidden test failures. The updated upstream
  frontend stack retains its existing beta/alpha dependency characteristics.

## External boundaries and remaining scope

UI changes are documentation only; paired browser behavior is regression-tested.
The HTTP and scoped MCP boundaries are changed and tested. Storage schemas and
workflow authorities are unchanged. CI/reuse and test harness process lifecycles
are changed and tested. Dependency resolution used the public npm registry.

No installed service was updated; no live provider, Tailscale configuration,
GitHub publication, or credential rotation was exercised. No merge, deployment,
repository visibility change, email, or external account setting change was made.
The repository is currently private. GitHub's private-vulnerability-reporting
endpoint returned 404, so reporting uses the maintainer email. Main currently has
no branch protection; the workflow dependency and updater's successful-run gate
are enforced in code, while server-side merge restrictions remain an owner setting.

Source fixes are reviewable independently of an explicitly authorized fresh-Mac
installation rehearsal or public launch. Raw local evidence is retained under
ignored `outputs/open-source-fixes/`.
