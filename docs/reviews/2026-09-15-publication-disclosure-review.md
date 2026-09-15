# Publication disclosure review

Reviewed 2026-09-15; collection completed at approximately 15:32 UTC. Remote
`main` was `42798bb`; the final refresh also includes the initial documentation
commit `0a1120779ae49586f8167628c5ca4b1f58122a27` and PR #153. This is the
requested dedicated history and GitHub-hosted disclosure review, performed with
Astra at maximum effort. It extends the earlier readiness and publication audits.

## Result and publication blocker

**No confirmed credential was found. Publication is held for one concrete privacy
finding:** [PR #30](https://github.com/aorfevre/cmux-companion/pull/30) contains two
real provider-account email addresses in its live quota examples, appearing three
times in its current body. Neither address is the public SECURITY.md contact or
a Git author identity. One account's ownership is not established. No addresses
or candidate secret values are reproduced in this report.

Replace the two accounts consistently with `account-one@example.com` and
`account-two@example.com`, preserving the example's behavior and distinct accounts.
The first account appears twice; the second appears once. User authorization for
that historical-content edit is pending at this report's cutoff.

PR #30 currently has **zero retained body-edit revisions**. Its two addresses were
absent from every retrieved edit diff and every reachable Git blob/commit object.
Editing the body will itself create revision history: inspect the resulting edits
and remove any revision retaining the original addresses through GitHub's supported
UI, then verify both the current body and retained revisions. The available
GraphQL schema exposes edit history but no `DeleteUserContentEditInput`; API
redaction alone must not be reported as complete historical removal. No external
content was modified by this audit.

Other historical material includes author identities, project/folder names and
live-operation evidence in PRs #125, #127 and #138. These are contextual publication
disclosures, not identified credentials. The provider-account examples are separate
from that ordinary source and operational history.

## Scope and evidence

Gitleaks **8.30.1** was downloaded from its upstream release. The Darwin ARM64
archive matched its published SHA-256:
`b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`.
Scans used the default rules without a custom suppression/baseline. The complete
object and hosted scans explicitly ignored `gitleaks:allow` comments. Retained
scanner reports redact values completely.

| Surface | Scope and result |
| --- | --- |
| Remote refs | Fresh mirror and final refresh: 181 branch refs and 157 PR refs; 684 remotely reachable commits. No tags were advertised. |
| Remote plus local history | Added 357 local refs to the disposable mirror: 769 reachable commits total. The initial patch scan processed 650 diff-bearing commits and found one historical synthetic fixture. |
| Complete Git objects | Scanned all 3,428 unique blobs (102,353,410 bytes) and all 769 commit objects (590,790 bytes), covering content or metadata omitted by patch-only scanning; 21 historical versions of the same fixture matched. |
| Issues and PRs | All states: 8 issues and 144 PRs at initial collection, plus the self-generated PR #153 delta; one issue comment, one submitted review, zero inline-review comments and zero commit comments. Paginated API retrieval completed without failures. |
| Edited descriptions/comments/reviews | Queried all 154 original content objects and retrieved 151 retained edit diffs; no further pages and no deleted edits were reported. Decoded edit prose scan: zero findings. |
| Uploaded attachments | No GitHub user-attachment/file URLs in current bodies, comments, reviews or retained edits. Six image links are Dependabot compatibility badges. Repository image evidence is covered separately below. |
| Actions artifacts | All 25 listed artifacts were unexpired and downloaded: 25 `verified-tree.json` files, 7,325 extracted bytes. Each contains only repository/workflow/run/version and Git identity fields; no secret finding. |
| Actions logs | Downloaded all 191 initial run archives plus PR #153's failed-run archive: 192 archives, 539 members, 72,298,065 extracted bytes. All runs had attempt 1, so there were no earlier retry archives to retrieve. No credential finding. |
| Historical images | Visually inspected all 15 unique historical PNG blobs: 13 demo UI screenshots and two icons. No visible credential identified; screenshots contain example/disposable paths. |
| Releases/wiki/discussions | Zero releases or release assets; wiki and discussions disabled. The discussions endpoint's HTTP 410 agrees with that configuration. |

Archive retrieval used the authenticated GitHub API. Every archive was checked for
unsafe paths and bounded expanded size before extraction; no archive content was
executed. Contextual review additionally checked account emails, private hosts,
credential-bearing URLs/assignments, filesystem paths and sensitive prose. The
remote and local copies include branches outside main, including earlier audits.

## Scanner findings and dispositions

1. **Historical fixture, one unique value:** `tests/api.test.mjs:1027` at
   `b6538e1ac50a8667e132d8a7c35dcea7db65aff9`. The predictable ascending digit/letter
   value has a token-like prefix and a length incompatible with a real classic
   GitHub token. It is supplied to `fakeReviewToken` through injected fake services
   and asserted in the same test. All 21 complete-object matches contain that
   identical fixture value. No credential rotation is indicated by this finding.
2. **Four export-format false positives:** scanning the combined raw GraphQL JSON
   additionally flagged four occurrences of three 40-character Git hashes under
   Gitleaks' Sourcegraph rule. A GitHub edit-node ID containing the rule's `sgp_`
   keyword activates its broad hash pattern in the same JSON record. The matches
   are explicitly labeled commit/published-head identities in PRs #139–#141; two
   hashes resolve to local commit objects, and the third appears twice as another
   project's published head. They are not prefixed Sourcegraph tokens. Decoded
   individual edit prose has zero findings. No suppression was added to hide them.

The history/object scans and final raw hosted-export scan returned finding exit
code 1 for these reviewed false positives; they are not described as zero-finding
passes. The initial hosted scan and decoded edit scan returned zero findings.
Candidates were not tested against any provider or external authentication service.

## Verification, limits and cleanup

**Passed:** upstream scanner checksum, paginated collection, all archive downloads
and extraction checks, complete-object coverage, historical-fixture triage,
hosted/edited-text triage, artifact schema inspection, contextual privacy review,
and historical PNG inspection. Publication privacy remains **failed/pending**
because of PR #30's account examples.

The documentation PR's CI is separate evidence: PR #153 run
[34988021208](https://github.com/aorfevre/cmux-companion/actions/runs/34988021208)
passed `macos` but failed full verification in
`tests/orchestration-dev.test.mjs:54`, where uncertain worker ownership left a goal
building instead of delivered. The parent agent's bounded local rerun passed both
tests (2/2). No runtime change or repeated CI retry was made to bypass that failure;
full verification is not claimed to pass for PR #153. Its logs were included above.

This is a bounded snapshot, not proof that arbitrary secrets/confidential facts
cannot exist. Unreachable or deleted server objects, removed/expired hosted content,
private forks, external link destinations, inaccessible revision content, and
arbitrary unrecognized encodings remain outside certification. Later PR/body/run
changes need a delta review; this sanitized report is the next self-generated delta.
Application behavior, storage and native/live integrations were not changed or
exercised by the audit; no live acceptance claim or bundled-release clearance follows.

Private exports, the disposable mirror, scanner and redacted evidence remain under
ignored `outputs/publication-disclosure-review/` in the original checkout with
restrictive creation permissions. Only this sanitized report enters the PR. No
Git history was rewritten, no secret rotated, and no service or account altered.
