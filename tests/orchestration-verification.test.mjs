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
