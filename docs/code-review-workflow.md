# CodeRabbit and protected auto-merge

`.coderabbit.yaml` selects assertive review, but asks reviewers to focus blocking
feedback on correctness, security and observable behavior. It enables summaries in
PR descriptions, incremental reviews and approval after CodeRabbit's findings are
resolved. Drafts are excluded. AGENTS.md and path-specific guidance cover the UI,
server, updater, tests, dependencies and workflow security. Generated output is
excluded; source, tests, manifests and lockfiles remain reviewable.

## Goal publication

Companion still waits for completed tasks, independent final review, all approved
checks on the exact integration head, stopped workers and human publication
approval. It creates the PR as a draft, verifies its identity and head, then marks
it ready. A crash between creation and promotion reconciles that same PR. Abort
or target movement before promotion leaves it a draft for operator recovery;
a draft does not count as delivered. Because GitHub cannot atomically check the
base SHA during promotion, Companion re-reads the PR after promotion and restores
draft status if the target moved. Unconfirmed restoration or an open ready PR
with a moved target remains unknown, never delivered; operators reconcile that
uncertainty before retrying publication. A later externally edited PR is not proof of
the original goal's completion. Existing already-published PRs are unchanged.

This does not publish a PR at goal creation or grant the coding agent publication
authority. Ready means completed for external review, not permission to skip CI.

## Addressing review comments

A delivered goal offers **Address review comments**. One press runs one review
round. Companion reads every unresolved review thread on the pull request and
GitHub's mergeable verdict in one call, runs one background fixer agent in a
fresh worktree with the integrator's team profile and tool set, and requires the
approved project checks to pass on the fix head before any push. The push uses force-with-lease against
the recorded head; a moved branch fails the round and posts nothing. Companion
then posts exactly one reply per thread and resolves the threads the agent marked
fixed. Declined and comment threads stay open for the human. Each reply is
preceded by a sent marker, so a lost response is recorded as unconfirmed and
never re-sent. Rounds are unlimited; one round runs at a time.

### Merge conflicts

When GitHub reports the pull request as conflicting, or has not yet computed a
verdict, the round first merges the target branch into the pull request branch.
Companion performs that merge itself and commits it with two parents, whether or
not it conflicts. A conflicted merge commit carries the conflict markers, and the
fixer's worktree starts on that commit, so the agent resolves the markers and
answers the threads in one commit. The agent never merges, fetches or pushes.

Companion records the conflicted paths from its own merge, never from the agent's
report. The agent may change the contract's owned areas plus exactly those paths.
Before the merged head is verified, Companion reads each recorded conflicted path
from Git and refuses a head that still carries conflict markers: a commit that
merely touches a conflicted file is not a resolution.
A clean merge with no unresolved thread runs no agent at all: Companion verifies
the merge commit and pushes it.

One round starts automatically per pull request head when the 15-minute merge
check observes a conflict. A push moves that head, so a conflict that survives a
round waits for a press rather than retrying. A failed automatic round never
restarts by itself. Review threads alone never start a round.

A failed round holds the goal with the existing **Recover goal** action and
leaves the recorded head unchanged. The saved publication operation is the
identity of the original request, so a round never rewrites it; it advances the
recorded pull request head only. The round does not review the fix
independently. It never rebases, never edits the target branch, and never merges
the pull request itself; it merges the target branch into the pull request branch
only to resolve a reported conflict.

## Auto-merge activation

The trusted default-branch `Review and auto-merge` workflow runs every 15 minutes and on manual dispatch from `main`. It never checks out PR code or downloads PR artifacts. It does not use
`workflow_run` or other privileged PR-completion triggers. GitHub CLI runs from
a fixed OS installation path with a restricted subprocess PATH. For bot
authors such as Dependabot it requests one CodeRabbit review per head: CodeRabbit
can report a successful status for a skipped bot review, which is not approval.

Before activation, configure GitHub repository settings:

- Enable **Allow auto-merge**.
- Protect `main`, including administrators, with strict/up-to-date required
  `macos` and `verify` checks from GitHub Actions (app ID 15368), and the
  `CodeRabbit` status.
- Require at least one approval, dismiss stale approvals, require approval of the
  most recent push, and require resolved conversations.
- Install a dedicated merge GitHub App on this repository with contents and pull
  requests write, administration read (to inspect protection), and actions, checks and commit
  statuses read.
  Set Actions variable `AUTO_MERGE_APP_ID` and secret `AUTO_MERGE_APP_PRIVATE_KEY`.
  The workflow creates a short-lived token scoped to this repository and revokes
  it after the run. These are the merge app's credentials, not CodeRabbit's or a
  personal CLI credential; never put keys in source or logs.

The separate credential preserves the resulting main push workflow. Merges made
with the default `GITHUB_TOKEN` can suppress downstream workflows, leaving the
installed updater without main verification evidence. It is used only for
protection inspection and native protected merge/auto-merge; the default workflow
token requests reviews and reads PR/CI state.

Admission requires a non-draft, mergeable PR to main, successful current Verify,
all reported checks settled without failures, an actual CodeRabbit approval for
the current head, no change requests and no unresolved review threads. Missing or
paginated evidence fails closed. GitHub then enforces protection at merge time;
the command pins the expected head and never uses an administrator bypass.
Merge commits preserve the existing verified-tree reuse policy. Deployment remains
a separate installed-updater policy and authorization.

At configuration time this repository was private on a plan that rejected branch
protection (HTTP 403) and left auto-merge disabled. Upgrade the GitHub plan or
complete the separate publication privacy work first. CodeRabbit's free
open-source entitlement likewise depends on repository visibility and its plan;
a green skipped-review status does not establish that a review ran.

Dry-run inspection (no comments or merges):

```sh
GITHUB_REPOSITORY=owner/repository node scripts/review-auto-merge.mjs --dry-run
```
