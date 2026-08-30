import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractLocalUrls, PreviewManager } from "../server/preview-manager.mjs";

test("discovers localhost apps and manages isolated Tailscale Serve ports", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-previews-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const execute = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === "status") return { stdout: JSON.stringify({ Self: { DNSName: "mac.tail.test." } }) };
    if (args[0] === "serve" && args[1] === "status") return { stdout: JSON.stringify({ TCP: { 8500: { HTTPS: true } } }) };
    return { stdout: "" };
  };
  const manager = new PreviewManager({ path: join(directory, "previews.json"), execute, checkPort: async () => true });
  const found = manager.discover({ workspaceId: "workspace-123", repoId: "repo_safe_123", name: "Web", targetPort: 3000, sourceUrl: "http://localhost:3000/app" });
  assert.equal(found.created, true);
  assert.equal(manager.discover({ workspaceId: "workspace-123", targetPort: 3000 }).created, false);
  const enabled = await manager.enable(found.preview.id);
  assert.equal(enabled.preview.url, "https://mac.tail.test:8501");
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
  assert.throws(() => manager.discover({ workspaceId: "bad space", targetPort: 3000 }), /Invalid workspace/);
  assert.throws(() => manager.discover({ workspaceId: "workspace-123", targetPort: 3210 }), /Invalid localhost port/);
  assert.deepEqual(extractLocalUrls("open http://localhost:5173/x and https://127.0.0.1:4443"), [
    { url: "http://localhost:5173/x", port: 5173 }, { url: "https://127.0.0.1:4443", port: 4443 },
  ]);
});

