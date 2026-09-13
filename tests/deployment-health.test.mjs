import test from "node:test";
import assert from "node:assert/strict";
import { updaterLaunchAgentRunning } from "../server/deployment-health.mjs";

// The launch agent probe asks launchctl on macOS only; elsewhere and when the
// probe itself fails it must answer "not running" instead of throwing.
test("the updater launch agent probe returns false when launchctl cannot be consulted", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const getuid = process.getuid;
  t.after(() => { Object.defineProperty(process, "platform", platform); process.getuid = getuid; });
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  assert.equal(await updaterLaunchAgentRunning(), false);
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  process.getuid = undefined;
  assert.equal(await updaterLaunchAgentRunning(), false);
  // A uid that no launchd domain owns makes launchctl fail; the probe reports false.
  process.getuid = () => 2_147_483_646;
  assert.equal(await updaterLaunchAgentRunning(), false);
});

test("the updater launch agent probe reads the real launchd answer on macOS", { skip: process.platform !== "darwin" ? "launchctl is macOS-only" : false }, async () => {
  const running = await updaterLaunchAgentRunning();
  assert.equal(typeof running, "boolean");
});

test('bundled updater heartbeat stays fresh between five-minute discovery checks', async () => {
  const { deploymentStatus } = await import('../server/deployment-health.mjs');
  const now = Date.now(), sha = 'a'.repeat(40);
  const status = deploymentStatus({ phase: 'idle', deployedSha: sha, observedRemoteSha: sha, updaterDeployedSha: sha, updaterObservedRemoteSha: sha, lastCheckAt: new Date(now - 240000).toISOString(), lastHeartbeatAt: new Date(now - 1000).toISOString() }, { gitSha: sha }, now, { updaterProcessRunning: true });
  assert.equal(status.services.updater.alive, true); assert.equal(status.summary, 'healthy');
});
