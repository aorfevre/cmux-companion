import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, BASE } from './helpers/orchestration/domain-fixture.mjs';
import { repairableChecks } from '../server/orchestration/domain/recovery.mjs';
import { readyWork } from '../server/orchestration/domain/scheduling.mjs';

function failed() {
  const f = fixture(); f.approve();
  f.goal.experienceVersion = 2;
  f.goal.tasks.forEach(task => { task.status = 'integrated'; task.integratedSha = BASE; });
  f.command('request_verification', { operationId: 'check' });
  f.command('record_verification_result', { operationId: 'check', result: { workerState: 'stopped', artifactId: 'f'.repeat(64), verification: { headSha: BASE, checks: [{ id: 'unit', passed: false, artifactId: 'e'.repeat(64), code: 'EXIT_FAILED' }] } } });
  return f;
}

test('stopped ordinary final check failures admit bounded repair with immutable failed evidence', () => {
  const f = failed(), evidence = structuredClone(f.goal.verification), holdId = f.goal.hold.id;
  assert.equal(repairableChecks(f.goal), true);
  assert.throws(() => f.command('repair_failed_checks', { holdId }, f.user), { code: 'FORBIDDEN' });
  assert.throws(() => f.command('repair_failed_checks', { holdId: 'stale' }), { code: 'NOT_READY' });
  f.command('repair_failed_checks', { holdId });
  assert.equal(f.goal.hold, null); assert.equal(f.goal.recoveries.length, 1);
  assert.deepEqual(f.goal.verification, evidence);
  assert.ok(readyWork(f.goal).some(work => work.role === 'integrator'));
  f.request('fix', 'integrator');
  assert.equal(f.goal.finalRepairCount, 1); assert.equal(f.goal.finalRepairLimit, 2);
});

const barriers = {
  legacy: g => { delete g.experienceVersion; },
  paused: g => { g.conversation = { paused: true }; },
  exhausted: g => { g.finalRepairCount = g.finalRepairLimit; },
  unknown: g => { g.verificationRuns[0].workerState = 'unknown'; },
  stale: g => { g.verificationRuns[0].headSha = 'c'.repeat(40); },
  workerCheck: g => { g.verificationRuns[0].attemptId = 'worker'; },
  pendingResult: g => { g.results = [{ status: 'pending' }]; },
  runningWorker: g => { g.attempts[0].workerState = 'running'; },
  unrelatedHold: g => { g.hold.reasons.push({ kind: 'attempt', target: 'failed', message: 'Setup failed' }); },
  repeatedUnchanged: g => { g.recoveries = [1, 2].map(commandId => ({ commandId: String(commandId), hold: structuredClone(g.hold) })); },
};
for (const [name, change] of Object.entries(barriers)) test(`automatic check recovery refuses ${name}`, () => {
  const f = failed(); change(f.goal);
  assert.equal(repairableChecks(f.goal), false);
  assert.throws(() => f.command('repair_failed_checks', { holdId: f.goal.hold.id }), { code: 'NOT_READY' });
});
for (const code of ['OWNERSHIP_UNCERTAIN', 'FORBIDDEN', 'ABORTED', 'CEILING_LIMIT', 'NOT_STARTED', undefined]) test(`automatic check recovery refuses ${code ?? 'missing classification'}`, () => {
  const f = failed();
  f.goal.verification.checks[0].code = code;
  f.goal.verificationRuns[0].result.verification.checks[0].code = code;
  assert.equal(repairableChecks(f.goal), false);
});

test('failed preparation requires a decision even when its exit code is ordinary', () => {
  const f = failed(), check = { id: 'prepare', passed: false, code: 'EXIT_FAILED', artifactId: 'd'.repeat(64) };
  f.goal.verification.checks.unshift(check);
  // The domain projection and durable receipt share the same immutable result.
  assert.equal(repairableChecks(f.goal), false);
});

test('combined final review and check failures repair together without clearing unrelated holds', () => {
  const f = failed();
  f.goal.reviews.push({ id: 'final', attemptId: f.goal.attempts[0].id, kind: 'integration', generation: f.goal.generation, revision: f.goal.revision, target: BASE, disposition: 'request_changes' });
  f.goal.hold.reasons.push({ kind: 'review', target: 'final', message: 'Changes required' });
  assert.equal(repairableChecks(f.goal), true);
  f.command('repair_failed_checks', { holdId: f.goal.hold.id });
  assert.equal(f.goal.hold, null);
});
