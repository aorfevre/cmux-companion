import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { CmuxClient } from "../server/cmux-client.mjs";

const exec = promisify(execFile);
const bin = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";
const marker = `CMUX_COMPANION_E2E_${process.pid}`;
const title = `companion-e2e-${process.pid}`;

test("creates, reads, controls, and closes an isolated live cmux workspace", { timeout: 30_000 }, async () => {
  const client = new CmuxClient({ bin });
  await client.ping();
  const created = await exec(bin, [
    "new-workspace",
    "--name", title,
    "--cwd", "/tmp",
    "--command", `printf '${marker}\\n'; sleep 20`,
    "--focus", "false",
  ], { encoding: "utf8" });
  const workspaceRef = created.stdout.match(/workspace:\d+/)?.[0];
  assert.ok(workspaceRef, "cmux returned a workspace reference");

  let workspaceId;
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
    await client.sendKey(terminal.id, "ctrl+c");
  } finally {
    await exec(bin, ["workspace", "close", "--workspace", workspaceId || workspaceRef], { encoding: "utf8" });
  }
});
