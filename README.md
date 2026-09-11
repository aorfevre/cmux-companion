# cmux companion

A private, mobile-first companion for [cmux](https://cmux.com). It runs on your Mac, stays on automatically, and lets your phone monitor or interact with cmux over your existing Tailscale network.

No cloud application server is involved. Terminal output and input travel directly between your phone and Mac.

## What it does

- Shows every cmux workspace and terminal
- Opens on the **Goals board**, with Goals, Worktrees, Licence Usage, and Settings as the main navigation. Tools keeps Sessions and Local apps accessible; Board tools contains repository/worktree and draft/launched goal lists, GitHub refresh/sync, and finished-session cleanup; Worktrees shows inventory and manual garbage collection; cleanup settings remain available in Settings. Explicit session and goal links still open their targets; old session-home preferences no longer override the dashboard.
- Shows sanitized per-account Claude Code and OpenAI Codex quota from CCS, including reported 5-hour, daily, weekly, monthly, and additional feature windows
- Highlights real cmux status, structured tasks, CPU, memory, and process health
- Collects permission requests, questions, plans, and meaningful notifications in an action inbox
- Launches allow-listed local repositories through the configured `xcodex` or `xclaude` aliases, a shell, or a declared package script
- Starts one goal as a visible conversation in its own worktree, with questions, revisions, and approval before implementation
- Turns one goal into a validated Delivery Contract with observable acceptance criteria, scope, assumptions, risks, ownership, verification, and dependency waves; then starts each eligible task in an isolated worktree while balancing Claude and Codex by remaining quota
- Opens plan review on a concise overview, with Design, Impacts, Tasks, and Checks tabs for proposed screens and flows, consequences, scope, dependencies, and verification; older plans retain their complete saved text
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
- Starts in read-only mode to avoid accidental phone input; the guard covers terminal input, proposal decisions and every Goals board action that starts, aborts, relaunches or syncs
- Installs as a standalone PWA on iPhone
- Waits quietly when cmux is closed and reconnects when it opens
- Starts automatically at macOS login through a LaunchAgent
- Detects a weekly quota window and offers **Start a burst**: one read-only scan agent per starred repository proposes one goal each; you approve, decline or rescan every candidate, and an approved candidate starts an ordinary goal session
- Marks any goal as **Burst**: every task brief permits subagents, an independent reviewer with the other provider checks each finished task (twice at most) before assembly, and a goal session gets one review when its pull request opens

## Visible goal sessions

In Worktrees, open **New goal**, describe a small increment and select **Start
goal session**. Companion saves the goal and opens an isolated worktree with a
native interactive conversation in cmux. Ask questions, answer the agent,
interrupt it and refine scope directly in the same terminal. Discovery stays open
until the agent publishes a validated delivery contract through its dedicated
Companion tool. The saved proposal then becomes ready for review; missing output,
a CLI exit or an interrupted conversation does not move it to Stopped.

Review the scope, exclusions, assumptions, acceptance criteria and verification,
then choose **Request changes** or **Approve and implement**. Approval applies to
that exact revision and session generation. Companion then sends the approval
to the agent's conversation itself, so the agent starts implementing without a
message from you. If the conversation is closed or the agent is showing a
prompt, the goal says why and offers **Send approval again**. Ordinary tool
permission prompts remain interactive. A new discovery message before approval withdraws the old proposal;
the agent republishes after incorporating your feedback. Phone feedback is saved
and reaches the agent when it next checks goal status or you send a terminal
message; it does not inject text into an active native prompt.

**Open conversation** returns to the recorded cmux workspace. **Resume
conversation** restarts an exited CLI with its saved conversation identity;
it preserves discovery and any proposal. An uncertain legacy implementation or
missing ownership still requires reconciliation, never an automatic replay.
Phone read-only protection disables approval, feedback and resume controls until
input is enabled. The owning conversation stays open while its PR is reviewed.

CCS uses its explicit Claude-compatible target for the selected provider, now
with the native Claude terminal UI rather than headless print/stream-json turns.
A supplied discovery prompt provides the `/goal` workflow; it does not require an
installed slash command. Read, Grep, Glob, questions and the dedicated goal tools
are available during discovery. A per-tool hook checks durable Companion approval
before Bash, Edit or Write; native permission prompts still apply afterward.
Only the Companion UI/API can approve a proposal. No completion envelope is
required, and no provider prose is treated as proof of successful delivery.

The owner is associated with one task for existing health and PR tracking.
Companion observes PR state through its GitHub refresh/watch path; provider prose
or a successful process exit is not delivery evidence. All new goals, GitHub issue
goals and restarted discovery use this same process. Starting or restarting discovery
shows a toast and returns to the board without opening the terminal; recovery
keeps the current sheet open. Choose **Open conversation** explicitly to enter it.
Old unlaunched goals offer
**Continue discovery**, which stops the old run and opens one recorded successor
with its saved contract, questions and discussion as historical context. Previously
launched deliveries retain their recovery controls. Automated planner/code-review
toggles are unavailable for native sessions; requests enabling them are rejected.
Merge and deployment remain separate decisions.

See the [feature contract and validation](docs/goal-session-planning.md). Local
fixtures exercise the workflow, identities and recovery boundaries; real CCS
permission enforcement, cmux continuity and live GitHub delivery still require
the explicit live-test opt-in. Product-quality and iteration-speed improvements
have not yet been measured on real goals.

## Burst

Burst has two independent parts. A **burst plan** scans every starred
repository with a read-only agent and proposes one goal per repository. Review
the goal, rationale and evidence on the Burst sheet (Board tools → Burst, or the
banner that appears when a weekly quota window is open). Approve a candidate to
start its goal session; the spec still needs your approval in that session.
Decline or rescan any candidate. One repository's scan failure is recorded on
that candidate and never aborts the others. Burst never launches work by itself.

The **Burst** toggle on the goal form is the second part. Every task brief of a
burst goal tells the agent it may launch subagents and that quota is not a
constraint. After a task reports finished, an independent reviewer with the
other provider reads the branch and writes a pass or block verdict. A block
returns the findings to the task agent for one more round; a second block marks
the task for your attention. A burst goal session gets the same review once its
pull request opens.

**Known limits:** burst reviewer sessions do not consult the quota floor —
they open directly through cmux rather than through the same capacity check
that gates scans and goal launches, so a burst goal can add review sessions
after the weekly window has closed. There is also no user action yet to waive
a task blocked twice by review; the only path forward is aborting the goal.
A goal started from an approved burst candidate always gets the burst review;
to run one of these goals without it, type the goal by hand and leave Burst
off.

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
- Node.js 22.23.1 (the supported Node 22 runtime is pinned in `.nvmrc`)
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

**Plan a goal** on a repository opens the same interactive goal-session form.
The agent asks any discovery questions in cmux and publishes a Delivery Contract
for approval. Saved legacy contracts and their Goal Passport remain readable;
use **Continue discovery** to revise an unlaunched goal in the native conversation.
There is no second planner or legacy launch action.

### Approving a goal

The first view of a ready goal is a concise approval summary. It states the
outcome, the intended user flow, the decisions and their consequences, the
success criteria, current readiness, and the delivery mode. It also draws the
workflow waves: tasks in the same wave can run in parallel, while a later wave
waits for its dependencies. Select a task in that chart to inspect its scope,
declared files and checks. The chart also names the goal's actual delivery mode.

The concise summary is a review surface, not a replacement contract. Expand
**Full delivery contract**, **Risks and technical constraints**, **Acceptance
evidence**, or **Task instructions** to inspect the saved Delivery Contract.
Readiness warnings and errors stay visible while those sections are collapsed
or expanded. A saved plan without an approval summary still shows its outcome,
delivery plan and the same saved-contract sections. Opening either view never
regenerates the plan or changes its saved contract.

### Spec depth

New coding goals enable independent planner and post-PR code review, unit tests,
end-to-end tests, edge cases and refactor review. Both reviewer controls are
editable; extra passes add provider usage and latency. Historical saved choices
and explicit opt-outs remain unchanged. After each published proposal, the
independent reviewer critiques it, then a read-only fork of the planner's own
conversation assesses every finding and publishes one reviewed final plan.
You approve or request changes on that final plan; you never adjudicate
findings. A failed review or assessment blocks approval until you retry it.
Code findings are saved in Companion and posted as an advisory comment to the
observed PR.

Choose **Analysis** for a repository-read-only outcome instead of code. Approve its
scope, then receive a versioned Markdown report in Companion, with download,
**Challenge the analysis** and **Launch coding goal** actions. Challenge saves an
independent critique without rewriting the report. Coding opens a separate linked
discovery that requires fresh approval. No commit or PR is required for analysis;
Bash, Edit and Write stay unavailable after analysis approval. See the
[goal workflow](docs/goal-session-planning.md#analysis-outcomes) for applicability,
version history, reviewer failure/reconciliation and recovery limits.

**Spec depth** on the Plan a goal sheet holds six independent requests. **Unit tests**, **End-to-end tests**, **Edge cases**, and **Refactor review** are on by default; **Screen wireframes** and **Flowcharts** remain off. Each selected request becomes a written requirement in every planning round and in every task brief. All six remain independently editable. Choosing **New goal** restores these form defaults, without changing existing saved goals or defaults for API callers that omit options. The six are:

- **Unit tests** — cover the new logic with unit tests.
- **End-to-end tests** — cover the user-visible flow with end-to-end tests.
- **Edge cases** — name the edge cases and cover each one.
- **Refactor review** — add a refactor task that reviews and cleans the touched code.
- **Screen wireframes** — return a screen wireframe for each new or changed screen.
- **Flowcharts** — return a flowchart for each new or changed flow.

A request is not a keyword search over the plan text. The planner must record structured evidence for each enabled request: a status, a rationale, the task ids and the acceptance criterion ids that carry it. Companion then derives one status per request from that evidence and from the contract itself.

**Planner Effort** is the existing extended-thinking control. It stays the only control for reasoning depth. Effort accepts Default, Low, Medium, High and Xhigh. Default sends no effort flag to the CLI; any other value is passed as `--effort`. Spec depth adds no second reasoning toggle, on purpose: the six requests state what the plan must contain, and Effort states how hard the planner thinks about it.

### Coverage states

The Goal Passport shows one line for each request you enabled. A request you left off is absent from the list, rather than reported as clean. Each line carries one of three states:

1. **Covered** — the evidence names at least one real task id and at least one real acceptance criterion id from the same contract. A covered **Refactor review** must also name a task whose type is `refactor`. A covered **Screen wireframes** must carry a screen artifact, and a covered **Flowcharts** must carry a flow artifact.
2. **Not applicable** — the planner declared the request does not apply and gave a rationale. The rationale is shown in place of the task and criterion links.
3. **Missing** — the request was made and the evidence does not hold up. The line states why: no evidence entry, a not-applicable entry with no rationale, no known task, no known acceptance criterion, no refactor-type task, or no artifact of the required kind.

Missing coverage is a readiness warning, not an error. It does not block the launch. A plan can read **Ready to code** and still warn that one requested kind of coverage is missing, so you decide whether to launch, ask another round, or reject the split.

### Design artifacts

**Screen wireframes** and **Flowcharts** ask the planner to return structured design artifacts with the contract. They are text descriptions of structure. They are not generated screenshots, not images, and not running UI.

Every artifact carries an id, a kind, a title and a summary. A flow artifact adds a list of nodes and a list of edges. Each node has a label and one kind: `start`, `step`, `decision` or `end`. Each edge names a source node, a target node and an optional label. Companion computes the layout from the edges alone, so the same artifact always draws the same picture. An edge whose source or target is unknown is dropped rather than re-targeted.

A screen artifact adds one screen, which has a name and a list of elements. Each element has a label, one kind of `header`, `text`, `input`, `button`, `list`, `image` or `note`, an optional note, and one change marker of `added`, `changed`, `removed` or `unchanged`. The passport renders those markers as **Added**, **Changed**, **Removed** and **Unchanged**. A screen with no name, or with no surviving element, is dropped rather than repaired.

Every string in an artifact comes from a model, so all of it is capped and treated as untrusted text. One contract keeps at most 6 artifacts. One flow keeps at most 24 nodes and 40 edges. One screen keeps at most 24 elements. An artifact id and a node id are cut at 40 characters. A title is cut at 200 characters, a summary at 600, a label or a screen name at 120, an element note at 240, and an evidence rationale at 500. All retained artifact text shares one aggregate budget of 16000 characters; text beyond that budget is dropped, and the rest of the plan stays readable. Artifact text reaches the page as React children only. No artifact supplies a link, a style, a coordinate or any raw HTML.

Tasks with no dependencies launch together from the freshly fetched default remote branch. Dependent tasks wait. Once a wave is clean, pushed, and carries valid completion evidence, the merge agent composes its pinned commits on the goal branch; Companion then creates the next wave's worktrees from that exact integrated commit. Downstream agents therefore see their dependencies without duplicating their work.

On the board, **Start a goal** on an individual **GitHub Issues** card opens the
same visible cmux planning conversation as **Start goal session**, using the
saved planner model defaults. The goal retains its issue links. Review the
proposal and choose **Approve and implement** before development starts.
Existing issue goals keep their original workflow and are reused on retries.

Aborted issue goals offer **Return issues to GitHub list**. After confirmation,
open issues already in the synced backlog appear immediately and can start a
fresh goal. Run **GitHub Sync** if an open issue is missing. The old goal stays
aborted with its history, linked issue references, branches and worktrees intact;
this action neither restarts work nor reopens a closed issue on GitHub.

The repository's bulk issue-planning sheet remains a separate workflow:

**GitHub Issues** loads up to 100 open tickets from the selected allowed repository.
Choose **Continue discovery** on an issue to use the same start action as the
GitHub board column. The server refreshes the issue, retains its source link and
deduplicates ownership. An existing native goal opens its recorded conversation;
an old unlaunched goal continues through the same migration service. There is no
separate topic analyzer, bulk planner or bulk launch. GitHub closes linked issues
when their PR merges; Companion never closes an issue directly.


This workflow requires the GitHub CLI to be authenticated for the repository (`gh auth status`). Issue bodies are treated as untrusted text, and the grouping model runs with local reads, writes, shell commands, tasks, and web tools disabled.

A planner round is bounded by silence, not by total time. Reading a large repository for a long goal is legitimate work, so the round is killed only after four minutes with no output, or at a thirty-minute ceiling. Whichever limit fires is stored on the plan, so a sheet reopened later names the real reason instead of guessing.

Every step is written to a local SQLite database at `~/.config/cmux-companion/goal-plans.db`, which the companion creates with mode 0600. It holds the goal, planner session, engine choice, the six Spec depth requests, contract and readiness result, option evidence, design artifacts, question rounds, answers, workflow tasks, edits, launch state, completion reports, changed files, ownership warnings, and integration evidence. A plan therefore survives a companion restart and an interrupted question round: reload it, and the next answer resumes the same planner session instead of starting the goal again.

The Worktrees view surfaces those saved plans beside the repository filters. **Draft Goals** collects resumable plans and **Launched Goals** keeps a read-only launch history for the selected Karven or Rekord project group. Each card opens the exact saved plan and can delete it after confirmation.

## Supervising launched goals

A launched goal used to have no liveness signal. Companion only heard cmux's
agent-stop event, so a crashed agent, a closed workspace, a hung session or a
sleeping Mac left a task pending for ever while the board reported "Dev in
progress". Nothing could start that task again, because a launch refuses a plan
that already launched.

**Goals board** columns are named for who acts: Discovering, Needs you, Building,
In review, Stopped, Shipped and Aborted, plus the two analysis columns. A goal that
asked a question or published a contract sits in **Needs you**; **Stopped** holds
failures only. The board also carries an attention rail. The rail
lists every task that died, went quiet, failed to launch, or is waiting for an
answer, across both project groups, with **Continue**, **Restart**, **Skip** and
**Open in cmux** on each row. Continue keeps the worktree and whatever the dead
agent already wrote, and its brief tells the new agent to read `git status` and
`git log` before it does anything. Restart discards the branch and the worktree
and rebuilds from the base, so it confirms first. Skip drops one task, so a
single dead task stops blocking every other task's finished work from reaching a
pull request.

**Open in cmux** selects that task's or merge agent's exact workspace, brings
its owning window forward, and briefly highlights the active terminal when
supported by cmux. The local Cypress suite checks the buttons' workspace targets
and failure notices; native window selection is validated separately against
installed cmux because the deterministic browser suite stubs the API.

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

Each cmux session Companion opens is named
`CC · Recover completed goal waves (7a2b) · T2-api · Wire the health sweep`:
the project code, then the goal, then the task code and the part of the work,
then the title. A merge session belongs to the goal rather than to one task, so
it reads `CC · Recover completed goal waves (7a2b) · MERGE`. The goal leads
because that is the order a person asks the questions in. In a sidebar of
twelve parallel sessions you look for which goal a session belongs to before
you look for which task it is, so the goal groups the list by eye. The goal
segment is the goal's own text plus a short fragment of the plan id, which is
what keeps two goals in one repository apart when they open with the same
words.

The reorder has a cost. The identifying code no longer leads, so it no longer
survives sidebar truncation for free. Fixed budgets pay that cost. The project
code takes at most 4 characters, the task-part code at most 10, and the goal
text is clipped to 36 characters before the plan-id fragment. That fragment is
4 characters in parentheses, and it is never the part that clips, so `T2-api`
stays at a near-fixed offset in cmux's narrow sidebar. Only the task title
loses characters. The same identity is exported into the session's own shell
as `COMPANION_PROJECT`, `COMPANION_PLAN`, `COMPANION_GOAL`, `COMPANION_TASK`
and `COMPANION_PART`, so it survives a rename.

Two limits are honest ones. A 4-character plan-id fragment can collide between
two goals. That stays cosmetic, because `COMPANION_GOAL` is only the readable
short form and `COMPANION_PLAN` carries the full plan id for every lookup. The
format also applies to newly opened sessions only. Companion does not rename
sessions that already exist, so a board can show both the old shape and the new
one until the last old session closes.

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

Companion also **retires the cmux sessions it opened for a goal** once their
work is provably finished. A goal PR being created makes its original task and
merge sessions eligible for retirement, including the single-task session that
opened the PR. Running agents and agents waiting for input finish first; the
next pass retries them. Follow-up sessions have separate identities. Goal
worktrees remain until the goal PR is merged and worktree cleanup is enabled.
A merge session a newer merge agent replaced is retired when idle.

The pass never closes a session whose agent is running or waiting for an
answer, never closes anything while an undelivered goal's merge is blocked, never closes
anything at all when cmux cannot be reached, and never touches a session
Companion did not open for a goal. Every session that stays open is reported
with the reason it stayed, so a kept session can always be explained.

The supervision timer runs this pass on its own schedule. Set
`CMUX_COMPANION_AUTO_CLOSE_SESSIONS` to `0`, `off` or `false` to stop the
timer pass; the on-demand route stays available. **Close finished sessions** in
the board header runs the same pass now. Its label carries the number of
sessions a pass would close, read from the dry-run route on the board's own
poll, so the button is honest before it is pressed and disables itself when
nothing is finished. It reports how many sessions were closed, how many were
kept and why, and names any session cmux refused to close. An unreachable cmux
is reported as unknown liveness with nothing closed, never as zero finished
sessions.

**Contract check.** When a goal session's pull request opens, Companion reads the
approved contract's verification lines, matches them to the repository's own
declared package scripts, and runs the matched script once per head commit in the
goal's worktree. The result sits on the card beside the pull request link as
**Contract check passed**, **failed** or **not run**. Prose such as "try a
sandbox payment" matches nothing, and nothing runs. The check records evidence
only; it never moves the goal and never runs a command the repository did not declare.

**Check if merged** on a card in In review or Stopped asks GitHub about
that one goal, instead of waiting for the next reconciliation pass. It reports
three outcomes differently: the goal moved to Shipped, its pull request is still
open, or GitHub knows no pull request for its branch.

**More actions** on every goal card in In review opens a follow-up
popup. Choose one or several actions: ask a question, add more unit and e2e
tests, run a complete code review, or give a free-form instruction, then choose
Claude or Codex. One submission opens exactly one cmux session in that goal's
delivery worktree. Any code it produces is committed and pushed on the same
branch, updating the existing pull request rather than opening another one.
The follow-up session is left open for you to read and close.

## Local end-to-end checks

The Cypress suite is intentionally excluded from `npm test`, `npm run verify`,
and CI. It starts an isolated frontend on port 3221 and stubs the application
API with deterministic fixtures. The specs cover pairing and offline recovery,
sessions and the terminal composer, the prompt queue, the inbox, workspace
launch, settings and push notifications, local app previews with the fix
editor, licence usage and CCS reconnect, worktree cleanup and release
retention, board actions and the read-only guard, bursts, deployment health,
automatic planner assessment of the independent review, and the goal fixtures: one- and two-task goals, a task that dies, an agent
waiting for input, a blocked merge whose cmux workspace remains open, and a
spec-rigor goal that submits its six requests and renders their coverage
evidence:

```bash
npm run test:e2e:local
npm run test:e2e:open
npm run test:e2e:local -- --spec cypress/e2e/goals-home.cy.ts
```

Set `CMUX_COMPANION_CYPRESS_PORT` when port 3221 is already in use; the runner
passes the matching base URL to Cypress.

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
| `GET /api/github-issues` | The stored open issues of your starred repositories, with the last sync time and the per-repository results. |
| `POST /api/github-issues/sync` | Pull the open issues of every starred repository into the durable store. Reports each repository, and says so plainly when nothing is starred. |
| `POST /api/github-issues/:repositoryId/:number/goal` | Turn one synced issue into one goal plan. Returns the existing plan when that issue already started one. |
| `GET /api/goals/health` | Check every launched goal's agents against the live cmux session list. Read-only. |
| `POST /api/goals/health/check` | Force the pass the watchdog runs on its timer, and report what changed. |
| `GET /api/worktree-plans/:planId/health` | The same verdict for one goal. |
| `GET /api/goals/capacity` | Which provider takes the next task, its headroom, deciding windows and resets. |
| `POST /api/worktree-plans/:planId/check-merge` | Ask GitHub about one goal's pull request now. |
| `POST /api/worktree-plans/:planId/tasks/:taskId/relaunch` | Start one task again. `mode` is `continue` or `restart`. |
| `POST /api/worktree-plans/:planId/tasks/:taskId/skip` | Drop one task so it stops blocking the merge. |
| `POST /api/goals/sessions/reap` | Run the finished-session retirement pass now. Reports every session closed, kept and refused. |
| `GET /api/goals/sessions/retirable` | What that pass would close, without closing it. |

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
- The goal planner invokes the selected `ccs claude` or `ccs codex` engine with read-only tool settings (`Read`, `Grep`, `Glob`), disabled slash commands and isolated MCP configuration; shell, editing, delegation and web tools are denied, the prompt follows a `--` terminator so text can never become a flag, and a plan is capped at eight tasks with a bounded number of question rounds.
- The goal health sweep is read-only. The watchdog reconciles GitHub state and collects finished goal sessions; it never deletes branches or worktrees. It can resume verified combined-goal delivery as described below.
- The supervision timer may close one thing: a cmux session Companion itself opened for a goal, recorded on that goal's plan row, after that session's work is delivered. It may never close a session whose agent is running or waiting for an answer, a session of a goal whose merge is blocked and has no delivery PR, any session while cmux is unreachable, or any session Companion did not open for a goal. It deletes no branch and no worktree. Set `CMUX_COMPANION_AUTO_CLOSE_SESSIONS` to `0`, `off` or `false` to stop the timer pass.
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

Use the Node version in `.nvmrc` (`nvm install && nvm use`), then `npm ci`.
See [development setup and completion](docs/development.md) for verification,
code-path evidence and the per-project **Review dev setup** workflow.

The replacement orchestration API has an account-free
[disposable development mode](docs/orchestration-development.md):
`npm run orchestration:dev -- --port 3211`. It uses real temporary Git repositories
and fake agents/GitHub; its mobile frontend is still under implementation.

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
| `CMUX_COMPANION_REPO_DB` | `~/.config/cmux-companion/repo-identity.db` | Rebuildable SQLite repository/worktree cache |
| `CMUX_COMPANION_STATUS_TTL_MS` | `30000` | How long displayed worktree status/change counts may be reused, in milliseconds; `0` disables reuse |
| `CMUX_COMPANION_PLANS_DB` | `~/.config/cmux-companion/goal-plans.db` | SQLite database of saved goal plans |
| `CMUX_COMPANION_AUTO_CLOSE_SESSIONS` | on | Automatic retirement of finished goal sessions on the supervision timer. Set `0`, `off` or `false` to stop the timer pass; `POST /api/goals/sessions/reap` stays available |
| `CMUX_PLANNER_IDLE_TIMEOUT_MS` | `240000` | How long a planner round may print nothing before it is killed |
| `CMUX_PLANNER_CEILING_MS` | `1800000` | Absolute limit on one planner round, whatever it prints |
| `CMUX_COMPANION_CHROME_BIN` | Google Chrome, Chromium, or Edge in `/Applications` | Browser executable used for private preview capture |
| `CCS_BIN` | First `ccs` executable in `PATH`, then installed NVM versions | Optional explicit CCS executable used to discover structured account quota support |
| `CMUX_COMPANION_PREVIEW_PORT_START` | `8500` | First Tailscale HTTPS preview port |
| `CMUX_COMPANION_PREVIEW_PORT_END` | `8599` | Last Tailscale HTTPS preview port |
| `CMUX_COMPANION_BURSTS_DB` | `~/.config/cmux-companion/bursts.db` | SQLite database of burst plans and candidates |
| `CMUX_BURST_IDLE_TIMEOUT_MS` | `240000` | How long one burst repository scan may print nothing before it is killed |
| `CMUX_BURST_CEILING_MS` | `900000` | Absolute limit on one burst repository scan, whatever it prints |

## Troubleshooting

- **Phone cannot connect:** confirm Tailscale is connected on both devices and run `npm run status`.
- **Waiting for cmux:** open cmux on the Mac. The companion will reconnect without a restart.
- **Mac is sleeping:** Tailscale and the companion cannot respond while macOS is asleep.
- **Logs:** inspect `~/Library/Logs/cmux-companion.log` and `~/Library/Logs/cmux-companion.error.log`.
- **Changed source after installation:** run `npm run install:mac` again to rebuild and restart.

## License

MIT

### Automatic goal session cleanup

Once Companion records a goal pull request, it closes the goal's recorded task
sessions and final merge session, including for single-task goals and PRs already
closed or merged. A combined goal's intermediate task and superseded merge
sessions still close when their work is integrated. Stopped goals without a goal
PR retain their sessions; a task PR within a combined goal does not finish it.

Cleanup runs when a combined delivery settles or GitHub reconciliation observes
the goal PR. The watchdog also sweeps durable records one minute after startup
and every five minutes afterward, including old merged goals, to retry failed
closes and collect leftovers. Plan retention preserves records with unretired
sessions so cleanup cannot lose their identities. Already-missing sessions count as retired; connection
failures remain retryable. Only workspace IDs recorded by Companion are closed.
Untracked sessions are not inferred from their titles or directories. Branches,
worktrees, and goal history remain available after sessions close.

Local validation combines backend tests of real SQLite lifecycle records and a
fake cmux adapter with Cypress coverage of the board retaining its PR state after
session counts reach zero. The deterministic Cypress suite does not operate real
cmux sessions.

### Automatic worktree inventory and garbage collection

Open **Worktrees** beside Goals (or `/?view=worktrees`) to see registered checkout,
development worktree, eligible and protected counts, paths, reasons and space estimates.
**Run garbage collection** previews a confirmation, then collects all eligible entries
regardless of search filters. It runs immediately without enabling a schedule or
bypassing safety checks and grace periods. Counts include missing Git registrations,
not every ordinary directory in `../`. Failed or uncertain runs require a fresh scan.

For old blocked goals whose development has not started, open the saved goal and
choose **Continue discovery**. This stops the previous discovery and opens native
interactive discovery with the saved contract, discussion, goal, images, engine,
Spec depth options and GitHub issue links;
automated reviews are disabled for native sessions. The original remains saved and
its issues are released for the successor. If startup fails before saving that successor,
issues remain available in the GitHub list. Repeated clicks reopen the same successor
instead of creating duplicate sessions. Goals with started development tasks use task recovery.

**Worktree cleanup** provides a central dry-run inventory across Karven and Rekord,
including nested repositories and external registrations. Sessions close when a
goal PR is created; verified goal worktrees become eligible immediately when that
PR is **merged**, subject to clean/unlocked/inactive and exact-commit checks.
Other proven merged worktrees use a configurable seven-day grace period.
Automatic development deletion, Git pruning, and updater release deletion all
start **disabled**. The UI offers separate enable controls, schedules, reviewed
manual runs, protected-item reasons, space estimates, and history. Branches are
preserved; checkout folders and approved ignored build artifacts are deleted.

See [cleanup policy, limitations and recovery](docs-worktree-cleanup.md).

### Responsiveness under load

Concurrent catalogue reads share one scan. Dashboard scans with different inputs
run sequentially, and catalogue Git commands share a limit of 12 concurrent
processes. Browser polls reuse an unfinished read; writes invalidate that shared
read so the following refresh can fetch updated state.

If Electron cannot start reliably on a busy Mac, run the same local Cypress suite
in an installed Chrome using:

```bash
CMUX_COMPANION_CYPRESS_BROWSER=chrome npm run test:e2e:local
```

This still uses deterministic local fixtures and refuses CI execution.

### Automatic goal delivery recovery

The watchdog checks about one minute after startup, then five minutes after each
completed sweep. After refreshing GitHub, it recovers missed task/merge Stop
hooks and retries the specific temporary “Another worktree operation holds this
lock” failure. An observed open PR clears obsolete delivery errors; merged and
aborted goals remain terminal. No activation is needed for this recovery.

Recovery requires an available cmux inventory and explicitly idle agents in the
recorded sessions and sessions using the task/integration worktrees (including
subdirectories). Running agents, input requests, and unknown activity prevent
recovery. Task readiness still requires clean Git status, a pushed exact commit,
the goal/task completion trailer, and the completion report when required by the
goal's delivery contract. Missing or unreadable evidence cannot prove completion.
Operations serialize with assembly and settling; overlapping checks share the
same recovery operation. Each goal's failure is isolated from the rest.

Real merge conflicts, failed task launches, and ambiguous associations still need
review. Recovery does not remove lock files or infer completion from inactivity.
Use **Check & build combined PR** after resolving a genuine blocker, or
`POST /api/goals/health/check` to run the supervision pass immediately. Session
retirement and worktree deletion retain their separate safety policies and controls.
The deterministic Cypress suite verifies the recovered board state; backend tests
exercise the actual recovery decisions without launching agents or deleting real worktrees.


### Model defaults

Settings → **Model defaults** exposes planner, spec reviewer, coder, code reviewer,
merge agent and follow-up agent roles. The planner model owns the interactive
discovery and implementation conversation. The issue-analyzer role remains stored
for compatibility but is hidden. Planning starts with Codex Astra
(`gpt-6-astra`). Explicit provider and model choices still apply.

Choose a model from the full dropdown or select **Custom model…** to enter a
provider model ID, then **Save model defaults**. `default` explicitly
lets the provider choose its model. Save applies the choices across paired
devices and survives restarts. Reset restores one role's built-in values;
press Save to apply it. A failed save keeps the previous configuration active.

New plans use the saved defaults and retain their resolved planner and requested
code-review models. Per-goal model choices override Settings. New task launches,
retries, dependency waves, merge sessions, and follow-ups read the current role
defaults; existing agent sessions are unchanged. A follow-up containing a code
review uses the code-review model even when it also requests tests or other work.
New native goals enable an independent specification reviewer by default; it uses
the opposite provider's saved spec-reviewer model. Analysis challenges use the
saved code-reviewer selection. No separate issue analyzer is started.

Configuration lives in `~/.config/cmux-companion/model-settings.json` (override
with `CMUX_COMPANION_MODEL_SETTINGS_FILE`). The paired, same-origin Settings
API is `GET` / `PATCH /api/settings/models`. Custom IDs are syntax-validated,
not checked against a live provider catalog; availability depends on the
configured provider/account. A model ID that a provider retires is rewritten to
its replacement when the saved settings and saved goals load, so an existing
selection does not break planning: `gpt-6` reads as `gpt-6-astra`.
Local Cypress covers the Settings and planner UI; backend tests verify
persistence and the commands for each role without starting live agents.

### Share a goal popup

Opening any saved goal updates the browser address to
`/?view=sessions&mode=worktrees&plan=<goal-id>`. Copy the address or press
**Copy goal link** beside the visible goal reference. The link identifies the
saved goal across planning, review, launch, merge, and completion; reopening it
uses the goal ID directly, even when the current board list does not include it.
Pairing and access to the same Companion instance are still required.

Reload and browser Back/Forward restore the popup. Closing it clears the popup
from the address. New-goal forms use `newGoal=<repository-id>` until saved;
these links restore the repository/form, not unsaved text or attachments.
Development-setup links also include `goalTemplate=dev-setup`. A missing goal
opens an error with a Close button rather than silently opening another goal.
