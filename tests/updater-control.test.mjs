import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UpdateControl } from '../updater/src/control.mjs';
import { GitHubUpdates } from '../updater/src/eligibility.mjs';
const sha = 'a'.repeat(40), previous = 'b'.repeat(40), newer = 'c'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'update-control-')), path = join(root, 'control.sqlite');
  const control = new UpdateControl(path); t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });
  control.checked({ candidate: { sha, changesUrl: 'https://github.com/example/repo/compare/base...head' }, observedSha: sha, deployedSha: previous });
  return { control, path };
}
test('default-off discovery, durable opt-in, revision conflict and duplicate manual approvals', t => {
  const { control, path } = fixture(t);
  assert.equal(control.status().automatic, false); assert.equal(control.status().request, null);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  control.policy(0, true); assert.throws(() => control.policy(0, false), /changed/);
  const reopened = new UpdateControl(path); assert.equal(reopened.status().automatic, true); reopened.close();
  assert.throws(() => control.policy(1, 'yes'), /Invalid/);
  const input = { id: 'manual-001', sha, whenIdle: true };
  assert.deepEqual(control.request(input), control.request(input));
  assert.throws(() => control.request({ ...input, sha: newer }), /already used/);
  assert.throws(() => control.request({ ...input, id: 'other-001', whenIdle: false }), /already queued/);
  assert.equal(control.request({ ...input, id: 'other-002' }).id, input.id);
  control.check(); assert.equal(control.status().checking, true);
});
test('disabling cancels queued automatic requests, preserves manual requests and discovery', t => {
  const { control } = fixture(t);
  assert.throws(() => control.request({ id: 'automatic1', sha, source: 'automatic' }), /not authorized/);
  control.policy(0, true); control.request({ id: 'automatic1', sha, source: 'automatic' });
  control.fence('automatic1', 'service'); control.policy(1, false);
  assert.throws(() => control.start('automatic1', 'service'), /admission/);
  control.unfence('automatic1'); assert.equal(control.status().maintenance, false);
  assert.equal(control.status().request.status, 'cancelled'); assert.equal(control.status().candidate.sha, sha);
  control.request({ id: 'manual-002', sha }); control.policy(2, false);
  assert.equal(control.status().request.status, 'queued');
});
test('start wins disable race safely; exact target survives newer discovery and running cancellation is refused', t => {
  const { control } = fixture(t); control.policy(0, true);
  control.request({ id: 'automatic2', sha, source: 'automatic' });
  assert.throws(() => control.start('automatic2', 'service'), /admission/);
  control.fence('automatic2', 'service'); control.start('automatic2', 'service'); control.policy(1, false);
  assert.equal(control.status().request.status, 'running');
  assert.throws(() => control.cancel('automatic2'), /started/);
  control.unfence('automatic2'); assert.equal(control.status().maintenance, true);
  control.checked({ candidate: { sha: newer }, observedSha: newer, deployedSha: previous });
  assert.equal(control.status().request.sha, sha);
  control.phase('automatic2', 'verifying'); assert.equal(control.status().request.phase, 'verifying');
  control.finish('automatic2', { success: true });
  assert.equal(control.status().candidate.sha, newer); assert.equal(control.status().deployedSha, sha); assert.equal(control.status().maintenance, false);
});
test('automatic cancellation suppresses rediscovery until opt-in renewal; recovery quarantines failures', t => {
  const { control } = fixture(t); control.policy(0, true);
  control.request({ id: 'automatic3', sha, source: 'automatic' }); control.cancel('automatic3'); control.cancel('automatic3');
  assert.throws(() => control.request({ id: 'automatic4', sha, source: 'automatic' }), /not authorized/);
  control.policy(1, true); assert.throws(() => control.request({ id: 'automatic4', sha, source: 'automatic' }), /not authorized/);
  control.policy(2, false); control.policy(3, true);
  control.request({ id: 'automatic4', sha, source: 'automatic' }); control.fence('automatic4', 'service'); control.start('automatic4', 'service');
  control.finish('automatic4', { success: false, recoveryRequired: true, error: 'Recovery failed' });
  assert.equal(control.status().request.status, 'recovery_required'); assert.equal(control.status().maintenance, true);
  control.finish('automatic4', { success: false }); assert.equal(control.status().maintenance, false);
  assert.throws(() => control.request({ id: 'manual-003', sha }), /eligible/);
});
test('invalid identities and check errors never create approval', t => {
  const { control } = fixture(t);
  for (const input of [{ id: 'bad', sha }, { id: 'valid-001', sha: 'main' }, { id: 'valid-001', sha, source: 'browser' }, { id: 'valid-001', sha, whenIdle: 'yes' }]) assert.throws(() => control.request(input));
  assert.throws(() => control.cancel('missing-001'), /not found/);
  assert.throws(() => control.fence('missing-001', 'service'), /not active/);
  assert.throws(() => control.phase('missing-001', 'anything'), /does not own/);
  assert.throws(() => control.finish('missing-001', {}), /does not own/);
  control.checked({ error: 'Check unavailable' }); assert.equal(control.status().candidate, null);
  assert.throws(() => control.request({ id: 'valid-001', sha }), /eligible/);
});
function github(overrides = {}) {
  const run = { head_sha: sha, head_branch: 'main', event: 'push', workflow_id: 5, repository: { full_name: 'example/repo' }, head_repository: { full_name: 'example/repo' }, run_number: 10, run_attempt: 1, status: 'completed', conclusion: 'success', ...overrides };
  return new GitHubUpdates({ repository: 'example/repo', api: async path => {
    if (path.includes('/commits?')) return [{ sha }, { sha: previous }];
    if (path.includes('/compare/')) return path.endsWith('...main') ? { status: 'identical', merge_base_commit: { sha } } : { status: 'ahead', merge_base_commit: { sha: previous } };
    if (path.includes('/runs?')) return { workflow_runs: [run] };
    return { id: 5, path: '.github/workflows/verify.yml', state: 'active' };
  } });
}
test('eligibility binds exact trusted main SHA, workflow, repository and successful run', async () => {
  assert.equal((await github().discover(previous)).candidate.sha, sha);
  await github().revalidate(previous, sha);
  for (const change of [{ head_sha: newer }, { head_branch: 'feature' }, { workflow_id: 6 }, { event: 'pull_request' }, { conclusion: 'failure' }, { status: 'in_progress' }, { repository: { full_name: 'other/repo' } }, { head_repository: null }]) assert.equal(await github(change).eligible(sha), false);
  assert.equal((await github({ conclusion: 'failure' }).discover(previous)).candidate, null);
  await assert.rejects(github({ conclusion: 'failure' }).revalidate(previous, sha), /changed/);
  assert.throws(() => new GitHubUpdates({ repository: '../../x' }));
});
test('missing or inaccessible workflow evidence and divergent history fail closed', async () => {
  const missing = new GitHubUpdates({ repository: 'example/repo', api: async () => ({}) });
  assert.equal(await missing.eligible(sha), false); await assert.rejects(missing.discover(previous), /unavailable/);
  const offline = new GitHubUpdates({ repository: 'example/repo', api: async () => { throw new Error('rate limited'); } });
  await assert.rejects(offline.discover(previous), /rate limited/);
  const divergent = new GitHubUpdates({ repository: 'example/repo', api: async path => path.includes('/commits?') ? [{ sha }] : { status: 'diverged' } });
  assert.equal((await divergent.discover(previous)).candidate, null); await assert.rejects(divergent.revalidate(previous, sha), /changed/);
});

test('quarantined candidates require an explicit idempotent retry; retained recovery cannot retarget a request', t => {
  const { control } = fixture(t); control.request({ id: 'failed-001', sha }); control.fence('failed-001', 'service'); control.start('failed-001', 'service'); control.finish('failed-001', { success: false });
  const input = { id: 'retry-001', sha, whenIdle: true };
  assert.deepEqual(control.retry(input), control.retry(input));
  assert.throws(() => control.retry({ ...input, sha: newer }), /already used/);
  assert.throws(() => control.retry({ id: 'retry-002', sha }), /not eligible/);
  assert.throws(() => control.retry({ ...input, whenIdle: 'yes' }), /Invalid/);
  control.fence('retry-001', 'service'); control.start('retry-001', 'service');
  control.change(state => { Object.assign(state.requests['retry-001'], { backup: { files: [] }, previousSha: previous }); });
  control.finish('retry-001', { success: false, recoveryRequired: true });
  assert.throws(() => control.recover('other-001'), /No matching/);
  control.recover('retry-001'); assert.equal(control.status().request.phase, 'rolling-back');
  assert.doesNotMatch(JSON.stringify(control.status()), /backup|files|serviceId|previousSha/);
});
