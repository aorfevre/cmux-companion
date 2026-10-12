import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../server/orchestration/create-runtime.mjs';
import { createBridge } from '../server/orchestration/bridge.mjs';
import { agentMcpRequest } from '../server/orchestration/agent-mcp.mjs';
import { createRepositoryFixture } from './helpers/orchestration/fixture.mjs';
import { FakeAgents } from './helpers/orchestration/fake-agents.mjs';

async function until(read, accept, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (accept(value)) return value; await delay(20); } while (Date.now() < deadline);
  assert.fail('Worker check fixture did not reach its named barrier');
}

async function fixture(t, { slow = false } = {}) {
  const repo = await createRepositoryFixture();
  const agents = new FakeAgents();
  agents.close = async () => { for (const worker of agents.workers.values()) worker.status = 'stopped'; };
  let launches = 0;
  const argv = ['node', '--input-type=module', '-e', slow ? 'setInterval(() => {}, 1000)' : "import { a } from './src/a.mjs'; console.log('check cwd', process.cwd()); console.log('actual', a()); if (a() !== 2) process.exit(1)"];
  const contract = { ...repo.contract, schemaVersion: 2, tasks: [{ ...repo.contract.tasks[0], resources: [] }], verification: [{ id: 'unit', argv }], waves: [{ id: 'single', title: 'Fix module A', taskIds: ['A'], checkIds: ['unit'] }] };
  const errors = [];
  const runtime = await createRuntime({ storage: { database: join(repo.directory, 'state.sqlite'), artifacts: join(repo.directory, 'artifacts'), resources: join(repo.directory, 'resources') },
    repositories: new Map([['repo', repo.repository]]), token: 'disposable-worker-check-token-over-32-characters', createAgents: () => agents, planReviewEnabled: () => false,
    resolvePrepare: () => ({ bin: process.execPath, argv: ['-e', "require('node:fs').mkdirSync('node_modules', {recursive:true}); console.log('prepared')"], env: { PATH: process.env.PATH }, environmentId: 'fixture-prepare', policy: { ceilingMs: 10000, idleMs: 5000, maxOutputBytes: 8192, killGraceMs: 100 } }),
    resolveCheck: (_repository, check) => { launches++; return { bin: process.execPath, argv: check.argv.slice(1), env: { PATH: process.env.PATH, NODE_OPTIONS: `--import=${new URL('./helpers/orchestration/await-verification-identity.mjs', import.meta.url).href}`, CMUX_COMPANION_FIXTURE_CHECK: check.id }, environmentId: 'fixture-node', policy: { ceilingMs: 10000, idleMs: 5000, maxOutputBytes: 8192, killGraceMs: 100 } }; },
    createPublisher: () => ({ publish: async () => { throw new Error('Publication must not run'); } }), onError: error => errors.push(error),
  });
  t.after(async () => { await runtime.close(); await repo.close(); });
  const endpoint = await runtime.listen();
  const execute = (type, payload = {}, authority = { kind: 'user' }) => runtime.service.execute({ id: randomUUID(), goalId: 'g', expectedVersion: runtime.store.get('g')?.version ?? 0, type, payload }, authority);
  execute('create_goal', { repositoryId: 'repo', title: 'Repair A', baseSha: repo.baseSha, experienceVersion: 2 });
  await runtime.scheduler.tick();
  const supervisor = runtime.store.get('g').attempts.find(attempt => attempt.role === 'planner');
  const authority = { kind: 'agent', goalId: 'g', generation: supervisor.generation, revision: supervisor.revision, role: 'planner', attemptId: supervisor.id };
  const { tasks, ...proposal } = contract;
  delete proposal.waves;
  execute('supervisor_propose', { contract: { ...proposal, implementation: { title: tasks[0].title, prompt: tasks[0].prompt, ownedAreas: tasks[0].ownedAreas } } }, authority);
  await runtime.scheduler.tick();
  execute('approve', { revision: runtime.store.get('g').revision });
  execute('supervisor_dispatch', {}, authority);
  await runtime.scheduler.tick();
  const attempt = runtime.store.get('g').attempts.find(attempt => attempt.role === 'implementer');
  assert.equal(attempt.workerState, 'running');
  assert.equal(attempt.taskId, 'implementation');
  assert.equal(runtime.store.get('g').tasks.length, 1);
  const credential = runtime.bridgeAuth.issue('g', attempt.id), bridge = createBridge({ endpoint, credential });
  const binding = { goalId: 'g', attemptId: attempt.id, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role: attempt.role, target: attempt.target, experienceVersion: 2 };
  const mcp = args => agentMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_check', arguments: args } }, { binding, bridge });
  const args = (id, head) => ({ id, expectedVersion: runtime.store.get('g').version, expectedHead: head, checkId: 'unit' });
  const commit = async (id, head, value) => {
    await writeFile(join(attempt.worktree, 'src/a.mjs'), `export function a() { return ${value}; }\n`);
    return bridge.commit({ id, expectedHead: head, message: `Set module A to ${value}` });
  };
  return { repo, runtime, agents, errors, execute, attempt, bridge, binding, mcp, args, commit, launches: () => launches };
}

test('worker checkpoints, sees a failing approved check, repairs and passes in its owned checkout before submission', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const bad = await f.commit('bad', f.attempt.baseSha, 0);
  const input = f.args('check-bad', bad.headSha), failed = await f.mcp(input);
  assert.equal(failed.result.isError, undefined);
  const first = JSON.parse(failed.result.content[0].text);
  assert.equal(first.status, 'complete'); assert.equal(first.workerState, 'stopped');
  assert.deepEqual(first.checks.map(check => check.passed), [true, false]);
  assert.match(first.checks[1].stdout, /actual 0/);
  assert.ok(first.checks[1].stdout.includes(f.attempt.worktree), 'check executed in the original worker checkout');
  assert.equal(first.checks[1].code, 'EXIT_FAILED');
  assert.equal(f.runtime.store.get('g').hold, undefined, 'ordinary check failure stays in the worker repair loop');
  await f.mcp(input); assert.equal(f.launches(), 1, 'exact MCP replay does not rerun the check');
  const fixed = await f.commit('fixed', bad.headSha, 2);
  const passed = JSON.parse((await f.mcp(f.args('check-fixed', fixed.headSha))).result.content[0].text);
  assert.ok(passed.checks.every(check => check.passed)); assert.equal(passed.runsUsed, 2); assert.equal(passed.budgetLimit, 3);
  const goal = f.runtime.store.get('g');
  assert.equal(goal.verification, null, 'worker checks cannot satisfy final integrated verification');
  assert.deepEqual(goal.verificationRuns.map(run => run.result.verification.checks.at(-1).passed), [false, true]);
  await access(f.attempt.worktree); await access(join(f.attempt.worktree, 'node_modules'));
  const raw = JSON.stringify({ schemaVersion: 1, ...f.binding, experienceVersion: undefined, output: { headSha: fixed.headSha, summary: 'Repaired A after a failing check', evidence: [] } });
  await f.bridge.submitResult({ id: 'candidate', raw }); await f.runtime.results.drain();
  assert.equal(f.runtime.store.get('g').tasks[0].candidateSha, fixed.headSha);
  assert.equal(f.runtime.store.get('g').tasks[0].status, 'in_review');
  assert.deepEqual(f.errors, []);
});

test('check authority rejects added argv, unapproved ids, cross-attempt evidence and legacy roles', async t => {
  const f = await fixture(t), base = f.args('check', f.attempt.baseSha);
  assert.equal((await f.mcp({ ...base, argv: ['sh', '-c', 'anything'] })).result.isError, true);
  assert.equal((await f.mcp({ ...base, checkId: 'unapproved' })).result.isError, true);
  assert.equal((await f.mcp({ ...base, checkId: 'prepare' })).result.isError, true);
  const context = { binding: { ...f.binding, experienceVersion: undefined }, bridge: f.bridge };
  const list = await agentMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, context);
  assert.ok(!list.result.tools.some(tool => tool.name === 'run_check'));
  const response = await f.runtime.app.inject({ url: '/api/orchestration/agent/checks/other', headers: { authorization: `Bearer ${f.runtime.bridgeAuth.issue('g', f.attempt.id)}` } });
  assert.equal(response.statusCode, 403); assert.equal(f.launches(), 0);
});

test('a running check fences commits and abort cancels its owned process without releasing the checkout early', { timeout: 30000 }, async t => {
  const f = await fixture(t, { slow: true });
  const running = f.mcp(f.args('slow', f.attempt.baseSha));
  await until(() => f.launches(), count => count === 1);
  await assert.rejects(f.commit('while-checking', f.attempt.baseSha, 3), { code: 'OWNERSHIP_UNCERTAIN' });
  f.execute('abort');
  await running;
  const stopped = await until(() => f.runtime.store.get('g').verificationRuns[0], run => run.workerState === 'stopped');
  assert.ok(stopped.result.verification.checks.some(check => !check.passed));
  assert.equal(f.launches(), 1); await access(f.attempt.worktree);
});

test('two unchanged failures exhaust a persisted budget and hold instead of looping', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.mcp(f.args('failure-1', f.attempt.baseSha));
  await f.mcp(f.args('failure-2', f.attempt.baseSha));
  const goal = f.runtime.store.get('g');
  assert.ok(goal.hold.reasons.some(reason => /repair budget exhausted/.test(reason.message)));
  assert.equal(goal.verificationRuns.length, 2); assert.equal(f.launches(), 2);
  assert.ok(f.agents.terminations.length || f.runtime.store.operations().some(op => op.kind === 'terminate'));
  assert.equal((await f.mcp(f.args('failure-3', f.attempt.baseSha))).result.isError, true);
  assert.equal(f.launches(), 2);
});

test('three different failing checkpoints exhaust the persisted per-check repair budget', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  let head = f.attempt.baseSha;
  for (const [index, value] of [0, 3, 4].entries()) {
    head = (await f.commit(`checkpoint-${index}`, head, value)).headSha;
    const result = JSON.parse((await f.mcp(f.args(`run-${index}`, head))).result.content[0].text);
    assert.equal(result.runsUsed, index + 1);
    assert.equal(result.checks.at(-1).passed, false);
    if (index < 2) assert.equal(f.runtime.store.get('g').hold, undefined);
  }
  const goal = await until(() => f.runtime.store.get('g'), goal => Boolean(goal.hold) && goal.attempts.find(attempt => attempt.id === f.attempt.id).workerState === 'stopped');
  assert.equal(goal.verificationRuns.length, 3);
  assert.match(goal.hold.reasons[0].message, /budget exhausted/);
  assert.equal((await f.mcp(f.args('extra', head))).result.isError, true);
  assert.equal(f.launches(), 3);
  f.runtime.bridgeAuth.revoke('g', f.attempt.id);
  assert.equal((await f.mcp(f.args('revoked', head))).result.isError, true);
});
