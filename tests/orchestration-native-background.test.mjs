import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, mkdir, readFile, writeFile, stat, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { NativeInputs } from '../server/orchestration/adapters/native-inputs.mjs';
import { NativeBackground } from '../server/orchestration/adapters/native-background.mjs';
const capabilities = { restricted: true, manualPermissions: true, hooks: true, strictMcp: true, streamJson: true, permissionPromptsNone: true, terminal: true };
const policy = { ceilingMs: 10000, idleMs: 8000, maxOutputBytes: 2 * 1024 * 1024, killGraceMs: 100 };
const conversationId = 'e7be1651-cb20-41e0-b658-c2d42c1d2c9f';
async function fixture(t, { role = 'reviewer' } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'orchestration-native-')));
  const worktree = join(directory, 'worktree'); await mkdir(worktree);
  const bin = join(directory, 'fake-native'), release = join(directory, 'release'), ready = join(directory, 'ready'), launches = join(directory, 'launches');
  await writeFile(bin, `#!${process.execPath}
import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.FAKE_ESCAPE_PID) {
  const escaped = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.env.FAKE_ESCAPE_PID, String(process.pid)); setInterval(() => {}, 1000);'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: process.env }); escaped.unref();
}
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const envelope = JSON.parse(readFileSync(arg('--append-system-prompt-file'), 'utf8').split('\\n')[0]);
appendFileSync(process.env.FAKE_LAUNCHES, 'launch\\n'); writeFileSync(process.env.FAKE_READY, 'ready');
const timer = setInterval(() => {
  if (!existsSync(process.env.FAKE_RELEASE)) return;
  clearInterval(timer);
  if (process.env.FAKE_CONTROL_BYTES) { process.stdout.write(Buffer.alloc(Number(process.env.FAKE_CONTROL_BYTES))); return; }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: arg('--session-id'), result: JSON.stringify(envelope) }) + '\\n');
}, 10);
`, { mode: 0o700 });
  const request = { goalId: 'goal', operationId: 'operation', attempt: { id: 'attempt', operationId: 'operation', role, mode: 'background', generation: 1, revision: 1, conversationId, target: 'a'.repeat(40), baseSha: 'a'.repeat(40), branch: 'companion/goal/attempt', worktree } };
  const envelope = { schemaVersion: 1, goalId: request.goalId, operationId: request.operationId, attemptId: request.attempt.id, role, generation: 1, revision: 1, target: request.attempt.target, output: { schemaVersion: 1, target: request.attempt.target, disposition: 'accept', findings: [] } };
  const inputs = new NativeInputs({ engine: { provider: 'default', model: 'fixture' }, capabilities, env: { PATH: process.env.PATH, FAKE_RELEASE: release, FAKE_READY: ready, FAKE_LAUNCHES: launches }, describe: () => ({ prompt: JSON.stringify(envelope), bridge: { endpoint: 'http://127.0.0.1:1', credential: 'private-scoped-credential-at-least-32-characters' } }) });
  const delivered = [], errors = [];
  const options = { directory: join(directory, 'native'), bin, inputs, policy, onResult: async (request, raw) => { delivered.push({ request, raw }); }, onError: (code) => errors.push(code) };
  const driver = new NativeBackground(options);
  t.after(async () => { await driver.close(); await rm(directory, { recursive: true, force: true }); });
  const waitReady = async () => {
    const deadline = Date.now() + 5000;
    while (true) { try { await access(ready); return; } catch { assert.ok(Date.now() < deadline, 'fixture worker did not reach its ready barrier'); await new Promise((resolve) => setTimeout(resolve, 10)); } }
  };
  return { directory, worktree, request, inputs, driver, options, delivered, errors, launches, release: () => writeFile(release, 'go'), waitReady };
}

test('native inputs and scoped credentials stay private and outside restricted tool directories', async (t) => {
  const f = await fixture(t, { role: 'implementer' });
  const inputsDirectory = join(f.directory, 'inputs'); await mkdir(inputsDirectory, { mode: 0o700 });
  const command = await f.inputs.prepare(f.request, inputsDirectory);
  assert.ok(!JSON.stringify(command.argv).includes('private-scoped-credential'));
  assert.ok(!command.argv.includes('--add-dir'));
  for (const name of ['context.txt', 'settings.json', 'mcp.json', 'hook.json', 'bridge.json']) assert.equal((await stat(join(inputsDirectory, name))).mode & 0o777, 0o600);
  const mcp = JSON.parse(await readFile(join(inputsDirectory, 'mcp.json'), 'utf8')); assert.ok(!JSON.stringify(mcp).includes('private-scoped-credential'));
  assert.deepEqual(await f.inputs.prepare(f.request, inputsDirectory), command);
  const unsafe = join(f.worktree, 'private'); await mkdir(unsafe);
  await assert.rejects(f.inputs.prepare(f.request, unsafe), { code: 'FORBIDDEN' });
});

test('native background launches once, pins running process identity and durably delivers structured output', async (t) => {
  const f = await fixture(t); assert.equal(f.driver.active.size, 0);
  const [first, duplicate] = await Promise.all([f.driver.launch(f.request), f.driver.launch(f.request)]);
  assert.deepEqual(first, duplicate); await f.waitReady();
  const reopened = new NativeBackground(f.options);
  assert.deepEqual(await reopened.observe('operation'), { status: 'running', identity: first.identity });
  assert.deepEqual(await reopened.launch(f.request), first);
  await f.release(); await Promise.all([...f.driver.active.values()].map((active) => active.job));
  assert.equal((await reopened.observe('operation')).status, 'stopped');
  assert.equal((await readFile(f.launches, 'utf8')).trim(), 'launch'); assert.equal(f.delivered.length, 1);
  assert.equal(JSON.parse(f.delivered[0].raw).attemptId, 'attempt'); assert.deepEqual(f.errors, []);
  await reopened.close();
});

test('native result delivery replays after callback loss without relaunching the process', async (t) => {
  const f = await fixture(t); let fail = true;
  f.driver.onResult = async (request, raw) => { f.delivered.push({ request, raw }); if (fail) throw new Error('store unavailable'); };
  await f.driver.launch(f.request); await f.waitReady(); await f.release();
  await Promise.all([...f.driver.active.values()].map((active) => active.job));
  assert.equal(f.delivered.length, 1); fail = false;
  const reopened = new NativeBackground({ ...f.options, onResult: f.driver.onResult });
  assert.equal((await reopened.observe('operation')).status, 'stopped');
  assert.equal(f.delivered.length, 2); assert.equal(f.delivered[0].raw, f.delivered[1].raw);
  await reopened.observe('operation'); assert.equal(f.delivered.length, 2);
  assert.equal((await readFile(f.launches, 'utf8')).trim(), 'launch'); await reopened.close();
});

test('a sent launch with lost identity remains uncertain and cannot relaunch', async (t) => {
  const f = await fixture(t);
  f.driver.failpoint = (point) => { if (point === 'sent') throw new Error('process interrupted'); };
  await assert.rejects(f.driver.launch(f.request), { code: 'OWNERSHIP_UNCERTAIN' });
  const reopened = new NativeBackground(f.options);
  assert.deepEqual(await reopened.observe('operation'), { status: 'unknown', identity: null });
  await assert.rejects(reopened.launch(f.request), { code: 'OWNERSHIP_UNCERTAIN' });
  await assert.rejects(f.driver.close(), { code: 'OWNERSHIP_UNCERTAIN' });
  await assert.rejects(access(f.launches), { code: 'ENOENT' });
  // This test killed the boundary before spawn and can prove there is no worker.
  // Clear only this test instance's shutdown responsibility; receipt remains uncertain.
  assert.equal((await reopened.observe('operation')).status, 'unknown');
  reopened.boot = () => 'simulated-next-kernel-boot';
  assert.equal((await reopened.observe('operation')).status, 'stopped');
  f.driver.managed.clear(); await reopened.close();
});

test('close terminates an owned live native worker and retains its recovery evidence', async (t) => {
  const f = await fixture(t); await f.driver.launch(f.request); await f.waitReady();
  await f.driver.close(); assert.equal((await f.driver.observe('operation')).status, 'stopped');
  assert.equal(f.delivered.length, 0);
  const receipt = JSON.parse(await readFile(join(f.options.directory, 'operation', 'outcome.json'), 'utf8'));
  assert.equal(receipt.outcome.cause.code, 'ABORTED');
  await access(join(f.options.directory, 'operation', 'context.txt'));
  assert.throws(() => f.driver.launch(f.request), { code: 'NOT_READY' });
});

test('concurrent native launch rejects a changed binding while input preparation is pending', async (t) => {
  const f = await fixture(t); const describe = f.inputs.describe; let release;
  const pending = new Promise((resolve) => { release = resolve; });
  f.inputs.describe = async (request) => { await pending; return describe(request); };
  const first = f.driver.launch(f.request);
  assert.throws(() => f.driver.launch({ ...f.request, attempt: { ...f.request.attempt, generation: 2 } }), { code: 'IDEMPOTENCY_CONFLICT' });
  release(); await first; await f.waitReady(); await f.release();
  await Promise.all([...f.driver.active.values()].map((active) => active.job));
  assert.equal(f.driver.active.size, 0); assert.equal(f.driver.managed.size, 0);
  assert.equal((await readFile(f.launches, 'utf8')).trim(), 'launch');
});

async function waitFile(path, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (true) { try { return await readFile(path, 'utf8'); } catch { assert.ok(Date.now() < deadline, `fixture receipt unavailable: ${path}`); await new Promise((resolve) => setTimeout(resolve, 10)); } }
}

test('independent native watchdog survives actual service SIGKILL and enforces its persisted limits', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const launcher = join(f.directory, 'service.mjs'), configuration = join(f.directory, 'service.json');
  await writeFile(configuration, JSON.stringify({ directory: f.options.directory, bin: f.options.bin, request: f.request, prompt: (await f.inputs.describe(f.request)).prompt, env: f.inputs.env, capabilities, policy: { ...policy, ceilingMs: 1000, idleMs: 800 } }), { mode: 0o600 });
  const inputsUrl = new URL('../server/orchestration/adapters/native-inputs.mjs', import.meta.url).href;
  const driverUrl = new URL('../server/orchestration/adapters/native-background.mjs', import.meta.url).href;
  await writeFile(launcher, `import { readFileSync } from 'node:fs';
import { NativeInputs } from ${JSON.stringify(inputsUrl)};
import { NativeBackground } from ${JSON.stringify(driverUrl)};
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inputs = new NativeInputs({ engine: { provider: 'default', model: 'fixture' }, capabilities: config.capabilities, env: config.env, describe: () => ({ prompt: config.prompt }) });
const driver = new NativeBackground({ ...config, inputs, onResult: () => {} });
await driver.launch(config.request); process.stdout.write('ready\\n');
`, { mode: 0o600 });
  const service = spawn(process.execPath, [launcher, configuration], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  t.after(() => { if (service.exitCode === null && service.signalCode === null) service.kill('SIGKILL'); });
  let stderr = ''; service.stderr.on('data', (chunk) => { stderr += chunk; });
  await once(service.stdout, 'data'); await f.waitReady();
  const exit = once(service, 'exit'); service.kill('SIGKILL'); assert.equal((await exit)[1], 'SIGKILL');
  const receipt = JSON.parse(await waitFile(join(f.options.directory, 'operation', 'outcome.json')));
  assert.equal(receipt.outcome.workerState, 'stopped');
  assert.ok(['IDLE_LIMIT', 'CEILING_LIMIT'].includes(receipt.outcome.cause.code));
  const recovered = new NativeBackground(f.options);
  assert.equal((await recovered.observe('operation')).status, 'stopped');
  await recovered.launch(f.request); assert.equal((await readFile(f.launches, 'utf8')).trim(), 'launch');
  assert.equal(stderr, ''); await recovered.close();
});

test('escaped native descendant remains uncertain after the original group disappears', { timeout: 10000 }, async (t) => {
  const f = await fixture(t); const escapedPath = join(f.directory, 'escaped.pid');
  f.inputs.env.FAKE_ESCAPE_PID = escapedPath;
  f.driver.policy = { ...policy, ceilingMs: 1000, idleMs: 300, killGraceMs: 30 };
  await f.driver.launch(f.request); await f.waitReady();
  const escapedPid = Number(await waitFile(escapedPath));
  t.after(() => { try { process.kill(-escapedPid, 'SIGKILL'); } catch { /* already reaped */ } });
  await waitFile(join(f.options.directory, 'operation', 'provider.json'));
  await f.release(); await Promise.all([...f.driver.active.values()].map((active) => active.job));
  const observation = await f.driver.observe('operation'); assert.equal(observation.status, 'unknown');
  process.kill(escapedPid, 0); // Actual escaped worker still exists, despite original group loss.
  await assert.rejects(f.driver.close(), { code: 'OWNERSHIP_UNCERTAIN' });
  const reopened = new NativeBackground(f.options);
  assert.equal((await reopened.observe('operation')).status, 'unknown');
  process.kill(-escapedPid, 'SIGKILL');
  // The test owns the extra process and performs explicit cleanup. Production
  // remains uncertain without stronger provider-wide evidence.
  assert.equal((await reopened.observe('operation')).status, 'unknown');
  reopened.boot = () => 'simulated-next-kernel-boot';
  assert.equal((await reopened.observe('operation')).status, 'stopped');
  f.driver.managed.clear(); await reopened.close();
});


test('maximum native control-byte output preserves stopped proof despite JSON expansion', async (t) => {
  const f = await fixture(t);
  f.inputs.env.FAKE_CONTROL_BYTES = String(policy.maxOutputBytes);
  await f.driver.launch(f.request); await f.waitReady();
  await waitFile(join(f.options.directory, 'operation', 'provider.json'));
  await f.release(); await Promise.all([...f.driver.active.values()].map((active) => active.job));
  assert.ok((await stat(join(f.options.directory, 'operation', 'outcome.json'))).size > 12 * 1024 * 1024);
  assert.equal((await f.driver.observe('operation')).status, 'stopped');
  assert.equal(JSON.parse(await readFile(join(f.options.directory, 'operation', 'delivery.json'), 'utf8')).code, 'INVALID_RESULT');
  assert.deepEqual(f.errors, []); assert.equal(f.delivered.length, 0);
  await f.driver.close();
});

test('watcher settles on changed supervisor stamp without signalling the replacement identity', async (t) => {
  const f = await fixture(t); await f.driver.launch(f.request); await f.waitReady();
  const path = join(f.options.directory, 'operation', 'identity.json');
  const receipt = await readFile(path, 'utf8');
  await writeFile(path, JSON.stringify({ ...JSON.parse(receipt), stamp: 'replacement-instance' }));
  try {
    await Promise.all([...f.driver.active.values()].map((active) => active.job));
    assert.ok(f.errors.includes('OWNERSHIP_UNCERTAIN'));
    assert.equal((await f.driver.observe('operation')).status, 'unknown');
    await assert.rejects(f.driver.terminate(JSON.parse(receipt).identity), { code: 'OWNERSHIP_UNCERTAIN' });
    process.kill(JSON.parse(receipt).pid, 0);
  } finally { await writeFile(path, receipt); }
  await f.driver.close();
});

test('shutdown attempts other owned workers after one termination fails', async (t) => {
  const f = await fixture(t);
  await f.driver.launch(f.request); await f.waitReady();
  const second = { ...f.request, operationId: 'second', attempt: { ...f.request.attempt, id: 'second-attempt', operationId: 'second' } };
  await f.driver.launch(second);
  await waitFile(join(f.options.directory, 'second', 'provider.json'));
  const terminate = f.driver.terminate.bind(f.driver), attempted = [];
  f.driver.terminate = async (identity) => {
    attempted.push(identity);
    if (identity.startsWith('native:operation:')) throw new Error('injected termination failure');
    return terminate(identity);
  };
  try {
    await assert.rejects(f.driver.close(), { code: 'OWNERSHIP_UNCERTAIN' });
    assert.ok(attempted.some((identity) => identity.startsWith('native:second:')));
    assert.equal((await f.driver.observe('second')).status, 'stopped');
  } finally { f.driver.terminate = terminate; }
  await f.driver.close();
});

test('reboot recovery delivers a durable successful native result before releasing its worker', async t => {
  const f = await fixture(t);
  f.driver.onResult = async () => { throw new Error('service intake unavailable'); };
  await f.driver.launch(f.request); await f.waitReady(); await f.release();
  await Promise.all([...f.driver.active.values()].map(active => active.job));
  assert.equal(f.delivered.length, 0);
  const reopened = new NativeBackground({ ...f.options, boot: () => 'next-kernel-boot' });
  assert.equal((await reopened.observe('operation')).status, 'stopped');
  assert.equal(f.delivered.length, 1);
  assert.equal((await reopened.observe('operation')).status, 'stopped');
  assert.equal(f.delivered.length, 1); await reopened.close();
});
