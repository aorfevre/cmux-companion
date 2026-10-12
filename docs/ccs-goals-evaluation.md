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
