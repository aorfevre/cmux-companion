import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CmuxClient, parseWorkspaceMetrics } from "../server/cmux-client.mjs";

const ID = "11111111-2222-4333-8444-555555555555";

test("selects the requested workspace, focuses its owning window, and highlights its active surface", async () => {
  const windowId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const calls = [];
  const client = new CmuxClient({ execute: async (_bin, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ window_id: windowId, workspace_id: ID }) };
  } });
  await client.selectWorkspace(ID);
  assert.deepEqual(calls, [
    ["--json", "rpc", "workspace.select", JSON.stringify({ workspace_id: ID })],
    ["--json", "rpc", "window.focus", JSON.stringify({ window_id: windowId })],
    ["--json", "rpc", "surface.trigger_flash", JSON.stringify({ workspace_id: ID, window_id: windowId })],
  ]);
});

test("workspace opening reports selection and window focus failures but tolerates an unavailable flash", async () => {
  for (const failure of ["workspace.select", "window.focus", "surface.trigger_flash"]) {
    const calls = [];
    const client = new CmuxClient({ execute: async (_bin, args) => {
      calls.push(args[2]);
      if (args[2] === failure) throw new Error("Target unavailable");
      return { stdout: JSON.stringify({ window_id: ID }) };
    } });
    if (failure === "surface.trigger_flash") await client.selectWorkspace(ID);
    else await assert.rejects(() => client.selectWorkspace(ID), /Target unavailable/);
    assert.equal(calls.at(-1), failure);
  }
});

test("uses argv-only cmux commands for screen reads", async () => {
  const calls = [];
  const client = new CmuxClient({
    bin: "/fake/cmux",
    execute: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: "last output\n", stderr: "" };
    },
  });

  const result = await client.readScreen(ID, 99);
  assert.deepEqual(result, { text: "last output", lines: 99 });
  assert.equal(calls[0].bin, "/fake/cmux");
  assert.deepEqual(calls[0].args, [
    "read-screen", "--surface", ID, "--scrollback", "--lines", "99",
  ]);
  assert.equal(calls[0].options.shell, undefined);
});

test("bounds concurrent cmux processes so polling cannot flood the socket", async () => {
  let active = 0;
  let maximum = 0;
  const client = new CmuxClient({
    maxConcurrent: 2,
    execute: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { stdout: "PONG", stderr: "" };
    },
  });
  await Promise.all(Array.from({ length: 8 }, () => client.ping()));
  assert.equal(maximum, 2);
});

test("enriches only the most relevant workspace statuses and caches them", async () => {
  const calls = [];
  const workspaces = Array.from({ length: 12 }, (_, index) => ({
    id: `11111111-2222-4333-8444-${String(index + 1).padStart(12, "0")}`,
    last_activity_at: index + 1,
    has_unread: index === 0,
    is_selected: index === 1,
  }));
  const client = new CmuxClient({ execute: async (_bin, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ effective: "working" }), stderr: "" };
  } });
  const first = await client.recentWorkspaceStatuses(workspaces);
  const second = await client.recentWorkspaceStatuses(workspaces);
  assert.equal(calls.length, 6);
  assert.equal(first.size, 6);
  assert.equal(second.size, 6);
  assert.equal(first.has(workspaces[0].id), true);
  assert.equal(first.has(workspaces[1].id), true);
});

test("requests a bounded, screen-anchored terminal replay", async () => {
  const calls = [];
  const client = new CmuxClient({ execute: async (_bin, args, options) => {
    calls.push({ args, options });
    return { stdout: '{"render_grid":{"format":"cmux.render-grid.v1"}}', stderr: "" };
  } });
  const replay = await client.terminalReplay(ID, 99_999);
  assert.equal(replay.render_grid.format, "cmux.render-grid.v1");
  assert.deepEqual(calls[0].args.slice(0, 3), ["--json", "rpc", "mobile.terminal.replay"]);
  assert.deepEqual(JSON.parse(calls[0].args[3]), {
    surface_id: ID,
    anchor: "screen",
    max_scrollback_rows: 2_000,
  });
  assert.equal(calls[0].options.maxBuffer, 16 * 1024 * 1024);
});

test("reports and clears a validated mobile terminal viewport", async () => {
  const calls = [];
  const client = new CmuxClient({ execute: async (_bin, args) => { calls.push(args); return { stdout: "{}", stderr: "" }; } });
  await client.terminalViewport(ID, { clientId: "phone-client-123", generation: 10, columns: 42, rows: 18 });
  await client.terminalViewport(ID, { clientId: "phone-client-123", generation: 11, clear: true });
  assert.deepEqual(JSON.parse(calls[0][3]), {
    surface_id: ID,
    client_id: "phone-client-123",
    viewport_generation: 10,
    viewport_columns: 42,
    viewport_rows: 18,
  });
  assert.deepEqual(JSON.parse(calls[1][3]), {
    surface_id: ID,
    client_id: "phone-client-123",
    viewport_generation: 11,
    clear: true,
  });
  assert.throws(() => client.terminalViewport(ID, { clientId: "bad", generation: 1, columns: 10, rows: 2 }), /client ID/);
});

test("sends a multiline prompt without leaking bracketed-paste markers", async () => {
  const calls = [];
  const client = new CmuxClient({
    execute: async (_bin, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    },
  });
  await client.sendPrompt(ID, "please review\nthen continue");
  assert.deepEqual(calls, [
    ["send", "--surface", ID, "--", "please review"],
    ["send-key", "--surface", ID, "--", "ctrl+j"],
    ["send", "--surface", ID, "--", "then continue"],
    ["send-key", "--surface", ID, "--", "enter"],
  ]);
  assert.equal(JSON.stringify(calls).includes("200~"), false);
});

test("submits a multiline recovery prompt to the active surface in a workspace", async () => {
  const calls = [];
  const client = new CmuxClient({ execute: async (_bin, args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  } });
  await client.sendWorkspacePrompt(ID, "repair the trailer\nthen stop again");
  assert.deepEqual(calls, [
    ["send", "--workspace", ID, "--", "repair the trailer"],
    ["send-key", "--workspace", ID, "--", "ctrl+j"],
    ["send", "--workspace", ID, "--", "then stop again"],
    ["send-key", "--workspace", ID, "--", "enter"],
  ]);
});

test("rejects arbitrary targets, keys, and oversized input", async () => {
  const client = new CmuxClient({ execute: async () => ({ stdout: "", stderr: "" }) });
  await client.sendPrompt(ID, "x".repeat(16_000));
  await assert.rejects(() => client.readScreen("surface:1"), /Invalid cmux target/);
  await assert.rejects(() => client.sendKey(ID, "cmd+q"), /Unsupported key/);
  await assert.rejects(() => client.sendText(ID, "x".repeat(16_001)), /16,000/);
  await assert.rejects(() => client.sendPrompt(ID, "x".repeat(16_001)), /16,000/);
  await assert.rejects(() => client.sendWorkspacePrompt(ID, "x".repeat(16_001)), /16,000/);
});

test("parses JSON output and rejects malformed JSON", async () => {
  const valid = new CmuxClient({ execute: async () => ({ stdout: '{"methods":["system.ping"]}', stderr: "" }) });
  assert.deepEqual(await valid.capabilities(), { methods: ["system.ping"] });

  const invalid = new CmuxClient({ execute: async () => ({ stdout: "not-json", stderr: "" }) });
  await assert.rejects(() => invalid.capabilities(), /invalid JSON/);
});

test("passes the private socket credential only to cmux child processes", async () => {
  let childEnvironment;
  const client = new CmuxClient({
    socketPassword: "private-socket-credential",
    execute: async (_bin, _args, options) => {
      childEnvironment = options.env;
      return { stdout: "PONG", stderr: "" };
    },
  });
  await client.ping();
  assert.equal(childEnvironment.CMUX_SOCKET_PASSWORD, "private-socket-credential");
});

test("uses structured RPC for safe workspace launch and shell-quotes prompts", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "cmux-workspace-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const calls = [];
  const client = new CmuxClient({ execute: async (_bin, args) => {
    calls.push(args);
    if (args.includes("workspace.create")) return { stdout: JSON.stringify({ workspace_id: ID }), stderr: "" };
    return { stdout: "{}", stderr: "" };
  } });
  const created = await client.workspaceCreate({ cwd: repo, title: "Test", agent: "codex", prompt: "fix 'quotes'; touch /tmp/nope" });
  assert.equal(created.workspace_id, ID);
  assert.deepEqual(JSON.parse(calls[0][3]), { cwd: repo, title: "Test", focus: false });
  const send = JSON.parse(calls[1][3]);
  assert.equal(send.workspace_id, ID);
  assert.equal(send.text, "xcodex 'fix '\\''quotes'\\''; touch /tmp/nope'\n");
  calls.length = 0;
  await client.workspaceCreate({ cwd: repo, title: "Claude", agent: "claude" });
  assert.equal(JSON.parse(calls[1][3]).text, "xclaude\n");
  await assert.rejects(() => client.workspaceCreate({ cwd: "/tmp", title: "x", agent: "evil" }), /Unsupported agent/);
  // cmux creates a workspace on a missing cwd and silently leaves the shell in
  // the directory it launched from, so the agent reads the wrong repository.
  await assert.rejects(
    () => client.workspaceCreate({ cwd: `${repo}-gone`, title: "x", agent: "claude" }),
    /This directory does not exist/,
  );
  // A file is not a working directory either.
  writeFileSync(join(repo, "file.txt"), "x");
  await assert.rejects(
    () => client.workspaceCreate({ cwd: join(repo, "file.txt"), title: "x", agent: "claude" }),
    /This directory does not exist/,
  );
});

test("validates structured inbox replies", async () => {
  const calls = [];
  const client = new CmuxClient({ execute: async (_bin, args) => { calls.push(args); return { stdout: "{}", stderr: "" }; } });
  await client.feedReply(ID, "permissionRequest", { mode: "once" });
  assert.equal(calls[0][2], "feed.permission.reply");
  assert.deepEqual(JSON.parse(calls[0][3]), { request_id: ID, mode: "once" });
  assert.throws(() => client.feedReply(ID, "permissionRequest", { mode: "yes" }), /Invalid permission/);
  assert.throws(() => client.feedReply(ID, "question", { selections: [] }), /Select at least one/);
});

test("parses the compact workspace health metrics row", () => {
  const metrics = parseWorkspaceMetrics("1.2\t1024\t3\tsurface\tsurface:1\tworkspace:1\tshell\n5.5\t2048\t8\tworkspace\tworkspace:1\twindow:1\tProject");
  assert.deepEqual(metrics, { cpuPercent: 5.5, memoryBytes: 2048, processCount: 8, ref: "workspace:1", parent: "window:1", title: "Project" });
});

test("merges cmux listening ports into the mobile workspace model", async () => {
  let listCalls = 0;
  const client = new CmuxClient({ execute: async (_bin, args) => {
    if (args.includes("mobile.workspace.list")) {
      listCalls += 1;
      return { stdout: JSON.stringify({ workspaces: [{ id: ID, title: "Web", current_directory: "/repo", terminals: [] }] }), stderr: "" };
    }
    if (args.includes("list-workspaces")) return { stdout: JSON.stringify({ workspaces: [{ title: "Web", current_directory: "/repo", listening_ports: [3000, 5173, "bad"] }] }), stderr: "" };
    if (args.includes("status")) return { stdout: "{}", stderr: "" };
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }, socketPassword: "secret" });
  const payload = await client.workspaceListDetailed();
  const cached = await client.workspaceListDetailed();
  assert.deepEqual(payload.workspaces[0].listening_ports, [3000, 5173]);
  assert.equal(cached, payload);
  assert.equal(listCalls, 1);
});

test("discovers localhost listeners owned by workspace processes", async () => {
  const calls = [];
  const client = new CmuxClient({ execute: async (bin, args) => {
    calls.push([bin, args]);
    if (bin === "/usr/sbin/lsof") return { stdout: "p123\nn127.0.0.1:3000\nn*:5173\nn127.0.0.1:3000\n", stderr: "" };
    return { stdout: `0\t0\t1\tprocess\t123\tworkspace:1\tnode\n0\t0\t1\tprocess\t456\t123\tchild\n`, stderr: "" };
  }, socketPassword: "secret" });
  assert.deepEqual(await client.workspaceListeningPorts(ID), [3000, 5173]);
  assert.equal(calls[1][0], "/usr/sbin/lsof");
  assert.equal(calls[1][1].includes("123,456"), true);
});

test("discovers all workspace listeners with one cmux process scan", async () => {
  const mobile = [{ id: ID, title: "Web", current_directory: "/repo" }];
  const local = [{ ref: "workspace:7", title: "Web", current_directory: "/repo" }];
  const client = new CmuxClient({ execute: async (bin, args) => {
    if (bin === "/usr/sbin/lsof") return { stdout: "p123\nn127.0.0.1:3000\nn*:5173\n", stderr: "" };
    assert.deepEqual(args, ["top", "--all", "--processes", "--flat", "--format", "tsv"]);
    return { stdout: [
      "0\t0\t1\tworkspace\tworkspace:7\twindow:1\tWeb",
      "0\t0\t1\tsurface\tsurface:9\tworkspace:7\tshell",
      "0\t0\t1\tprocess\t123\tsurface:9\tnode",
    ].join("\n"), stderr: "" };
  }, socketPassword: "secret" });
  const ports = await client.workspaceListeningPortsAll(mobile, local);
  assert.deepEqual(ports.get(ID), [3000, 5173]);
});

test("sends a workspace notification through the rpc surface", async () => {
  const calls = [];
  const client = new CmuxClient({
    bin: "/bin/true",
    execute: async (bin, args) => { calls.push(args); return { stdout: "{}", stderr: "" }; },
  });
  await client.notify(ID, { title: "Goal ready", body: "3 of 3 branches ready" });
  assert.equal(calls[0][1], "rpc");
  assert.equal(calls[0][2], "notification.create");
  assert.deepEqual(JSON.parse(calls[0][3]), {
    workspace_id: ID,
    title: "Goal ready",
    body: "3 of 3 branches ready",
  });
});

test("refuses a notification for an invalid workspace target", async () => {
  const client = new CmuxClient({
    bin: "/bin/true",
    execute: async () => ({ stdout: "{}", stderr: "" }),
  });
  await assert.rejects(() => client.notify("workspace-one", { title: "Goal ready" }), /Invalid cmux target/);
});

test("clamps an oversized notification title and body before sending", async () => {
  const calls = [];
  const client = new CmuxClient({
    bin: "/bin/true",
    execute: async (bin, args) => { calls.push(args); return { stdout: "{}", stderr: "" }; },
  });
  await client.notify(ID, { title: "x".repeat(150), body: "y".repeat(600) });
  assert.deepEqual(JSON.parse(calls[0][3]), {
    workspace_id: ID,
    title: "x".repeat(100),
    body: "y".repeat(500),
  });
});

test("falls back to a default title instead of failing on a blank one", async () => {
  const calls = [];
  const client = new CmuxClient({
    bin: "/bin/true",
    execute: async (bin, args) => { calls.push(args); return { stdout: "{}", stderr: "" }; },
  });
  await client.notify(ID, { title: "   ", body: "still delivered" });
  assert.deepEqual(JSON.parse(calls[0][3]), {
    workspace_id: ID,
    title: "cmux companion",
    body: "still delivered",
  });
});

test("passes a custom model to the agent command and refuses shell syntax before creating a workspace", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "cmux-model-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const agent of ["codex", "claude"]) {
    const calls = [];
    const client = new CmuxClient({ execute: async (_bin, args) => { calls.push(args); return { stdout: JSON.stringify({ workspace_id: ID }) }; } });
    await client.workspaceCreate({ cwd: repo, title: "Custom model", agent, model: "provider/custom-v2", prompt: "Do the task" });
    const text = JSON.parse(calls[1][3]).text;
    assert.match(text, new RegExp(`^x${agent} --model 'provider/custom-v2' 'Do the task'\\n$`));
    const before = calls.length;
    await assert.rejects(() => client.workspaceCreate({ cwd: repo, title: "Bad model", agent, model: "$(touch /tmp/unsafe)" }), /Model must/);
    assert.equal(calls.length, before);
  }
});

const SURFACE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function recordingClient(reply = () => ({ stdout: "{}", stderr: "" })) {
  const calls = [];
  const client = new CmuxClient({
    bin: "/fake/cmux",
    execute: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return reply(args, bin);
    },
  });
  return { client, calls };
}

test("wraps a failed cmux process into a command error carrying stderr and the exit code", async () => {
  const client = new CmuxClient({ execute: async () => {
    throw Object.assign(new Error("spawn failed"), { code: 7, stderr: "socket refused\n" });
  } });
  const error = await client.ping().catch((value) => value);
  assert.equal(error.name, "CmuxCommandError");
  assert.equal(error.message, "socket refused");
  assert.equal(error.code, 7);
  assert.equal(error.stderr, "socket refused");

  const bare = new CmuxClient({ execute: async () => { throw new Error("timeout"); } });
  await assert.rejects(() => bare.ping(), { name: "CmuxCommandError", message: "timeout", stderr: "" });
  const silent = new CmuxClient({ execute: async () => { throw {}; } });
  await assert.rejects(() => silent.ping(), /cmux command failed/);
});

test("passes the process environment without a credential when no socket password exists", async () => {
  let childEnvironment;
  const client = new CmuxClient({ socketPassword: null, execute: async (_bin, _args, options) => {
    childEnvironment = options.env;
    return { stdout: "PONG" };
  } });
  assert.equal(await client.ping(), true);
  assert.equal("CMUX_SOCKET_PASSWORD" in childEnvironment, "CMUX_SOCKET_PASSWORD" in process.env);
  assert.equal(new CmuxClient({ socketPassword: null, maxConcurrent: 99 }).maxConcurrent, 4);
  assert.equal(new CmuxClient({ socketPassword: null, maxConcurrent: "nope" }).maxConcurrent, 2);
});

test("exposes host status, workspace list, feeds and notifications as fixed argv commands", async () => {
  const { client, calls } = recordingClient(() => ({ stdout: JSON.stringify({ ok: true }) }));
  assert.deepEqual(await client.hostStatus(), { ok: true });
  await client.workspaceList();
  await client.pendingFeed();
  await client.notifications();
  await client.markNotificationRead(ID);
  await client.todoList(ID);
  await client.todoAction(ID, SURFACE, "check");
  assert.deepEqual(calls.map((call) => call.args), [
    ["--json", "rpc", "mobile.host.status", "{}"],
    ["--json", "rpc", "mobile.workspace.list", "{}"],
    ["--json", "rpc", "feed.list", JSON.stringify({ pending_only: true })],
    ["--json", "rpc", "notification.list", "{}"],
    ["--json", "rpc", "notification.mark_read", JSON.stringify({ id: ID })],
    ["--json", "todo", "list", "--workspace", ID],
    ["--json", "todo", "check", SURFACE, "--workspace", ID],
  ]);
  assert.ok(calls.every((call) => call.bin === "/fake/cmux"));
  await assert.rejects(() => client.markNotificationRead("notification-1"), /Invalid cmux target/);
  assert.throws(() => client.todoList("todo"), /Invalid cmux target/);
  await assert.rejects(() => client.todoAction(ID, "todo-1", "check"), /Invalid cmux target/);
  await assert.rejects(() => client.todoAction(ID, SURFACE, "delete"), /Unsupported todo action/);
});

test("refuses RPC method names outside the verified surface before spawning anything", () => {
  const { client, calls } = recordingClient();
  for (const method of ["", "Workspace.list", "rm -rf", "1abc", "a", `a${"b".repeat(90)}`, null]) {
    assert.throws(() => client.rpc(method), /Invalid cmux method/);
  }
  assert.equal(calls.length, 0);
});

test("answers questions and plan reviews through structured feed replies with bounded feedback", async () => {
  const { client, calls } = recordingClient();
  await client.feedReply(ID, "question", { selections: ["Option A", "Option B"] });
  await client.feedReply(ID, "exitPlan", { mode: "manual" });
  await client.feedReply(ID, "exitPlan", { mode: "deny", feedback: "  too broad  " });
  assert.deepEqual(calls.map((call) => [call.args[2], JSON.parse(call.args[3])]), [
    ["feed.question.reply", { request_id: ID, selections: ["Option A", "Option B"] }],
    ["feed.exit_plan.reply", { request_id: ID, mode: "manual" }],
    ["feed.exit_plan.reply", { request_id: ID, mode: "deny", feedback: "too broad" }],
  ]);
  assert.throws(() => client.feedReply(ID, "question", { selections: ["  "] }), /Select at least one/);
  assert.throws(() => client.feedReply(ID, "question", { selections: [42] }), /Select at least one/);
  assert.throws(() => client.feedReply(ID, "question", { selections: ["x".repeat(501)] }), /Select at least one/);
  assert.throws(() => client.feedReply(ID, "question", { selections: Array.from({ length: 21 }, () => "a") }), /Select at least one/);
  assert.throws(() => client.feedReply(ID, "question", {}), /Select at least one/);
  assert.throws(() => client.feedReply(ID, "exitPlan", { mode: "yolo" }), /Invalid plan response/);
  assert.throws(() => client.feedReply(ID, "exitPlan", { mode: "deny", feedback: "x".repeat(4_001) }), /Feedback is too long/);
  assert.throws(() => client.feedReply(ID, "todo", {}), /Unsupported inbox item/);
  assert.throws(() => client.feedReply("req-1", "question", { selections: ["a"] }), /Invalid cmux target/);
  assert.equal(calls.length, 3);
});

test("launches a shell workspace with a package script, a printed prompt, or nothing at all", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "cmux-shell-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const { client, calls } = recordingClient((args) => ({
    stdout: args.includes("workspace.create") ? JSON.stringify({ workspace_ref: ID }) : "{}",
  }));
  const created = await client.workspaceCreate({ cwd: repo, title: "  Dev  ", script: "dev" });
  assert.equal(created.workspace_id, ID, "a workspace_ref answer is accepted as the id");
  assert.equal(JSON.parse(calls[0].args[3]).title, "Dev");
  assert.equal(JSON.parse(calls[1].args[3]).text, "npm run dev\n");

  calls.length = 0;
  await client.workspaceCreate({ cwd: repo, title: "Notes", prompt: "  echo 'hi'  " });
  assert.equal(JSON.parse(calls[1].args[3]).text, "printf '%s\\n' 'echo '\\''hi'\\'''\n");

  calls.length = 0;
  await client.workspaceCreate({ cwd: repo, title: "Empty" });
  assert.equal(calls.length, 1, "an empty shell sends no text at all");

  await assert.rejects(() => client.workspaceCreate({ cwd: repo, title: " ", agent: "shell" }), /Invalid workspace title/);
  await assert.rejects(() => client.workspaceCreate({ cwd: repo, title: "x".repeat(101) }), /Invalid workspace title/);
  await assert.rejects(() => client.workspaceCreate({ cwd: repo, title: "Long", prompt: "x".repeat(8_001) }), /Prompt is too long/);
  await assert.rejects(() => client.workspaceCreate({ cwd: repo, title: "Long", prompt: 42 }), /Prompt is too long/);
  await assert.rejects(() => client.workspaceCreate({ cwd: repo, title: "Bad", script: "dev; rm -rf /" }), /Invalid package script/);
  await assert.rejects(() => client.workspaceCreate({ cwd: "relative/path", title: "Bad" }), /Invalid repository path/);
  await assert.rejects(() => client.workspaceCreate(null), /Invalid repository path/);
  await assert.rejects(() => client.createWorkspaceLocked({ cwd: "relative", title: "Bad" }), /Invalid repository path/);
  await assert.rejects(() => client.createWorkspaceLocked({ cwd: `${repo}/missing`, title: "Bad" }), /does not exist/);
});

test("stamps only well-formed identity variables into the session shell before the agent command", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "cmux-env-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const { client, calls } = recordingClient((args) => ({
    stdout: args.includes("workspace.create") ? JSON.stringify({ workspace_id: ID }) : "{}",
  }));
  const env = {
    CMUX_GOAL_ID: " goal-1 ",
    CMUX_TASK_ID: "x".repeat(300),
    lower_case: "dropped",
    "BAD NAME": "dropped",
    EMPTY: "   ",
    NUMBER: 42,
    QUOTED: "it's",
  };
  for (let index = 0; index < 20; index += 1) env[`EXTRA_${index}`] = `v${index}`;
  await client.workspaceCreate({ cwd: repo, title: "Stamped", agent: "claude", env });
  const text = JSON.parse(calls[1].args[3]).text;
  assert.equal(text.startsWith(`export CMUX_GOAL_ID='goal-1'; export CMUX_TASK_ID='${"x".repeat(200)}'; export QUOTED='it'\\''s'; `), true);
  assert.equal(text.endsWith("; xclaude\n"), true);
  assert.equal((text.match(/export /g) || []).length, 12, "the export list is capped");
  assert.doesNotMatch(text, /lower_case|BAD NAME|EMPTY|NUMBER|dropped/);

  calls.length = 0;
  await client.workspaceCreate({ cwd: repo, title: "Plain", env: { lower: "x" } });
  assert.equal(calls.length, 1, "no valid variable and no command means nothing is sent");
  calls.length = 0;
  await client.workspaceCreate({ cwd: repo, title: "Plain", env: "CMUX_GOAL_ID=goal" });
  assert.equal(calls.length, 1);
});

test("rejects a workspace whose creation answer has no usable identifier", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "cmux-noid-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const { client, calls } = recordingClient(() => ({ stdout: JSON.stringify({ workspace_id: "workspace:7" }) }));
  await assert.rejects(() => client.workspaceCreate({ cwd: repo, title: "Bad", agent: "claude" }), /Invalid cmux target/);
  assert.equal(calls.length, 1, "no text is sent to an unverified workspace");
});

test("renames and closes a workspace through argv-only commands", async () => {
  const { client, calls } = recordingClient(() => ({ stdout: "" }));
  assert.deepEqual(await client.workspaceRename(ID, "  New title  "), { ok: true });
  assert.deepEqual(await client.workspaceClose(ID), { ok: true });
  assert.deepEqual(calls.map((call) => call.args), [
    ["workspace", "rename", ID, "--title", "New title"],
    ["workspace", "close", ID],
  ]);
  await assert.rejects(() => client.workspaceRename(ID, "   "), /Invalid workspace title/);
  await assert.rejects(() => client.workspaceRename(ID, "x".repeat(101)), /Invalid workspace title/);
  await assert.rejects(() => client.workspaceRename("workspace:1", "x"), /Invalid cmux target/);
  await assert.rejects(() => client.workspaceClose("workspace:1"), /Invalid cmux target/);
  assert.equal(calls.length, 2);
});

test("starts the goal session runner with the checked-in entry point and quoted arguments only", async () => {
  const { client, calls } = recordingClient();
  const planId = "22222222-3333-4444-8555-666666666666";
  const dispatchId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  await client.workspaceStartGoalSessionRunner(ID, { planId, databasePath: "/data/it's.sqlite", generation: 3, dispatchId });
  const sent = JSON.parse(calls[0].args[3]);
  assert.equal(calls[0].args[2], "surface.send_text");
  assert.equal(sent.workspace_id, ID);
  assert.equal(sent.text, `'${process.execPath}' '${fileURLToPath(new URL("../server/goal-session-runner.mjs", import.meta.url))}' '${planId}' '/data/it'\\''s.sqlite' '3' '${dispatchId}'\n`);
  const valid = { planId, databasePath: "/data/goals.sqlite", generation: 1, dispatchId };
  for (const invalid of [
    { ...valid, planId: "plan-1" },
    { ...valid, databasePath: "relative.sqlite" },
    { ...valid, databasePath: null },
    { ...valid, generation: 0 },
    { ...valid, generation: 1.5 },
    { ...valid, dispatchId: "; rm -rf /" },
  ]) {
    await assert.rejects(() => client.workspaceStartGoalSessionRunner(ID, invalid), /Invalid goal session runner/);
  }
  await assert.rejects(() => client.workspaceStartGoalSessionRunner("ws", valid), /Invalid cmux target/);
  assert.equal(calls.length, 1);
});

test("respawns a surface into a login shell with explicit targets", async () => {
  const { client, calls } = recordingClient(() => ({ stdout: JSON.stringify({ ok: true }) }));
  assert.deepEqual(await client.workspaceRespawn(ID, SURFACE), { ok: true });
  assert.equal(calls[0].args[2], "surface.respawn");
  assert.deepEqual(JSON.parse(calls[0].args[3]), {
    workspace_id: ID,
    surface_id: SURFACE,
    command: "/bin/zsh -l",
    tmux_start_command: "exec ${SHELL:-/bin/zsh} -l",
  });
  await assert.rejects(() => client.workspaceRespawn(ID, "surface:1"), /Invalid cmux target/);
});

test("builds a workspace overview and tolerates missing metrics or surface health", async () => {
  const { client, calls } = recordingClient((args) => {
    if (args[0] === "top") return { stdout: "1\t2\t3\tsurface\tsurface:1\tworkspace:1\tshell\n4.5\t512\t2\tworkspace\tworkspace:1\twindow:1\tApp" };
    if (args.includes("surface.health")) throw new Error("unsupported");
    if (args.includes("status")) return { stdout: JSON.stringify({ effective: "idle" }) };
    return { stdout: JSON.stringify({ todos: [] }) };
  });
  const overview = await client.workspaceOverview(ID);
  assert.deepEqual(overview, {
    status: { effective: "idle" },
    todos: { todos: [] },
    metrics: { cpuPercent: 4.5, memoryBytes: 512, processCount: 2, ref: "workspace:1", parent: "window:1", title: "App" },
    surfaceHealth: null,
  });
  const top = calls.find((call) => call.args[0] === "top");
  assert.deepEqual(top.args, ["top", "--workspace", ID, "--processes", "--flat", "--format", "tsv"]);
  assert.equal(top.options.timeout, 15_000);

  const degraded = recordingClient((args) => {
    if (args[0] === "top") throw new Error("top unavailable");
    return { stdout: "{}" };
  });
  assert.equal((await degraded.client.workspaceOverview(ID)).metrics, null);
  assert.equal(await degraded.client.workspaceMetrics(ID).catch(() => "failed"), "failed");
  assert.equal(parseWorkspaceMetrics("1\t2\t3\tsurface\tsurface:1\tworkspace:1\tshell"), null);
  await assert.rejects(() => client.workspaceMetrics("ws"), /Invalid cmux target/);
});

test("sends text and allowed keys to a surface, normalising key case", async () => {
  const { client, calls } = recordingClient(() => ({ stdout: "" }));
  await client.sendText(SURFACE, "ls -la");
  await client.sendKey(SURFACE, "Ctrl+C");
  assert.deepEqual(calls.map((call) => call.args), [
    ["send", "--surface", SURFACE, "--", "ls -la"],
    ["send-key", "--surface", SURFACE, "--", "ctrl+c"],
  ]);
  await assert.rejects(() => client.sendText(SURFACE, ""), /between 1 and 16,000/);
  await assert.rejects(() => client.sendText(SURFACE, 42), /between 1 and 16,000/);
  await assert.rejects(() => client.sendKey("surface:1", "enter"), /Invalid cmux target/);
});

test("submits a prompt that ends with a blank line without sending an empty chunk", async () => {
  const { client, calls } = recordingClient(() => ({ stdout: "" }));
  await client.sendPrompt(SURFACE, "one\r\n\r\n");
  assert.deepEqual(calls.map((call) => call.args), [
    ["send", "--surface", SURFACE, "--", "one"],
    ["send-key", "--surface", SURFACE, "--", "ctrl+j"],
    ["send-key", "--surface", SURFACE, "--", "ctrl+j"],
    ["send-key", "--surface", SURFACE, "--", "enter"],
  ]);
});

test("clamps read-screen line counts and replay rows to their bounds", async () => {
  const { client, calls } = recordingClient((args) => ({ stdout: args[0] === "--json" ? "{}" : "" }));
  assert.equal((await client.readScreen(SURFACE, 1)).lines, 20);
  assert.equal((await client.readScreen(SURFACE, "many")).lines, 240);
  assert.equal((await client.readScreen(SURFACE, 5_000)).lines, 2_000);
  await client.terminalReplay(SURFACE, -5);
  assert.equal(JSON.parse(calls[3].args[3]).max_scrollback_rows, 0);
  await client.terminalReplay(SURFACE, "abc");
  assert.equal(JSON.parse(calls[4].args[3]).max_scrollback_rows, 600);
  assert.throws(() => client.terminalReplay("surface", 1), /Invalid cmux target/);
});

test("rejects viewport generations and dimensions outside the mobile terminal's bounds", () => {
  const { client, calls } = recordingClient();
  const base = { clientId: "phone-client-123", generation: 1 };
  assert.throws(() => client.terminalViewport(SURFACE, { ...base, generation: -1, columns: 80, rows: 24 }), /viewport generation/);
  assert.throws(() => client.terminalViewport(SURFACE, { ...base, generation: 2 ** 60, columns: 80, rows: 24 }), /viewport generation/);
  assert.throws(() => client.terminalViewport(SURFACE, { ...base, columns: 19, rows: 24 }), /columns must be between 20 and 300/);
  assert.throws(() => client.terminalViewport(SURFACE, { ...base, columns: 301, rows: 24 }), /columns must be between 20 and 300/);
  assert.throws(() => client.terminalViewport(SURFACE, { ...base, columns: 80.5, rows: 24 }), /columns must be between 20 and 300/);
  assert.throws(() => client.terminalViewport(SURFACE, { ...base, columns: 80, rows: 4 }), /rows must be between 5 and 120/);
  assert.throws(() => client.terminalViewport(SURFACE, { ...base, columns: 80, rows: 121 }), /rows must be between 5 and 120/);
  assert.throws(() => client.terminalViewport(SURFACE), /client ID/);
  assert.throws(() => client.terminalViewport("surface", base), /Invalid cmux target/);
  assert.equal(calls.length, 0);
});

test("falls back to a status enrichment cache and drops statuses for closed workspaces", async () => {
  let fail = false;
  const { client, calls } = recordingClient(() => {
    if (fail) throw new Error("status unavailable");
    return { stdout: JSON.stringify({ effective: "working" }) };
  });
  const first = await client.recentWorkspaceStatuses([{ id: ID }, { id: SURFACE }]);
  assert.equal(first.size, 2);
  fail = true;
  client.statusCache.get(ID).at -= 20_000;
  const second = await client.recentWorkspaceStatuses([{ id: ID }, { id: SURFACE }]);
  assert.deepEqual(second.get(ID), { effective: "working" }, "a stale cached value survives a failed refresh");
  assert.equal(second.size, 2);
  assert.equal(calls.length, 3);
  const third = await client.recentWorkspaceStatuses([{ id: SURFACE }]);
  assert.equal(client.statusCache.has(ID), false, "a closed workspace is forgotten");
  assert.equal(third.size, 1);
  const stranger = "99999999-2222-4333-8444-555555555555";
  const fourth = await client.recentWorkspaceStatuses([{ id: stranger }]);
  assert.equal(fourth.size, 0, "a workspace that never answered is omitted rather than nulled");
});

test("derives detailed workspace status from the raw payload when enrichment is unavailable", async () => {
  const second = "99999999-2222-4333-8444-555555555555";
  const third = "88888888-2222-4333-8444-555555555555";
  const { client, calls } = recordingClient((args, bin) => {
    if (bin === "/usr/sbin/lsof") return { stdout: "p42\nn127.0.0.1:4000\n" };
    if (args.includes("mobile.workspace.list")) {
      return { stdout: JSON.stringify({ workspaces: [
        { id: ID, title: "★ Web", current_directory: "/repo", status: "  running " },
        { id: second, title: "Api", current_directory: "/api", agent_status: { effective: "idle" } },
        { id: third, title: "Blank", current_directory: "/blank" },
      ] }) };
    }
    if (args.includes("list-workspaces")) throw new Error("older cmux");
    if (args[0] === "top") return { stdout: ["0\t0\t1\tworkspace\tworkspace:1\twindow:1\tWeb", "0\t0\t1\tprocess\t42\tworkspace:1\tnode"].join("\n") };
    if (args.includes("status")) throw new Error("status unavailable");
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });
  const payload = await client.workspaceListDetailed();
  const [web, api, blank] = payload.workspaces;
  assert.deepEqual(web.status, { effective: "running" });
  assert.deepEqual(web.listening_ports, [4000], "a missing local inventory triggers the process scan");
  assert.deepEqual(api.status, { effective: "idle" });
  assert.deepEqual(api.listening_ports, []);
  assert.equal(blank.status, null);
  assert.equal(calls.some((call) => call.args[0] === "top" && call.args[1] === "--all"), true);
});

test("serialises concurrent detailed listings into a single in-flight load and skips the scan when unneeded", async () => {
  let lists = 0;
  const { client, calls } = recordingClient((args) => {
    if (args.includes("mobile.workspace.list")) {
      lists += 1;
      return { stdout: JSON.stringify({ workspaces: [{ id: ID, title: "Web", current_directory: "/repo" }] }) };
    }
    if (args.includes("list-workspaces")) return { stdout: JSON.stringify({ workspaces: [{ title: "Web", current_directory: "/repo", listening_ports: [3000] }] }) };
    if (args[0] === "top") throw new Error("scan should not run when every workspace lists its ports");
    if (args.includes("status")) return { stdout: JSON.stringify({ effective: "working" }) };
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });
  const [first, second] = await Promise.all([client.workspaceListDetailed(), client.workspaceListDetailed()]);
  assert.equal(first, second);
  assert.equal(lists, 1);
  assert.deepEqual(first.workspaces[0].status, { effective: "working" });
  assert.equal(calls.some((call) => call.args[0] === "top"), false);
  client.detailedCache.at -= 10_000;
  await client.workspaceListDetailed();
  assert.equal(lists, 2, "an expired cache reloads");
});

test("maps listeners across the process tree and ignores orphans, cycles and bad ports", async () => {
  const mobile = [{ id: ID, title: "Web", current_directory: "/repo" }, { id: SURFACE, title: "Api", current_directory: "/api" }];
  const local = [{ workspace_ref: "workspace:7", title: "Web", current_directory: "/repo" }];
  const { client } = recordingClient((args, bin) => {
    if (bin === "/usr/sbin/lsof") return { stdout: "p100\nn127.0.0.1:3000\nn*:70000\np200\nn[::1]:8080\nn127.0.0.1:8080\np300\nn127.0.0.1:9\nsomething\n" };
    return { stdout: [
      "0\t0\t1\tworkspace\tworkspace:7\twindow:1\t★ Web",
      "0\t0\t1\tworkspace\tworkspace:8\twindow:1\tApi",
      "0\t0\t1\tsurface\tsurface:9\tworkspace:7\tshell",
      "0\t0\t1\tprocess\t100\tsurface:9\tnode",
      "0\t0\t1\tprocess\t200\tworkspace:8\tnode",
      "0\t0\t1\tprocess\t300\tloop:a\tnode",
      "0\t0\t1\tloop\tloop:a\tloop:b\t",
      "0\t0\t1\tloop\tloop:b\tloop:a\t",
      "\t\t\t\t",
    ].join("\n") };
  });
  const ports = await client.workspaceListeningPortsAll(mobile, local);
  assert.deepEqual(ports.get(ID), [3000]);
  assert.deepEqual(ports.get(SURFACE), [8080], "a workspace matched by title alone still collects its ports");
  assert.equal(ports.size, 2);

  const empty = recordingClient(() => ({ stdout: "0\t0\t1\tworkspace\tworkspace:1\twindow:1\tNobody" }));
  assert.equal((await empty.client.workspaceListeningPortsAll(mobile, [])).size, 0);
  assert.equal(empty.calls.length, 1, "lsof is not run without a workspace-owned process");

  const single = recordingClient(() => ({ stdout: "0\t0\t1\tsurface\tsurface:1\tworkspace:1\tshell" }));
  assert.deepEqual(await single.client.workspaceListeningPorts(ID), []);
});
