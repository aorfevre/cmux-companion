import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { superviseFrontend } from "../server/frontend-supervisor.mjs";

async function fixture(t, mode = "ready") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:http';
    const server = createServer((_request, response) => { if (${JSON.stringify(mode)} !== 'hung') response.end('ready'); });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
    process.on('message', message => { if (message === 'exit') process.exit(0); });
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const [port] = await once(child, "message");
  let closes = 0;
  const options = { frontend: child, url: `http://127.0.0.1:${port}/`, startBridge: async () => ({ app: { close: async () => { closes++; } } }), startupTimeoutMs: 500, requestTimeoutMs: 50, shutdownTimeoutMs: 200 };
  return { child, options, closes: () => closes };
}

test("hung HTTP readiness obeys an overall deadline and never starts the bridge", async t => {
  const fixtureResult = await fixture(t, "hung");
  let starts = 0;
  const start = Date.now();
  await assert.rejects(superviseFrontend({ ...fixtureResult.options, startBridge: async () => { starts++; } }), /deadline/);
  assert.equal(starts, 0);
  assert.ok(Date.now() - start < 2000);
  assert.notEqual(fixtureResult.child.signalCode, null);
});

for (const mode of ["exit", "SIGTERM"]) test(`unexpected frontend ${mode} shuts down bridge and reports failure`, async t => {
  const f = await fixture(t);
  const supervisor = await superviseFrontend(f.options);
  if (mode === "exit") f.child.send("exit"); else f.child.kill(mode);
  const result = await supervisor.closed;
  assert.equal(result.code, 1);
  assert.match(result.error.message, /unexpectedly/);
  assert.equal(f.closes(), 1);
});

test("intentional shutdown is idempotent and bridge startup failures clean up the child", async t => {
  const f = await fixture(t);
  const supervisor = await superviseFrontend(f.options);
  const results = await Promise.all([supervisor.stop(), supervisor.stop()]);
  assert.deepEqual(results.map(result => result.code), [0, 0]);
  assert.equal(f.closes(), 1);
  const failing = await fixture(t);
  await assert.rejects(superviseFrontend({ ...failing.options, startBridge: async () => { throw new Error("bridge failed"); } }), /bridge failed/);
  assert.notEqual(failing.child.signalCode, null);
});
