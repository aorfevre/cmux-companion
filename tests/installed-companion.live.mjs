import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const bin = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";
const base = process.env.CMUX_COMPANION_URL || "http://127.0.0.1:3210";
const marker = `CMUX_COMPANION_INSTALLED_E2E_${process.pid}`;
const title = `companion-installed-e2e-${process.pid}`;
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function companion(path, token, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      origin: base,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json();
  assert.equal(response.ok, true, JSON.stringify(body));
  return body;
}

test("installed companion reads, controls, and exposes an isolated cmux app", { timeout: 60_000 }, async () => {
  const tokenPath = process.env.CMUX_COMPANION_TOKEN_FILE || join(homedir(), ".config", "cmux-companion", "token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  const appPort = await availablePreviewTargetPort();
  const appScript = `require("node:http").createServer((_request,response)=>response.end("${marker}")).listen(${appPort},"127.0.0.1",()=>console.log("${marker}"))`;
  const created = await exec(bin, [
    "new-workspace",
    "--name", title,
    "--cwd", "/tmp",
    "--command", `${process.execPath} -e ${JSON.stringify(appScript)}`,
    "--focus", "false",
  ], { encoding: "utf8" });
  const workspaceRef = created.stdout.match(/workspace:\d+/)?.[0];
  assert.ok(workspaceRef);

  let workspaceId;
  let attachmentPath;
  let previewId;
  let previewActive = false;
  try {
    let terminal;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await companion("/api/bootstrap", token);
      const workspace = state.workspaces.find((item) => item.title === title);
      workspaceId = workspace?.id;
      terminal = workspace?.terminals?.[0];
      if (terminal?.is_ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(terminal?.id, "workspace appeared through the installed companion");
    const overview = await companion(`/api/workspaces/${workspaceId}/overview`, token);
    assert.equal(typeof overview.status.effective, "string");
    const repos = await companion("/api/repos", token);
    const companionRepo = repos.repos.find((repo) => repo.name === "cmux-companion");
    assert.ok(companionRepo);
    const pullRequest = await companion(`/api/repos/${companionRepo.id}/pull-request?refresh=1`, token);
    assert.equal(typeof pullRequest.available, "boolean");
    const markdown = await companion(`/api/repos/${companionRepo.id}/markdown?file=README.md`, token);
    assert.equal(markdown.path, "README.md");
    assert.match(markdown.content, /# cmux companion/);
    const previews = await companion("/api/previews", token);
    assert.equal(previews.tailnetOnly, true);
    assert.equal(Array.isArray(previews.previews), true);
    const inbox = await companion("/api/inbox", token);
    assert.equal(Array.isArray(inbox.items), true);
    const uploaded = await companion("/api/attachments/images", token, {
      method: "POST",
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${onePixelPng}`, name: "installed-test.png" }),
    });
    attachmentPath = uploaded.image.path;
    assert.equal(uploaded.image.mime, "image/png");
    assert.equal((await readFile(attachmentPath)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    let screen;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      screen = await companion(`/api/terminals/${terminal.id}/screen?lines=40`, token);
      if (screen.text.includes(marker)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(screen.text, new RegExp(marker));
    const replay = await companion(`/api/terminals/${terminal.id}/replay?scrollback=80`, token);
    assert.equal(replay.mode, "grid");
    assert.equal(replay.render_grid.format, "cmux.render-grid.v1");
    assert.match(JSON.stringify(replay.render_grid), new RegExp(marker));
    let preview;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await companion("/api/previews", token);
      preview = current.previews.find((item) => item.workspaceId === workspaceId && item.targetPort === appPort);
      if (preview) break;
      await companion("/api/bootstrap", token);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(preview?.id, "localhost app was detected from the cmux workspace");
    previewId = preview.id;
    const enabled = await companion(`/api/previews/${previewId}/enable`, token, { method: "POST", body: "{}" });
    previewActive = true;
    assert.match(enabled.preview.url, /^https:\/\/.*\.ts\.net:\d+$/);
    const previewResponse = await fetch(enabled.preview.url);
    assert.equal(previewResponse.status, 200);
    assert.equal(await previewResponse.text(), marker);
    await companion(`/api/previews/${previewId}/stop`, token, { method: "POST", body: "{}" });
    previewActive = false;
    await companion(`/api/previews/${previewId}`, token, { method: "DELETE", body: "{}" });
    previewId = null;
    const viewportClient = `installed-test-${process.pid}`;
    try {
      const viewport = await companion(`/api/terminals/${terminal.id}/viewport`, token, {
        method: "POST",
        body: JSON.stringify({ clientId: viewportClient, generation: 1, columns: 42, rows: 18 }),
      });
      assert.equal(viewport.columns, 42);
      assert.equal(viewport.rows, 18);
      const fitted = await companion(`/api/terminals/${terminal.id}/replay?scrollback=80`, token);
      assert.equal(fitted.render_grid.columns, 42);
      assert.equal(fitted.render_grid.rows, 18);
    } finally {
      await companion(`/api/terminals/${terminal.id}/viewport`, token, {
        method: "POST",
        body: JSON.stringify({ clientId: viewportClient, generation: 2, clear: true }),
      });
    }
    const controlled = await companion(`/api/terminals/${terminal.id}/key`, token, {
      method: "POST",
      body: JSON.stringify({ key: "ctrl+c" }),
    });
    assert.equal(controlled.ok, true);
  } finally {
    if (previewId && previewActive) await companion(`/api/previews/${previewId}/stop`, token, { method: "POST", body: "{}" }).catch(() => {});
    if (previewId) await companion(`/api/previews/${previewId}`, token, { method: "DELETE", body: "{}" }).catch(() => {});
    if (attachmentPath) await unlink(attachmentPath).catch(() => {});
    await exec(bin, ["workspace", "close", "--workspace", workspaceId || workspaceRef], { encoding: "utf8" });
  }
});

async function availablePreviewTargetPort() {
  for (let port = 41_000; port < 42_000; port += 1) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      await new Promise((resolve) => server.close(resolve));
      return port;
    } catch {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  }
  throw new Error("No local preview test port is available");
}
