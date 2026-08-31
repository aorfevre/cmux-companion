import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptQueue } from "../server/prompt-queue.mjs";

const WORKSPACE = "workspace-test-123";
const SURFACE = "surface-test-123";

test("persists, edits, reorders, and removes queued prompts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-queue-"));
  const path = join(directory, "queue.json");
  const queue = new PromptQueue({ path });
  const first = queue.enqueue({ workspaceId: WORKSPACE, surfaceId: SURFACE, text: "first task" }).item;
  const second = queue.enqueue({ workspaceId: WORKSPACE, surfaceId: SURFACE, text: "second task" }).item;
  queue.update(second.id, { text: "updated second task" });
  queue.move(second.id, -1);
  assert.deepEqual(queue.list({ workspaceId: WORKSPACE }).items.map((item) => item.text), ["updated second task", "first task"]);
  queue.remove(first.id);
  assert.deepEqual(new PromptQueue({ path }).list().items.map((item) => item.id), [second.id]);
  assert.equal((await readFile(path, "utf8")).includes("updated second task"), true);
  assert.throws(() => queue.enqueue({ workspaceId: WORKSPACE, surfaceId: SURFACE, text: " " }), /prompt is required/i);
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test("sends one prompt after each agent stop and retains failed work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cmux-queue-events-"));
  const queue = new PromptQueue({ path: join(directory, "queue.json") });
  queue.enqueue({ workspaceId: WORKSPACE, surfaceId: SURFACE, text: "one" });
  queue.enqueue({ workspaceId: WORKSPACE, surfaceId: SURFACE, text: "two" });
  const sent = [];
  const cmux = { sendPrompt: async (surfaceId, text) => { sent.push([surfaceId, text]); } };
  const hub = new EventEmitter(); hub.addConsumer = () => {}; hub.removeConsumer = () => {};
  const detach = queue.attach({ hub, cmux });
  hub.emit("event", { name: "agent.hook.Stop", workspace_id: WORKSPACE });
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(sent, [[SURFACE, "one"]]);
  assert.deepEqual(queue.list().items.map((item) => item.text), ["two"]);
  hub.emit("event", { name: "agent.hook.Stop", payload: { workspace_id: WORKSPACE } });
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(sent.at(-1), [SURFACE, "two"]);
  assert.equal(queue.list().count, 0);
  detach();

  const failed = queue.enqueue({ workspaceId: WORKSPACE, surfaceId: SURFACE, text: "retry me" }).item;
  await assert.rejects(() => queue.sendNow(failed.id, { sendPrompt: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(queue.list().items[0].lastError, "Could not reach that cmux terminal");
  assert.equal(queue.list().items[0].attempts, 1);
  t.after(() => rm(directory, { recursive: true, force: true }));
});
