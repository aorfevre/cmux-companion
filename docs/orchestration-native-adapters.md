# Native orchestration adapters

The replacement has separate native background and interactive terminal adapters.
Production construction uses `probeNativeCapabilities`, then `createNativeAgents`
as the `createRuntime` agent factory. Configuration is explicit: state directory,
CCS and Claude executable paths, provider/model/effort, native environment, cmux
executable/environment and background limits. Constructors neither discover
credentials nor start workers. Installed source cutover is a separate T14 gate.

## Compatibility and authority

The initial reviewed CLI contracts are Claude Code **2.1.268** and CCS **8.9.0 or 8.10.0**.
The probe reads CCS package ownership/version metadata without invoking CCS
startup, and runs only native `--help` and `--version` with bounded output/time and
no inherited credentials. Required flags and the known hook/settings schema must
be supported. Other versions fail closed until their adapter contracts are reviewed.
This is compatibility evidence; it does not establish production permission
behavior or model quality.

The resolved Claude executable is pinned through `CCS_CLAUDE_PATH`. Entry binaries
and package metadata are checked again during input preparation and immediately
before provider startup in the independent supervisor. An updater symlink cannot
silently select another CLI. These checks cover the entry files and package
metadata, not integrity of every transitive dependency or a hostile local account.
Do not update the native installation while owned work is active.

All native roles use restricted tools, manual permissions, strict MCP configuration
and a deny-only hook. Reviewers have no write, shell, delegation or MCP tools;
planners can read, ask questions and submit proposals. Implementers/integrators
can edit and call the scoped server commit tool. Approval, scope expansion,
integration and publication remain service decisions. Context, hooks and credentials
live in private files outside the assigned worktree; no credential enters argv,
public events or browser projections.

Before launching a provider, its supervisor waits for the service to commit its
identity and confirm current scoped authority over loopback. Queued credentials
cannot read goal state or mutate it. Abort, replacement, repository removal and
lost scheduler ownership deny activation. A stopped or denied provider is never
accepted as successful evidence merely because its process exited.

## Interactive planning

Cmux creates a dedicated workspace and starts one fixed terminal runner using a
private configuration path. Creation and runner-send receipts precede effects;
operation, workspace and process birth/command identity are bound together.
Titles and Stop events never establish ownership or completion. Lost create/send
responses remain uncertain and cannot create another workspace automatically.

The provider inherits terminal stdin/stdout/stderr. A permission prompt or user
wait has no background idle or ceiling timer. Terminal interruption reaches the
owned provider group; explicit termination has a bounded grace/kill policy.
After native exit, the runner preserves the conversation in a paused state.
`resume_planner` is a paired-user, expected-version command for the current owned
attempt. Its durable intent uses a stable, bounded internal ID, and the runner
uses `--resume` with the same native conversation UUID. Replayed receipts never
start another conversation. Publishing/replacing the contract fences the old
planner generation; resuming it cannot restore revoked authority.

The paired-user terminal-opening endpoint focuses only the recorded current
planner workspace. Read-only interfaces, stale versions, missing ownership,
other attempts and aborted goals are denied.

## Termination and recovery limits

Stopped evidence proves termination of the **recorded owned process groups**.
It is not a claim of OS sandboxing or complete containment of arbitrary escaped
process trees. A provider that intentionally detaches task workers outside its
owned group is unsupported. Background execution additionally retains uncertainty
when escaped descendants keep its output pipes open. Persistent provider-wide
daemons are distinct external resources, not task worker slots.

Live acceptance must check this assumption for every enabled CCS provider flow.
An uncertain process identity or termination retains ownership and requires
reconciliation. Never signal an unverified replacement PID, use a workspace title
as identity, or delete private recovery evidence before confirmed termination.
Private context and adapter receipts are retained for T13's owned-resource cleanup.

## Offline evidence

`tests/orchestration-native-capabilities.test.mjs` verifies pinned metadata probes
and installation changes. Native-background tests use actual subprocesses and
service SIGKILL. Native-launch tests exercise the real service, SQLite, Git and
HTTP activation handshake. Native-terminal tests allocate a real PTY with the
system `script` utility and verify inherited I/O, user waits, same-conversation
resume, receipt replay and shutdown races. On macOS the fixture bridges Node's
socket-backed stdin through a real pipe because BSD `script` rejects the socket.
These tests do not use installed cmux, authenticated providers or real GitHub.

## Explicit opt-in live acceptance

Do not run live cases without separate task authorization. They exercise real
provider accounts and, for manual terminal cases, actual cmux workspaces.
Routine test discovery excludes `tests/orchestration-agents.live.mjs`.

For the automated reviewer case, create a private mode-0600 JSON file outside any
repository with `ccsBin`, `claudeBin`, `engine` (`provider`, `model`, optional
`effort`) and an explicitly selected `env`. Supply needed native authentication
through that private configuration; never commit it or include it in logs.
After authorization, the operator runs:

```sh
CMUX_ORCHESTRATION_LIVE=1 \
CMUX_ORCHESTRATION_LIVE_CONFIG=/absolute/private/native-live.json \
node --test tests/orchestration-agents.live.mjs
```

The suite creates a disposable real Git repository, uses the real service and
native reviewer, requires one structured pinned review, checks the snapshot was
not modified and confirms termination. It neither approves implementation nor
pushes to GitHub. Cleanup stops only owned workers; uncertain cleanup retains
its temporary resources for investigation. Passing this case does not establish
that a native tool denial was actually attempted.

The remaining live acceptance cases require operator observation in a disposable
repository and dedicated newly created cmux workspace:

| Case | Required evidence |
| --- | --- |
| Native permission/user wait | Observe a real native prompt; keep it waiting beyond the configured background idle limit and confirm the planner remains active with inherited terminal I/O. |
| Fresh/resume | Exit the native conversation, request resume, and verify the same conversation UUID, one runner/workspace and retained native history. |
| Hook/native isolation | Attempt a forbidden mutation/delegation/approval tool, capture its actual denial, and prove the sentinel repository and approval state remain unchanged. Model abstention is not denial evidence. |
| Provider/group death | Terminate the recorded group; confirm stopped receipt or explicit uncertainty and no duplicate provider launch. Inspect for detached task workers in the selected CCS flow. |
| Cmux event/recovery | Restart the service during an active conversation; correlate recorded workspace/process identity. Closing/renaming an unrelated workspace must have no effect on its ownership. |
| Structured results | Verify successful and malformed native terminal results against exact attempt/revision/target identities; prose or Stop events cannot pass a review. |

Record observed versions, provider flow, case status, operation counts, sanitized
receipts and interventions. Report unavailable/untested paths as unverified.
**No live acceptance, installed cutover, merge or release has been performed.**
