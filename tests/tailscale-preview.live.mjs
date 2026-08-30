import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PreviewManager } from "../server/preview-manager.mjs";

test("serves and removes a real tailnet-only localhost preview", { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-preview-live-"));
  const marker = `preview-live-${process.pid}`;
  const server = createServer((_request, response) => response.end(marker));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const targetPort = server.address().port;
  const manager = new PreviewManager({ path: join(directory, "previews.json"), portStart: 8580, portEnd: 8599 });
  const detected = manager.discover({ workspaceId: "workspace-live-test", name: "Live preview test", targetPort });
  let enabled = null;
  try {
    enabled = await manager.enable(detected.preview.id);
    const response = await fetch(enabled.preview.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), marker);
  } finally {
    if (enabled) await manager.stop(detected.preview.id);
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
  const status = execFileSync(manager.tailscaleBin, ["serve", "status", "--json"], { encoding: "utf8" });
  assert.equal(Boolean(JSON.parse(status).TCP?.[enabled.preview.publicPort]), false);
  t.assert?.ok?.(true);
});
