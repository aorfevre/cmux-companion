import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const bin = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";
const base = process.env.CMUX_COMPANION_URL || "http://127.0.0.1:3210";
const marker = `CMUX_COMPANION_INSTALLED_E2E_${process.pid}`;
const title = `companion-installed-e2e-${process.pid}`;

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
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test("installed companion reads and controls an isolated cmux terminal", { timeout: 30_000 }, async () => {
  const tokenPath = process.env.CMUX_COMPANION_TOKEN_FILE || join(homedir(), ".config", "cmux-companion", "token");
  const token = (await readFile(tokenPath, "utf8")).trim();
  const created = await exec(bin, [
    "new-workspace",
    "--name", title,
    "--cwd", "/tmp",
    "--command", `printf '${marker}\\n'; sleep 20`,
    "--focus", "false",
  ], { encoding: "utf8" });
  const workspaceRef = created.stdout.match(/workspace:\d+/)?.[0];
  assert.ok(workspaceRef);

  let workspaceId;
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
    const inbox = await companion("/api/inbox", token);
    assert.equal(Array.isArray(inbox.items), true);

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
    await exec(bin, ["workspace", "close", "--workspace", workspaceId || workspaceRef], { encoding: "utf8" });
  }
});
