# Burst mode design

Date: 2026-09-08

## Purpose

Burst turns a detected quota window into launched work. It has two independent parts.

1. **Burst plan.** A cross-repository recommender. It scans every starred repository and proposes one goal per repository. The user approves or declines each candidate. An approved candidate becomes an ordinary goal session.
2. **Burst flag.** A per-goal execution intensity. It adds independent review agents and tells every task agent that it may launch subagents. Burst uses more quota on purpose.

Either part works without the other. The burst flag can be set on a goal the user typed by hand.

## Non-goals

- Burst never launches work by itself. The capacity banner is a shortcut only.
- Burst never bypasses the spec gate. Every goal still publishes a delivery contract and waits for spec approval.
- Burst never exceeds quota. It respects `MIN_HEADROOM` in `server/capacity-policy.mjs`.
- No cross-repository goal. One goal owns one repository, as today.

## Architecture

### New modules

| Module | Purpose |
| --- | --- |
| `server/burst-store.mjs` | node:sqlite tables `burst_plans` and `burst_candidates`. Follows `worktree-plan-store.mjs` conventions. |
| `server/burst-scanner.mjs` | Runs one read-only scan agent per starred repository. Returns one proposed goal per repository. |
| `server/burst-service.mjs` | Creates a burst, owns the scan, approves one candidate and calls `goalSessions.start()`. |
| `server/burst-routes.mjs` | The API group, in the style of `planner-routes.mjs`. |
| `app/burst-plan.tsx` | The review screen. |

### Data

`burst_plans`: `burst_id`, `created_at`, `status`, `capacity_snapshot` (JSON), `scan_state`.

`burst_candidates`: `burst_id`, `repository_id`, `repository_name`, `goal`, `rationale`, `evidence` (JSON list), `size_estimate`, `status`, `reason`, `plan_id`, `updated_at`. Primary key is (`burst_id`, `repository_id`). One candidate per repository per burst.

Candidate `status` is one of `scanning`, `proposed`, `failed`, `approved`, `declined`. `plan_id` is the goal session the approval created. `reason` holds the stated failure reason.

Burst `status` is one of `scanning`, `ready`, `closed`. A burst is `ready` when no candidate is `scanning`. A burst is `closed` when every candidate is `approved`, `declined` or `failed`.

### Repository source

The starred set is `RepositoryFavorites`, the same set `GitHubIssueSync` reads. No new selection concept exists.

### Capacity link

Burst creation records the `agentCapacity()` snapshot. `weeklyOpportunity()` in `server/capacity-policy.mjs` already detects an account with at least 20% weekly quota that resets inside 24 hours. The Goals board shows one banner when it finds such a window: **Start a burst**. The banner opens the burst creation flow. It does not create anything by itself.

## Burst plan flow

### Create

`POST /api/bursts` reads the starred repositories, writes one `scanning` candidate per repository, starts the scan in the background and returns the burst at once. An empty starred set returns a stated reason with HTTP 200, not an empty success. One burst may be `scanning` at a time. A second create while one scans returns the running burst.

### Scan

One agent per repository, launched through the existing planner process path in `server/planner-process.mjs`, not through cmux. The agent is read-only: Read, Grep and Glob only. Its brief:

1. Read `AGENTS.md` or `CLAUDE.md` and the README of the repository.
2. Find the largest tractable increment worth one goal in this repository.
3. Return one JSON object with `goal` (one sentence), `rationale`, `evidence` (file paths or commands) and `sizeEstimate` (`small`, `medium` or `large`).

The agent proposes work. It does not write files. Scan concurrency is capped at 3. The provider for each scan comes from `assignAgents()` so both providers share the load.

Scan output is validated against a schema before storage. Invalid output marks the candidate `failed` with the reason. It never becomes a silent empty proposal. One repository's failure never aborts the other scans. This copies the rule in `GitHubIssueSync.sync()`.

### Review

`GET /api/bursts` lists bursts, newest first. `GET /api/bursts/:burstId` returns the burst and its candidates. The screen shows one card per repository: the proposed goal, the rationale, the evidence, the size estimate and the scan state. Each card has **Approve**, **Decline** and **Rescan**. The user may edit the goal text before approval.

### Approve

`POST /api/bursts/:burstId/candidates/:repositoryId/approve` with an optional `goal` override:

1. Validates the candidate is `proposed`.
2. Calls `goalSessions.start({ repositoryId, goal, specOptions: { burst: true } })`.
3. Stores the returned `planId` and marks the candidate `approved`.

From that point the goal is an ordinary goal session. It opens its worktree, runs discovery, publishes a delivery contract and waits for spec approval as today. Burst adds no second approval concept.

Approving an already-approved candidate returns its existing `planId`. It never starts a second session.

`POST .../decline` marks the candidate `declined`. `POST .../rescan` resets one candidate to `scanning` and runs one scan for that repository only.

### Read-only protection

Approve, decline and rescan are disabled on the phone until input is enabled, like the existing goal controls.

## Burst flag on a goal

`burst` is a new boolean in `specOptions`, normalized in `server/worktree-planner-options.mjs` and persisted with the plan. It reaches every launched task. The goal form gets one toggle, **Burst**, with the hint "Uses more quota: extra reviewers and subagents". Burst-created goals set it by default. The user can clear it before starting the goal.

The flag changes execution in two places.

### Task briefs

`taskPrompt()` in `server/worktree-planner.mjs` adds one block when `burst` is true:

> You may launch subagents for independent slices, for exploration and for review. Prefer parallel work where it is safe. Quota is not a constraint for this task. Every subagent result is your responsibility: verify it before you report it.

Without the flag the prompt is unchanged.

### Extra review agents

After a task reports finished, and before assembly, the planner launches one independent review agent on that task's branch with the other provider. The reviewer engine reuses `reviewerEngine()` in `server/worktree-planner-options.mjs`. The reviewer reads the delivery contract and the diff. It returns findings tagged `blocking` or `advisory`.

- No blocking findings: the task proceeds to assembly. Advisory findings are recorded on the task.
- Blocking findings: the task returns to its owner agent with those findings through the existing follow-up path in `server/goal-followup.mjs`. The task then gets one more review.
- Blocking findings on the second review: the loop stops. The task is marked for the user's attention with the findings. It does not move to Blocked by itself.

The assembled goal branch gets one review of the same kind before the pull request opens.

### Capacity floor

Burst respects `MIN_HEADROOM`. When both providers are at the floor, new burst launches wait. The card shows "Waiting for quota". The existing capacity poll releases the wait.

## UI

- Board tools gets a **Burst** entry that opens the burst list and the create action.
- The Goals board shows the opportunity banner when `weeklyOpportunity()` finds a window.
- `app/burst-plan.tsx` is the review screen described above.
- Each goal card with the burst flag shows a small **Burst** badge.
- The goal form shows the **Burst** toggle.

## Errors

Every failure has a stated reason on the object that failed: the burst, the candidate, the review or the task. No failure moves a goal to Blocked by itself. This matches the goal-session rule in the README.

## Tests

- `tests/burst-store.test.mjs`: table creation, one candidate per repository, status transitions, idempotent approval.
- `tests/burst-service.test.mjs`: create with empty starred set, scan failure isolation, approve calls `goalSessions.start()` with `burst: true`, second approve returns the same `planId`. Uses a fake scanner and a fake goal session service.
- `tests/burst-scanner.test.mjs`: schema validation of agent output, concurrency cap, provider assignment. Uses a fake planner process.
- `tests/worktree-planner-options.test.mjs`: the burst flag normalizes and persists.
- `tests/worktree-planner.test.mjs`: the burst block appears in `taskPrompt()` only when the flag is set; the review loop stops after the second blocking review.
- `tests/ui-burst-plan.test.tsx`: the review screen renders candidates and disables actions in read-only mode.
- `cypress/e2e/burst-plan.cy.ts`: stubbed flow from banner to approved candidate.
- Live scans are opt-in only, under the existing `*.live.mjs` rule.

## Implementation order

1. Burst flag: options, task prompt, goal form toggle, badge. Small and independent.
2. Burst store and service with a fake scanner.
3. Burst scanner on the planner process path.
4. Routes and review screen.
5. Extra review agents in the planner.
6. Opportunity banner and Cypress coverage.
