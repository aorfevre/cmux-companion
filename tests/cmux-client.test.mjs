import assert from "node:assert/strict";
import test from "node:test";
import { CmuxClient, parseWorkspaceMetrics } from "../server/cmux-client.mjs";

const ID = "11111111-2222-4333-8444-555555555555";

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

test("rejects arbitrary targets, keys, and oversized input", async () => {
  const client = new CmuxClient({ execute: async () => ({ stdout: "", stderr: "" }) });
  await client.sendPrompt(ID, "x".repeat(16_000));
  await assert.rejects(() => client.readScreen("surface:1"), /Invalid cmux target/);
  await assert.rejects(() => client.sendKey(ID, "cmd+q"), /Unsupported key/);
  await assert.rejects(() => client.sendText(ID, "x".repeat(16_001)), /16,000/);
  await assert.rejects(() => client.sendPrompt(ID, "x".repeat(16_001)), /16,000/);
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

test("uses structured RPC for safe workspace launch and shell-quotes prompts", async () => {
  const calls = [];
  const client = new CmuxClient({ execute: async (_bin, args) => {
    calls.push(args);
    if (args.includes("workspace.create")) return { stdout: JSON.stringify({ workspace_id: ID }), stderr: "" };
    return { stdout: "{}", stderr: "" };
  } });
  const created = await client.workspaceCreate({ cwd: "/approved/repo", title: "Test", agent: "codex", prompt: "fix 'quotes'; touch /tmp/nope" });
  assert.equal(created.workspace_id, ID);
  assert.deepEqual(JSON.parse(calls[0][3]), { cwd: "/approved/repo", title: "Test", focus: false });
  const send = JSON.parse(calls[1][3]);
  assert.equal(send.workspace_id, ID);
  assert.equal(send.text, "xcodex 'fix '\\''quotes'\\''; touch /tmp/nope'\n");
  calls.length = 0;
  await client.workspaceCreate({ cwd: "/approved/repo", title: "Claude", agent: "claude" });
  assert.equal(JSON.parse(calls[1][3]).text, "xclaude\n");
  await assert.rejects(() => client.workspaceCreate({ cwd: "/tmp", title: "x", agent: "evil" }), /Unsupported agent/);
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
