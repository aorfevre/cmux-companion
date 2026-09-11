# cmux ecosystem survey: orchestration and companion tools

Date: 2026-09-11. Method: web search plus README reads. Star counts and
commit counts are as seen that day. Not verified by running any project.

## Question

Has someone already built what cmux companion does, and which parts of the
ecosystem are worth borrowing for the orchestration layer?

## Short answer

No project combines goal discovery in a live conversation, revision-bound
approval, independent review plus planner assessment, one worktree per task,
waves with a merge agent, and PR observation. Many projects mirror terminals to
a phone. Several orchestrate tasks. None does the whole pipeline. The mobile
layer is out of scope for now; orchestration comes first.

## cmux extension surfaces (what cmux itself offers)

1. Socket JSON-RPC v2 and the `cmux` CLI. This is what companion uses today.
   Issue manaflow-ai/cmux#3944 proposes a documented schema and an event
   subscription channel (workspace, pane, agent, file, branch, PR events).
   PR #3962 is open for it.
2. Workspace providers. A `workspace_providers` entry in `~/.config/cmux/cmux.json`
   with `list`, `create` and `destroy` subcommands. Provider workspaces appear
   under the "+" titlebar button and receive `CMUX_PROVIDER_*` env vars.
   Example: eunjae-lee/cmux-worktree.
3. Extension Kit for the right sidebar. Native Swift SDK `CmuxExtensionKit`,
   protocol `CmuxSidebarExtension`, extension point
   `com.cmuxterm.app.cmux.sidebar`. Renders native snapshots, not web content.
4. Hooks and skills. `cmux hooks <agent> install` and the official skill pack
   manaflow-ai/cmux-skills.
5. Native Goals sidebar, in progress by the maintainers. Issue #3931 and open
   PR #3961 add a `GoalSupervisionRecord` (title, acceptance criteria, linked
   workspace, status pending/active/paused/blocked/done/abandoned, notes,
   active time) stored in `Application Support/cmux/goals.json`, with a CLI
   `cmux right-sidebar goals`. Pause/resume snapshots, PR/CI tracking and cost
   are deferred. This overlaps companion's board, not its pipeline.

Two ideas from this: register companion as a workspace provider so goals can
start from the "+" button; and write companion goals into `goals.json` once
PR #3961 lands, so the native sidebar and the phone show the same goals.

## Orchestration projects, by family

### Ticket-driven dispatchers

| Project | Strength | Gap versus companion |
| --- | --- | --- |
| ClipboardHealth/groundcrew (610 commits, 64 stars, npm) | Polls Linear/Jira/local files for `agent-*` labels. One worktree per task with a `prepareWorktree` hook. `agent-any` picks the agent with the most remaining quota and weekly budget. Sandboxed by Docker or Safehouse. cmux, tmux and zellij panes. Blocked tasks wait. | No discovery, no approval gate, no review loop. Agents run unattended. |
| untra/operator (alpha, Rust TUI, 37 stars) | Ticket types with fixed priority INV > FIX > FEAT > SPIKE. Paired mode (human required) vs autonomous. `max_parallel`, launch confirmation, webhooks that create urgent tickets, REST API. | No worktrees, no PRs. |
| hummer98/cmux-team (1033 commits, 17 stars) | Deterministic daemon that is not a Claude session. One Conductor pane per task, agents spawned per role. Completion by done-marker files plus Stop/SessionEnd hooks. JSONL events, DuckDB metrics, per-task API traces. Worktree per task cut from the main branch. | Review is "watch the panes". Rough: test suite can hang, too many panes break cmux. |

### Pipeline engines with gates

- alevental/cccp (77 commits, 3 stars, npm). YAML stages: `agent`, `pge`
  (planner, evaluator writes a contract, generator, evaluator, retries up to
  `max_iterations`), `ge`, `autoresearch`, `parallel`, `human_gate`. The
  evaluator's verdict is one regex on `### Overall: PASS` or `FAIL`. Human
  gates are rows in `~/.cccp/cccp.db`, answered through MCP tools or
  `--headless`. State saved after every transition; `resume --from <stage>`.
  Agents are markdown system prompts run with `claude -p`, each with a fresh
  context and its own MCP profile.
- AhmedElBanna80/superteam (147 commits, 0 stars). Planner, implementer,
  spec-reviewer and code-reviewer on Claude Agent Teams. Per-ticket worktree.
  Reviewers return APPROVED or ISSUES_FOUND; the planner re-queues
  implementation with the feedback. A PreToolUse hook denies `--no-verify`
  and blocks a behavioural commit unless a failing test exists on the branch.
  Runtime is a research preview and hides panes.

### Correlators and boards

- flotilla-org/flotilla (887 commits, 1 star, Rust). Providers (GitHub PRs,
  issues, worktrees, Claude Code hooks) emit fragments that merge by identity
  into one work item per unit of work. Daemon plus TUI plus CLI with `--json`.
  Multi-host over SSH. Workspace templates spawn multi-agent panes.
- manaflow-ai/manaflow (6.4k commits, 1.1k stars). By the cmux team. One cloud
  or local Docker VS Code workspace per run, grid view of every agent, diff
  heatmap, squash-merge and PR from the app. Sandboxes instead of worktrees.
- gcalgcal/ServantHub (181 commits, 3 stars). SwiftUI kanban where each task
  is a Markdown file; embedded MCP server on port 9420; approval-waiting
  detection; iOS and web mirrors. No PR tracking, no goal planning.
- nkzou/cmux-board, aschreifels/cwt, tasuku43/kra, theodaguier/wt: ticket to
  worktree to pane tools with one-time PR checkout, no ongoing tracking.

### Plan-first skills

- mormamn/ticket-flow (3 commits). `/triage` premise check and self-interview
  before code, worktree per ticket, `/ship` to PR, `/clear-worktrees` with
  approval for borderline cases. Claude Code only.
- Islanders-Treasure0969/claude-pilot (110 commits). Web dashboard with
  `workflow.yml` phases and declarative file gates; pushes prompts into a
  cmux pane; Autopilot runs substeps in sequence.

### Mobile and remote clients (recorded, out of scope for now)

- Official cmux iOS: TestFlight beta, Founders Edition, terminal mirror and
  notification forwarding over Tailscale or WireGuard. No goals.
- Cmux Remote (App Store, MIT, NewTurn2017): third-party mirror with keys,
  uploads, inbox, workspace create/close.
- JPBallares/cmux-companion, richardhowes/cmux-mobile, itsmaleen/merry: Go or
  Node bridge over the socket to an iPhone app. Mirror and input only.
- ronnie3786/cmux-orchestrator (538 commits): Python dashboard on port 9091
  with iOS app, voice mode, git diffs, PR comment lookup through `gh`.

Full inventory: github.com/yigitkonur/awesome-cmux (170+ projects).

## What to borrow, in order of value

1. Deterministic scheduler outside the model (cmux-team, cccp). The goal
   integrator already does this for waves; planner assessment and approval
   delivery follow the same rule. Keep every loop counter and routing
   decision in the store, never in a prompt.
2. Quota-aware agent selection (groundcrew `agent-any`). Companion already
   reads account usage; use it to pick claude or codex per task automatically,
   with a per-goal override.
3. Done markers plus hooks as completion evidence (cmux-team). The health
   sweep infers from screen text; a marker file written by the task hook is
   cheaper and more reliable. Keep screen reading as the fallback.
4. One verdict line across all reviews (cccp). Planner review, burst review
   and code review each parse their own shape. One `### Overall: PASS|FAIL`
   line plus the findings block would let one parser serve all three.
5. Commit guard hook (superteam). A PreToolUse rule in the task hook that
   denies `--no-verify` and `--no-gpg-sign` for task agents.
6. Fragment merging into one work item (flotilla). The repo identity cache
   plus PR observation is close. One view that merges goal, task, worktree,
   branch, PR and session by identity removes the last manual correlation.

Not worth copying: per-run sandboxes (manaflow, groundcrew), because worktrees
on one Mac are companion's explicit model; Claude Agent Teams as the runtime
(superteam), because it is a research preview and hides the panes companion
relies on.

## Gaps in this survey

- dagster-io/erk ("AI plans, isolated worktree execution, automated PR")
  returned 404 on the web and the GitHub API; probably renamed or private.
- Star and commit counts were read from page captures and may lag.
- No project was run; all claims come from READMEs and docs.
