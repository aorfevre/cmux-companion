import assert from "node:assert/strict";
import test from "node:test";
import { CmuxClient } from "../server/cmux-client.mjs";

const bin = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";
const marker = `CMUX_COMPANION_E2E_${process.pid}`;
const title = `companion-e2e-${process.pid}`;

test("creates, reads, controls, and closes an isolated live cmux workspace", { timeout: 30_000 }, async () => {
  const client = new CmuxClient({ bin });
  await client.ping();
  const created = await client.workspaceCreate({ cwd: process.cwd(), title, agent: "shell", prompt: marker });
  assert.ok(created.workspace_id, "cmux returned a workspace id");

  let workspaceId = created.workspace_id;
  try {
    let terminal;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const listing = await client.workspaceList();
      const workspace = listing.workspaces.find((item) => item.title === title);
      workspaceId = workspace?.id;
      terminal = workspace?.terminals?.[0];
      if (terminal?.is_ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(terminal?.id, "isolated terminal became ready");

    let text = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      text = (await client.readScreen(terminal.id, 40)).text;
      if (text.includes(marker)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.match(text, new RegExp(marker));
    const replay = await client.terminalReplay(terminal.id, 80);
    assert.equal(replay.render_grid.format, "cmux.render-grid.v1");
    assert.match(JSON.stringify(replay.render_grid), new RegExp(marker));
    const viewportClient = `live-test-${process.pid}`;
    try {
      const viewport = await client.terminalViewport(terminal.id, { clientId: viewportClient, generation: 1, columns: 42, rows: 18 });
      assert.equal(viewport.columns, 42);
      assert.equal(viewport.rows, 18);
      const fitted = await client.terminalReplay(terminal.id, 80);
      assert.equal(fitted.render_grid.columns, 42);
      assert.equal(fitted.render_grid.rows, 18);
    } finally {
      await client.terminalViewport(terminal.id, { clientId: viewportClient, generation: 2, clear: true });
    }
    const overview = await client.workspaceOverview(workspaceId);
    assert.equal(typeof overview.status.effective, "string");
    assert.equal(Array.isArray(overview.todos.items), true);
    await client.sendKey(terminal.id, "ctrl+c");
  } finally {
    await client.workspaceClose(workspaceId);
  }
});
