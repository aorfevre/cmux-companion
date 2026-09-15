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

## Auto-merge activation

The trusted default-branch `Review and auto-merge` workflow runs after Verify and
every 15 minutes. It never checks out PR code or downloads PR artifacts. For bot
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
