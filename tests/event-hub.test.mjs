import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { CmuxEventHub } from "../server/event-hub.mjs";

function fixture(t) {
  const children = [];
  const hub = new CmuxEventHub({ bin: "/fake/cmux", retryDelay: 5, spawn: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kills: 0, kill() { this.kills++; } });
    children.push(child);
    return child;
  } });
  t.after(() => { hub.stop(); for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); child.emit("close"); } });
  return { hub, children };
}
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate());
}

test("failed spawn closes and retries once without claiming connection", async (t) => {
  const { hub, children } = fixture(t);
  const states = [];
  hub.on("state", state => states.push(state));
  hub.addConsumer();
  assert.deepEqual(states, []);
  children[0].emit("error", new Error("ENOENT"));
  children[0].emit("close");
  children[0].emit("close");
  await until(() => children.length === 2);
  children[1].emit("spawn");
  assert.deepEqual(states.map(s => s.connected), [false, false, true]);
  assert.equal(hub.process, children[1]);
});

test("intentional stop cancels retry and obsolete children cannot disconnect replacements", async (t) => {
  const { hub, children } = fixture(t);
  const events = [];
  hub.on("event", event => events.push(event));
  hub.addConsumer();
  const old = children[0];
  hub.removeConsumer();
  assert.equal(old.kills, 1);
  hub.addConsumer();
  old.emit("error", new Error("late error"));
  old.stdout.write('{"old":true}\n');
  old.emit("close");
  children[1].stdout.write('{"current":true}\n');
  assert.equal(hub.process, children[1]);
  assert.deepEqual(events, [{ current: true }]);
  children[1].emit("exit", 0);
  children[1].emit("close");
  hub.removeConsumer();
  await delay(20);
  assert.equal(children.length, 2);
  assert.equal(hub.retryTimer, null);
});

test("real nonexistent executable can recover through repeated spawn failures", async (t) => {
  const hub = new CmuxEventHub({ bin: "/nonexistent/companion-test-cmux", retryDelay: 5 });
  t.after(() => hub.stop());
  let errors = 0;
  hub.on("state", state => { if (state.error) errors++; });
  hub.addConsumer();
  await until(() => errors >= 2);
  hub.removeConsumer();
  assert.equal(hub.process, null);
});
