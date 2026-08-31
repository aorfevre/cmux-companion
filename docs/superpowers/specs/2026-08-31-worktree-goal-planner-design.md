# Worktree goal planner

Date: 2026-08-31

## Problem

The worktree launcher is single-shot. `POST /api/worktree-dashboard/:id/launch` takes one
agent and one prompt, and it starts one cmux session in one existing worktree. A goal that
holds several independent units of work has no path. You must split the goal by hand, create
each worktree by hand, and launch each session by hand.

## Goal

Accept a goal at the repository level. Decide whether the goal splits into independent tasks.
Create one worktree per task. Launch one agent session per task. Keep a confirmation gate
before any Git command runs.

## Decisions

| Decision | Choice |
|---|---|
| Who splits the goal | A headless Claude call |
| Transport | `ccs claude --print --output-format json` |
| Skills | Full session. The prompt names `/brainstorming` and `/dispatching-parallel-agents` |
| Where tasks run | One new worktree per task |
| Entry point | A new "Plan a goal" button on the repository row |
| Gate | The plan is shown. You edit it. You confirm the launch |
| Single unit of work | The planner returns a task list of one. No special case |
| Base ref | The default remote branch, fetched before the launch |
| Agent per task | Server assigns from live account usage. You can override per task |
| Clarifying questions | An open loop, capped at 6 rounds, with a skip action |

## Architecture

One new server module, `server/worktree-planner.mjs`. It has three jobs.

1. Ask the model. It spawns `ccs claude` in the primary worktree. It keeps the returned
   `session_id`. Later rounds use `--resume <session_id>`, so the repository context is not
   re-sent.
2. Run the loop. Each reply holds `questions` or `tasks`, never both. Your answers go back
   through the same session. The loop stops at round 6, or when you skip.
3. Hold the draft in memory: goal, session id, round, questions, tasks. It expires after
   30 minutes.

The planner runs with `--allowed-tools Read,Grep,Glob,Skill`. It reads the repository. It
cannot write to it.

Existing collaborators do not change their purpose.

- `WorktreeDashboard.create` already creates a worktree with branch validation, a base check,
  and the sibling path convention. The planner reuses it.
- `AccountUsage` is read, not changed.
- `CmuxClient.workspaceCreate` launches each session.

## Prompt contract

The system prompt states five things.

1. The goal, the repository name, and the repository path.
2. Use `/brainstorming` for the question rounds. Use `/dispatching-parallel-agents` for the
   split.
3. Overrides: write no file, create no design doc, create no plan file. Both skills demand a
   document and an approval gate. This run does not have one.
4. Output one JSON object. It holds `questions` or `tasks`. It never holds both.
5. Each task is independent. Each names a branch under `feature/`. Each prompt is
   self-contained, because the agents do not see each other.

The `agent` field is absent from the model output. The server fills it.

## Output parse

The CCS wrapper prints banner lines before the JSON. The parser scans for the first line that
starts with `{`. It parses the Claude envelope, reads `result`, and extracts the plan JSON
from that text. A fenced code block is tolerated. An unparsable reply gets one silent retry
per round.

## Failures

| Failure | Message |
|---|---|
| `ccs` is not installed | The planner needs the ccs CLI. |
| Timeout after 180 seconds | The planner did not answer in time. Try again. |
| Output does not parse | The planner returned an unusable answer. Try again. |
| Both keys present, or neither | The planner returned an unusable answer. Try again. |

## Agent assignment

A pure function: `assignAgents(tasks, usage) -> tasks with { agent, agentReason }`.

For each provider it takes the lower of the `5h` and `weekly` remaining percent, across that
provider's ready accounts. The rules apply in order.

1. A provider with no ready account, or with headroom at or below 5 percent, is not used.
2. If neither provider is usable, every task gets `claude`. The reason states that usage data
   was unavailable.
3. If the two headrooms differ by more than 10 points, every task goes to the roomier
   provider.
4. Otherwise tasks alternate. The roomier provider goes first.

`agentReason` is one short string per task, for example `Codex - 5h 82% left`. The sheet shows
it under the toggle, so the choice is not opaque.

The function takes the usage snapshot as an argument. It touches no clock and no I/O.

## Endpoints

All four live under `/api/worktree-plans`.

1. `POST /api/worktree-plans` with `{ repositoryId, goal }`. It returns the draft.
2. `POST /api/worktree-plans/:planId/answers` with `{ answers }` or `{ skip: true }`. It
   resumes the session and returns the draft with `round` raised by one.
3. `PATCH /api/worktree-plans/:planId` with `{ tasks }`. It stores your edits and re-validates
   the branch names. It makes no model call.
4. `POST /api/worktree-plans/:planId/launch`. It creates each worktree, then launches each
   session.

The draft shape:

```
{ planId, round, status: "questions" | "ready",
  questions: [{ id, text, options }],
  tasks: [{ id, title, branch, prompt, agent, agentReason }] }
```

## Launch order

Before the first create, the server resolves the default remote branch. It runs one
`git fetch origin <default>`. A failed fetch stops the launch and reports the network error,
because a stale base is worse than no launch.

For each task, in order:

1. `worktrees.create(repositoryId, { branch: task.branch, base })`.
2. `cmux.workspaceCreate({ cwd, title, agent, prompt })`.

A failure on one task does not roll back an earlier task. The response reports each task as
launched or failed with its reason.

## UI

One new sheet, `app/worktree-planner.tsx`, in the style of the existing launcher sheet. The
repository summary row gains a "Plan a goal" button beside the archive button.

The questions state shows the goal, then each question. A question with options renders as
option buttons. Two actions: Answer, and Skip questions. A counter shows the round.

The plan state shows one card per task: title, branch, a Codex/Claude toggle with its reason,
and the prompt in a collapsed area you can edit. Each card has a remove button. The footer
names the base branch and the session count.

After the launch, the sheet reports each task as launched or failed. It does not close on its
own after a partial failure.

## Tests

New file `tests/worktree-planner.test.mjs`.

1. `assignAgents` sends every task to the roomier provider when headroom is far apart.
2. `assignAgents` alternates when headroom is close.
3. `assignAgents` falls back to `claude` when no usage is available.
4. The parser strips banner lines and a fenced block.
5. The parser rejects a reply that holds both `questions` and `tasks`.
6. A questions reply keeps the session id.
7. An answers round resumes with the recorded session id.
8. Round 6 forces the ready status.
9. A launch failure on the second task still reports the first as launched.
10. A patch rejects an invalid branch name.

`tests/api.test.mjs` gains route coverage with a fake planner. `tests/ui-features.test.tsx`
gains a sheet test. The `test` script in `package.json` gains the new file.
