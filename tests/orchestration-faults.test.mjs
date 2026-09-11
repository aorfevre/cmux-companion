import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRepositoryFixture } from './helpers/orchestration/fixture.mjs';
const run = (script, directory, point) => spawnSync(process.execPath, [`tests/helpers/orchestration/${script}.mjs`, directory, point], { encoding: 'utf8', timeout: 20000 });
for (const point of ['before_write', 'after_state', 'after_events', 'before_commit', 'after_commit', 'before_notify']) test(`actual service death at transaction ${point} preserves one receipt or complete rollback`, t => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-transaction-fault-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const crashed = run('transaction-crash-child', directory, point);
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr); assert.equal(readFileSync(join(directory, 'checkpoint'), 'utf8'), point);
  const recovered = run('transaction-crash-child', directory, 'none'); assert.equal(recovered.status, 0, recovered.stderr);
  const state = JSON.parse(recovered.stdout), committed = ['after_commit', 'before_notify'].includes(point);
  assert.equal(state.before.cursor, committed ? 1 : 0); assert.equal(Boolean(state.before.goal), committed);
  t.diagnostic(JSON.stringify({ caseId: t.name, failpoint: point, seed: 0, observed: { version: state.after.version, eventCursor: state.after.cursor, receipts: state.receipts, launches: 0 }, expected: 'Rollback before commit; exactly one committed receipt afterward' }));
  assert.deepEqual(state.after, { version: 1, cursor: 1 }); assert.equal(state.receipts, 1);
});
for (const point of ['publication_requested', 'push_sent', 'push_success', 'push_returned', 'pr_sent', 'pr_success', 'pr_returned']) test(`actual service death at publication ${point} reconciles remote identity before retry`, async t => {
  const repo = await createRepositoryFixture(); t.after(() => repo.close());
  const candidate = await repo.checkout('candidate'), headSha = await repo.implement(candidate.worktree, 'A');
  const input = { operationId: 'publish_g', goalId: 'g', repositoryId: 'repo', branch: 'companion-goals/g', baseBranch: 'main', baseSha: repo.baseSha, headSha, marker: '<!-- companion-goal:g -->' };
  writeFileSync(join(repo.directory, 'publication-input.json'), JSON.stringify({ repository: repo.repository, remote: repo.remote, input }));
  const crashed = run('publication-crash-child', repo.directory, point); assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  const uncertain = ['push_sent', 'pr_sent'].includes(point);
  for (let i = 0; i < 2; i++) {
    const recovered = run('publication-crash-child', repo.directory, 'none'); assert.equal(recovered.status, 0, recovered.stderr);
    const state = JSON.parse(recovered.stdout);
    t.diagnostic(JSON.stringify({ caseId: t.name, failpoint: point, seed: 0, observed: { prCreates: state.creates, remoteHead: state.head, status: state.result.status }, expected: uncertain ? 'Remain uncertain without resending' : 'One PR at the exact intended head' }));
    assert.equal(state.result.status, uncertain ? 'unknown' : 'published'); assert.equal(state.creates, uncertain ? 0 : 1);
    if (!uncertain) { assert.equal(state.head, headSha); assert.equal(state.result.pr.headSha, headSha); }
  }
});

for (const point of ['abort_committed', 'termination_sent', 'termination_success']) test(`actual death during ${point} cannot revive aborted work or launch a replacement`, t => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-abort-fault-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const killed = run('recovery-child', directory, point); assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  for (let i = 0; i < 2; i++) {
    const resumed = run('recovery-child', directory, 'none'); assert.equal(resumed.status, 0, resumed.stderr);
    const state = JSON.parse(resumed.stdout);
    t.diagnostic(JSON.stringify({ caseId: t.name, failpoint: point, seed: 0, observed: { status: state.status, capacity: state.capacity.total, launches: readFileSync(join(directory, 'launches.txt'), 'utf8').trim().split('\n').length }, expected: 'Aborted with zero owned capacity, one original launch and no replacement' }));
    assert.equal(state.status, 'aborted'); assert.equal(state.attempt.workerState, 'stopped'); assert.equal(state.capacity.total, 0);
    assert.equal(readFileSync(join(directory, 'launches.txt'), 'utf8').trim().split('\n').length, 1);
    assert.deepEqual(state.operations, []);
  }
});
test('consumer SIGKILL after side effect replays its key without replaying workflow', t => {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-consumer-fault-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(run('consumer-crash-child', directory, 'consumer_sent').signal, 'SIGKILL');
  for (let i = 0; i < 2; i++) {
    const resumed = run('consumer-crash-child', directory, 'none'); assert.equal(resumed.status, 0, resumed.stderr);
    t.diagnostic(JSON.stringify({ caseId: t.name, failpoint: 'consumer_sent', seed: 0, observed: JSON.parse(resumed.stdout), expected: 'One deduplicated notification with unchanged goal version and no workflow operations' }));
    assert.deepEqual(JSON.parse(resumed.stdout), { delivered: 1, cursor: 1, goalVersion: 1, operations: 0 });
  }
});
