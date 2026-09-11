import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepository } from '../server/orchestration/adapters/git.mjs';
import { VerificationRunner } from '../server/orchestration/adapters/verification.mjs';
import { ArtifactStore } from '../server/orchestration/storage/artifacts.mjs';
import { DomainError } from '../server/orchestration/domain/contracts.mjs';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';

const policy = { ceilingMs: 10000, idleMs: 2000, maxOutputBytes: 8192, killGraceMs: 100 };
async function fixture(t, passing = true) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  let headSha = repo.baseSha;
  if (passing) {
    const candidate = await repo.checkout('candidate');
    for (const task of ['A', 'B', 'C']) headSha = await repo.implement(candidate.worktree, task);
  }
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  let resolved = 0;
  const options = { repositories, resolveCheck: (repositoryId, check) => {
    resolved++; assert.equal(repositoryId, 'repo');
    if (check.argv[0] !== 'node') throw new DomainError('UNSUPPORTED_CAPABILITY', 'No fixture command policy');
    return { bin: process.execPath, argv: check.argv.slice(1), env: { PATH: process.env.PATH }, environmentId: 'fixture-node', policy };
  } };
  const runner = new VerificationRunner(options);
  const input = { goalId: 'g', repositoryId: 'repo', operationId: 'verify_a', headSha, checks: [{ id: 'unit', argv: ['node', '--test', 'test/acceptance.test.mjs'] }] };
  return { repo, artifacts, repositories, runner, options, input, resolved: () => resolved };
}

test('verification runs the real fixture at its exact commit and replays durable evidence without rerunning', async (t) => {
  const f = await fixture(t), result = await f.runner.run(f.input);
  assert.equal(result.verification.headSha, f.input.headSha); assert.equal(result.workerState, 'stopped');
  assert.equal(result.verification.checks[0].passed, true);
  const evidence = JSON.parse(f.artifacts.get(result.verification.checks[0].artifactId).toString());
  assert.equal(evidence.headSha, f.input.headSha); assert.equal(evidence.environment.id, 'fixture-node');
  assert.match(evidence.environment.environmentHash, /^[a-f0-9]{64}$/); assert.match(evidence.outcome.stdout, /pass/);
  assert.deepEqual(await new VerificationRunner(f.options).run(f.input), result);
  assert.equal(f.resolved(), 1);
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', 'main']), f.repo.baseSha);
  await assert.rejects(f.runner.run({ ...f.input, headSha: f.repo.baseSha }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('a failing or unavailable required check remains a recorded failure', async (t) => {
  const f = await fixture(t, false);
  const result = await f.runner.run({ ...f.input, checks: [...f.input.checks, { id: 'missing', argv: ['unavailable'] }] });
  assert.deepEqual(result.verification.checks.map((check) => check.passed), [false, false]);
  const evidence = result.verification.checks.map((check) => JSON.parse(f.artifacts.get(check.artifactId).toString()));
  assert.equal(evidence[0].code, 'EXIT_FAILED'); assert.equal(evidence[1].code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(evidence[1].outcome, null); assert.equal(result.workerState, 'stopped');
});

test('check mutations cannot be reported as a passing result for the original commit', async (t) => {
  const f = await fixture(t);
  const result = await f.runner.run({ ...f.input, checks: [{ id: 'mutating', argv: ['node', '-e', "require('node:fs').writeFileSync('src/a.mjs','tampered');"] }] });
  assert.equal(result.verification.checks[0].passed, false);
  const evidence = JSON.parse(f.artifacts.get(result.verification.checks[0].artifactId).toString());
  assert.equal(evidence.code, 'DIRTY_WORKTREE');
  assert.equal(await fixtureGit(f.repo.repository, ['show', `${f.input.headSha}:src/a.mjs`]), 'export function a() { return 2; }');
});

test('verification abort terminates its worker and marks remaining checks unavailable', async (t) => {
  const f = await fixture(t), controller = new AbortController();
  const runner = new VerificationRunner({ ...f.options, failpoint: (point) => { if (point === 'identity_recorded') controller.abort(); } });
  const result = await runner.run({ ...f.input, signal: controller.signal, checks: [{ id: 'first', argv: ['node', '-e', 'setInterval(() => {}, 1000);'] }, { id: 'second', argv: ['node', '-e', "console.log('must not run');"] }] });
  assert.deepEqual(result.verification.checks.map((check) => check.passed), [false, false]);
  assert.equal(result.workerState, 'stopped'); assert.equal(f.resolved(), 1);
  for (const check of result.verification.checks) assert.equal(JSON.parse(f.artifacts.get(check.artifactId).toString()).code, 'ABORTED');
});

for (const point of ['requested', 'before_launch', 'check_recorded', 'completed']) test(`verification reopening preserves ownership after ${point}`, async (t) => {
  const f = await fixture(t);
  const runner = new VerificationRunner({ ...f.options, failpoint: (at) => { if (at === point) throw new Error('interrupted verification'); } });
  await assert.rejects(runner.run(f.input), /interrupted verification/);
  const before = f.resolved();
  if (point === 'completed') assert.equal((await new VerificationRunner(f.options).run(f.input)).verification.checks[0].passed, true);
  else await assert.rejects(new VerificationRunner(f.options).run(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.equal(f.resolved(), before);
});

test('verification policy cannot silently change approved arguments or follow aliased run paths', async (t) => {
  const f = await fixture(t);
  const runner = new VerificationRunner({ ...f.options, resolveCheck: () => ({ bin: process.execPath, argv: ['-e', 'process.exit(0)'], env: {}, environmentId: 'wrong', policy }) });
  const result = await runner.run(f.input);
  assert.equal(result.verification.checks[0].passed, false);
  symlinkSync(join(f.repo.directory, 'missing'), join(runner.directory, 'aliased'));
  await assert.rejects(runner.run({ ...f.input, operationId: 'aliased' }), { code: 'OWNERSHIP_UNCERTAIN' });
  const request = JSON.parse(readFileSync(join(runner.directory, f.input.operationId, 'request.json'), 'utf8'));
  assert.deepEqual(request.checks, f.input.checks);
});

test('verification receipts cannot be rebound to a different request or approved command', async (t) => {
  const f = await fixture(t); await f.runner.run(f.input);
  const path = join(f.runner.directory, f.input.operationId, 'request.json');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  for (const changes of [{ headSha: f.repo.baseSha }, { goalId: 'other' }, { checks: [{ id: 'unit', argv: ['node', '-e', 'process.exit(0)'] }] }]) {
    writeFileSync(path, JSON.stringify({ ...original, ...changes }));
    assert.throws(() => f.runner.receipt(f.input.operationId), { code: 'OWNERSHIP_UNCERTAIN' });
  }
});

test('verification watchdog survives service SIGKILL and recovery never launches unchecked remaining commands', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { existsSync } = await import('node:fs');
  const pidPath = join(f.repo.directory, 'check.pid'), forbidden = join(f.repo.directory, 'must-not-launch');
  const input = { ...f.input, checks: [
    { id: 'slow', argv: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000)`] },
    { id: 'later', argv: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)}, 'ran')`] },
  ] };
  const configPath = join(f.repo.directory, 'verification-child.json');
  writeFileSync(configPath, JSON.stringify({ repository: f.repo.repository, resources: f.repositories.directory, artifacts: f.artifacts.directory, input }));
  const script = `import { readFileSync } from 'node:fs';
    import { GitRepository } from './server/orchestration/adapters/git.mjs';
    import { ArtifactStore } from './server/orchestration/storage/artifacts.mjs';
    import { VerificationRunner } from './server/orchestration/adapters/verification.mjs';
    const config = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const repositories = new GitRepository({ repositories: new Map([['repo',config.repository]]), directory:config.resources, artifacts:new ArtifactStore({directory:config.artifacts}) });
    const runner = new VerificationRunner({repositories, resolveCheck: (_id,check)=>({bin:process.execPath,argv:check.argv.slice(1),env:{PATH:process.env.PATH},environmentId:'crash-fixture',policy:{ceilingMs:3000,idleMs:5000,maxOutputBytes:8192,killGraceMs:100}})});
    await runner.run(config.input);`;
  const service = spawn(process.execPath, ['--input-type=module', '-e', script, configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; service.stderr.on('data', chunk => stderr += chunk);
  t.after(() => { if (service.exitCode === null && service.signalCode === null) service.kill('SIGKILL'); });
  const deadline = Date.now() + 15000;
  while (!existsSync(pidPath)) {
    assert.equal(service.exitCode, null, stderr); assert.ok(Date.now() < deadline, 'check did not start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const checkPid = Number(readFileSync(pidPath, 'utf8'));
  t.after(() => { try { process.kill(-checkPid, 'SIGKILL'); } catch { /* test-owned process already stopped */ } });
  const exit = once(service, 'exit'); service.kill('SIGKILL'); assert.equal((await exit)[1], 'SIGKILL');
  const reopened = new VerificationRunner(f.options);
  assert.equal(await reopened.observe(input.operationId), null);
  let result;
  while (!(result = await reopened.observe(input.operationId))) {
    assert.ok(Date.now() < deadline, 'independent watchdog did not finish'); await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result.workerState, 'stopped'); assert.deepEqual(result.verification.checks.map(check => check.passed), [false, false]);
  assert.equal(JSON.parse(f.artifacts.get(result.verification.checks[0].artifactId).toString()).code, 'CEILING_LIMIT');
  assert.equal(JSON.parse(f.artifacts.get(result.verification.checks[1].artifactId).toString()).code, 'NOT_STARTED');
  assert.equal(existsSync(forbidden), false); assert.equal(f.resolved(), 0);
  assert.throws(() => process.kill(checkPid, 0), { code: 'ESRCH' });
  assert.deepEqual(await reopened.run(input), result);
});

for (const proof of ['boot', 'outcome']) test(`${proof} evidence proves uncertain verification stopped without rewriting completed checks`, async t => {
  const f = await fixture(t), runner = new VerificationRunner({ ...f.options, boot: () => 'boot-a', failpoint: point => { if (point === 'before_launch') throw new Error('interrupted'); } });
  await assert.rejects(runner.run(f.input), /interrupted/);
  const { mkdirSync } = await import('node:fs');
  const directory = join(runner.directory, f.input.operationId, 'workers', 'unit');
  mkdirSync(directory);
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ identity: 'uncertain-fixture', startedAt: 0, bootId: 'boot-a' }));
  const unknown = await runner.observe(f.input.operationId);
  assert.equal(unknown.workerState, 'unknown'); assert.equal(unknown.verification.checks[0].passed, false);
  runner.boot = () => null;
  assert.deepEqual(await runner.observe(f.input.operationId), unknown);
  if (proof === 'boot') runner.boot = () => 'boot-b';
  else {
    runner.boot = () => 'boot-a';
    writeFileSync(join(directory, 'outcome.json'), JSON.stringify({ identity: 'uncertain-fixture', outcome: { status: 'failed', workerState: 'stopped', cause: { code: 'ABORTED', exitCode: null, signal: null }, stdout: '', stderr: '' } }));
  }
  const stopped = await runner.observe(f.input.operationId);
  assert.equal(stopped.workerState, 'stopped'); assert.deepEqual(stopped.verification, unknown.verification);
  assert.notEqual(stopped.artifactId, unknown.artifactId);
});

test('legacy verification launch without supervisor proof remains uncertain', async t => {
  const f = await fixture(t), runner = new VerificationRunner({ ...f.options, failpoint: point => { if (point === 'before_launch') throw new Error('interrupted'); } });
  await assert.rejects(runner.run(f.input), /interrupted/);
  const path = join(runner.directory, f.input.operationId, 'request.json');
  const request = JSON.parse(readFileSync(path, 'utf8')); delete request.supervised; delete request.bootId;
  writeFileSync(path, JSON.stringify(request));
  assert.equal(await runner.observe(f.input.operationId), null);
});

test('reboot recovery preserves a real successful supervised check outcome', async t => {
  const f = await fixture(t), runner = new VerificationRunner({ ...f.options, boot: () => 'boot-a', failpoint: point => { if (point === 'identity_recorded') throw new Error('service interrupted'); } });
  await assert.rejects(runner.run(f.input), /service interrupted/);
  const { existsSync } = await import('node:fs');
  const outcomePath = join(runner.directory, f.input.operationId, 'workers', 'unit', 'outcome.json');
  const deadline = Date.now() + 10000;
  while (!existsSync(outcomePath)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(JSON.parse(readFileSync(outcomePath, 'utf8')).outcome.status, 'succeeded');
  const result = await new VerificationRunner({ ...f.options, boot: () => 'boot-b' }).observe(f.input.operationId);
  assert.equal(result.workerState, 'stopped'); assert.equal(result.verification.checks[0].passed, true);
  assert.equal(f.resolved(), 1);
});

for (const boundary of ['prepared', 'sent']) test(`supervisor ${boundary} crash distinguishes proven no-send from uncertainty`, async t => {
  const f = await fixture(t);
  const { runSupervisedProcess, observeSupervisedProcess } = await import('../server/orchestration/adapters/supervised-process.mjs');
  const directory = join(f.repositories.directory, 'supervisor-claim');
  await assert.rejects(runSupervisedProcess({ bin: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: f.repo.repository, env: {} }, { directory, policy, onIdentity() {}, failpoint: point => { if (point === boundary) throw new Error('interrupted'); } }), /interrupted/);
  if (boundary === 'prepared') {
    const observed = await observeSupervisedProcess(directory);
    assert.equal(observed.workerState, 'stopped'); assert.equal(observed.cause.code, 'NOT_STARTED');
  } else {
    assert.equal(await observeSupervisedProcess(directory), null);
    const path = join(directory, 'request.json'), request = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...request, startedAt: 0 }));
    assert.equal((await observeSupervisedProcess(directory)).workerState, 'unknown');
  }
});

test('legacy launched check recovered after boot is not mislabeled as never started', async t => {
  const f = await fixture(t), runner = new VerificationRunner({ ...f.options, boot: () => 'boot-a', failpoint: point => { if (point === 'before_launch') throw new Error('interrupted'); } });
  await assert.rejects(runner.run(f.input), /interrupted/);
  const path = join(runner.directory, f.input.operationId, 'request.json'), request = JSON.parse(readFileSync(path, 'utf8')); delete request.supervised;
  writeFileSync(path, JSON.stringify(request)); runner.boot = () => 'boot-b';
  const result = await runner.observe(f.input.operationId);
  assert.equal(result.workerState, 'stopped');
  assert.equal(JSON.parse(f.artifacts.get(result.verification.checks[0].artifactId).toString()).code, 'OWNERSHIP_UNCERTAIN');
});
