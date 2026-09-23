# Publication privacy, protection and distribution audit

Audit date: 2026-09-15. Source and remote main at snapshot:
`ec816593cf4c49a4328303490378595513839350` (PR #141 merged).
User authorized the three audits and configuring required CI on main. Repository
visibility, billing, history rewriting, content deletion, release publication and
live installation were not changed.

## Result

No confirmed credential was identified by the dedicated scans. One historical
synthetic test token was reviewed and classified as a fixture. Publication still
has a concrete privacy decision: PR #30 includes two real provider-account email
addresses, separate from the deliberately public SECURITY.md contact.

GitHub rejected required branch protection with HTTP 403 because the current
plan does not support it on this private repository. **Required CI is not enabled
as a server-side merge restriction.** The prepared configuration is retained below.

The dependency/artwork audit is complete within its stated scope. **Bundled binary
distribution is not cleared:** native-library notices/source obligations and font
notices remain unresolved. Icon origin is now maintainer-attested Codex generation. The source MIT notices are present.

## Privacy evidence

Gitleaks **8.30.1** was downloaded from its upstream GitHub release and its macOS
ARM64 archive verified against the release checksum file. Scans used its default
rules with `--redact=100` and JSON reports. No broad allowlist was added, no finding
value is copied into this report, and no candidate credential was tested against
an external service.

| Surface | Scope and result |
| --- | --- |
| Remote Git history | Fresh owned mirror, all advertised refs plus explicit PR-head fetch: 671 reachable commits, 177 branch refs and 151 PR refs. Gitleaks reports 572 diff-bearing commits scanned; one fixture match. |
| Local Git history | All local refs: 733 reachable commits; Gitleaks reports 629 diff-bearing commits scanned; same fixture match. Includes local-only history absent from the remote mirror. |
| Issues and PRs | 8 issues, 141 PRs, one issue comment and one submitted PR review; zero review-inline or commit comments. Exported 292 text records, including duplicate issue/PR representations. Gitleaks: zero findings. |
| Attachments | No GitHub user-attachment URLs found in exported bodies. Linked repository evidence remains covered by the Git/history review. No separately uploaded release assets exist. |
| Actions artifacts | Downloaded all 19 listed, unexpired artifacts; zero retrieval failures. Each contains only a verification-receipt JSON object with repository/workflow/run/commit/tree identity fields. Gitleaks: zero findings. |
| Actions logs | Downloaded all 180 listed run log archives successfully; 71,361,519 extracted bytes scanned. Gitleaks: zero findings. |
| Releases, wiki, discussions | Zero releases/assets; wiki and discussions disabled. |
| Tracked PNGs | Contact sheet of all 14 PNGs reviewed: 12 UI evidence screenshots and two app icons. No visible credential identified. Artwork rights have separate limits below. |

Reproduction commands for an owned clone/export directory (the exports contain
private material and must not be committed):

```sh
gitleaks git /path/to/owned-mirror.git --log-opts=--all --redact=100 \
  --report-format json --report-path /private/evidence/history.json
gitleaks git . --log-opts=--all --redact=100 \
  --report-format json --report-path /private/evidence/local-history.json
gitleaks dir /private/evidence/hosted-text --redact=100 \
  --report-format json --report-path /private/evidence/hosted.json
gitleaks dir /private/evidence/artifacts --redact=100 \
  --report-format json --report-path /private/evidence/artifacts.json
gitleaks dir /private/evidence/action-logs --redact=100 \
  --report-format json --report-path /private/evidence/logs.json
```

GitHub API collections were paginated: issues/pulls in all states, repository
issue/review/commit comments, reviews for every PR, releases/assets, Actions
artifacts and Actions runs. Every listed artifact and run-log archive was
retrieved through the authenticated API, checked for unsafe member paths and
extracted into a separate owned directory; archive contents were never executed.

The single scanner match is `tests/api.test.mjs:1027` in historical commit
`b6538e1ac50a8667e132d8a7c35dcea7db65aff9`. The matching value has a token-like
prefix followed by a predictable ascending digit/letter sequence. The test uses
`fakeReviewToken` and injected fake services. This is a scanner false positive,
not evidence requiring rotation of a live credential. Both history scans exit 1
because of that reviewed match; they are not reported as zero-finding passes.

Additional contextual review checked contact addresses, filesystem paths,
tailnet hosts, IP literals and credential-related prose. PR #30 contains actual
provider-account emails in quota examples. Replace them with distinct
`example.com` addresses before publication unless intentional disclosure is
accepted. This review did not edit historical discussion content. PRs #125,
#127 and #138 also contain live-operation evidence (project counts, job identities,
local temporary paths and a description of work on another project). These are
not credentials but will become public as part of repository discussion history.
Git author identities and historical project/folder names also remain visible.

This is a bounded scanner/content audit, not proof that every possible secret or
confidential fact is absent. Unreachable/deleted server objects, deleted or expired
logs/artifacts, edited-comment history, private forks, external websites, arbitrary
encodings and secrets outside scanner patterns are not certified. Results are a
snapshot; rerun against the actual publication head and newly created GitHub
content immediately before changing visibility. Raw exports remain ignored and
private under `outputs/publication-audit/`, not in the source PR.

## Repository protection: attempted and blocked

The authenticated account has repository admin permission. Reads of branch
protection/rulesets and the actual PUT to the main branch-protection endpoint
returned:

> Upgrade to GitHub Pro or make this repository public to enable this feature.

The [prepared request](2026-09-15-main-protection.json) requires:

- Pull requests before merging, without adding an independent-reviewer requirement
  to this single-maintainer project.
- Successful `macos` and `verify` checks from the GitHub Actions app (15368).
- An up-to-date branch before merge, with enforcement applying to administrators.
- No force pushes or deletion of main.

After the owner enables an eligible plan or separately authorizes publication,
apply the exact request from the checkout:

```sh
gh api --method PUT repos/aorfevre/cmux-companion/branches/main/protection \
  --input docs/reviews/2026-09-15-main-protection.json
```

Then read the endpoint back and verify both required check names, strict status
checks and admin enforcement. The PUT's HTTP 403 is an actual failure, not a
successful configuration or an automatic-approval rejection. No billing/visibility
change was attempted. Existing workflow dependencies and updater eligibility
checks do not replace server-side merge restrictions.

## Distribution and artwork

See [the distribution audit](../distribution-licensing.md) and the
[976-entry dependency inventory](../licenses/2026-09-15-dependencies.json).

The audit confirmed both source MIT notices and matching installed versions for
848 package entries, classified all locked licenses, inspected the libvips binary's
embedded-library list and the Noto Sans font's embedded license metadata. It found
33 installed packages without a named license/notice file, and two app icons with
no recorded source/license. Missing named files are evidence to resolve, not proof
that each upstream project has no license. The maintainer subsequently confirmed both icons were generated in Codex; that
attestation is now recorded in the asset inventory. No independent copyright
exclusivity is asserted and no dependency was relicensed.

No Companion binary is currently published in GitHub releases. The local-build
installer obtains dependencies with npm, including development tools. Before
redistributing a prebuilt tree, assemble exact third-party notices and required
source/build materials for all shipped native components, fonts and runtimes;
validate the actual target architecture and LGPL replacement/relink requirements.

## Checks and remaining work

Passed: upstream scanner checksum; full hosted-content retrieval; hosted text,
artifact and log scans; historical fixture triage; license inventory/installed
version comparison; PNG review; current full-lockfile npm audit (zero advisories).

Failed: main branch-protection configuration, HTTP 403 (plan restriction).
History scanners returned their expected finding exit code for the documented
fixture; neither scan failed to execute.

Unverified: independent third-party/exclusive rights clearance for generated icons; complete notices and corresponding
source/relink compliance for a hypothetical binary bundle; arbitrary confidential
content beyond the stated privacy review. No runtime implementation changed, so
application unit/UI/build/Cypress suites were not rerun for this documentation-only
audit. Inventory consistency and `git diff --check` are the relevant local checks.

Owner actions still needed: resolve the GitHub plan/visibility prerequisite,
confirm or sanitize the identified personal account examples and live-operation
prose. Icon origin has been supplied by the maintainer. Binary packaging requires
the artifact-specific compliance work described in the distribution audit.
