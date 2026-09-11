import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { createRepositoryFixture, fixtureGit } from './helpers/orchestration/fixture.mjs';
import { cleanupFixture } from './helpers/orchestration/cleanup-fixture.mjs';
async function fixture(t) {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const f = await cleanupFixture(repo); t.after(() => f.store.close()); return { ...f, repo };
}
test('preview and cleanup retain branch, artifacts and workflow state while removing only the owned clean checkout', async t => {
  const f = await fixture(t), before = f.store.get('goal');
  const artifact = f.artifacts.put('retained evidence');
  assert.equal((await f.cleanup.preview('goal')).candidates[0].eligible, true);
  await f.cleanup.execute(f.input); await f.cleanup.execute(f.input);
  assert.equal(existsSync(before.attempts[0].worktree), false);
  assert.equal(await fixtureGit(f.repo.repository, ['rev-parse', 'companion/goal/planner']), f.repo.baseSha);
  assert.equal(f.artifacts.get(artifact.id).toString(), 'retained evidence');
  assert.deepEqual(f.store.get('goal'), before); assert.equal(f.store.operations().length, 0);
});
test('dirty worktrees, missing ownership and stale versions are refused', async t => {
  const f = await fixture(t), path = f.store.get('goal').attempts[0].worktree;
  writeFileSync(join(path, 'unrelated.txt'), 'do not delete');
  assert.equal((await f.cleanup.preview('goal')).candidates[0].eligible, false);
  await assert.rejects(f.cleanup.execute(f.input), { code: 'DIRTY_WORKTREE' });
  assert.ok(existsSync(path));
  await assert.rejects(f.cleanup.execute({ ...f.input, expectedVersion: 0 }), { code: 'VERSION_CONFLICT' });
  await fixtureGit(f.repo.repository, ['update-ref', '-d', 'refs/companion/resources/planner_operation']);
  await assert.rejects(f.cleanup.execute(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.equal(readFileSync(join(path, 'unrelated.txt'), 'utf8'), 'do not delete');
});
for (const boundary of ['cleanup_intent', 'cleanup_removed']) test(`SIGKILL at ${boundary} recovers only cleanup without workflow replay`, async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  writeFileSync(join(repo.directory, 'cleanup-input.json'), JSON.stringify({ directory: repo.directory, repository: repo.repository, baseSha: repo.baseSha }));
  const run = point => spawnSync(process.execPath, ['tests/helpers/orchestration/cleanup-child.mjs', repo.directory, point], { encoding: 'utf8', timeout: 10000 });
  const killed = run(boundary); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal(readFileSync(join(repo.directory, 'cleanup-checkpoint'), 'utf8'), boundary);
  let original;
  for (let i = 0; i < 2; i++) {
    const resumed = run('none'); assert.equal(resumed.status, 0, resumed.stderr);
    const state = JSON.parse(resumed.stdout);
    t.diagnostic(JSON.stringify({ caseId: t.name, failpoint: boundary, seed: 0, observed: { cleanupStatus: state.receipt.status, goalVersion: state.goal.version, goalStatus: state.goal.status, capacity: state.capacity.total }, expected: 'Cleanup completes once without changing terminal workflow state' }));
    assert.equal(state.receipt.status, 'completed'); assert.equal(state.capacity.total, 0); assert.equal(state.goal.status, 'aborted');
    if (original) assert.deepEqual(state, original); original = state;
  }
});

test('ignored files are user data and are never removed', async t => {
  const f = await fixture(t), path = f.store.get('goal').attempts[0].worktree;
  writeFileSync(join(f.repo.repository, '.git/info/exclude'), 'precious.local\n');
  writeFileSync(join(path, 'precious.local'), 'retain ignored content');
  assert.equal((await f.cleanup.preview('goal')).candidates[0].eligible, false);
  await assert.rejects(f.cleanup.execute(f.input), { code: 'DIRTY_WORKTREE' });
  assert.equal(readFileSync(join(path, 'precious.local'), 'utf8'), 'retain ignored content');
});
for (const state of ['running', 'unknown', 'pending']) test(`cleanup refuses ${state} worker ownership`, async t => {
  const f = await fixture(t), goal = f.store.get('goal');
  goal.attempts[0].workerState = state;
  f.store.db.prepare('UPDATE goals SET state=? WHERE id=?').run(JSON.stringify(goal), goal.id);
  await assert.rejects(f.cleanup.execute(f.input), { code: 'OWNERSHIP_UNCERTAIN' });
  assert.ok(existsSync(goal.attempts[0].worktree));
});
test('a pending side effect prevents cleanup even after workers stop', async t => {
  const f = await fixture(t);
  f.store.db.prepare("UPDATE operations SET status='pending'").run();
  await assert.rejects(f.cleanup.execute(f.input), { code: 'NOT_READY' });
});
test('cleanup records failure and refuses a clean head advance between preview and removal', async t => {
  const f = await fixture(t), resource = f.repositories.resource('planner_operation');
  const check = f.repositories.checkCheckout.bind(f.repositories); let calls = 0;
  f.repositories.checkCheckout = async (...args) => {
    if (++calls === 2) await f.repo.implement(resource.worktree, 'A');
    return check(...args);
  };
  await assert.rejects(f.cleanup.execute(f.input), { code: 'STALE_TARGET' });
  assert.ok(existsSync(resource.worktree));
  assert.equal(f.store.db.prepare('SELECT status FROM resource_cleanup').get().status, 'failed');
});

test('a missing checkout with pending receipt finishes its exact stale registration', async t => {
  const f = await fixture(t), resource = f.repositories.resource('planner_operation');
  f.store.db.prepare("INSERT INTO resource_cleanup VALUES (?,?,?,'pending',NULL)").run('goal', 'planner', f.repo.baseSha);
  rmSync(resource.worktree, { recursive: true });
  await f.cleanup.execute(f.input);
  assert.equal(await f.cleanup.registration(resource), undefined);
  assert.equal(f.store.db.prepare('SELECT status FROM resource_cleanup').get().status, 'completed');
});
test('recreated cleanup paths and changed branch registration are preserved', async t => {
  const f = await fixture(t), resource = f.repositories.resource('planner_operation');
  await fixtureGit(resource.worktree, ['checkout', '-b', 'unrelated']);
  await assert.rejects(f.cleanup.execute(f.input), { code: 'STALE_TARGET' });
  await fixtureGit(resource.worktree, ['checkout', resource.branch]);
  await f.cleanup.execute(f.input);
  mkdirSync(resource.worktree); writeFileSync(join(resource.worktree, 'private.txt'), 'retain');
  await assert.rejects(f.cleanup.execute(f.input));
  assert.equal(readFileSync(join(resource.worktree, 'private.txt'), 'utf8'), 'retain');
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`cleanup preserves files hidden by ${flag}`, async t => {
  const f = await fixture(t), path = f.store.get('goal').attempts[0].worktree;
  await fixtureGit(path, ['update-index', flag, 'src/a.mjs']);
  writeFileSync(join(path, 'src/a.mjs'), 'private unfinished change');
  assert.equal((await f.cleanup.preview('goal')).candidates[0].eligible, false);
  await assert.rejects(f.cleanup.execute(f.input), { code: 'DIRTY_WORKTREE' });
  assert.equal(readFileSync(join(path, 'src/a.mjs'), 'utf8'), 'private unfinished change');
});
