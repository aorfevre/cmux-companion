# Session KPIs and agent allocation review

Reviewed 2026-09-07 against origin/main `3a0518a`, in the separate worktree
`cmux-companion-session-capacity`, branch `feature/session-capacity`.
The initial review covered source, deterministic verification and a concrete
proposal. The implementation below follows the user’s subsequent instruction.
Installed configuration and live sessions remain unchanged.

## Implementation: first delivery

The first product increment implements visible weekly reset opportunities (within
24 hours, at least 20% remaining), account-grouped windows, upstream observation
age, and navigation to full account usage. Opportunities expire from the screen
when their reset passes and are hidden after a failed refresh. Stale data remains
labelled rather than silently appearing current. Quota remains account-level;
no session-to-account mapping is invented.

A shared policy now excludes paused/reconnect accounts from provider scores,
respects provider fetch availability and all reported core usage windows, and
separates unknown telemetry from known blocks. Automatic task assignment refuses
an all-blocked set. The existing unknown-telemetry fallback remains available,
explicitly labelled unverified, and cannot select a known-blocked provider.
Saved legacy tasks refresh the usage snapshot before worktree creation; all
relaunch modes check before closing an existing session or mutating its worktree.
They preserve the saved provider instead of silently switching it.

No storage migration or new background service was needed. Existing polling and
AccountUsage caching remain; launch/relaunch asks for a refreshed snapshot. The
API uses the existing authenticated capacity route. No credentials, wrapper
configuration, installed services or live sessions were changed.

Reset urgency does **not** yet change automatic routing: per-invocation account
affinity is unverified. Durable reservations, cross-goal rotation, usage history,
model-specific bucket selection and automatic engine selection for new managed
goal conversations remain separate work. Existing goal conversations retain
their selected engine. Current recommendations use reported capacity, including
observations labelled stale; freshness is not yet an allocation eligibility gate.

The findings below describe the reviewed baseline; the items above identify
which parts are now implemented.

## Recommendation

Make **unused weekly capacity resetting soon** visible on the main dashboard,
with account identity, short-window headroom and data freshness. Use the same
information for automatic selection, but first make selection correspond to
the account and workflow actually launched. An account quota is shared by its
sessions; it is not a separate allowance for each workspace.

Illustrative card (synthetic data, not a reading of your accounts):

> Weekly reset soon · Claude / Work account  
> 60% weekly capacity remaining · resets in 3h  
> 45% short-window capacity remaining · checked 1m ago  
> Available for new work; account selection by the launcher is not yet verified.

This indicates an opportunity. It does not predict that all 60% will go unused,
or suggest creating unnecessary work just to consume quota.

## Findings

| Priority | Finding and consequence | Source |
| --- | --- | --- |
| High | Reset dates never enter allocation. Claude with 60% remaining and a reset in 3h loses every task to Codex at 90% resetting in 6 days. | `server/worktree-planner.mjs:59` |
| High | The best account determines the provider score, but launch only supplies a provider/model to `xclaude` or `xcodex`. The measured account is not bound to the session. Optimizing the wrong account cannot guarantee better utilization. | `server/worktree-planner.mjs:83`, `:1076`; `server/cmux-client.mjs:252` |
| High | New managed goal sessions select the requested/default engine, then resume that engine's conversation. They do not call `assignAgents`. The dashboard's unconditional “takes the next task” is therefore too broad. | `server/goal-session-service.mjs:15`; `server/goal-session-runner.mjs:178` |
| High | When both providers are exhausted, the panel selects nobody but `assignAgents` falls back to Claude with “Account usage is unavailable”. Known exhaustion and unknown telemetry are conflated. | `server/worktree-planner.mjs:64`; `server/agent-capacity.mjs:25` |
| High | Paused accounts remain eligible because selection only checks status. Their `paused` flag is present in usage but lost in the capacity projection. | `server/account-usage.mjs:127`; `server/worktree-planner.mjs:94`; `server/agent-capacity.mjs:44` |
| Medium | Alternation is local to the task array. Independent one-task goals repeatedly select the same provider; no running-load or reservation input exists. | `server/worktree-planner.mjs:75` |
| Medium | Legacy task assignment happens when the planner returns ready; launches use the saved agent without reevaluating quota. A preview today is not necessarily the choice saved yesterday. | `server/worktree-planner.mjs:1166`, `:956`, `:1076` |
| Medium | The capacity panel is collapsed initially. Its expanded provider card flattens accounts' windows without their labels, making multiple weekly limits ambiguous. The sessions list has counts but no quota information. | `app/worktree-dashboard.tsx:294`, `:1002`; `app/page.tsx:192` |
| Medium | “Both exhausted” also labels missing/unavailable data. The capacity API drops observation timestamps; repeated UI polling cannot establish that upstream quota is fresh. | `app/worktree-dashboard.tsx:1042`; `server/agent-capacity.mjs:33`; `server/account-usage.mjs:73` |
| Medium | The earliest reset is not the earliest recovery: resetting a 5h window does not unblock an account whose weekly window is also empty. Past dates are not filtered. | `server/agent-capacity.mjs:104` |
| Medium | Claude's most restrictive weekly bucket is promoted regardless of the selected model. Daily/monthly windows are not included in allocation's deciding windows. Eligibility must consider limits applicable to the chosen workload. | `server/account-usage.mjs:340`; `server/worktree-planner.mjs:102` |

These are source-level findings. External wrapper account selection, live account
usage and visual rendering of the supplied Tailscale URL were not verified:
computer-use reported that no browser was available. The installed version may
differ from the reviewed main commit.

## Proposed dashboard

1. Keep session counts: working, needs attention, and inactive/finished, with
   clear state definitions and links to filtered sessions. Count workspaces and
   terminals separately. Preserve the existing goal board's supervision states.
2. Add a visible opportunity summary: number of accounts with a weekly reset
   within 24h and at least 20% remaining. These are proposed configurable policy
   defaults, not provider rules. Do not add percentages across unlike plans.
3. Group detail by provider **and account**: weekly remaining and reset countdown,
   short-window remaining, restrictive applicable limits, paused/reconnect state,
   and upstream observation age. Distinguish “unused capacity, currently blocked”
   from “available for new work”. Link to the full account-usage page.
4. Explain allocation by workflow: automatic task recommendation versus an
   explicitly selected goal-session engine. Say “recommended” until a launch is
   committed; then show the recorded choice and reason. Label an unmapped session
   “Account unknown”; never infer its account from the provider's best balance.
5. Separate exhausted, unavailable, stale, missing reset and reconnect states.
   After a reset passes, refresh the observation; do not manufacture 100% quota.

Defer burn-rate and “projected unused at reset” until timestamped usage history
exists. A single snapshot cannot measure either. Quota can also be consumed by
sessions outside Companion, so any future forecast needs a confidence label.

## Proposed allocation policy

**Eligibility before optimization.** Respect explicit provider/model choices,
paused state, authentication, provider availability and every applicable limit.
Use a freshness threshold tied to actual upstream timestamps (initial proposal:
2 minutes); absent/stale data is unknown, not exhausted. Retain the existing >5%
floor as an initial reserve, and surface that it is a policy threshold.

**Prefer usable quota that resets soon.** Among eligible automatic candidates,
prefer accounts meeting the 24h/20% opportunity rule, earliest reset first; break
ties by usable headroom, fewer active reservations, then stable account ID.
Otherwise use usable headroom with fair rotation inside the existing 10-point
band. Percentages represent each account's own allowance, not equal compute
across providers. Do not let urgency override short-window exhaustion or explicit
model compatibility. Test the thresholds against observed workloads before
claiming they maximize utilization.

**Make the decision executable.** Verify a supported per-invocation account
selection mechanism in the wrappers/CCS before enabling account-based routing.
Do not switch global/default credentials to route a task. Until that mechanism
is proven, show account opportunities and label automatic selection as a
provider recommendation with unverified account routing.

**Decide at dispatch.** Reevaluate newly launched automatic tasks and reserve the
chosen candidate atomically, including concurrent goals and restarts. Persist
account reference, provider/model, reason, observation timestamp, policy version
and reservation lifecycle. Release reservations on failure/completion and
reconcile abandoned ones. Running sessions keep their account and conversation;
do not migrate them across providers when a quota reset approaches. A resumed
goal conversation retains its engine. Add any new “Auto” option only for a new
conversation, while preserving explicit choices.

**Handle no candidate honestly.** Known exhaustion waits for a relevant reset;
missing telemetry uses an explicit, visible fallback policy, not the same path.
Expose the difference between next reset and estimated eligibility recovery.
Retry from fresh evidence with bounded backoff rather than blindly relaunching.

## Boundaries and implementation sequence

| Boundary | Required work |
| --- | --- |
| UI | Visible opportunity cards, grouped account windows, accurate workflow copy, timestamps, empty/error states and mobile layout. |
| API/pure policy | Shared eligibility and recommendation module used by capacity preview and dispatch; structured reasons instead of duplicated UI policy. Preserve authenticated same-origin reads. |
| Storage | No schema needed for the initial snapshot display. Durable decisions/reservations and usage history are separate follow-ups, with migrations and restart recovery. |
| Background | Existing dashboard polls every 10s while visible; AccountUsage caches for 60s. Add reset-aware refresh and reservation reconciliation without starting work simply to consume quota. |
| External | Verify wrapper/CCS account affinity and provider-specific limits through separately authorized controlled integration tests; preserve argv allow-lists and loopback boundaries. |

Recommended bounded first product change: account-grouped weekly opportunities,
observation age, and truthful recommendation/exhaustion copy, with shared pure
opportunity derivation. Next, fix eligibility/fallback correctness. Finally enable
reset-aware dispatch after account affinity and durable reservations are proven.
No automatic live routing changes are part of this review.

## Verification and acceptance evidence

Passed on Node 22.23.1, after `npm ci` with the checked-in lockfile:

```
node --test tests/account-usage.test.mjs tests/agent-capacity.test.mjs \
  tests/worktree-planner.test.mjs tests/goal-session-service.test.mjs \
  tests/goal-session-runner.test.mjs
```

203 passed, 0 failed, 0 skipped. The tests establish the current implementation;
they do not establish that the allocation policy satisfies this proposal.

Read-only synthetic probes directly invoked `assignAgents` and `agentCapacity`:

| Probe | Observed result |
| --- | --- |
| Claude 60%, reset +3h; Codex 90%, reset +144h | Both tasks go to Codex. |
| Paused Claude 95%; Codex 40% | Both tasks go to paused-account-scored Claude. |
| Both accounts exhausted, 0% | Panel next=null; both tasks assigned Claude. |
| Claude 60%; Codex 58% | Two-task batch alternates; two separate one-task calls both select Claude. |

No failed checks. Full verify, UI/browser suites and live integrations were not
run for this documentation-only change. No browser was available for the live
URL. No installed processes, accounts, credentials or unrelated working changes
were modified. Missing-file exploratory searches were corrected using the
repository inventory; they were not test failures.

For implementation, add backend cases for fresh/stale/past/missing timestamps,
paused and unavailable accounts, multiple applicable windows, reset opportunity
versus short-window exhaustion, pinned engine choices, concurrent reservations,
restart recovery and launch failures. Add UI and deterministic Cypress coverage
for the opportunity on the collapsed dashboard, account labels, unknown versus
exhausted, refresh after reset, and narrow mobile layout. Run `npm run verify`
and `npm run test:e2e:local`; verify external account affinity separately before
making promises about which account receives work.

## Implementation verification

- `npm run verify` passed: 1,035 backend tests, 126 UI tests, lint, both type
  checks and production build. After the final countdown/readability adjustments,
  UI (126), lint, types and production build passed again.
- A subsequent recovery regression passed with all 45 tests in
  `tests/goal-recovery.test.mjs`, including the new check that blocked quota cannot
  close an existing session in any relaunch mode.
- The full deterministic Cypress suite passed: 98 tests across 20 specs. The
  standard runner initially refused occupied port 3221; an isolated frontend on
  localhost:3297 ran the same suite with `--config baseUrl=http://localhost:3297`.
  No existing port owner or installed companion was stopped.
- Final focused Cypress coverage passed all 15 tests at 390px, 1100px and
  1440px, checking mobile and desktop opportunity visibility,
  account grouping, paused/unknown states, quota refresh and account-usage
  navigation, plus panel bounds. Screenshots prompted larger quota labels and
  reset countdowns with explicit units rather than an ambiguous clock.
- Initial targeted assertions described the previous monthly-window policy and
  “next task” wording; they were updated to check the new behavior. Initial lint
  failures on native links were fixed by using the existing view-navigation
  callback. No test coverage was dropped and no unresolved check failures remain.

External account affinity, live provider usage and the installed dashboard were
not exercised. There is no merge, deployment or live automatic routing change.
The existing Sites configuration is build scaffolding; repository instructions
keep publishing separate from this PR.
