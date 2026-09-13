# Open-source readiness audit — 2026-09-13

## Scope and outcome

Audit baseline: merged `main` at `92bb3f2` (PR #117). This change covers portability,
confirmed dead-code cleanup, tracked-file/history secret review and attribution.
It does not change product policy, rewrite history, publish the repository, merge,
install, migrate live services or change external account settings.

The implementing agent owns the audit, fixes, validation and delivery. No work
was delegated. The existing untracked burst-scan plan and installed state are
outside the audit and remain untouched.

## Portability and hardcoded values

| Finding | Disposition |
| --- | --- |
| Node/zsh updater wrappers searched the account home even when `CMUX_COMPANION_HOME` selected a different installation. | Fixed both resolvers; reject relative homes. A disposable fake-operator regression covers paths containing spaces, the custom home and explicit updater override. |
| Current/legacy LaunchAgent labels were duplicated between server and installer. | Use the shared identity module. Retain legacy names for detection, stop checks and migration; renaming those strings would lose ownership evidence. |
| Synthetic tests and a historical plan example used the original author's project group names. | Replaced with generic `projects`/`examples` and an example GitHub owner. `/Users/dev`, `/Users/test` and `/Users/me` remain deliberate formatting fixtures, not directories accessed on the host. |
| Absolute application defaults under `/Applications`, plus Homebrew/PATH fallbacks. | Standard macOS defaults, configurable through Tools/settings or documented bootstrap overrides; macOS remains an explicit product requirement. |
| Ports 3210/3211/8443 and preview range 8500–8599. | Defaults, not account identifiers. Existing settings/environment overrides remain; loopback binding is a security requirement. |
| GitHub `origin/main`, workflow identity and update polling bounds. | Intentional update trust contract. The repository owner/name comes from installation configuration; no runtime dependency on the author's GitHub account was found. |
| CCS/provider/model defaults and execution limits. | Configured in settings with supported CLI capability checks. Fixed provider flags/model catalogs and resource ceilings are product compatibility/safety rules, not laptop paths. |
| `.openai/hosting.json`, Worker and Sites/Vinext dependencies. | Retained: no registered account/project IDs or bindings in the manifest; Vite imports this scaffolding, so removing it requires a separately verified frontend migration. |
| Legacy updater repository override and root CLI wrappers. | Retained: they are documented operator compatibility paths, not unused sibling-repository dependencies. |

README now explains installation-home/override scope. These overrides do not
relocate the running service's settings or credentials implicitly; those have
separate explicit paths.

## Removed or clarified

- Removed the unused historical plan fixture, whose imports referenced retired
  planner modules, and the unused updater JSON-state helper module.
- Removed unused attachment review/picker/reference helpers and a dead model-role
  alias left after legacy workflow retirement, plus their five orphan CSS rules.
- Removed 1,473 additional selectors tied to 297 absent legacy component classes,
  reducing `app/features.css` from 175,198 to 44,377 bytes (about 75%). Every removed
  selector required an absent class outside negation/alternative pseudo-classes;
  dynamic state classes and selectors for active components remain. The literal
  reference inventory is supporting evidence, not a blind CSS purge.
- Removed unused legacy worktree error classification/construction, an unused
  worktree JSON reader and unused updater path-removal helper.
- Removed unused bootstrap-handoff and notification-file path fields; retained
  legacy stores and status fields still needed by migration/health consumers.
- Marked the old unattended-updater spec unambiguously historical and linked the
  approved default-off contract and current runbook.
- Corrected Knip's entry graph for app routes, updater scripts/tests and subprocess
  fixtures. Internal exports used within their own module are intentionally not
  counted as dead code. No dependency was removed just because a static tool
  could not follow a framework or subprocess entry.
- Kept the explicit SPA experiment and comparison script: they remain documented,
  reproducible migration evidence, and the Cypress runner supports that mode.
- Updated the Cloudflare build dependency chain within existing declared ranges
  to remove the sharp/libheif advisory chain: Vite plugin 1.54.2 → 1.54.8,
  Wrangler 4.127.1 → 4.131.1 and sharp 0.35.2 → 0.35.4. No package manager or manifest
  version-range substitution was made.

## Publication and privacy evidence

Gitleaks **8.30.1**, downloaded from its official release and SHA-256 checked
against the published checksum file, scanned a tracked `git archive` snapshot
and full `git --all` history with `--redact=100`. The checkout is not shallow.
At the baseline this covered **623 reachable commits**. A separate read-only
object audit examined **2,693 historical blobs**, including two binary blobs,
for absolute user paths, original project names, tailnet hostnames and private
network addresses. Binary contents are outside that textual pattern audit.

- Current tracked snapshot: **zero Gitleaks findings**.
- Reachable history: **one reviewed generic-api-key finding**, in
  `tests/api.test.mjs` at `b6538e1ac50a`, line 1027. It is a predictable token-shaped
  literal containing a sequential numeric placeholder, passed only to an in-memory
  `fakeReviewToken` store and checked for response redaction. No external token
  verification was attempted. The test is no longer in the current file.
- **No confirmed credentials were found.** No broad scanner allowlist was added,
  so the historical fixture remains visible for future reviewers.
- Historical project-group names and synthetic `/Users/...` paths remain in Git.
  Historical `.env.example` tailnet names carry placeholder markers; no private
  network IP matched the audited patterns. Two author identities remain in commit
  metadata. Review their intended public attribution before changing visibility.
- `.env*` except `.env.example`, output/coverage/browser captures and PEM files are
  ignored; no tracked runtime database, token file or credential archive was found.
  Public PNG icons date to the initial project commit; no separate third-party
  asset attribution was found in the repository.

The history scan covers locally reachable branches/tags fetched from origin, not
unreachable objects, server-only hidden refs, GitHub issue/PR attachments, release
assets, ignored local files or other repositories. Pattern scanning and dependency
metadata cannot prove the absence of all secrets or establish copyright ownership.
No history rewrite or credential rotation was indicated by a confirmed finding.

## Licensing and dependencies

- Root MIT notice is retained; `license: "MIT"` added to npm metadata/lockfile.
  `private: true` remains to prevent accidental npm publication.
- Imported updater MIT notice and exact-source provenance remain unchanged.
- The root notice names **Alexandre Orfèvre**; the updater notice names
  **Aurelien Orfevre**. The maintainer must confirm the intended root attribution
  and rights before publication; this audit does not silently rewrite either.
- All resolved lockfile packages have a declared license. Direct runtime packages
  are MIT, Apache-2.0 or MPL-2.0; optional build tooling also includes LGPL and
  attribution-licensed data. See [third-party inventory](../THIRD_PARTY.md).
- Initial `npm audit` reported **four high-severity entries**: sharp's libheif
  advisory GHSA-rgj7-g3m4-5g8c propagated through Miniflare, Wrangler and the
  Cloudflare Vite plugin. After compatible lockfile updates, audit reports **zero**.
  This is dependency advisory evidence, not a penetration test.

## Verification and interventions

Final results are recorded below before delivery; logs are in ignored
`outputs/open-source-audit/`. Secret reports are fully redacted and are not
committed. The source changes touch CLI resolution and installer identity reuse,
plus removal of unreachable UI/backend code; they do not add API endpoints,
change data schemas, scheduling policy, authorization or network exposure.

The existing updater migration/native tests verify the shared labels and portable
checkout behavior with disposable state. The new CLI test substitutes a fake
operator; it never invokes installed update commands. The zsh resolver is checked
on macOS; that part is conditional when `/bin/zsh` is absent. Cypress covers the
renamed monitoring fixtures; it cannot prove installed launchd behavior.

An early Knip invocation overlapped npm installation and reported missing temporary
loader-cache files. It was discarded and rerun after installation completed.
Framework routes and subprocess fixtures initially appeared unused because the
old entry graph omitted them; the graph was corrected before deciding removals.

The first targeted/full backend runs failed only the new fixture's comparison of
macOS `/var` and canonical `/private/var` paths. The assertion now compares the
executed module's decoded URL to `realpath(expected)`; the selected operator must
still match exactly. The isolated regression passed after that correction.

### Reproduce the security review

Use a full checkout, fetch the branches/tags intended for publication, install
Gitleaks from a checksum-verified official release, and keep reports local:

```sh
mkdir -p outputs/open-source-audit
gitleaks git --redact=100 --log-opts=--all --report-format=json \
  --report-path=outputs/open-source-audit/history-secrets.json .
npm audit
npx --yes knip@6.34.0 --config docs/reviews/knip.config.json --no-progress
```

The historical fixture makes the unsuppressed history scan exit 1; inspect its
rule, path and commit rather than treating it as a clean exit or hiding the entire
file. For current-source scanning, export the reviewed commit with `git archive`
to an OS temporary directory outside the checkout and run `gitleaks dir --redact=100` on that directory.
This intentionally excludes ignored credentials and unrelated working files.

Subsequent validation exposed two transient browser timeouts: the coverage suite's
offline-shell reopen timed out at navigation, and a Cypress local-app case stayed
on the initial loading screen before issuing its first preview request. The failed
screenshot and logs were inspected; this was not a missing-element/style assertion.
The offline browser test passed alone under coverage, and all ten local-app cases
passed in isolation. Their timing causes were not proven. Final confirmation runs
serialize coverage and Cypress rather than overlapping browser workloads; no
assertion timeout, retry count, coverage threshold or browser-skip policy was
weakened.

The broad CSS removal also exposed a pre-retirement responsive-test assertion for
`.worktree-list` and a grouped selector naming the absent worktree launcher. Those
obsolete expectations were removed/updated; checks for the active desktop grids,
sidebar, hero, usage layout, document/detail widths and session/queue/reconnect
dialogs remain. The corrected responsive test passed before final confirmation.


### Passed checks

- `npm run verify`: 755 backend passes, one macOS platform skip, 124 UI passes;
  lint, frontend/backend types and production build passed. Final CSS cleanup
  subsequently passed the responsive regression, lint and production build.
- `npm run test:coverage`: final sequential confirmation **passed**, 755 passes,
  one platform skip, **97.59% backend line coverage**, including updater sources.
- `npm run test:ui:coverage`: **124 passed**, **95.81% line coverage**.
- `CMUX_COMPANION_CYPRESS_PORT=3333 npm run test:e2e:local`: final confirmation
  **78 passed**, five settings/orchestration/update separate-mode cases pending;
  zero failures. An earlier isolated local-app diagnostic also passed all ten cases.
- Corrected Knip analysis: **zero findings**. `npm audit`: **zero advisories**.
- zsh entry-point syntax and staged whitespace checks passed.
- Final staged-source secret scan: zero findings; baseline history scan retains
  the one reviewed mock-token finding described above.

The platform skip is the invalid UTF-8 filename test: macOS rejects that filename
before Git can inspect it. Live cmux/Tailscale/launchd installation, updates and
rollback were not exercised; disposable fixtures and fake operator effects cover
the changed boundaries. Exact committed-head CI evidence is recorded in the PR.

An audit snapshot exported inside ignored `outputs/` triggered a Vite reload during
the passing Cypress confirmation. Generated source snapshots were removed after
scanning; future snapshot exports should use an OS temporary directory outside the
checkout, since Git ignore rules do not necessarily exclude Vite watcher inputs.
