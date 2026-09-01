# Agent-driven goal merge and CMUX workspace groups

Date: 2026-09-01
Status: approved design, not yet implemented

## Problem

A multi-task goal in combined delivery mode ends in one pull request. Today
`server/goal-integrator.mjs` builds that pull request itself with `git` and `gh`
subprocesses. Two problems follow.

1. **No conflict path.** `git merge --squash` exits non-zero on a conflict. The
   whole assembly goes to `blocked`, and the integration worktree stays in a
   half-merged state. Only a human can recover it. Two tasks that touch the same
   file therefore cannot be delivered automatically.
2. **No task progress.** The per-task delivery status exists in SQLite, but no
   surface shows "2 of 5 branches ready". CMUX shows a flat list of workspaces
   with no relation between them.

## Goals

1. Replace the subprocess merge with one CMUX agent that can resolve conflicts.
2. Show goal progress as a live count in the companion, in the CMUX group name,
   and in CMUX notifications.
3. Group related workspaces in CMUX: one group per multi-task goal, and one
   shared group per repository for every single workspace.

## Non-goals

- Changing how a plan is created, edited, or launched.
- Changing single-PR delivery mode, where each task opens its own pull request.
- Any change to the CMUX application itself. Everything uses existing RPC.

## Architecture

Three concerns replace today's one.

### A. `server/cmux-groups.mjs` (new)

A thin service over the `workspace.group.*` RPC methods. Four operations:

| Operation | Behaviour |
|---|---|
| `ensureProjectGroup(repositoryName)` | List groups, match by name, create when absent. Returns the group id. |
| `ensureGoalGroup(plan)` | The same, keyed by the plan's stored `cmux_group_id`, with a name lookup as the fallback after a CMUX restart. |
| `addWorkspace(groupId, workspaceId)` | `workspace.group.add`. |
| `setLabel(groupId, name)` | `workspace.group.rename`, used for the counter. |

Every operation is best-effort. A CMUX without group support, or a failed group
call, logs a warning and never fails a launch or a delivery. Grouping is
presentation. It must not break delivery.

`workspace.group.create` takes an anchor workspace. So the first workspace of a
goal creates the group and later workspaces are added to it. The group appears
after the first task launches, not before.

### B. `server/goal-integrator.mjs` (rewritten)

The readiness watcher stays. The merge goes.

New responsibilities:

1. Watch git for task readiness. The `#readyHead` logic does not change.
2. Publish progress on every change: a plan store event, a group rename, and a
   CMUX notification at the three milestones listed below.
3. When every task is ready, create the integration worktree, then launch one
   CMUX agent in it with the merge prompt.
4. On the merge workspace's `Stop` hook, read `gh pr view` for the goal branch.
   A URL means success. No URL means the agent stopped, so mark the plan blocked
   with the agent's reason and leave the live session for the user.

The companion still runs `git` and `gh`, but only to **read**: `status`,
`rev-parse`, `rev-list`, `ls-remote`, `log`, and `pr view`. It no longer runs
`merge`, `commit`, `push`, or `pr create`. Those move into the agent.

### C. `server/worktree-planner.mjs` and `server/app.mjs` (small change)

After `#launchTask` succeeds, put the new workspace in the right group. The same
call goes into the two dashboard routes at `server/app.mjs:253` and
`server/app.mjs:301`, so a manual `+ Session` also lands in the project group.

### Data

Three new nullable columns on `plans`:

- `cmux_group_id`
- `merge_workspace_id`
- `merge_status` — one of `running`, `done`, `blocked`

No new column on `plan_tasks`. Its `delivery_status` already carries the state.

Two new event kinds: `merge_launched`, `merge_blocked`.

## The merge agent

### Launch

When the last task becomes ready, the integrator does three things in order.

1. Create the integration worktree on branch `goal/<slug>-<planId prefix>` from
   `origin/<base>`. This stays in the companion. `worktrees.create` already
   exists, and a worktree is not a merge decision.
2. Call `cmux.workspaceCreate({ cwd: integrationPath, title: "Merge: <goal>",
   agent: "claude", prompt: mergePrompt(plan) })`.
3. Store the returned workspace id in `merge_workspace_id`, set `merge_status`
   to `running`, and add the workspace to the goal group.

The agent is Claude through `xclaude`, the same path every task agent uses
(`server/cmux-client.mjs:242`).

### The prompt

Built from the plan, so it names every branch and commit explicitly.

1. **Context.** The goal text. The base branch. The current branch, already
   checked out.
2. **The task list.** One line per task: title, branch name, and the exact
   pinned commit SHA. The SHA matters. The agent must merge that commit, not the
   branch tip, so a task agent that pushes again mid-merge cannot change what is
   merged.
3. **The merge instruction.** Squash-merge each listed commit in order. Make one
   commit per task. Each commit message must end with the trailer
   `Cmux-Goal-Task: <planId>/<taskId>/<headSha>`. Check the existing log first
   and skip a task that already carries its trailer. This makes a retry
   idempotent.
4. **The conflict rule.**
   - Resolve a mechanical conflict yourself: imports, adjacent edits,
     formatting, a lockfile, both sides adding to the same list.
   - Resolve a semantic conflict when the goal makes the intent clear, and
     record what you chose.
   - Stop when two tasks genuinely disagree about behaviour and the goal does
     not settle it. Do not guess. Leave the worktree as it is and explain the
     choice you cannot make.
5. **The verification gate.** Run the repository's own verification:
   `npm run verify` when it exists, else `test`, `lint`, `typecheck`, `build`,
   whichever exist. Fix what your merge broke. Do not fix a failure that is
   already present on the base branch. Report it instead.
6. **The finish.** Push the goal branch. Open one pull request against the base
   with `gh pr create`. The body lists every task with its branch and short SHA,
   a `Conflicts resolved` section when the agent resolved any, the verification
   result, and the `Closes #N` lines for the linked issues.
7. **The stop clause.** If you stop, do not open a pull request. State plainly
   what blocked you.

The `Conflicts resolved` section is required, not optional. The merge agent can
now write code that no reviewer chose. That section is the only record of what
it decided on its own.

### Result detection

The integrator already listens for `agent.hook.Stop`. It now also matches the
merge workspace id. On that Stop, after the existing one-second debounce:

- Run `gh pr view <goal branch> --json number,url` in the integration worktree.
- A URL means done: `recordFinalPr`, `merge_status` = `done`, the group renamed
  to `<goal> — PR #N`, and a CMUX notification.
- No URL means blocked: `merge_status` = `blocked`, `recordDeliveryFailure` with
  a message that points at the live workspace, and the group keeps its counter.

The agent cannot report false success, because success is defined as a real pull
request on the real branch.

`verifiedAt` changes meaning slightly. Today it means the companion ran the
gate. It now means the agent reported the gate passed. The pull request body
carries the actual output, so the record stays honest.

### Retry

`POST /api/worktree-plans/:planId/assemble` on a blocked plan sends a fresh
prompt into the existing merge session, rather than creating a second
workspace. `cmux.sendText` takes a surface id, not a workspace id, so the retry
uses the same `surface.send_text` RPC with `workspace_id` that
`workspaceCreate` already uses at `server/cmux-client.mjs:244`. The agent keeps its context and its partly-merged
worktree. The prompt is short: "Continue the merge. Here is what is still
unmerged: …". A missing or closed workspace falls back to a new one in the same
worktree, so the agent inherits the partial merge.

## Progress tracking

One source of truth: the `delivery_status` column on `plan_tasks`. Every surface
reads it. The counter is `tasks with status ready or integrated` over
`tasks launched`.

The count changes at three moments only.

1. A task branch becomes ready. The git watcher sees it after that task's agent
   stops.
2. A ready task regresses to pending, because its agent pushed more work. The
   counter goes down. This is correct, not a bug.
3. The merge agent finishes. The plan leaves counting and enters a terminal
   state.

### Surfaces

**Companion planner panel.** The delivery section in
`app/worktree-planner.tsx:232` gains a counter line and per-task rows. Each row
shows the task title, its branch, and one of four states: waiting, ready,
merged, failed to launch. This is a display change over data the API already
returns.

**CMUX group name.** Renamed on each change:

| Plan state | Group name |
|---|---|
| Counting | `Refactor auth — 2/5` |
| Merging | `Refactor auth — merging` |
| Done | `Refactor auth — PR #123` |
| Blocked | `Refactor auth — blocked` |

**CMUX workspace title.** Each task workspace keeps its own title. The merge
workspace title carries the plan state, because it is the workspace the user
opens when something goes wrong.

**CMUX notification.** Sent through `notification.create_for_target`, which
the capability list confirms. `server/cmux-client.mjs` has no notification-send
method today, so one is added beside `markNotificationRead`. Three
notifications only:

1. Every branch is ready, merge starting.
2. The pull request is open, with its number.
3. The merge is blocked, with the reason.

Not one per task. A chatty agent stops many times, so a per-task notification
would be noise on a five-task goal.

**CMUX progress bar.** `set-progress` is a CLI command, not an RPC method. The
255-method capability list contains no `progress` method. So it needs
`cmux set-progress <fraction> --label "2/5" --workspace <id>` through the
existing `run` path. It is optional polish, behind the same best-effort wrapper
as the group calls, and dropped silently when the command is not available.

### Ordering guarantee

All surfaces update from a single function in the integrator, called after the
store commits. The store write is the commit point. A failed CMUX call never
rolls it back, and the next change re-sends the correct current count. So a
dropped rename self-heals.

## Group assignment

| Case | Group |
|---|---|
| Multi-task goal, any delivery mode | Goal group, named for the goal, with the counter |
| Merge workspace | The same goal group |
| One-task goal | Project group, named for the repository |
| `+ Session` or `+ Worktree` from the dashboard | Project group |

Both lookups follow the same rule: list the groups, match by name, create when
absent, add when present.

The goal group stores its id on the plan row, so a rename by the user does not
orphan it. The project group has no stored id and matches by repository name
only. A repository renamed in the companion config therefore gets a new group.
That is acceptable.

## Failure handling

| Failure | Behaviour |
|---|---|
| A group call fails | Log and continue. Delivery never depends on it. |
| CMUX is down at merge time | The plan stays `assembling` with an error. The existing startup sweep in `attach()`, which schedules every active combined plan, retries when the server restarts. |
| The merge agent never stops | Nothing happens. There is no timeout: a long merge is normal, and killing a working agent is worse than waiting. The `Check & build combined PR` button is the manual nudge. |
| Two Stop events race | The existing per-plan lock in `assemble` covers it. A second launch is prevented by `merge_status` being `running`. |
| The merge workspace id is stale | Fall back to a new workspace in the same worktree, so the agent inherits the partial merge. |

## Testing

`tests/goal-integrator.test.mjs` exists with a fake `execute` and a fake store.
The readiness tests stay as they are, because that logic does not change.

New tests:

1. Every task ready launches exactly one merge workspace, with the pinned SHAs
   present in the prompt.
2. A Stop on the merge workspace with a pull request present records the final
   pull request.
3. The same Stop with no pull request marks the plan blocked.
4. A retry on a blocked plan sends text to the existing workspace and creates no
   second one.
5. Group calls that throw do not fail the launch.
6. `server/cmux-groups.mjs` gets its own unit test for the find-or-create branch,
   with a fake RPC.

Test 5 is the important one. It is the guarantee that the presentation layer
cannot break delivery.

## Code removed

From `server/goal-integrator.mjs`: `#integratedCommit`, the squash-merge loop,
`qualityCommands` and its "no supported declared verification script" error,
`#pullRequest`, `pullRequestBody`, and `taskCommitMessage`. Roughly 100 lines.

`qualityCommands` is exported and tested, so its test goes with it.

The knowledge in those functions does not vanish. It moves into the prompt,
where an agent can apply judgment instead of failing.
