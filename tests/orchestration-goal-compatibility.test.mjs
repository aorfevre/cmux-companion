import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OrchestrationStore } from '../server/orchestration/storage/store.mjs';
import { backupData, restoreData } from '../updater/src/data-recovery.mjs';

// Supported rollback restores the pre-activation database; this deliberately
// does not claim that old executables can operate on new workflow semantics.
test('updater rollback restores original goals and journal after candidate startup and clarification writes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-rollback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'core.sqlite'), baseSha = 'a'.repeat(40);
  let store = new OrchestrationStore({ path: database });
  let next = 0;
  const command = (goalId, type, payload, authority = { kind: 'user' }) => store.apply({
    id: `command${++next}`, goalId, expectedVersion: store.get(goalId)?.version ?? 0, type, payload,
  }, authority);
  command('historical', 'create_goal', { repositoryId: 'repo', title: 'Original request', baseSha });
  const baseline = { goals: store.list(), events: store.events(), journalId: store.journalId };
  assert.equal(baseline.goals[0].startup, undefined);
  const backup = await backupData({ root: join(directory, 'backups'), id: 'installation', files: [database], previousSha: baseSha });
  command('new-goal', 'create_goal', { repositoryId: 'repo', title: 'New request', description: 'Plan the new feature', projectCode: 'DEMO' });
  assert.equal(store.get('new-goal').startup.status, 'pending');
  command('historical', 'request_attempt', { role: 'planner', attemptId: 'planner', operationId: 'launch', conversationId: 'planning' }, { kind: 'system' });
  command('historical', 'record_dispatch', { attemptId: 'planner', identity: 'fake-worker', worktree: '/fixture/owned', branch: 'goal/planner' }, { kind: 'system' });
  const attempt = store.get('historical').attempts[0];
  command('historical', 'request_clarification', { question: 'Which audience?' }, {
    kind: 'agent', goalId: 'historical', attemptId: attempt.id, role: 'planner', generation: attempt.generation, revision: attempt.revision,
  });
  assert.equal(store.get('historical').clarification.question, 'Which audience?');
  assert.ok(store.events().length > baseline.events.length);
  store.close();
  // The installer stops the candidate before replacing SQLite and its WAL/SHM.
  await restoreData(backup, [database]);
  store = new OrchestrationStore({ path: database });
  try {
    assert.deepEqual({ goals: store.list(), events: store.events(), journalId: store.journalId }, baseline);
    assert.equal(store.get('new-goal'), null);
    assert.equal(store.get('historical').baseSha, baseSha);
    assert.equal(store.get('historical').clarification, undefined);
  } finally { store.close(); }
});
