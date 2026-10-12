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
