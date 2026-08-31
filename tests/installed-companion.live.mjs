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
  const method = init.method || "GET";
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      signal: init.signal || AbortSignal.timeout(20_000),
      headers: {
        authorization: `Bearer ${token}`,
        origin: base,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  } catch (error) {
    throw new Error(`${method} ${path} failed: ${error.message}`, { cause: error });
  }
  const body = await response.json();
  assert.equal(response.ok, true, `${method} ${path}: ${JSON.stringify(body)}`);
  return body;
}

test("installed companion reads, controls, and exposes an isolated cmux app", { timeout: 120_000 }, async (t) => {
  const tokenPath = process.env.CMUX_COMPANION_TOKEN_FILE || join(homedir(), ".config", "cmux-companion", "token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  const appPort = await availablePreviewTargetPort();
  const appScript = `require("node:http").createServer((_request,response)=>response.end("${marker}")).listen(${appPort},"127.0.0.1",()=>console.log("${marker}"))`;
  const created = await exec(bin, [
    "new-workspace",
    "--name", title,
    "--cwd", process.cwd(),
    "--command", `${process.execPath} -e ${JSON.stringify(appScript)}`,
    "--focus", "false",
  ], { encoding: "utf8", timeout: 15_000 });
  const workspaceRef = created.stdout.match(/workspace:\d+/)?.[0];
  assert.ok(workspaceRef);
  t.diagnostic("isolated localhost workspace created");

  let workspaceId;
  let attachmentPath;
  let previewId;
  let previewActive = false;
  let queuedPromptId;
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
    t.diagnostic("workspace discovered through installed bootstrap");
    const overview = await companion(`/api/workspaces/${workspaceId}/overview`, token);
    assert.equal(typeof overview.status.effective, "string");
    const repos = await companion("/api/repos", token);
    const companionRepo = repos.repos.find((repo) => repo.name === "cmux-companion");
    assert.ok(companionRepo);
    const accountUsage = await companion("/api/account-usage?refresh=1", token);
    assert.equal(accountUsage.source, "CCS");
    assert.equal(Array.isArray(accountUsage.providers), true);
    assert.equal(accountUsage.providers.some((provider) => provider.id === "claude"), true);
    assert.equal(accountUsage.providers.some((provider) => provider.id === "codex"), true);
    const worktreeDashboard = await companion("/api/worktree-dashboard?refresh=1", token);
    const companionWorktree = worktreeDashboard.repositories
      .flatMap((repository) => repository.worktrees)
      .find((worktree) => worktree.path === companionRepo.path);
    assert.ok(companionWorktree, "installed repository appears in the worktree dashboard");
    assert.equal(companionWorktree.sessions.some((session) => session.id === workspaceId), true, "isolated cmux workspace is grouped into its worktree");
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
    t.diagnostic("repository, worktree dashboard, PR, Markdown, inbox, and image APIs verified");

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
    t.diagnostic("terminal text and render-grid replay verified");
    let preview;
    let detectionState = null;
    let lastPreviews = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await companion("/api/previews", token);
      lastPreviews = current.previews;
      preview = current.previews.find((item) => item.workspaceId === workspaceId && item.targetPort === appPort);
      if (preview) break;
      detectionState = await companion("/api/bootstrap", token);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const detectedWorkspace = detectionState?.workspaces?.find((item) => item.id === workspaceId);
    const detectionDetails = JSON.stringify({
      expectedPort: appPort,
      reportedPorts: detectedWorkspace?.listening_ports || [],
      matchingPreviews: lastPreviews.filter((item) => item.workspaceId === workspaceId).map((item) => ({ port: item.targetPort, status: item.status })),
    });
    if (!preview?.id) {
      const registered = await companion("/api/previews/discover", token, { method: "POST", body: JSON.stringify({ workspaceId, repoId: companionRepo.id, port: appPort, url: `http://localhost:${appPort}` }) });
      preview = registered.preview;
      t.diagnostic(`cmux did not report its listener in time; explicit authenticated discovery succeeded: ${detectionDetails}`);
    } else {
      t.diagnostic("localhost listener automatically detected");
    }
    previewId = preview.id;
    const capture = await companion(`/api/previews/${previewId}/capture`, token, { method: "POST", body: JSON.stringify({ width: 390, height: 844 }) });
    assert.match(capture.dataUrl, /^data:image\/png;base64,iVBOR/);
    assert.deepEqual(capture.viewport, { width: 390, height: 844 });
    const queued = await companion("/api/prompt-queue", token, { method: "POST", body: JSON.stringify({ workspaceId, surfaceId: terminal.id, text: `${marker} queued follow-up` }) });
    queuedPromptId = queued.item.id;
    const queue = await companion(`/api/prompt-queue?workspaceId=${workspaceId}&surfaceId=${terminal.id}`, token);
    assert.equal(queue.items.some((item) => item.id === queuedPromptId), true);
    await companion(`/api/prompt-queue/${queuedPromptId}`, token, { method: "PATCH", body: JSON.stringify({ text: `${marker} edited follow-up` }) });
    await companion(`/api/prompt-queue/${queuedPromptId}`, token, { method: "DELETE", body: "{}" });
    queuedPromptId = null;
    t.diagnostic("mobile preview capture and persistent prompt queue verified");
    const enabled = await companion(`/api/previews/${previewId}/enable`, token, { method: "POST", body: "{}" });
    previewActive = true;
    assert.match(enabled.preview.url, /^https:\/\/.*\.ts\.net:\d+$/);
    const previewResponse = await fetch(enabled.preview.url);
    assert.equal(previewResponse.status, 200);
    assert.equal(await previewResponse.text(), marker);
    t.diagnostic("tailnet-only HTTPS preview fetched successfully");
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
    t.diagnostic("mobile viewport and terminal control verified");
  } finally {
    if (queuedPromptId) await companion(`/api/prompt-queue/${queuedPromptId}`, token, { method: "DELETE", body: "{}" }).catch(() => {});
    if (previewId && previewActive) await companion(`/api/previews/${previewId}/stop`, token, { method: "POST", body: "{}" }).catch(() => {});
    if (previewId) await companion(`/api/previews/${previewId}`, token, { method: "DELETE", body: "{}" }).catch(() => {});
    if (attachmentPath) await unlink(attachmentPath).catch(() => {});
    await exec(bin, ["workspace", "close", "--workspace", workspaceId || workspaceRef], { encoding: "utf8", timeout: 15_000 });
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
