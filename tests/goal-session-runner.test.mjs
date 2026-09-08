import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { goalDiscoveryPrompt, interactiveGoalCommand, runInteractiveGoalSession } from "../server/goal-session-interactive.mjs";
import { callGoalTool, goalHook, handleGoalRpc } from "../server/goal-session-bridge.mjs";
import { goalBoardState } from "../server/goal-board.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "cmux-interactive-goal-"));
  const databasePath = join(directory, "plans.db");
  const store = new WorktreePlanStore({ path: databasePath });
  const binding = { planId: "goal-plan", generation: 1, sessionId: "00000000-0000-4000-8000-000000000001" };
  store.createPlan({ planId: binding.planId, repositoryId: "repo", cwd: directory, goal: "Add billing", issueNumbers: [12] });
  store.reserveGoalSession(binding.planId, { branch: "goal-session/test", generation: 1 });
  store.recordGoalSessionStart(binding.planId, { worktreePath: directory, workspaceId: "workspace", generation: 1 });
  store.recordGoalSessionProviderSession(binding.planId, { generation: 1, providerSessionId: binding.sessionId });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const get = () => store.get(binding.planId);
  const hook = (tool_name) => goalHook(store, binding, { hook_event_name: "PreToolUse", session_id: binding.sessionId, tool_name });
  return { store, binding, directory, databasePath, get, hook };
}
const contract = () => ({ basedOnRevision: 0, addressedFeedback: "", spec: { outcome: "Add billing", inScope: ["Billing"], nonGoals: ["Subscriptions"], assumptions: ["One currency"], acceptanceCriteria: [{ id: "AC-1", text: "Invoice is displayed", verification: "UI test" }] }, tasks: [{ id: "T1", title: "Billing", branch: "feature/billing", prompt: "Add the invoice UI", criterionIds: ["AC-1"], ownedAreas: ["app/**"], verification: ["npm test"] }] });

test("native CLI owns the terminal and resumes the same conversation without envelopes or input interception", async (t) => {
  const { databasePath, binding, get, directory } = setup(t);
  const child = new EventEmitter(); child.pid = 234567; child.kill = () => {};
  let invocation;
  const run = runInteractiveGoalSession({ ...binding, databasePath, out: () => {}, spawnAgent: (command, args, options) => {
    invocation = { command, args, options }; return child;
  } });
  child.emit("spawn");
  assert.equal(get().goalSessionRunnerPid, child.pid, "native process protects against duplicate launch even if supervisor dies");
  assert.equal(invocation.command, "ccs");
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.options.cwd, directory);
  assert.equal(invocation.args[invocation.args.indexOf("--resume") + 1], binding.sessionId);
  for (const flag of ["--print", "--output-format", "--permission-prompts", "--dangerously-skip-permissions"]) assert.ok(!invocation.args.includes(flag));
  child.emit("exit", 0, null); await run;
  assert.equal(get().goalSessionRunnerPid, null);
  assert.equal(get().goalSessionError, null);
  assert.equal(goalBoardState(get()), "discovering");
});

test("fresh session identity is durable on spawn, and native failure preserves discovery", async (t) => {
  const { store, binding, databasePath, get } = setup(t);
  store.db.prepare("UPDATE plans SET goal_session_provider_session_id = NULL WHERE plan_id = ?").run(binding.planId);
  const child = new EventEmitter(); child.kill = () => {};
  let args;
  const run = runInteractiveGoalSession({ ...binding, databasePath, out: () => {}, spawnAgent: (_command, input) => { args = input; return child; } });
  assert.equal(get().goalSessionProviderSessionId, null);
  child.emit("spawn");
  assert.equal(get().goalSessionProviderSessionId, args[args.indexOf("--session-id") + 1]);
  assert.equal(args.at(-2), "--");
  child.emit("exit", 1, null); await run;
  assert.equal(get().goalSessionError, null);
  assert.equal(goalBoardState(get()), "discovering");
});

test("spawn failure releases ownership without inventing a provider session or blocking the goal", async (t) => {
  const { store, binding, databasePath, get } = setup(t);
  store.db.prepare("UPDATE plans SET goal_session_provider_session_id = NULL WHERE plan_id = ?").run(binding.planId);
  const child = new EventEmitter(); child.kill = () => {};
  const run = runInteractiveGoalSession({ ...binding, databasePath, out: () => {}, spawnAgent: () => child });
  child.emit("error", new Error("ccs missing"));
  await assert.rejects(run, /ccs missing/);
  assert.equal(get().goalSessionProviderSessionId, null);
  assert.equal(get().goalSessionRunnerPid, null);
  assert.equal(goalBoardState(get()), "discovering");
});

test("command config binds mandatory approval hooks and only the dedicated MCP server", (t) => {
  const { get, databasePath } = setup(t);
  const args = interactiveGoalCommand(get(), databasePath);
  assert.ok(args.includes("--restricted")); assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "manual");
  assert.ok(!args.includes("--append-system-prompt"), "CCS appends its own steering prompt; discovery context comes from the mandatory user-turn hook");
  assert.ok(!args.includes("--settings"), "CCS strips the standalone flag and leaks its JSON into the user prompt");
  const settings = JSON.parse(args.find((arg) => arg.startsWith("--settings=")).slice("--settings=".length));
  assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /goal-session-bridge.mjs/);
  assert.ok(settings.hooks.UserPromptSubmit);
  assert.deepEqual(Object.keys(JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers), ["companion_goal"]);
  assert.match(goalDiscoveryPrompt(get()), /AskUserQuestion/);
  assert.match(goalDiscoveryPrompt(get()), /#12/);
});

test("questions and reading stay interactive; no tool permission mode bypasses unapproved writes", (t) => {
  const { hook, get } = setup(t);
  for (const tool of ["Read", "Grep", "Glob", "AskUserQuestion", "mcp__companion_goal__get_status"]) assert.deepEqual(hook(tool), {});
  for (const tool of ["Bash", "Write", "Edit", "ExitPlanMode", "Agent", "mcp__other__run"]) assert.equal(hook(tool).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(goalBoardState(get()), "discovering");
});

test("validated publication makes review ready; stale or invalid proposals stay in the conversation", (t) => {
  const { store, binding, get } = setup(t);
  assert.throws(() => callGoalTool(store, binding, "publish_proposal", { ...contract(), spec: {} }), /outcome|criterion/);
  assert.equal(get().goalSessionError, null);
  assert.equal(get().proposalRevision, 0);
  const result = callGoalTool(store, binding, "publish_proposal", contract());
  assert.equal(result.approved, false);
  assert.equal(get().goalSessionState, "awaiting_approval");
  assert.equal(get().proposal.intendedBehavior, "Add billing");
  assert.deepEqual(get().proposal.verification, ["npm test"]);
  assert.throws(() => callGoalTool(store, binding, "publish_proposal", contract()), /changed/);
  assert.equal(get().proposalRevision, 1);
});

test("direct conversation feedback withdraws the prior proposal and guards against stale phone approval", (t) => {
  const { store, binding, get, hook } = setup(t);
  callGoalTool(store, binding, "publish_proposal", contract());
  const context = goalHook(store, binding, { hook_event_name: "UserPromptSubmit", session_id: binding.sessionId, prompt: "Exclude exports" });
  assert.match(context.hookSpecificOutput.additionalContext, /Exclude exports/);
  assert.match(context.hookSpecificOutput.additionalContext, /interactive owner of this goal/);
  assert.match(context.hookSpecificOutput.additionalContext, /Add billing/);
  assert.equal(get().goalSessionState, "planning");
  assert.throws(() => store.approveProposal(binding.planId, { generation: 1, revision: 1 }), /no longer current/);
  assert.throws(() => callGoalTool(store, binding, "publish_proposal", { ...contract(), basedOnRevision: 1 }), /feedback changed/);
  callGoalTool(store, binding, "publish_proposal", { ...contract(), basedOnRevision: 1, addressedFeedback: "Exclude exports" });
  assert.equal(get().goalSessionPendingInput, null);
  store.approveProposal(binding.planId, { generation: 1, revision: 2 });
  assert.deepEqual(hook("Edit"), {}, "approval does not auto-grant native permission");
  assert.equal(get().transitionStatus, "delivered");
  assert.equal(get().finalPrUrl, null, "tool authorization is not delivery evidence");
  assert.throws(() => callGoalTool(store, binding, "publish_proposal", { ...contract(), basedOnRevision: 2 }), /unavailable/);
});

test("phone feedback reaches the next native turn and is acknowledged atomically with publication", (t) => {
  const { store, binding, get } = setup(t);
  callGoalTool(store, binding, "publish_proposal", contract());
  store.requestProposalChanges(binding.planId, { generation: 1, revision: 1, feedback: "Add receipts" });
  assert.equal(callGoalTool(store, binding, "get_status").addressedFeedback, "Add receipts");
  const event = goalHook(store, binding, { hook_event_name: "UserPromptSubmit", session_id: binding.sessionId, prompt: "Please continue" });
  assert.match(event.hookSpecificOutput.additionalContext, /Add receipts/);
  assert.throws(() => store.publishProposal(binding.planId, { generation: 1, proposal: {}, expectedRevision: 1, expectedFeedback: "stale" }), /changed/);
  assert.equal(get().goalSessionPendingInput, "Add receipts");
  callGoalTool(store, binding, "publish_proposal", { ...contract(), basedOnRevision: 1, addressedFeedback: "Add receipts" });
  assert.equal(get().proposalRevision, 2);
  assert.equal(get().goalSessionPendingInput, null);
});

test("stale generation, wrong conversation, closed goals and legacy uncertainty fail closed", (t) => {
  const { store, binding, hook } = setup(t);
  assert.throws(() => callGoalTool(store, { ...binding, generation: 2 }, "get_status"), /no longer current/);
  assert.throws(() => goalHook(store, binding, { hook_event_name: "PreToolUse", session_id: "other", tool_name: "Read" }), /identity/);
  callGoalTool(store, binding, "publish_proposal", contract());
  store.approveProposal(binding.planId, { generation: 1, revision: 1 });
  store.claimGoalSessionTransition(binding.planId, { generation: 1, revision: 1 });
  store.recordGoalSessionTransition(binding.planId, { generation: 1, revision: 1, error: "Legacy handoff uncertain" });
  assert.equal(hook("Bash").hookSpecificOutput.permissionDecision, "deny");
  store.db.prepare("UPDATE plans SET board_status = 'aborted' WHERE plan_id = ?").run(binding.planId);
  assert.throws(() => hook("Read"), /no longer current/);
});

test("MCP handshake, validation errors and unavailable methods cannot approve a goal", (t) => {
  const { store, binding, get } = setup(t);
  const rpc = (method, params) => handleGoalRpc(store, binding, { jsonrpc: "2.0", id: 1, method, params });
  assert.equal(rpc("initialize").result.serverInfo.name, "companion-goal");
  assert.deepEqual(rpc("tools/list").result.tools.map((tool) => tool.name), ["get_status", "publish_proposal"]);
  assert.equal(rpc("tools/call", { name: "approve", arguments: {} }).result.isError, true);
  assert.equal(rpc("tools/call", { name: "publish_proposal", arguments: {} }).result.isError, true);
  assert.equal(rpc("unknown").error.code, -32601);
  assert.equal(get().approvalRevision, null);
  assert.equal(get().goalSessionError, null);
});


test("stdio bridge emits MCP JSON and hook failures deny through exit code 2", (t) => {
  const { binding, databasePath } = setup(t);
  const entry = fileURLToPath(new URL("../server/goal-session-bridge.mjs", import.meta.url));
  const run = (mode, input) => spawnSync(process.execPath, [entry, mode, binding.planId, databasePath, "1", binding.sessionId], { input, encoding: "utf8", timeout: 5000 });
  const mcp = run("mcp", [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_status", arguments: {} } },
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  assert.equal(mcp.status, 0, mcp.stderr);
  const messages = mcp.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.length, 2);
  assert.equal(JSON.parse(messages[1].result.content[0].text).approved, false);
  const event = { hook_event_name: "PreToolUse", session_id: binding.sessionId, tool_name: "Bash" };
  const deny = run("hook", JSON.stringify(event));
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");
  const wrongSession = run("hook", JSON.stringify({ ...event, session_id: "other" }));
  assert.equal(wrongSession.status, 2);
  assert.match(wrongSession.stderr, /identity/);
  assert.equal(run("hook", "invalid json").status, 2);
});


test("CLI modes that disable approval hooks cannot start a native agent", async (t) => {
  const { binding, databasePath, get } = setup(t);
  for (const flag of ["CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SIMPLE"]) {
    await assert.rejects(runInteractiveGoalSession({ ...binding, databasePath, out: () => {}, env: { [flag]: "1" }, spawnAgent: () => assert.fail("must not spawn without hooks") }), /require approval hooks/);
    assert.equal(get().goalSessionRunnerPid, null);
    assert.equal(goalBoardState(get()), "discovering");
  }
});
