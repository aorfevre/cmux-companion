# cmux companion

A private, mobile-first companion for [cmux](https://cmux.com). It runs on your Mac, stays on automatically, and lets your phone monitor or interact with cmux over your existing Tailscale network.

No cloud application server is involved. Terminal output and input travel directly between your phone and Mac.

## What it does

- Shows every cmux workspace and terminal
- Adds an opt-in **Worktrees Beta** home view that groups parallel branches, agents, Git state, and open pull requests while keeping the existing Sessions view
- Shows sanitized per-account Claude Code and OpenAI Codex quota from CCS, including reported 5-hour, daily, weekly, monthly, and additional feature windows
- Highlights real cmux status, structured tasks, CPU, memory, and process health
- Collects permission requests, questions, plans, and meaningful notifications in an action inbox
- Launches allow-listed local repositories through the configured `xcodex` or `xclaude` aliases, a shell, or a declared package script
- Turns one goal into a validated Delivery Contract with observable acceptance criteria, scope, assumptions, risks, ownership, verification, and dependency waves; then starts each eligible task in an isolated worktree while balancing Claude and Codex by remaining quota
- Groups a repository's open GitHub issues into selectable master topics, plans and launches the topics in parallel, and links every final PR back to the issues it closes
- Delivers a multi-task goal as one verified pull request: task agents push isolated branches, Companion pins their finished commits and cuts one goal branch, and a single merge agent squash-merges them, resolves the conflicts it can, re-runs the repository's own verification against a baseline, and opens the combined PR
- Supervises every launched goal: checks each task's agent against the live cmux session list, alerts when one dies or goes quiet, and can continue, restart or skip that one task without abandoning the goal
- Reviews staged, unstaged, and untracked Git changes and per-file diffs
- Shows the current branch's open pull request, review decision, and check status directly inside its session
- Sends contextual Web Push alerts for decisions, failures, completion, PR changes, and detected local apps
- Opens each decision notification on a focused approval or reply card instead of a generic terminal
- Makes terminal `.md` references tappable and renders safe repository Markdown, tables, code, and local images on mobile
- Detects localhost apps and creates explicit, tailnet-only Tailscale Serve links from a private Apps screen
- Streams cmux activity and reconnects automatically with exponential backoff
- Renders cmux's native terminal replay grid with exact colors, styles, cursor, cell geometry, and scrollback
- Opens terminals at the latest output, follows only near the bottom, and preserves scrollback while reading
- Provides persistent terminal text-size controls, readable 16px input, and pinch zoom on mobile
- Keeps one mobile composer visible and accepts pasted or photo-library images as private local agent attachments
- Queues, edits, reorders, cancels, or manually sends follow-up prompts and releases one automatically after each agent stop
- Captures localhost apps at a mobile viewport, accepts finger annotations, and sends or queues a private visual “Fix this” prompt
- Keeps secondary navigation, PR details, display options, shortcuts, and special keys in one session menu
- Auto-grows short messages and provides a focused full-screen editor for long prompts
- Sends prompts and a small, safe allow-list of terminal keys
- Provides a searchable, provider-labelled `/` shortcut palette for common Codex and Claude workflows
- Restarts a stuck terminal or closes a workspace with explicit confirmation
- Starts in read-only mode to avoid accidental phone input
- Installs as a standalone PWA on iPhone
- Waits quietly when cmux is closed and reconnects when it opens
- Starts automatically at macOS login through a LaunchAgent

## Architecture

```text
iPhone PWA
    │ private HTTPS + WebSocket
    ▼
Tailscale Serve :8443
    │ loopback proxy
    ▼
cmux companion :3210
    │ allow-listed argv calls
    ▼
cmux CLI → replay grid / safe input RPCs → cmux Unix socket → cmux.app
```

The service binds only to `127.0.0.1`. Tailscale Serve is the only network-facing listener. The installer uses HTTPS port 8443 so it does not replace an existing Tailscale Serve handler on port 443.

Local app previews use separate HTTPS ports from 8500 through 8599. This preserves application root paths, redirects, assets, and WebSockets better than path-prefix proxying. A detected app is not exposed until you tap **Create private link**; links remain tailnet-only and Companion never enables Tailscale Funnel.

By default, the phone reflows the full Mac-width replay grid locally, keeping the Mac terminal unchanged while preserving enough history to scroll. The **Fit** control switches between this readable phone layout and the exact terminal grid. Older cmux versions automatically fall back to the authenticated plain-text screen endpoint.

The installer also enables cmux’s supported password-protected automation mode. It creates a separate socket credential at `~/.config/cmux-companion/cmux-socket-password` and makes a timestamped `cmux.json.*.bak` before changing cmux configuration.

## Requirements

- macOS with cmux installed in `/Applications/cmux.app`
- Node.js 22.13 or later
- Tailscale connected on both the Mac and phone

## Install

```bash
npm run install:mac
```

The installer builds the PWA, installs the macOS LaunchAgent, starts the companion, and configures private Tailscale HTTPS access on port 8443.

Show the phone URL and pairing code:

```bash
npm run status -- --show-token
```

Open the URL on your phone, enter the pairing code, then use Safari’s **Share → Add to Home Screen**.

The pairing code is stored with mode `0600` at `~/.config/cmux-companion/token`.

## Daily use

There is nothing to launch. The lightweight companion starts at login and remains ready. If cmux is not open, the phone UI displays “Waiting for cmux” and reconnects automatically when cmux starts.

The home screen starts in **Sessions**. Use the compact **Sessions / Worktrees Beta** switch below the header to test the worktree dashboard without removing the classic view. The selection persists on that phone; switch back to **Sessions** at any time.

Open **Settings → Licence usage** to see the remaining quota for every Claude Code and OpenAI Codex account registered in CCS. The view refreshes directly from each provider, clearly marks expired accounts that need reconnection, and labels provider-omitted windows as **Not reported** instead of treating them as exhausted.

Worktrees Beta discovers Git's registered worktrees for the configured repository roots, then groups open cmux sessions by their current directory. Each worktree shows its branch, changed-file count, ahead/behind state, latest activity, agent state, and matching open GitHub pull request. **＋ Worktree** on a repository creates or opens a branch in a sibling Git worktree and can immediately start its first agent session. **＋ Session** on an existing worktree starts another cmux session there with Codex through `xcodex` or Claude through `xclaude`. The server derives the worktree path, validates Git refs, and refreshes registered worktrees before each action.

**Plan a goal** on a repository sends one goal to a read-only headless planner. The planner may ask clarifying questions first; answer them, or skip and keep its assumptions visible. A ready plan is a Delivery Contract: outcome, scope and non-goals, constraints, assumptions, risks, observable acceptance criteria, task ownership, expected verification, and explicit dependencies. The Goal Passport shows that contract, readiness warnings, workflow waves, and criterion evidence before and after launch. You can still switch a task's agent, edit it, reject the split with written feedback, or drop it before confirming.

Tasks with no dependencies launch together from the freshly fetched default remote branch. Dependent tasks wait. Once a wave is clean, pushed, and carries valid completion evidence, the merge agent composes its pinned commits on the goal branch; Companion then creates the next wave's worktrees from that exact integrated commit. Downstream agents therefore see their dependencies without duplicating their work.

**GitHub Issues** loads up to 100 open tickets from the repository selected by the local checkout's `origin`, then asks an isolated Claude analyzer to group every ticket exactly once into delivery-sized master topics. Select the topics to deliver, answer topic-level clarifications, and create the saved goal plans. Any repository-planner follow-up questions stay in the same sheet. Once every selected plan is ready, one action launches all topic worktrees; their agents then run in parallel.

Each selected topic is an independent delivery unit. Tickets likely to touch the same files are grouped into the same topic, where Plan a Goal can sequence or split the implementation. Even a one-task issue topic uses Companion's generated delivery branch and verification gate. Its final PR contains one `Closes #N` line per linked ticket, so GitHub closes those issues only when the PR merges. Companion never closes an issue directly. The sheet refreshes selected tickets before planning and refuses tickets that changed, closed, or already belong to another saved goal.

This workflow requires the GitHub CLI to be authenticated for the repository (`gh auth status`). Issue bodies are treated as untrusted text, and the grouping model runs with local reads, writes, shell commands, tasks, and web tools disabled.

A planner round is bounded by silence, not by total time. Reading a large repository for a long goal is legitimate work, so the round is killed only after four minutes with no output, or at a thirty-minute ceiling. Whichever limit fires is stored on the plan, so a sheet reopened later names the real reason instead of guessing.

Every step is written to a local SQLite database at `~/.config/cmux-companion/goal-plans.db`, which the companion creates with mode 0600. It holds the goal, planner session, contract and readiness result, question rounds, answers, workflow tasks, edits, launch state, completion reports, changed files, ownership warnings, and integration evidence. A plan therefore survives a companion restart and an interrupted question round: reload it, and the next answer resumes the same planner session instead of starting the goal again.

The Worktrees view surfaces those saved plans beside the repository filters. **Draft Goals** collects resumable plans and **Launched Goals** keeps a read-only launch history for the selected Karven or Rekord project group. Each card opens the exact saved plan and can delete it after confirmation.

## Supervising launched goals

A launched goal used to have no liveness signal. Companion only heard cmux's
agent-stop event, so a crashed agent, a closed workspace, a hung session or a
sleeping Mac left a task pending for ever while the board reported "Dev in
progress". Nothing could start that task again, because a launch refuses a plan
that already launched.

**Goals board** now carries a **Blocked** column and an attention rail. The rail
lists every task that died, went quiet, failed to launch, or is waiting for an
answer, across both project groups, with **Continue**, **Restart**, **Skip** and
**Open in cmux** on each row. Continue keeps the worktree and whatever the dead
agent already wrote, and its brief tells the new agent to read `git status` and
`git log` before it does anything. Restart discards the branch and the worktree
and rebuilds from the base, so it confirms first. Skip drops one task, so a
single dead task stops blocking every other task's finished work from reaching a
pull request.

The verdict comes from a read-only sweep that joins each task's recorded cmux
workspace to the live workspace list. It writes no plan state: moving a goal on
a timer could declare a slow agent dead and rebuild its worktree underneath it,
so every recovery stays an explicit decision. When cmux cannot be reached the
sweep reports every session as unknown, and the rail says liveness is unknown
rather than listing live agents as dead.

A watchdog runs that sweep every five minutes and sends one Web Push alert when
a goal's health gets worse. A goal in the same state is not alerted twice, a
goal that recovers is forgotten so a relapse alerts again, and an unreachable
cmux skips the pass entirely. An alert that reached no device, because quiet
hours are on or no phone is registered, is offered again on the next pass rather
than remembered as sent.

Each pass refreshes GitHub and reconciles pull requests before it judges
liveness. Without that, a goal whose agent opened its pull request and stopped
would keep a stale board state and be reported as quiet twenty minutes after it
succeeded. A goal that already has an open pull request has finished the work
the sweep watches, so its task reads as ready whatever became of its session.

A crashed agent usually leaves its cmux workspace open at a shell prompt, so
**Continue** closes that session first when the sweep has already judged the
task stuck. A session that is still working, or one that is waiting for an
answer, is never closed by Continue.

Each cmux session Companion opens is named `KRV-T2-api · <task title>`: the
project code, the task code within its goal, and the part of the work, before
the title. The same identity is exported into the session's own shell as
`COMPANION_PROJECT`, `COMPANION_TASK` and `COMPANION_PART`, so it survives a
rename.

On a screen 1280 pixels wide or wider the board takes the whole window, its
lanes keep a readable minimum width, and the row scrolls sideways when eight of
them no longer fit. Squeezing every lane to fit is what made the board
unreadable. Every other view keeps its 1500-pixel cap, because prose and forms
stop being readable past it. Narrower screens keep the phone strip.

**＋ New goal** in the board header starts a goal without leaving the board, and
asks which repository only when more than one is visible. Each card carries its
repository as a coloured chip, so a board of parallel work says which product
each goal belongs to at a glance.

An **agent capacity** strip above the board answers which provider takes the
next task and why. It shows each provider's headroom, its deciding 5-hour and
weekly windows with live reset countdowns, and the account status behind them.
The verdict comes from the dispatcher's own rule rather than a second copy of
it, so the panel and the behaviour cannot disagree. When both providers are
exhausted it leads with the reset countdown.

**Check if merged** on a card in Waiting for merge or Blocked asks GitHub about
that one goal, instead of waiting for the next reconciliation pass. It reports
three outcomes differently: the goal moved to Merged, its pull request is still
open, or GitHub knows no pull request for its branch.

## Local end-to-end checks

The Cypress suite is intentionally excluded from `npm test`, `npm run verify`,
and CI. It starts an isolated frontend on port 3221 and stubs the application
API with one- and two-task goal fixtures, including a task that dies, an agent
waiting for input, and a blocked merge whose cmux workspace remains open:

```bash
npm run test:e2e:local
npm run test:e2e:open
```

The live audit is also local-only. It compares the installed companion's goal
board and health responses to workspace ids returned directly by cmux. It does
not create, close, or focus sessions:

```bash
npm run test:e2e:live-audit
```

The destructive smoke suite targets the disposable
`karven/cmux-e2e-cypress` checkout (remote:
`aorfevre/cmux-e2e-cypress`) and launch real `xclaude`/`xcodex` sessions. It is
separate from the deterministic Cypress suite and requires an explicit opt-in
before it creates branches and a pull request. Failed runs abort their goal and
close cmux sessions whose fixture worktree contains the unique run marker;
successful runs also remove their temporary worktrees and branches:

```bash
CMUX_COMPANION_LIVE_E2E=I_UNDERSTAND npm run test:e2e:live-agent -- --tasks=1
CMUX_COMPANION_LIVE_E2E=I_UNDERSTAND npm run test:e2e:live-agent -- --tasks=2
```

| Route | Purpose |
| --- | --- |
| `GET /api/worktree-plans` | Saved plans, newest first. Filter with `repositoryId`, `status` (`draft`, `launched` or `all`) and `limit`. |
| `GET /api/worktree-plans/:planId` | One saved plan with its tasks and its whole event log. |
| `POST /api/worktree-plans/:planId/resume` | Reload a plan into the running planner and return the draft. |
| `DELETE /api/worktree-plans/:planId` | Delete a plan with its tasks and events. |
| `POST /api/github-topic-plans/analyze` | Load open issues for a repository and propose bounded master topics. |
| `POST /api/github-topic-plans/prepare` | Refresh selected tickets and compile each selected topic into a saved goal plan. |
| `POST /api/github-topic-plans/launch` | Launch every ready selected topic; agents run in parallel after deterministic worktree creation. |
| `GET /api/goals/health` | Check every launched goal's agents against the live cmux session list. Read-only. |
| `POST /api/goals/health/check` | Force the pass the watchdog runs on its timer, and report what changed. |
| `GET /api/worktree-plans/:planId/health` | The same verdict for one goal. |
| `GET /api/goals/capacity` | Which provider takes the next task, its headroom, deciding windows and resets. |
| `POST /api/worktree-plans/:planId/check-merge` | Ask GitHub about one goal's pull request now. |
| `POST /api/worktree-plans/:planId/tasks/:taskId/relaunch` | Start one task again. `mode` is `continue` or `restart`. |
| `POST /api/worktree-plans/:planId/tasks/:taskId/skip` | Drop one task so it stops blocking the merge. |

The server chooses Codex or Claude per task from live CCS quota, not the model. It takes the lower of each provider's 5-hour and weekly remaining percent, sends the work to the provider with more headroom, and alternates when the two are within ten points. Every task keeps a toggle, so you can override the choice.

A launch of several tasks takes up to a minute, because each eligible worktree is created and inspected in turn. The sheet reports each task as launched, queued for a later workflow wave, or failed. A failed task does not roll back the tasks before it, and a task whose branch already exists is refused rather than started on old work.

Single-task goals keep the direct pull-request workflow. Multi-task goals use combined delivery: each agent commits and pushes its own task branch without opening a PR. The final commit carries both a plan-specific readiness trailer and a compact completion report that names satisfied criteria, checks and their real status, and limitations. Companion verifies that evidence against the contract, records changed files, warns about files outside planned ownership, and sends one corrective prompt to a task workspace when evidence is missing or invalid. Only evidenced commits are pinned for integration.

After each eligible wave is ready, Companion starts a merge agent in the goal worktree. It records a verification baseline, squash-merges pinned commits, resolves conflicts when the goal settles them, and verifies the composition. Intermediate waves are pushed without a pull request so the next wave can branch from their exact commit. The final wave opens one pull request against the default branch with Delivery contract, Integrated tasks, Evidence, Conflicts resolved, and Verification sections. A failure counts as pre-existing only when the baseline had it too. The agent stops and asks instead of guessing when two tasks genuinely disagree about behaviour. Agent-stop events trigger the check automatically; **Check & build combined PR** retries it from the saved goal view and continues a blocked merge in its existing session.

```bash
npm run status
npm run status -- --show-token
npm run install:mac
npm run uninstall:mac
```

The uninstall command removes automatic startup but deliberately preserves the pairing token and Tailscale Serve configuration.

## Security model

- The HTTP service listens on loopback only.
- Tailscale Serve provides private HTTPS transport and tailnet identity headers.
- Tailscale membership alone is not enough: every browser must also pair.
- The browser receives an HttpOnly, SameSite=Strict session cookie.
- State-changing requests enforce same-origin checks.
- cmux identifiers must be full UUIDs.
- Terminal input, keys, and text length are explicitly validated.
- No route accepts a shell command, arbitrary cmux arguments, or arbitrary RPC.
- Repository launch is restricted to immediate Git repositories in configured roots; package scripts must come from that repository's `package.json`.
- The goal planner runs `ccs claude` read-only: `Bash`, `Write`, `Edit`, `Task`, `Skill`, and web access are denied by name, the prompt follows a `--` terminator so text can never become a flag, and a plan is capped at eight tasks with a bounded number of question rounds.
- The goal health sweep and its watchdog only read. They never move a goal, never close a session, and never touch a worktree, so an automatic check cannot destroy work.
- Restarting a task deletes its branch and its worktree, so it is refused for the primary checkout and for a managed release checkout, and the phone confirms before it runs.
- Relaunching a task is refused while its cmux session is still open, because a second agent in one worktree would fight the first over the same files.
- Session identity is exported with a strict variable-name pattern and shell-quoted values, so neither a goal nor a task title can become a command.
- The GitHub topic analyzer treats ticket content as untrusted data and denies every local repository, shell, write, task, and web tool; it accepts only a complete grouping of the server-fetched issue numbers.
- Git diff requests are restricted to files currently reported as changed, and untracked symlink content is hidden.
- The CLI is spawned with argv arrays and never through a shell.
- Read-only protection is enabled by default on each phone.
- Push subscriptions and VAPID keys stay in a mode-`0600` file on the Mac; notification content is hidden by default.
- Alert categories, quiet hours, persistent deduplication, and lock-screen privacy are configurable per phone.
- Markdown reads are restricted to regular `.md`/`.markdown` files inside allow-listed repositories; canonical paths block traversal and out-of-repo symlinks, rendered HTML is not executed, and local images are type and size restricted.
- Preview targets must be localhost TCP ports. Tailscale HTTPS ports are allocated from a bounded range, can be stopped from the Apps screen, and are never exposed with Funnel.
- Preview capture runs in headless Chrome with every non-loopback request blocked; annotated screenshots use the same private attachment validation and retention policy.
- Queued prompts are stored in a mode-`0600` file and can target only validated cmux workspace and terminal identifiers.
- Pasted images are magic-byte validated, limited to 8 MB, stored with mode `0600`, and removed automatically after seven days.

Treat a paired phone as privileged: unlocking terminal input gives it control of interactive processes running in cmux.

## Development

Run the bridge and frontend in separate terminals:

```bash
CMUX_COMPANION_TOKEN=development-token-at-least-32-characters npm run companion:dev
npm run dev
```

Then open `http://localhost:3000` and pair using the development token.

Verification:

```bash
npm test
npm run test:ui
npm run lint
npm run typecheck
npm run build
npm run test:live
npm run test:installed
npm run test:preview-live
```

`test:live` exercises the cmux adapter directly. `test:installed` sends the same read/control flow through the installed HTTP service. Both create an isolated cmux workspace and close it in cleanup; neither uses one of your existing sessions.

`test:preview-live` starts a temporary loopback HTTP server, exposes it through an unused private Tailscale Serve port, verifies HTTPS access, and removes the Serve handler in cleanup.

The proposed unattended, self-updating macOS deployment design is documented in the [Local Updater Specification](docs/local-updater-spec.md).

Open **Settings → Deployments** to see the running Companion release and the deployed updater release together. The card compares both services with their latest observed `main` commit, verifies that the updater LaunchAgent has a live process, and shows active rollout phases, paused automatic updates, scheduled retry backoff, stale activity, and failures without reporting old state as healthy.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CMUX_BIN` | `/Applications/cmux.app/Contents/Resources/bin/cmux` | cmux CLI location |
| `CMUX_COMPANION_HOST` | `127.0.0.1` | Local bind address |
| `CMUX_COMPANION_PORT` | `3210` | Companion HTTP port |
| `CMUX_COMPANION_FRONTEND_PORT` | `3211` | Internal PWA server port |
| `CMUX_COMPANION_TAILSCALE_PORT` | `8443` | Private HTTPS port |
| `CMUX_COMPANION_TAILSCALE_BIN` | Tailscale macOS app CLI, then `tailscale` | CLI used to manage private preview links |
| `CMUX_COMPANION_TOKEN_FILE` | `~/.config/cmux-companion/token` | Pairing token path |
| `CMUX_COMPANION_REPO_ROOTS` | `~/Developers/karven:~/Developers/rekord` (expanded defaults for this install) | Colon-separated repository roots |
| `CMUX_COMPANION_PUSH_FILE` | `~/.config/cmux-companion/push.json` | Private push keys and device subscriptions |
| `CMUX_COMPANION_VAPID_SUBJECT` | Installed private Tailscale HTTPS URL | Web Push sender identity advertised to Apple and other push services |
| `CMUX_COMPANION_PREVIEWS_FILE` | `~/.config/cmux-companion/previews.json` | Managed private preview registry |
| `CMUX_COMPANION_QUEUE_FILE` | `~/.config/cmux-companion/prompt-queue.json` | Persistent follow-up prompt queue |
| `CMUX_COMPANION_PLANS_DB` | `~/.config/cmux-companion/goal-plans.db` | SQLite database of saved goal plans |
| `CMUX_PLANNER_IDLE_TIMEOUT_MS` | `240000` | How long a planner round may print nothing before it is killed |
| `CMUX_PLANNER_CEILING_MS` | `1800000` | Absolute limit on one planner round, whatever it prints |
| `CMUX_COMPANION_CHROME_BIN` | Google Chrome, Chromium, or Edge in `/Applications` | Browser executable used for private preview capture |
| `CCS_BIN` | First `ccs` executable in `PATH`, then installed NVM versions | Optional explicit CCS executable used to discover structured account quota support |
| `CMUX_COMPANION_PREVIEW_PORT_START` | `8500` | First Tailscale HTTPS preview port |
| `CMUX_COMPANION_PREVIEW_PORT_END` | `8599` | Last Tailscale HTTPS preview port |

## Troubleshooting

- **Phone cannot connect:** confirm Tailscale is connected on both devices and run `npm run status`.
- **Waiting for cmux:** open cmux on the Mac. The companion will reconnect without a restart.
- **Mac is sleeping:** Tailscale and the companion cannot respond while macOS is asleep.
- **Logs:** inspect `~/Library/Logs/cmux-companion.log` and `~/Library/Logs/cmux-companion.error.log`.
- **Changed source after installation:** run `npm run install:mac` again to rebuild and restart.

## License

MIT
