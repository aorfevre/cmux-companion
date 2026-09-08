import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractLocalUrls, PreviewManager } from "../server/preview-manager.mjs";

test("discovers localhost apps and manages isolated Tailscale Serve ports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-previews-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  let commandEnvironment;
  const execute = async (bin, args, options) => {
    calls.push([bin, ...args]);
    commandEnvironment = options.env;
    if (args[0] === "status") return { stdout: JSON.stringify({ Self: { DNSName: "mac.tail.test." } }) };
    if (args[0] === "serve" && args[1] === "status") return { stdout: JSON.stringify({ TCP: { 8500: { HTTPS: true } } }) };
    return { stdout: "" };
  };
  const manager = new PreviewManager({ path: join(directory, "previews.json"), execute, checkPort: async () => true, environment: {} });
  const found = manager.discover({ workspaceId: "workspace-123", repoId: "repo_safe_123", name: "Web", targetPort: 3000, sourceUrl: "http://localhost:3000/app" });
  assert.equal(found.created, true);
  assert.equal(manager.discover({ workspaceId: "workspace-123", targetPort: 3000 }).created, false);
  const enabled = await manager.enable(found.preview.id);
  assert.equal(enabled.preview.url, "https://mac.tail.test:8501");
  assert.equal(commandEnvironment.TERM, "dumb");
  assert.equal(calls.some((call) => call.includes("--https=8501") && call.at(-1) === "http://127.0.0.1:3000"), true);
  await manager.restart(found.preview.id);
  assert.equal(manager.list().previews[0].status, "active");
  await manager.stop(found.preview.id);
  assert.equal(manager.list().previews[0].status, "stopped");
  assert.equal((await readFile(join(directory, "previews.json"), "utf8")).includes("mac.tail.test"), false);
  assert.deepEqual(manager.remove(found.preview.id), { removed: true });
});

test("auto-detects stable workspace ports and rejects unsafe targets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-previews-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new PreviewManager({ path: join(directory, "previews.json"), execute: async () => ({ stdout: "{}" }), checkPort: async () => true });
  await manager.syncWorkspaces([{ id: "workspace-123", title: "App", current_directory: "/repo", listening_ports: [3000, 3210, 55_000], terminals: [] }], [{ id: "repo_safe_123", name: "App", path: "/repo" }]);
  assert.deepEqual(manager.list().previews.map((item) => item.targetPort), [3000]);
  await manager.syncWorkspaces([], []);
  await manager.syncWorkspaces([], []);
  assert.equal(manager.list().previews[0].status, "stopped", "closed workspaces move their apps to history");
  await manager.syncWorkspaces([{ id: "workspace-123", title: "App", current_directory: "/repo", listening_ports: [3000], terminals: [] }], []);
  assert.equal(manager.list().previews[0].status, "detected", "a restarted local app becomes testable again");
  assert.throws(() => manager.discover({ workspaceId: "bad space", targetPort: 3000 }), /Invalid workspace/);
  assert.throws(() => manager.discover({ workspaceId: "workspace-123", targetPort: 3210 }), /Invalid localhost port/);
  assert.deepEqual(extractLocalUrls("open http://localhost:5173/x and https://127.0.0.1:4443"), [
    { url: "http://localhost:5173/x", port: 5173 }, { url: "https://127.0.0.1:4443", port: 4443 },
  ]);
});

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cmux-previews-extra-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "previews.json");
  const checkPort = "checkPort" in options ? {} : { checkPort: async () => true };
  return { directory, path, manager: new PreviewManager({ path, environment: {}, ...checkPort, ...options }) };
}

const tailscale = ({ serveFails = false, serveStatus = { TCP: {} }, statusStdout = JSON.stringify({ Self: { DNSName: "mac.tail.test." } }) } = {}) => {
  const calls = [];
  const execute = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "status") return { stdout: statusStdout };
    if (args[0] === "serve" && args[1] === "status") {
      if (serveStatus instanceof Error) throw serveStatus;
      return { stdout: JSON.stringify(serveStatus) };
    }
    if (args[0] === "serve" && serveFails) throw new Error("tailscale serve failed");
    return { stdout: "" };
  };
  return { calls, execute };
};

test("enable reports a Tailscale Serve failure without recording a link", async (t) => {
  const { execute } = tailscale({ serveFails: true });
  const { manager } = fixture(t, { execute });
  const { preview } = manager.discover({ workspaceId: "workspace-123", targetPort: 3000 });
  await assert.rejects(manager.enable(preview.id), /Tailscale could not create that private preview link/);
  assert.equal(manager.list().previews[0].status, "detected");
  assert.equal(manager.list().previews[0].url, null);
});

test("enable refuses a localhost app that is not accepting connections", async (t) => {
  const { execute, calls } = tailscale();
  const { manager } = fixture(t, { execute, checkPort: async () => false });
  const { preview } = manager.discover({ workspaceId: "workspace-123", targetPort: 3000 });
  await assert.rejects(manager.enable(preview.id), /not accepting connections/);
  assert.equal(calls.length, 0, "Tailscale is never asked for an app that is down");
});

test("the next public port skips ports Tailscale already serves and tolerates a failed status read", async (t) => {
  const failing = tailscale({ serveStatus: new Error("tailscale is not running") });
  const { manager } = fixture(t, { execute: failing.execute, portStart: 8500, portEnd: 8501 });
  assert.equal(await manager.nextPublicPort(), 8500, "a failed status read falls back to the first port of the range");
  const busy = tailscale({ serveStatus: { TCP: { 8500: {}, 8501: {} } } });
  const exhausted = fixture(t, { execute: busy.execute, portStart: 8500, portEnd: 8501 });
  await assert.rejects(exhausted.manager.nextPublicPort(), /No private preview ports are available/);
  const { preview } = exhausted.manager.discover({ workspaceId: "workspace-123", targetPort: 3000 });
  await assert.rejects(exhausted.manager.enable(preview.id), /No private preview ports are available/);
});

test("a previously assigned public port is reused across restarts", async (t) => {
  const { execute, calls } = tailscale({ serveStatus: { TCP: { 8500: {} } } });
  const { manager } = fixture(t, { execute });
  const { preview } = manager.discover({ workspaceId: "workspace-123", targetPort: 3000 });
  await manager.enable(preview.id);
  assert.equal(manager.list().previews[0].publicPort, 8501);
  await manager.stop(preview.id);
  calls.length = 0;
  await manager.enable(preview.id);
  assert.equal(manager.list().previews[0].publicPort, 8501);
  assert.equal(calls.some((args) => args[1] === "status"), false, "no port lookup runs when a port is already assigned");
});

test("tailnet hostname failures are reported as unavailable", async (t) => {
  const broken = fixture(t, { execute: tailscale({ statusStdout: "not json" }).execute });
  await assert.rejects(broken.manager.tailnetHostname(), /Tailscale DNS name is unavailable/);
  const unsafe = fixture(t, { execute: tailscale({ statusStdout: JSON.stringify({ Self: { DNSName: "bad host!" } }) }).execute });
  await assert.rejects(unsafe.manager.tailnetHostname(), /Tailscale DNS name is unavailable/);
  const missing = fixture(t, { execute: tailscale({ statusStdout: JSON.stringify({ Self: {} }) }).execute });
  await assert.rejects(missing.manager.tailnetHostname(), /Tailscale DNS name is unavailable/);
});

test("stop without a public port skips Tailscale, and removal is refused while active", async (t) => {
  const { execute, calls } = tailscale();
  const { manager } = fixture(t, { execute });
  const { preview } = manager.discover({ workspaceId: "workspace-123", targetPort: 3000 });
  const stopped = await manager.stop(preview.id);
  assert.equal(stopped.preview.status, "stopped");
  assert.equal(calls.length, 0);
  assert.equal(manager.discover({ workspaceId: "workspace-123", targetPort: 3000 }).preview.status, "detected", "rediscovery revives a stopped app");
  await manager.enable(preview.id);
  assert.throws(() => manager.remove(preview.id), /Stop the preview before removing it/);
  assert.deepEqual(await manager.stop(preview.id, { preserve: false }), { removed: true });
  assert.deepEqual(manager.list().previews, []);
  assert.throws(() => manager.require(preview.id), /Unknown preview/);
  assert.throws(() => manager.discover({ workspaceId: "workspace-123", targetPort: 70_000 }), /Invalid localhost port/);
});

test("stored previews are normalized on load and unsafe records are dropped", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cmux-previews-stored-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "previews.json");
  writeFileSync(path, JSON.stringify({ previews: [
    { id: "stale-id", workspaceId: "workspace-123", targetPort: "3000", repoId: "bad id", name: "  ", publicPort: "8500", sourceUrl: "http://localhost:3000/app", url: "https://mac.tail.test:8500", status: "active", detectedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", misses: "1" },
    { workspaceId: "workspace-456", targetPort: 4000, publicPort: 8501, url: "http://insecure", status: "stopped" },
    { workspaceId: "workspace-789", targetPort: 5000, status: "detected" },
    { workspaceId: "workspace-111", targetPort: 6000, status: "active" },
    { workspaceId: "bad space", targetPort: 3000 },
    { workspaceId: "workspace-000", targetPort: 3210 },
  ] }));
  const manager = new PreviewManager({ path, execute: async () => ({ stdout: "" }), checkPort: async () => true, environment: {} });
  const previews = manager.list().previews;
  assert.equal(previews.length, 4, "invalid workspace ids and blocked ports are dropped");
  const active = previews.find((item) => item.workspaceId === "workspace-123");
  assert.notEqual(active.id, "stale-id", "the id is recomputed from the workspace and port");
  assert.equal(active.targetPort, 3000);
  assert.equal(active.repoId, null);
  assert.equal(active.name, "Local app");
  assert.equal(active.publicPort, null, "a non-integer public port is not trusted");
  assert.equal(active.sourceUrl, "http://localhost:3000/app");
  assert.equal(active.status, "active");
  assert.equal(active.misses, 1);
  const insecure = previews.find((item) => item.workspaceId === "workspace-456");
  assert.equal(insecure.url, null, "only https links are kept");
  assert.equal(insecure.status, "stopped");
  assert.equal(insecure.publicPort, 8501);
  assert.equal(previews.find((item) => item.workspaceId === "workspace-111").status, "stopped", "an active record without a link is not active");
  const detected = previews.find((item) => item.workspaceId === "workspace-789");
  assert.equal(detected.status, "detected");
  assert.ok(detected.detectedAt && detected.updatedAt);
  assert.equal(detected.sourceUrl, "http://localhost:5000");
});

test("the default port probe reports a live loopback listener and a closed port", async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const { execute } = tailscale();
  const { manager } = fixture(t, { execute, checkPort: undefined });
  const { preview } = manager.discover({ workspaceId: "workspace-123", targetPort: port });
  const enabled = await manager.enable(preview.id);
  assert.equal(enabled.preview.status, "active");
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(manager.enable(preview.id), /not accepting connections/);
});

test("workspace sync stops an active preview after two misses and resolves repositories through terminals", async (t) => {
  const { execute, calls } = tailscale();
  const { manager } = fixture(t, { execute });
  const workspace = { id: "workspace-123", title: "Terminal app", terminals: [{ current_directory: "/repo/app/src" }], listening_ports: [3000, 80, 60_000, "not-a-port"] };
  await manager.syncWorkspaces([workspace], [{ id: "repo_safe_123", name: "App", path: "/repo/app" }]);
  const [preview] = manager.list().previews;
  assert.equal(preview.repoId, "repo_safe_123");
  assert.equal(preview.name, "App");
  assert.equal(manager.list().previews.length, 1);
  await manager.enable(preview.id);
  await manager.syncWorkspaces([], []);
  assert.equal(manager.list().previews[0].status, "active", "one miss is tolerated");
  await manager.syncWorkspaces([], []);
  assert.equal(manager.list().previews[0].status, "stopped");
  assert.ok(calls.some((args) => args[0] === "serve" && args.at(-1) === "off"), "the Serve link is torn down");
  assert.equal(manager.list().previews[0].publicPort, 8500, "the port stays reserved for a restart");
});

test("the command environment keeps an explicit TERM and extractLocalUrls bounds and deduplicates matches", (t) => {
  const { manager } = fixture(t, { execute: async () => ({ stdout: "" }), environment: { TERM: "xterm", PATH: "/bin" } });
  assert.deepEqual(manager.environment, { TERM: "xterm", PATH: "/bin" });
  assert.deepEqual(extractLocalUrls("http://localhost http://localhost https://[::1]/x http://127.0.0.1:3210/ http://localhost:99999"), [
    { url: "http://localhost", port: 80 }, { url: "https://[::1]/x", port: 443 },
  ]);
  assert.deepEqual(extractLocalUrls(null), []);
  const many = Array.from({ length: 15 }, (_, index) => `http://localhost:${4000 + index}`).join(" ");
  assert.equal(extractLocalUrls(many).length, 12);
});
