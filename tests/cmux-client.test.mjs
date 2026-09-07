import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("configures provider executables while retaining aliases and safely quoting Kimi prompts", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "launcher-test-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const calls = [];
  const client = new CmuxClient({ launcherEnv: { CMUX_COMPANION_CODEX_COMMAND: "codex", CMUX_COMPANION_KIMI_COMMAND: "/Applications/My CLI/kimi" }, execute: async (_bin, args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ workspace_id: ID }) };
  } });
  await client.workspaceCreate({ cwd: repo, title: "Kimi", agent: "kimi", prompt: "$(touch /tmp/nope) 'quoted'", model: "kimi-test" });
  assert.equal(JSON.parse(calls.at(-1)[3]).text, "'/Applications/My CLI/kimi' --model 'kimi-test' --prompt '$(touch /tmp/nope) '\\''quoted'\\'''\n");
  await client.workspaceCreate({ cwd: repo, title: "Codex", agent: "codex" });
  assert.equal(JSON.parse(calls.at(-1)[3]).text, "codex\n");
  await client.workspaceCreate({ cwd: repo, title: "Claude", agent: "claude" });
  assert.equal(JSON.parse(calls.at(-1)[3]).text, "xclaude\n");
  await client.workspaceCreate({ cwd: repo, title: "Kimi", agent: "kimi" });
  assert.equal(JSON.parse(calls.at(-1)[3]).text, "'/Applications/My CLI/kimi'\n");
  for (const command of ["ccs kimi", "kimi; touch /tmp/nope", "$(whoami)", "kimi\n", "", "--help"]) {
    assert.throws(() => new CmuxClient({ launcherEnv: { CMUX_COMPANION_KIMI_COMMAND: command } }), /Invalid kimi launcher/);
  }
});
