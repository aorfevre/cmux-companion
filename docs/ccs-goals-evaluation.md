# CCS Goals implementation and evaluation evidence

Status: delivery contract approved; implementation in progress.

Contract: [CCS-based conversational Goals](superpowers/specs/2026-10-12-ccs-goal-experience.md).
Spec commit: `aa8b19c4`.
Branch: `feat/ccs-goal-experience`, based on `origin/main` at `02a433a3`.

## Launcher discovery — 2026-10-12

Read-only terminal metadata lookup established that both `xclaude` and `xcodex`
are aliases in the current Mac environment. The repository's existing
`resolveProviderCommand` was then called for each, with model `default`.
Neither call launched CCS, a model or a cmux workspace.

| Launcher | Current resolver result | Permission flags discarded by existing resolver |
| --- | --- | --- |
| `xclaude` | `ccs claude` | `--dangerously-skip-permissions` |
| `xcodex` | `ccsxp` | `--yolo` |

This proves the current aliases can be resolved by the existing code. It does
not prove their native startup, account selection, resume/input transport or
termination behavior. Their actual provider/account credentials were not read
or printed. The implementation must make its managed-policy differences explicit
and preserve CCS routing rather than treating alias resolution as runtime parity.

## Checks

- Passed: fresh remote main fetched and an isolated worktree created.
- Passed: spec commit whitespace check (`git show --check HEAD`).
- Passed: read-only alias lookup and existing resolver for both launchers.
- Passed: `npm ci --no-audit --no-fund` on Node 22.23.1 in the isolated
  worktree (856 packages installed; checked-in lockfile unchanged).
- Passed: existing adapter baseline, 18 tests, zero failures/skips:
  `node --test --test-concurrency=4 tests/provider-command.test.mjs tests/orchestration-ccs-managed-launcher.test.mjs tests/codex-native.test.mjs`.
  These tests cover alias resolution, fixed CCS invocation/routing, native
  session binding, resume arguments, process/PTY identity and restricted tools
  with disposable fake providers. They do not establish live launcher parity or
  the proposed continuous Goals conversation.
- Implementation verification is recorded in the checkpoint below.
- Not run: native provider/cmux trials, GitHub publication, installation or update.

The full delivery contract and five-goal native success measure remain pending.
The conversation foundation below is implemented; partial criterion evidence does
not establish end-to-end native usability. The user approved the
committed contract with “implement the goal. I approve it”; the human-review
gate is satisfied before the implementation plan commit.

The original checkout and its untracked burst-scan plan remain unchanged.


## Conversation foundation checkpoint — 2026-10-12

Implemented in the isolated worktree, with one owner and no changes to installed
services:

- Persisted opt-in experience version 2, ordered conversation messages and
  queued/delivered/answered receipts. Existing goals keep their original flow.
- One recorded planner acts as the supervisor across plan generations, using
  scoped conversation commands. Questions retain the native attempt; supervisor
  commands cannot approve, commit, invoke legacy planner publication or bypass
  the user's publication decision.
- Native Claude/Codex input preparation carries a supervisor binding through the
  existing CCS adapter and terminal handoff. The transport waits without model
  polling turns. Real native timeout/idle behavior is still unverified.
- Pause gates pending launch/integration/verification/publication work. Abort
  retains evidence and requests observed termination. Unknown supervisor
  ownership blocks execution barriers; confirmed stop plus explicit recovery can
  reconstruct a supervisor from saved context.
- Conversation-first browser workspace, proposals, current workers, result
  evidence and a persistent composer. Exact pending message envelopes are saved
  per journal for reload/reconciliation. Technical records remain in details.
- Account-free demo supervisor uses the real scoped HTTP API, not workflow store
  writes. It asks a fixed question, acknowledges guidance, revises and dispatches.
  It is deliberately scripted and proves no model intelligence or CCS routing.

### Passed evidence

- `npm run verify`: backend 1,052 passed / 1 intentionally skipped; UI 205 passed;
  backend line coverage 97.40%, UI line coverage 95.02%; lint, types and build
  passed. Lint retains two existing settings navigation warnings.
- Follow-up UI coverage passed 208 tests at 95.04% line coverage; final lint,
  typecheck and build passed after the conversation-control race correction.
- Targeted UI tests subsequently passed 34 cases, including exact original
  message-envelope replay after reload and isolation between journals.
- Native terminal fixture suite: 13 passed, including both Claude-shaped and
  Codex-shaped supervisor handoff/resume with the same native conversation ID.
  These are disposable fake executables, not the user's actual launchers.
- Conversation domain/API regressions: 11 passed, including unknown-worker
  fencing, acknowledged input, exact receipt replay and self-approval denial.
- Real-service conversation Cypress: one journey passed in Chrome, with checked
  1440px desktop and 390px phone widths. It covers start, question/answer,
  proposal revision, pause, queued steering, reload, resume, approval, dispatch
  and abort. Exactly one supervisor launch is asserted across that journey.
- Legacy real-service Cypress: three writable journeys passed, one read-only
  branch intentionally pending in the writable run. Includes independent
  reviews, failed checks, exact-head publication, review fixes and merge conflict
  repair against the disposable remote and fake GitHub.
- Added a real-Git development-composition regression for the review-merge remote
  binding; passed after the fixture correction described below.

### Interventions and limits

- Initial new terminal-resume tests failed because the fixture did not copy its
  launched identity into its resume request. Corrected the fixture, then all 13
  terminal tests passed; the ownership guard was retained.
- Initial legacy Cypress run failed with `REVIEW_FIX_FAILED` while preparing a
  post-publication merge. The demo constructed ReviewMerge before createPublisher
  initialized `fixtureRemote`. Replaced the eager undefined reference with a
  deferred fixed fetch adapter, added a regression, and reran successfully.
- A later conversation Cypress run exposed a version race: the supervisor's
  wait receipt could commit between projecting and clicking Pause. The pause was
  rejected and the user's following message was answered rather than queued.
  Added bounded rebasing for definitive conflicts on message/pause/resume only;
  approval and uncertain-response envelopes remain unchanged. Added a UI
  regression, waited for the observed paused state in Cypress, and passed the
  journey after that correction.
- The first desktop capture was constrained to 1280px by Chrome's headless window.
  The harness now uses a 1600px window and checks the actual 1440px document width.
  Inspected both new screenshots; collapsed superseded proposals and verification
  argv to keep the phone conversation readable.
- Full verification preceded the final fixture-only remote-binding correction
  and the conversation-control race correction; targeted regression, Cypress,
  full UI coverage, lint, types and build validate those follow-ups. No coverage threshold was changed.

### Remaining implementation and acceptance

The approved worker edit–check–fix tool and bounded final-check recovery are
implemented in the follow-up below. Automatic failed-launch recovery remains
outstanding. The new experience's full result/diff/review/publication
journey, process-level service restart, readiness/policy disclosure for actual
launchers, native waiting/capacity evidence and all five native representative
goals remain outstanding. The current Cypress journey ends after dispatch/abort;
it must not be described as complete A1 or native success. Result-card unit tests
and unchanged legacy delivery tests are supporting evidence only.

Actual `xclaude` / `xcodex` provider trials, live cmux and GitHub publication were
not run. No installation, update, merge or deployment occurred. Keep the delivery
in progress until the remaining contract and native evidence are resolved.


Inspected conversation captures (scripted fixture only):
[desktop at 1440px](evidence/ccs-goals/conversation-desktop.png) and
[phone at 390px](evidence/ccs-goals/conversation-phone.png).


## Worker checks and bounded repair checkpoint — 2026-10-12

Implementation in progress, following the conversation foundation:

- Version-2 implementers/integrators can checkpoint through the existing commit
  tool and run a named approved check in their owned checkout. The tool accepts
  no argv, uses existing dependency/environment policy and retains bounded output.
- Durable operation receipts make exact retries idempotent. Active check ownership
  fences commits and candidate submission. Abort cancels the physical check;
  verification cleanup never removes a worker checkout. Worker receipts cannot
  satisfy independent final verification, even for the same commit.
- Each attempt has three runs per check and at most two unchanged failures.
  Exhaustion holds the goal and requests worker termination. Preparation and
  nonordinary process failures request attention on the first failed run.
- Ordinary, proven-stopped final check failures can admit an integrator repair
  within the existing persisted final repair budget. Mixed current review/check
  findings can repair together. Legacy goals, unknown ownership, setup failures,
  pending results, stale receipts and exhausted budgets retain their holds.
- Dependency preparation participates in uncertain-process reconciliation; an
  unknown preparation process cannot be declared stopped just because the main
  check never launched.

Targeted evidence: 29 worker/verification tests passed before adding automatic
final-check repair, and typecheck passed. The expanded recovery suite initially
had one fixture failure: its synthetic review omitted the owning attempt ID;
adding the required identity made all 19 recovery cases pass. The additional
three-checkpoint test exposed a real receipt race: the budget hold could stop
the worker before its final poll. Exact owned check receipts now use historical
credential binding, preserving reads after stop without mutation authority;
explicit revocation, terminal goals and cross-attempt access remain denied.
All five worker integration cases then passed.

Full `npm run verify` passed on the final code: backend 1,079 passed, one
intentional skip, 97.43% line coverage; UI 208 passed, 94.84% line coverage;
lint, types and build passed, with the same two existing settings navigation
warnings. The preceding broad run failed only on the receipt race above; it
was investigated and fixed before the successful rerun. No threshold changed.
The follow-up conversation Cypress run exposed an Abort version race with
supervisor commits (HTTP 409). Abort now shares the bounded definitive-conflict
retry of Pause/Resume; uncertain requests keep their original envelope and
approval is never rebased. A new UI regression covers that race. Follow-up UI
coverage passed 209 tests at 94.84% lines, lint and types passed, and the Chrome
conversation journey passed at desktop/phone widths. The harness closed its
owned service, frontend and disposable resources. This journey still stops at
dispatch/abort and does not cover worker-check rendering or full delivery; those
remain part of the next browser-fixture extension. Native provider evidence is
still outstanding. Full verification preceded only this UI Abort fix; follow-up
build validation passed.


## Result delivery and real CCS preview — 2026-10-12

The scripted conversation now reaches independently reviewed, verified results,
shows worker check failure/fix receipts and a bounded exact-head Git diff, and
publishes to the fake GitHub adapter only after explicit approval. Chrome Cypress
passed the complete 41-second journey. Inspected result captures at
[1440px](evidence/ccs-goals/conversation-result-desktop.png) and
[390px](evidence/ccs-goals/conversation-result-phone.png); the result, diff and
publication action remain within the conversation column. This supersedes the
previous dispatch-only fixture limitation, but proves no native delivery.

Full `npm run verify` passed: 1,086 backend tests, one intentional skip,
97.17% backend line coverage; 212 UI tests, 94.87% UI line coverage; lint,
typecheck and build passed. The first broad run failed on the old goal-creation
notice assertion; corrected it to match the startup-status wording. The bridge
loading follow-up below was added during verification and separately passed all
10 native-launch/capability regressions. No coverage threshold was changed.

User authorized an isolated clone and recreation of their mobile Sessions Explorer
goal using copied local configuration. Production owns the original repository,
so the preview uses its own clone, journal, token and worktrees. Production
ownership was preserved. Failed pre-preparation goals no longer prevent reopening
the preview; retries still require repository ownership.

Actual xclaude resolves through CCS 8.10.0 to Claude 2.1.296, displaying Fable 5.1.
The native metadata resolver now skips recognized cmux decoration shims and pins
the actual CLI while preserving CCS as launcher. New conversational goals reject
direct-provider execution. Installed Codex 0.162.1 remains unsupported/unverified.

Live interventions: accepted the trust prompt only for this authorized isolated
worktree. Claude initially began without companion tools because MCP loading was
asynchronous. Interrupted that investigation, confirmed the bridge independently
returned its four supervisor tools, then asked the same session to check again.
The tools became available; get_status delivered the saved user message and the
same CCS session resumed investigation. Added `alwaysLoad: true` to the explicit
companion MCP configuration so future sessions await bridge startup, with a
regression assertion. A fresh native launch proving that correction remains
unverified. Workspace trust still needs a visible product startup decision.

This is real launcher/model activity, not successful native plan approval or
worker delivery. The five representative native goals, Codex compatibility,
process-level conversation restart, waiting/capacity behavior, failed-launch
recovery and policy disclosure remain incomplete. No live PR publication, merge,
installation or deployment occurred.


## Single-implementer proposals — 2026-10-12

Conversational supervisors can now propose one `implementation` (title, prompt
and owned areas) without manufacturing tasks or waves. The service normalizes it
before persistence/approval into one scoped task with all criteria and all
checks. Explicit independent task graphs remain supported; mixed forms and
unsafe paths fail validation. The MCP tool advertises both exact proposal forms.

Passed: 15 conversation/real-Git worker-check cases and three supervisor MCP/API
cases, including exact receipt replay, approval gating, revision invalidation,
legacy rejection and the complete worker failing-check repair using the simple
form. The Chrome conversation delivery journey passed in 43 seconds and cleaned
up its disposable resources. Broad verification passed 1,088 backend tests
(one intentional skip; 97.02% lines) and 212 UI tests (94.87% lines), then failed
lint on an unused fixture variable. Removed that variable; follow-up lint,
typecheck and build passed, with the two existing navigation warnings. The MCP
schema addition was separately exercised by the supervisor bridge tests after
the broad backend run. No coverage threshold changed.

## Native display and decision queue correction — 2026-10-12

The user's screenshots exposed two independent defects. Interactive launch
configuration omitted terminal display capabilities, and the detached provider
group did not receive terminal resize signals. The native terminal worker now
inherits only bounded display values (TERM, COLORTERM, TERM_PROGRAM/version and
color preferences) from its actual cmux host and forwards SIGWINCH to its owned
provider group. Executable paths, credentials and authority remain pinned.
Real-PTY regression proves color propagation and resize receipt without stopping
the provider. Applied one SIGWINCH to the observed live CCS group: its rendered
separator expanded from 99 to 156 columns. The running session was not restarted;
its initial monochrome environment cannot be replaced in place. Fresh native
color rendering remains to be inspected.

The two same-titled rows were the preserved original startup failure and the
new isolated goal, not duplicate launches. Independent plan review was incorrectly
classified as a user decision. It now appears as Plan review in the fleet/Running
filter and enters Needs You when review permits approval. Actual failure/ownership
holds still take priority, and startup errors precede misleading missing-profile
messages. No goal history was deleted or aborted for display cleanup.

Passed: all 15 native-terminal cases; eight Mission Control UI cases; eight
Mission Control Cypress cases, including pending-review/approval transitions at
1440px and 390px; and the goal-workspace Cypress journey. Its initial run failed
on an existing four-navigation-link assertion; corrected it to the actual five
links and reran successfully. Full `npm run verify` then passed: 1,090 backend
tests, one intentional skip, 97.42% backend lines; 213 UI tests, 94.87% UI lines;
lint, typecheck and build passed with the same two existing navigation warnings.
The five native-goal success measure and other recorded acceptance gaps remain
open; these fixes do not establish full native delivery.

## Process-level conversation recovery — 2026-10-12

Added a child-process regression against one persistent disposable SQLite journal.
The service is killed with SIGKILL after committing a queued steering message,
with a saved question/answer, proposal, exact-revision approval, paused supervisor
and pending worker launch. Two new service processes restore the unchanged goal,
replay the lost-response command without duplicate input and preserve the original
supervisor/native conversation identity. After resume, the service observes the
supervisor in that process before admitting exactly one worker; the same
supervisor acknowledges and answers the queued message. Another restart creates
neither a new supervisor nor a duplicate worker.

A separate case returns unknown supervisor ownership on restart and proves that
queued input is retained, the goal is held and pending work is not launched.
These tests use a persistent fake provider inventory outside the journal; they
prove process-level service recovery (A10), not actual CCS resume or idle-tool
compatibility. No installed service was restarted. Both new cases and the
existing process recovery/supervisor bridge suite passed (17 total), and lint
passed with the same two navigation warnings. The final strengthened observation
ordering assertion also passed both new cases. This follow-up changes tests and
reporting only; the preceding full verification remains the application-code
baseline.

## CCS admission and managed-policy disclosure — 2026-10-12

Settings validation now distinguishes a supported direct command (original Goals
only) from a CCS-backed command eligible for conversational Goals. The setup form
and additional profile validation explain read-only planning/review, approved-path
worker edits, service-run checks, managed hooks/MCP configuration and discarded
permission bypass flags. Alias resolution records the same policy text alongside
the frozen requested/resolved invocation and discarded flags.

Before admitting a conversational goal, settings composition requires a ready
CCS/CCSXP-backed profile for every role. Ineligible direct profiles cannot be
selected for later workers. Failure preserves the browser draft and creates no
goal snapshot, repository ownership claim or worker. The original experience
retains its direct-provider contract. Specific installation failures are retained
instead of being mislabeled as routing failures. Existing active goals retain
their recorded snapshots; the running native preview was not restarted.

Passed: 29 targeted settings/resolver/capability tests and 21 settings UI tests;
full `npm run verify` passed 1,094 backend tests, one intentional skip, 97.53%
backend lines; 214 UI tests, 94.88% UI lines; lint, types and build passed with the
two existing navigation warnings. The subsequent diagnostic-preservation predicate
passed all 18 settings-runtime cases and its strengthened admission regression.
Chrome provider-terminal validation passed; all five Settings browser cases passed
at phone/desktop widths after opening the existing collapsed account Details
control before asserting its message. The initial Settings run failed on that
hidden-message assertion. The initial admission test omitted an await on fixture
settings persistence; corrected it before the successful checks.

This closes direct-command admission and policy disclosure gaps, not native
compatibility or account identity validation. Codex 0.162.1 support, long native
wait behavior/capacity, bounded failed-launch recovery and intervention-free
representative native delivery remain outstanding.

## Autonomous supervision: responsive idle transport — 2026-10-12

The user clarified that the acceptance target is the autonomous end-to-end Goals
process with minimal human intervention, not implementation of the example goal.
The existing native MCP stdin loop awaited `wait_for_input` before reading its
next frame. While waiting for a goal event, it could not answer client pings,
status requests or cancellation notifications. This is a concrete control-channel
stall independent of the user approval gates.

The transport now keeps at most one idle wait in flight while processing other
requests serially. Duplicate waits are refused; matching MCP cancellation and
stdin closure abort the wait, including its authenticated HTTP request and timer.
Cancelled calls emit no late reply. Response sizes and output drain deadlines
remain enforced, with at most two responses in flight. The change does not start
agents, change persisted authorization, or remove human plan/publication approval.

Regression evidence covers ping and status responses during an active idle wait,
duplicate rejection, cancellation identity, a subsequent wake response, input
closure, and cancellation of an actual in-flight loopback HTTP request. The
scripted real-service browser delivery journey passed (41 seconds). This is not
proof of indefinite native client tool-timeout compatibility or shared capacity;
those acceptance gaps remain open. The user's existing CCS session was not
restarted and no further paid native goal was launched.

Checks: full `npm run verify` passed with 1,097 backend tests and one intentional
skip (97.58% lines), 214 UI tests (94.88% lines), lint, typecheck and build; existing
navigation warnings remain. The initial targeted typecheck caught missing JSDoc
and unsafe access to unknown request parameters; corrected both before full
verification. All six supervisor-bridge regressions and the existing MCP output
backpressure regressions passed. No coverage thresholds were changed.

## Autonomous supervision: shared capacity admission — 2026-10-12

Conversational supervisors now share global and per-goal execution admission with
background workers. Recording an idle wait releases a persisted capacity
reservation without releasing physical process ownership. A queued wake does not
itself reserve another slot: the agent transport atomically requests supervisor
activation before returning new input to the model. Capacity contention stays
inside that same wait call. Unknown/pending ownership counts conservatively;
replacement supervisors start with capacity reserved. Legacy planners retain their
original separate planner pool, and the planner session limit still bounds idle
native sessions.

The saved reservation survives reopening the SQLite journal. Service admission
also checks ordinary supervisor commands after an idle release, so skipping the
activation command cannot bypass the shared limit. Existing pairing, scoped
agent authority, exact command receipts, and human approval boundaries apply.
The conversation displays a queued supervisor as waiting for execution capacity
with no action needed, rather than incorrectly claiming it is working.

Passed: 92 targeted scheduler/conversation/bridge tests, including global=1 and
perGoal=1 dispatch, unknown-worker retention, supervisor reactivation, and legacy
coexistence. A fake-clock test holds one idle tool call through five seconds of
capacity contention, then verifies that uncertain activation delivery retries
its exact command envelope. The first fake-clock run failed because a previously
captured timer function bypassed Node's clock mock; changed timer access to the
module property, added cancellation cleanup, and terminated only that identified
stuck test process before rerunning successfully. Real-service API coverage also
checks idle release and activation through the authenticated bridge.

Full `npm run verify` passed: 1,100 backend tests plus one intentional skip,
97.29% backend lines, lint, typecheck and build. Its 214-test UI pass preceded the
new capacity status assertion; the final UI coverage run passed 215 tests at
94.88% lines. The real-service Cypress conversation delivery journey passed in
41 seconds. The new capacity label is directly covered by the UI test; the
scripted browser journey does not force capacity contention. Existing navigation
warnings remain; no thresholds changed. Native CCS idle-timeout compatibility
and intervention-free end-to-end trials remain unverified; no live service or
supervisor was restarted to load this change.

## Autonomous supervision: bounded pre-process launch recovery — 2026-10-12

Native spawn errors previously lost their OS classification. A background worker
could retain unknown ownership even when Node proved no provider PID existed;
observation of a stopped terminal could become a generic cancelled attempt. The
native drivers now preserve a sanitized, explicitly pre-process failure code only
when spawn failed before assigning a provider PID. Errors after process startup,
identity persistence failures, and uncertain descendants do not gain that proof.

Conversational goals admit one automatic replacement for a proven transient OS
spawn error (EAGAIN, EMFILE, ENFILE or ENOMEM), keyed by saved generation, revision,
role, task and target. The failed attempt, code, budget and retry decision remain
in the journal. A second failure exhausts the budget and produces a visible
conversation decision/hold. Permission errors, missing executables, unknown
ownership, pending results, existing holds and legacy goals do not automatically
retry. A spawn that never reached provider execution does not consume a code
repair budget. Replacement launches retain the approved scope and use new durable
operation identities; normal capacity admission still applies. Needs You excludes
an already-authorized automatic retry but includes exhaustion and real blockers.

Passed targeted evidence: 51 process/native-background/reconciler tests, 76
scheduler tests and 16 native-terminal PTY tests. Actual missing-executable tests
prove stopped classification through both native drivers without exposing paths
or command errors. Scheduler tests cover one successful replacement, exhaustion
surviving scheduler restart, permission/configuration/unknown-owner exclusions,
legacy behavior and approved worker retry. The browser delivery journey now
injects one transient implementer spawn failure before any script runs, observes
exactly one replacement and its budget message, then completes worker checks,
repair, independent review, final verification and human-approved fake
publication (42 seconds). This is scripted fault injection, not an additional
paid native CCS trial.

Full `npm run verify` passed: 1,109 backend tests plus one intentional skip
(97.58% lines), 216 UI tests (94.88% lines), lint, types and build. The same two
settings-navigation warnings remain. No coverage thresholds changed. No live
preview restart, installed-state change or native provider execution was needed.

## Native idle acceptance failure and transport direction — 2026-10-12

Read-only inspection of the already-authorized isolated CCS trial establishes a
native failure that the scripted wait tests cannot prove away. Claude 2.1.296
backgrounded each pending MCP call after 120 seconds. The earlier waits completed
on real review events, so those subsequent turns were legitimate. The final wait
started at 11:06:38 UTC with the accepted plan awaiting user approval; at
11:36:43 UTC the supervisor reported that the client had timed it out after
30 minutes without a goal event. It issued get_status, which then also became a
background task after 120 seconds. The old serial MCP process was still occupied
by the earlier wait. The owned CCS/provider process handles were still live;
none was restarted or terminated during this investigation.

The installed native binary's tool-timeout schema explicitly describes a hard
wall-clock limit that progress notifications cannot extend, and its call path
supplies a maximum total timeout. The recent cancellable/concurrent MCP fix
addresses the queued-status stall for future launches. It does not eliminate the
native timeout or the resulting unsolicited model turn. A12 is therefore not
satisfied by the fake-clock/service tests alone. Raising the deadline or sending
heartbeats would postpone this failure, not meet the idle contract.

The implementation direction is service-triggered structured native turns:
record idle state, finish the model turn, and submit new native input only after
an actionable saved event and capacity admission. Preserve the selected CCS
launcher, logical and native conversation IDs, scoped tools, visible owned cmux
workspace and exact wake receipts. Reconcile uncertain input delivery before
sending anything again. The approved specification already allows structured
native output and event-triggered waking; no approval gate or product requirement
is being removed. Launcher compatibility must establish the supported input and
resume protocol separately for both native clients before readiness is claimed.

Metadata-only `--help` on the pinned Claude 2.1.296 executable confirms
`--print`, `--input-format stream-json`, `--output-format stream-json`,
`--replay-user-messages`, `--session-id` and `--resume`; this is CLI evidence,
not proof of interactive turn continuity or selected account behavior. MCP task
capabilities were also inspected, but bundled SDK code alone does not prove that
the native tool path uses task execution. A request to the MCP documentation
website timed out; the versioned task specification was retrieved from its
GitHub source instead. No new native model run, user message, plan approval,
production change or secret output was needed for these observations.


## Event-triggered Claude supervisor turns — 2026-10-12

Implemented the service-triggered transport for new conversational Claude
supervisors through the selected CCS launcher. The owned cmux runner keeps the
logical/native conversation and resumes the same native session for saved events.
It waits without a provider process between turns, eliminating the dependency on
a native MCP call surviving an indefinite idle period. Capacity is released only
after the provider group is observed stopped; pause, uncertain command delivery
and service downtime do not themselves produce model calls. A bounded hung turn
is stopped and surfaces a specific hold rather than an unbounded retry. The
managed permission behavior is disclosed. Legacy and Codex transport is unchanged.

Passed process/API/PTY fixture evidence: two turns preserve one native session
and workspace, idle and pause cause no provider launches, manual resume is refused,
and a third hung turn reaches the service as SUPERVISOR_TURN_TIMEOUT. Protocol
tests preserve Unicode, suppress private tool frames, require a matching final
session result, and accept only CCS's exact initial CLIProxy preamble. Arbitrary
diagnostics and repeated/midstream preambles remain failures.

Full npm run verify passed before the final preamble compatibility addition:
1,113 backend tests passed, one intentional skip, 97.60% backend lines; 216 UI
tests passed, 94.88% UI lines; lint, types and build passed. Earlier lint and
type failures were corrected (control-character regex and optional conversation
access). After the preamble addition, all 21 native-terminal/protocol tests and
lint passed; git diff --check passed. No coverage threshold was changed.
The scripted real-service browser conversation/retry/delivery journey passed
in 40 seconds. Cypress exercises scripted supervisors; the real process/API/PTY
fixture exercises the new native transport with a fake executable.

Unverified: actual CCS print/resume with the selected account, long native idle
and wake-up, and native end-to-end completion without intervention. Codex still
requires a supported resumable-turn implementation. These checks do not establish
A2 or the five-goal native success measure. The existing preview and installed
production were not restarted or changed, and no additional paid trial was run.


## Codex event-triggered supervisor turns — 2026-10-12

Codex conversational supervisors now use persisted exec/JSON turns through the
selected CCS profile or ccsxp launcher. Subsequent turns use explicit session-ID
resume, never latest-session selection. The runner retains the owned terminal
and operation, releases capacity only after observed provider termination, and
waits without a provider process. The stream must contain one native thread and
a successful turn completion matching the SessionStart hook's saved identity.
Hook receipt validation occurs at completion to avoid racing thread creation.
Private tool output is not displayed as assistant prose. Failed, incomplete or
wrong-session streams cannot release the turn as successful.

The Codex adapter now retains supervisor metadata (previously discarded when
converting Claude preparation into Codex inputs), disables interactive approvals
for managed turns, and preserves scoped hooks, files and bridge configuration.
Legacy interactive goals keep their existing behavior. Both launchers share
the service-controlled idle/wake and bounded timeout machinery.

Metadata evidence: the installed Codex 0.162.1 --version, --help, exec --help and
exec resume --help expose the required flags and explicit session resume. The
capability probe now accepts 0.162.1 and checks exec/resume JSON support for both
recognized Codex versions. The installed ccsxp/CCS 8.10.0 metadata probe passed;
this is not a paid model run or proof of selected account identity.

The official [non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
describes JSONL turn events and explicit exec session resume. Generated managed
configuration passed the current official
[configuration schema](https://developers.openai.com/codex/config-schema.json).
The installed CLI loaded that configuration in an isolated, account-free
features-list metadata invocation. Its effective metadata reports hooks enabled,
shell_tool/apps/multi_agent/computer_use/remote_plugin/memories/code_mode disabled,
but unified_exec and code_mode_host enabled despite the former's explicit false
setting. Scoped hook denial and read-only sandbox remain configured; metadata
alone does not establish actual enforcement. Native policy validation remains
required. The schema is current official evidence, not a version-pinned runtime
execution test.

Interventions/failures retained: the first metadata fixture and one new test
used a non-UUID conversation ID and were corrected. Strict config is not supported
by the features metadata subcommand, so it was not represented as a successful
strict-runtime test. The schema validator initially rejected Rust numeric format
names; explicit numeric validators were added to the disposable validation script.
No project dependencies were added. The first browser command omitted the
orchestration fixture flag and skipped its sole test; the corrected command
ran and passed the journey in 40 seconds with owned-resource cleanup.

Passed: 40 targeted native capability/input, process/API/PTY and protocol tests;
the additional delayed SessionStart receipt assertion also passed. The Codex
process fixture covers two turns with the same native session, no idle/paused
provider launches, one terminal and runner, and a hung third turn producing an
exact service timeout hold. Profile and model argv, managed approval policy,
private configuration and preparation idempotency have regression coverage.
The first full verification also exposed a stale CCSXP metadata fixture after
the new resume capability probe; its advertised help was updated to include the
required JSON/resume contract, and all four provider-command tests passed.
Final npm run verify passed: 1,118 backend tests passed with one intentional
skip and 97.61% lines; 216 UI tests passed with 94.88% lines; lint (two existing
settings-navigation warnings), types and build passed. No thresholds changed.

Still unverified: actual xclaude/xcodex model runs with the selected routing and
account, tool enforcement, native resume/long idle and the five-goal success
measure. Existing previews were not restarted and production state was not
changed. The user has authorized merging the implementation to main once fixed;
required full-contract verification and review still precede that merge.

Merge-gate inspection of pushed head e7c49788: macos and verify checks passed,
but CodeQL reports nine alerts (two high, seven medium), and SonarCloud reports
two reliability issues (an implicit button type and a fixture authority default).
CodeRabbit's green status explicitly says review skipped because the PR is a
draft; there is no approval. These findings must be investigated/resolved before
merge. They are not replaced by local deterministic verification.


## Review findings follow-up — 2026-10-12

Changed revision authorization to an explicit action-to-authority mapping.
Supervisor identity, planner role and running ownership are still enforced
before command dispatch; neither user/system impersonation nor a different
attempt can use supervisor revision. Added invalid-credential throttling to the
check-receipt route (60 failures per address per minute); authenticated polling
does not consume the failure budget, and expiration restores access. Wake values
are checked as positive integers before becoming native receipt/recipe IDs.
Linux script-command paths are now individually shell-quoted. The conversation
send button explicitly submits its form, and the restart fixture no longer uses
an object literal as a parameter default.

Validation: the targeted API/conversation/restart/native-terminal/worker-check
run passed 47 tests and exposed one incorrect assertion: an unknown attempt is
rejected as STALE_ATTEMPT, not FORBIDDEN. After correcting that assertion, all
10 conversation tests passed. Four conversation UI tests, lint (the same two
existing warnings), types and diff checking passed. The Linux-specific script
branch was inspected but is not exercised by the macOS PTY tests. Full npm run
verify then passed: 1,119 backend tests plus one intentional skip (97.61% lines), 216 UI tests (94.88% lines), lint, types and build.
Fresh CodeQL/Sonar analysis is still pending for these edits.

The remaining file/network alerts require review of their actual trust paths:
Companion's scoped bridge deliberately exchanges persisted context and receipts
with its authenticated loopback service, and the owned runner deliberately writes
receipts/launch recipes. No alert has been dismissed or excluded; native policy
and end-to-end acceptance remain separate outstanding evidence.


## Linux CI and receipt race follow-up — 2026-10-12

Fresh CI at 51f43d20 passed macos but failed verify: the check-cancellation
fixture waited for command resolution, then edited a tracked file before the
verification subprocess necessarily started. Linux detected the dirty checkout
and revoked the worker before the intended commit-fence assertion. The fixture
now waits for an explicit marker written by the actual supervised check process
and requests a commit without first changing its checked files. This preserves
the OWNERSHIP_UNCERTAIN assertion and subsequent abort/termination evidence; it
does not accept the unrelated FORBIDDEN response as success.

Fresh CodeQL removed the revision-authority alert but identified a receipt
lstat/read race. Codex session receipts now open with O_NOFOLLOW, inspect the
opened descriptor with fstat, and read that same descriptor before closing it.
The PTY relay was moved into a fixed argv-only shell helper. Attempting to remove
the relay failed reproducibly because macOS script rejects Node's stdin socket;
that experimental run was interrupted, the direct-spawn change was discarded,
and all 18 PTY tests passed with the fixed helper.

Passed: 23 worker-check/native-terminal tests for the process barrier and receipt
fix, all 18 terminal tests with the final relay, 24 bridge/managed-launcher/API
boundary tests, types and lint (existing warnings). A new two-server loopback
regression proves that status, references, result submission and check polling
never relay their credential or persisted input to an HTTP redirect target.
Full CI and fresh security analysis still need to validate this new head.

CodeQL's remaining file-to-HTTP and HTTP-to-file traces describe the scoped
loopback bridge and owned receipt/recipe persistence; their endpoint, redirect,
identity, path and argv boundaries are under explicit review. The manual
invalid-credential rate limiter passes exhaustion/expiration tests but remains
unrecognized by the static query. No security alert has been dismissed.

## Explicit supervisor selection — 2026-10-12

The new-goal composer now lists configured supervisor profiles and their CCS
readiness before creation. Paired reads share a 30-second settings-revision cache;
explicit refresh bypasses it. Creation always probes again, validates the selected
profile, and saves it as the manual planner assignment and primary launch
snapshot. It cannot silently select another provider when the requested profile
is unavailable. Worker/reviewer preferences remain unchanged. Fixed production
and disposable compositions expose choices from the same team configuration used
for admission.

Passed: 19 settings-runtime tests, including authenticated/coalesced readiness,
forced refresh, settings revision invalidation, unavailable-selection rejection,
selected CCS routing and idempotent replay; 33 UI tests; real-service conversational
Cypress journey with explicit Codex selection through revised approval, transient
launch recovery, worker checks, independent review and fixture publication.
Desktop/phone conversation screenshots inspected: content and controls fit both
widths. The first two new UI tests failed because this suite does not install
jest-dom matchers; assertions were corrected to native DOM properties and passed.
Full verification of this change is recorded separately once complete.

CI for preceding commit 7457d618 passed macos and verify. CodeQL still reports
seven findings: four scoped file-to-loopback transports, two response-to-owned-file
persistence paths, and the manually rate-limited check receipt route. The earlier
receipt race and PTY shell findings are absent from fresh annotations. None of
the remaining findings has been dismissed or excluded. CodeRabbit continues to
skip the draft PR; that status is not approval.

No additional native provider trial, installed preview restart or production
change was made. Five bounded native acceptance goals remain awaiting the
previously requested authorization; scripted browser success does not establish
actual CCS routing or native permission enforcement. Merge is authorized by the
user but remains gated on native acceptance and completed review/security checks.

Verification outcome: full backend coverage passed (1,121 passed, one intentional
skip; 97.38% lines), full UI coverage passed (218 tests; 94.95% lines). The verify
command then stopped at a synchronous-effect-state lint error in the new picker.
Loading/error reset now occurs in the refresh event handler; lint subsequently
passed with the two pre-existing settings-navigation warnings, types and build
passed, and both picker tests passed again. No coverage threshold was changed.

## CodeQL trust-path review — 2026-10-12

Reviewed all code flows in CodeQL analysis 1936281706 (PR merge tree
54f86b66a8b56c1e2412293069ba714ea5c4ac49), against current source 216eb90a.
The seven remaining traces have the following dispositions; no query or source
path is excluded from scanning.

| Alerts | Observed source and sink | Boundary and disposition |
| --- | --- | --- |
| 88, 89, 90, 104 | Private bridge configuration's credential enters the Authorization header of POST/status/check/reference requests. | Intentional scoped authentication. createBridge rejects anything except literal HTTP 127.0.0.1 without URL userinfo; paths are service-owned and fetch uses redirect:error. The two-server redirect regression proves credentials/body never reach the redirect target. These traces do not show arbitrary local file upload or an external destination. False positive for exfiltration. |
| 106 | HTTP status response's conversation.wake enters runId, then the generated CCS shim text. | integer(wake, 1) requires a positive safe integer; prepareCcsLaunch additionally validates runId as an identifier. The service-owned private directory and fixed filename prefix bound the path. Shell operands are quoted, native executable and arguments are pinned, and the recipe is exclusive, immutable and digest checked. False positive for untrusted executable content/path injection. |
| 107 | HTTP error code or validated runId enters JSON.stringify(value) written as a private receipt. | Receipt names are hard-coded call-site constants; response data is JSON content, never a filename or executable. Temporary files use exclusive creation and mode 0600, followed by rename into the same owned directory. Persisting service results is intentional. False positive for arbitrary file write. |
| 108 | receiptAuthority runs in the check-poll route. | A custom per-address window rejects further authentication attempts after 60 invalid credentials in 60 seconds, before receiptAuthority. The API regression proves exhaustion, 429 and expiry. Valid scoped worker polling does not consume the guessing budget. The static rule does not model this limiter. False positive for missing authentication throttling; not a claim that all authenticated traffic is rate-limited. |

The former session-receipt TOCTOU and PTY shell findings (109 and 105) are
reported fixed by GitHub, rather than dismissed. This trust-path review does not
establish native policy enforcement or actual CCS account routing; A2 and the
five native-goal success measure remain unverified.

Applied these seven individual false-positive dispositions to GitHub alerts
88, 89, 90, 104, 106, 107 and 108, with a boundary-specific reason and this review
reference on each alert. GitHub confirmed state=dismissed for each. The first
request was rejected because its comment exceeded GitHub's 280-character limit;
shortened comments were then accepted. No scan configuration or query changed.
