# Open-source readiness review

Reviewed 2026-09-15 at `068c830edfe01a78a2934c7e06d46cfe1d212afc` on macOS with Node 22.23.1.

Implementation follow-up: [remediation and verification](2026-09-15-open-source-remediation.md). The findings below preserve the original review evidence.

## Decision

**Hold the public launch until the scoped-file and WebSocket findings are fixed and the dependency advisory is resolved or explicitly assessed.** The project has substantial verification and recovery infrastructure, an MIT license, and a working clean-source build. It does not need a wholesale rewrite. The main release risk is a gap between strong documented security boundaries and a few incompletely enforced details.

This is a review, not a remediation change. No application code, dependencies, installed services, external accounts, or Git history were changed. Two pre-existing untracked documents were left untouched and excluded from the reviewed release source. Findings below distinguish reproduced behavior from readiness recommendations and unverified integrations.

## Findings, ordered by priority

### OSS-01 — P1: Case aliases bypass protected agent metadata paths on macOS

**Evidence:** `server/codex-files.mjs:7-23,28-43`; the configuration enabling this file server is in `server/codex-native.mjs:46-47,77`.

`inside()` rejects `.git`, `.codex`, and `.companion` using exact, case-sensitive component comparisons. On this Mac's case-insensitive filesystem, `.GIT` addresses `.git`, and `realpathSync()` preserves the requested case spelling. The second canonical-path check therefore does not restore the boundary. The write path checks the parent and uses `O_NOFOLLOW`, but neither protects against a case alias to a regular file.

**Reproduced:** In a disposable directory, create a regular `.git` file containing fixture text, read it through `scopedFile(..., 'read_file', {path: '.GIT'})`, then pass its returned hash to `write_file` on `.GIT`. Both operations succeed; reading `.git` directly confirms its content was replaced. No race, symlink, shell execution, or permission prompt is needed. A linked Git worktree uses precisely this regular-file shape for its `.git` pointer.

**Impact:** An agent with the intended file tools can read and corrupt metadata deliberately excluded from its authority. Planners/reviewers can also cross the read exclusion. This proves metadata access and modification, not a completed arbitrary-code-execution or external-publication exploit; later Git identity checks may reject a corrupted checkout. That later rejection does not make the file boundary correct.

**Fix:** Apply a consistent protected-component policy to requested paths, canonical paths, directory enumeration, and creation. On the supported Mac filesystem, reject case aliases of protected names; assess filesystem normalization equivalences as well. Keep the symlink/hardlink checks. Add regression coverage using a real linked worktree and mixed-case protected directory components.

**Acceptance:** On a case-insensitive macOS volume, all three roles' reads and implementer/integrator writes reject protected aliases, while ordinary project files still work. Include this test in a macOS check; Ubuntu alone will not reproduce the failure.

### OSS-02 — P2: Authenticated event WebSockets accept a foreign origin

**Evidence:** `server/app.mjs:86-99,384-406`; origin helper at `server/security.mjs:80-87`.

Origin checks run only for POST/PUT/PATCH/DELETE. `/api/events` upgrades a GET request, so a valid session cookie is sufficient even when `Origin` identifies another website.

**Reproduced:** The disposable monitoring fixture accepted `injectWS('/api/events')` with a synthetic valid cookie, `Host: mac.example.test`, and `Origin: https://mac.example.test:9443`, and returned `companion:ready`. No real cmux process was used.

**Impact:** A hostile **same-site, different-origin** page can potentially read the event stream when the browser sends the paired cookie. Cookie SameSite protection distinguishes sites, not ports; it does not replace WebSocket origin validation. Ordinary unrelated cross-site pages are constrained by SameSite=Strict. This review proved server-side acceptance, not an end-to-end browser exploit against a live Tailscale installation.

**Fix:** Validate the expected origin before WebSocket upgrade, using a deliberate policy for non-browser bearer clients without Origin. As part of the same boundary review, compare the complete trusted origin: the existing helper compares host/port only and does not compare scheme. Derive forwarded values only under the intended proxy trust contract.

**Acceptance:** A cookie-authenticated foreign-origin upgrade receives 403 and never subscribes to the hub; same-origin pairing/events and explicitly supported bearer clients continue working. Test same-site/different-port and scheme mismatch separately.

### OSS-03 — P2: The checked-in dependency tree has a high-severity advisory

**Evidence:** `package-lock.json:11457` locks `sharp` 0.35.2; the chain includes Miniflare, Wrangler, and `@cloudflare/vite-plugin`. `npm audit --json` reported [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), concerning libheif vulnerabilities, with the affected range `sharp <0.35.4`.

There is **one advisory represented by four high-severity package entries**, not four independent confirmed application exploits. npm reports fixes available. `npm audit --omit=dev` reports zero vulnerabilities, but that does not describe the complete installed product: `server/supervisor.mjs:10-13` starts vinext from `node_modules`, and installed releases include the build toolchain. Reachability of vulnerable image decoding from Companion requests was not established.

**Fix:** Update the relevant dependency chain and lockfile with npm, then run clean installation, verification, and the relevant browser checks. Avoid an unreviewed forced major upgrade. If a fix cannot be adopted, record concrete reachability evidence and the temporary acceptance decision.

**Acceptance:** The full installed dependency graph no longer reports this advisory, or a reviewed exception explains the affected functionality, exposure, mitigation, and expiry. Add automated dependency advisory monitoring; the current workflow has none.

### OSS-04 — P2: Release eligibility does not enforce the documented coverage/platform contract

**Evidence:** `.github/workflows/verify.yml:11,31-35`; `package.json` scripts `verify`, `test:coverage`, and `test:ui:coverage`; `vitest.config.ts:10-16`.

The only CI job runs on Ubuntu. `verify` runs tests without coverage. The separate coverage commands produce reports, but neither the Node command nor Vitest configuration sets a 90% line threshold. The README/AGENTS requirement is therefore a convention rather than a failing check. A successful main workflow also serves as updater eligibility evidence, so these omissions affect release confidence.

The case-alias defect in OSS-01 illustrates the platform gap: the core product is macOS-specific, while the required workflow cannot exercise its default filesystem semantics. Native process fixtures provide valuable coverage, but they are not a substitute for running platform-dependent tests on the supported platform.

**Fix:** Enforce the agreed backend/UI line threshold in an appropriate required check, and add a bounded macOS job for filesystem and process behavior. If the verification workflow becomes a matrix or changes job naming, update and test `scripts/ci-verified-tree.mjs`, whose reuse policy currently expects exactly one job named `verify`. Preserve the fail-closed updater/reuse behavior.

**Acceptance:** Deliberately dropping either line metric below 90% fails its check; a protected-path regression on macOS fails before an installed update becomes eligible. No live accounts or installed cmux are needed for these checks.

### OSS-05 — P2 readiness gap: No repository-local private vulnerability reporting policy

The tracked tree contains no `SECURITY.md` or equivalent reporting instructions. For a project that handles pairing credentials, terminal input, agent execution, and automatic updates, the default public-issue path risks disclosing exploit details or users' private evidence.

**Fix:** Publish a short policy naming supported versions, a monitored private reporting destination, what information to include, and what never to attach publicly. Decide who triages reports. GitHub private vulnerability reporting may already be enabled; repository settings were not inspected, so its status is **unknown**, not asserted disabled. Choosing/enabling an external destination remains an owner decision.

**Acceptance:** A new visitor can find and use the intended private reporting route without posting a public issue or sharing a token.

### OSS-06 — P2 test reliability: Settings and updater specs share active-agent state

**Evidence:** `scripts/run-local-cypress.mjs:29` creates one settings demo for the entire invocation; `cypress/e2e/settings-onboarding.cy.ts:50-63` creates goals without settling their workers; `cypress/e2e/updates.cy.ts:30-31` removes only its synthetic busy marker and then expects an idle installation.

Running both specs in one supported `--spec` invocation produced two passing settings tests and a failing update test: after 12 seconds, “Update complete” was absent. The failure screenshot explicitly showed “Waiting for Companion-managed work to finish.” The maintenance guard in `server/update-maintenance.mjs:4-11` treats active/unsettled agents as busy. Clearing the marker in the Cypress task does not clear the earlier goals' workers.

This is evidence of test isolation failure, not evidence that the updater should ignore active work. A fresh-fixture update run is recorded separately below. Fix by giving independent specs independent services/data, or performing explicit owned-goal cleanup and proving idle state between them. Do not loosen the production maintenance guard or merely lengthen the timeout.

**Acceptance:** The combined settings/update invocation passes in either spec order, with no inherited active workers and no changes to the update safety boundary.

## Contributor, licensing, and product readiness

- **Clean source works:** An isolated `git archive HEAD` installed 848 platform-selected packages with `npm ci --no-fund --no-audit` and built successfully. The lockfile's resolved package URLs all use the public npm registry; no private registry or local-file dependency was found. This used the current machine's npm/cache environment, so it is not proof of a completely new user's machine.
- **Licensing is present:** Root MIT notice and the imported updater's separate MIT notice/provenance are retained. Different named copyright holders are not, by themselves, an error. `private: true` in package.json prevents accidental npm publication and is compatible with open source. Add `license` and repository metadata for ecosystem tooling when convenient.
- **Do not describe all dependencies as MIT:** Lockfile metadata includes LGPL, MPL, and CC-BY packages as well as permissive licenses. This is not evidence that the source repository violates a license. Before distributing a prebuilt application or dependency bundle, inventory the shipped artifacts and satisfy their notice/source obligations. Root MIT text alone does not replace third-party notices. Original artwork rights were not independently established.
- **First-time installation needs a fuller journey:** `docs/updates.md:73-77` ends the Tailscale step with “your existing operator procedure.” A new public user may have no such procedure. Provide a documented, tested example that preserves existing handlers, uses private Serve rather than Funnel, and explains pairing and recovery. The root prerequisites also omit the provider/GitHub requirements needed for the goals/updater journey; link a clear capability/version matrix from that section. The detailed guides currently mention CCS 8.9.0 while code additionally accepts 8.10.0.
- **Contributor entry is usable but scattered:** README and AGENTS contain substantial setup/testing guidance. A short CONTRIBUTING entry point, issue templates, and an explicit support scope would reduce maintenance cost; these are improvements rather than licensing prerequisites. Avoid presenting the agent-only process as the only way humans may contribute.
- **Clarify what “private” means:** Explain that tailnet access is private transport, while configured providers receive model inputs and GitHub receives approved publication data. State that terminal input protection is a browser preference for preventing mistakes, not a separate server permission tier. Session cookies are derived from one shared token and last a year; logout clears one browser's cookie rather than revoking its copied credential. Per-device revocation is a future hardening opportunity, not a claimed feature.
- **Keep the architecture:** The separation between pure transitions, SQLite command receipts, ownership fencing, scheduler effects, and adapters is appropriate. Generation/revision-bound agent credentials, exact-head publication approval, immutable operation identity, safe refusal on uncertain effects, and independent worker supervision are meaningful strengths. Preserve these boundaries while fixing the narrower defects.

## Privacy and repository-history evidence

Reviewed the current tracked tree (483 files) and all locally reachable history (729 commits; 3,327 unique blobs, 97,662,886 bytes). The automated history pass looked for private-key headers, GitHub token formats, provider-prefixed keys, AWS key IDs, Slack token formats, and credential-bearing URLs. It found one historical test fixture with an ascending alphanumeric synthetic GitHub token. Its surrounding test uses a fake executor. No live credential was identified by these patterns, and no secret value is reproduced here.

All 12 tracked documentation PNGs were visually inspected in a contact sheet. They show empty/demo interfaces, example repositories, and disposable filesystem paths; no visible pairing/provider credential was identified. `.env.example` contains documented placeholders/defaults rather than live values. No tracked SQLite database, log, or JSONL session artifact appeared in the filename inventory. The current hosting metadata contains null bindings.

**Limit:** This is a bounded pattern scan and image inspection, not a guarantee that every possible secret or confidential statement is absent. It excludes unreachable objects, remote-only refs, GitHub issues/PR attachments/Actions artifacts, and arbitrary secret formats. Author identity/email and historical references to the owner's repositories are present and will become public with history; these are publication decisions, not automatically vulnerabilities. Consider a dedicated history secret scanner before changing visibility, and review GitHub-hosted content if making the existing repository public.

## Verification and interventions

Check results and interventions are recorded below. Raw local logs are retained under ignored `outputs/open-source-review/`; they are not part of the release source.

| Check | Result |
| --- | --- |
| `npm run verify` | Passed: backend 839 passed, 1 skipped; UI 19 files / 155 tests passed; lint, both TypeScript checks, and production build passed |
| Backend skip | Invalid-UTF-8 filename fixture intentionally skips on macOS, which rejects the filename before Git sees it |
| Clean archived-source `npm ci` and `npm run build` | Passed |
| `npm run test:ui:coverage` | Passed; line coverage 95.09% (1,145 / 1,204) |
| `npm run test:coverage` | Passed; backend line coverage 97.19%, branches 91.01%, functions 91.14% |
| Full `npm audit --json` | Failed advisory check: four high package entries, one advisory; OSS-03 |
| `npm audit --omit=dev --json` | Passed; zero reported advisories in the production-dependency subset |
| Default `npm run test:e2e:local` | Did not start: port 3221 already owned; its owner was left untouched |
| Chrome Cypress on free port 33281 | Passed: 63 tests; 6 fixture-mode tests pending in the default mode |
| Real-service orchestration Cypress on free port 33282 | Passed: 2 tests; read-only case intentionally pending in this mode |
| Real-service read-only Cypress on free port 33284 | Passed: 1 test; 2 writable-mode cases intentionally pending |
| Settings/onboarding plus updates, port 33283 | Settings passed (2 tests); updates failed waiting for “Update complete”; see fixture-interference finding below |
| Updates alone in a fresh settings fixture, port 33285 | Passed: 1 test; confirms combined-run interference rather than an independently failing update journey |
| Case-insensitive metadata reproduction | Confirmed unwanted read/write; OSS-01 |
| Foreign-origin WebSocket fixture | Confirmed unwanted upgrade; OSS-02 |
| History pattern scan and tracked PNG review | Completed with limits above |

Build output warns that vinext cannot statically classify these routes; both builds nevertheless completed successfully. Experimental SQLite notices are expected for the pinned runtime. No warning was treated as proof of runtime failure.

**Not run:** installed-service installation/migration/rollback; real provider permission enforcement; live cmux, Tailscale, GitHub publication; real browser exploit against the installed service; GitHub branch protections/private reporting configuration; dependency image-decoder exploit. Those require separate live scope or external evidence. No release or deployment action was taken. All owned browser/frontend/demo processes exited through their harness cleanup. The isolated archived checkout was removed after successful installation/build; existing port owners and user files were preserved.

## Bounded path to release

1. Fix OSS-01 and OSS-02 with regressions, then review those changes privately before publishing the exploit details.
2. Resolve OSS-03, enforce the coverage/platform checks in OSS-04, and rerun the release checks without weakening coverage.
3. Choose the private security-reporting destination, complete the public installation/version guide, and review history plus externally hosted artifacts for disclosure.
4. Rehearse the supported fresh Mac installation and native adapter boundary with explicit live authorization. Record the exact supported versions and passed/failed/unverified paths.
5. Make repository visibility and supported release publication separate owner decisions. A passing offline suite does not establish live-service acceptance.
