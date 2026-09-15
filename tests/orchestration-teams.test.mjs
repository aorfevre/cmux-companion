import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTeamConfiguration, suggestAssignment } from '../server/orchestration/domain/teams.mjs';
import { transition, planTarget } from '../server/orchestration/domain/transitions.mjs';
import { contract, BASE } from './helpers/orchestration/domain-fixture.mjs';
import { launchProfiles, teamDefaults, profileCapacity } from '../server/launch-profiles.mjs';
import { defaultSettings } from '../server/local-settings.mjs';
const roles = ['planner', 'implementer', 'reviewer', 'integrator'];
const configuration = () => ({ capturedAt: '2026-09-15T10:00:00.000Z', defaults: Object.fromEntries(roles.map(role => [role, 'claude'])), profiles: ['claude', 'codex'].map((provider, index) => ({ id: provider, label: provider, provider, model: 'default', roles, ready: true, reason: 'Validated', capacity: { remainingPercent: index ? 80 : 10, source: 'CCS provider pool', checkedAt: '2026-09-15T10:00:00.000Z', reason: 'Saved provider capacity signal' } })) });
function fixture() {
  let goal = null, id = 0;
  const command = (type, payload = {}, kind = 'system') => { const result = transition(goal, { id: `c${++id}`, goalId: 'g', expectedVersion: goal?.version ?? 0, type, payload }, { kind }); goal = result.goal; return result; };
  command('create_goal', { repositoryId: 'repo', title: 'Team', baseSha: BASE, teamConfiguration: configuration() }, 'user');
  return { get goal() { return goal; }, command, request: (id, role, taskId = null) => command('request_attempt', { attemptId: id, role, taskId, operationId: `op_${id}`, conversationId: id }) };
}
test('suggestions use eligibility and capacity while unknown never means exhausted', () => {
  const config = parseTeamConfiguration(configuration());
  assert.equal(suggestAssignment(config, 'planner', null).profileId, 'codex');
  config.profiles[1].roles = ['implementer']; assert.equal(suggestAssignment(config, 'planner', null).profileId, 'claude');
  config.profiles[0].capacity.remainingPercent = null; assert.equal(suggestAssignment(config, 'planner', null).profileId, 'claude');
  config.profiles[0].capacity.remainingPercent = 0; assert.equal(suggestAssignment(config, 'planner', null).profileId, null);
});
test('one plan approval includes the proposed team and current attempt snapshots are immutable', () => {
  const f = fixture(); f.request('planner', 'planner');
  assert.equal(f.goal.attempts[0].assignment.provider, 'codex');
  assert.throws(() => f.command('override_assignment', { key: 'planner:*', profileId: 'claude' }, 'user'), { code: 'NOT_READY' });
  f.command('record_stopped', { attemptId: 'planner' });
  f.command('publish_contract', { contract: contract() }, 'user');
  f.command('override_assignment', { key: 'implementer:A', profileId: 'claude' }, 'user');
  assert.equal(f.goal.team.approved, false);
  f.request('review', 'reviewer');
  f.command('record_dispatch', { attemptId: 'review', identity: 'review_process', worktree: '/tmp/review', branch: 'review' });
  f.command('record_review', { attemptId: 'review', reviewId: 'review-result', review: { schemaVersion: 1, target: planTarget(f.goal), disposition: 'accept', findings: [] } });
  f.command('record_stopped', { attemptId: 'review' });
  f.command('approve', { revision: 1 }, 'user'); assert.equal(f.goal.team.approved, true);
  f.request('a', 'implementer', 'A');
  const snapshot = structuredClone(f.goal.attempts.at(-1).assignment);
  assert.equal(snapshot.profileId, 'claude');
  assert.throws(() => f.command('override_assignment', { key: snapshot.key, profileId: 'codex' }, 'user'), { code: 'NOT_READY' });
  f.command('record_failure', { attemptId: 'a', confirmedStopped: true, error: 'Fixture failure' });
  f.command('override_assignment', { key: snapshot.key, profileId: 'codex' }, 'user');
  assert.deepEqual(f.goal.attempts.at(-1).assignment, snapshot);
  assert.ok(f.goal.hold, 'changing the next assignment cannot clear a failure hold');
  f.command('recover_goal', { holdId: f.goal.hold.id }, 'user'); f.request('retry', 'implementer', 'A');
  assert.equal(f.goal.attempts.at(-1).assignment.profileId, 'codex');
  assert.equal(f.goal.team.changes.length, 2);
  assert.throws(() => f.command('override_assignment', { key: 'reviewer:*', profileId: 'claude' }, 'agent'));
});
test('launch profiles restrict commands, role defaults and duplicate identities', () => {
  const settings = defaultSettings();
  settings.launchProfiles.push({ id: 'review', label: 'Review', provider: 'codex', command: { executable: 'ccs', args: ['review'], model: 'default' }, enabled: true, roles: ['reviewer'] });
  settings.teamDefaults = { reviewer: 'review' };
  assert.equal(teamDefaults(settings, launchProfiles(settings)).reviewer, 'review');
  settings.teamDefaults.planner = 'review'; assert.throws(() => teamDefaults(settings)); delete settings.teamDefaults.planner;
  settings.launchProfiles[0].command.args.push('--dangerously-bypass-approvals-and-sandbox'); assert.throws(() => launchProfiles(settings));
  settings.launchProfiles[0].command.args.pop(); settings.launchProfiles[0].id = 'claude'; assert.throws(() => launchProfiles(settings));
});
test('failed, stale and missing capacity stays unknown and valid zero remains exhausted', () => {
  const now = Date.parse('2026-09-15T10:00:00Z'), stamp = new Date(now).toISOString();
  const profile = { provider: 'codex' }, usage = { available: true, generatedAt: stamp, providers: [{ id: 'codex', accounts: [{ paused: false, status: 'ready', updatedAt: stamp, windows: [{ category: 'usage', remainingPercent: 65 }] }] }] };
  assert.equal(profileCapacity(profile, usage, now).remainingPercent, 65);
  assert.equal(profileCapacity(profile, usage, now + 16 * 60 * 1000).remainingPercent, null);
  usage.providers[0].accounts[0].status = 'unavailable'; assert.equal(profileCapacity(profile, usage, now).remainingPercent, null);
  usage.providers[0].accounts[0].status = 'exhausted'; usage.providers[0].accounts[0].windows[0].remainingPercent = 0;
  assert.equal(profileCapacity(profile, usage, now).remainingPercent, 0);
  usage.providers[0].accounts.push({ paused: false, status: 'unavailable', updatedAt: stamp, windows: [] });
  assert.equal(profileCapacity(profile, usage, now).remainingPercent, null);
});

test('slow quota services produce unknown capacity without holding goal creation', async () => {
  const { boundedUsageSnapshot } = await import('../server/launch-profiles.mjs');
  assert.deepEqual(await boundedUsageSnapshot(() => new Promise(() => {}), 5), { available: false });
  assert.deepEqual(await boundedUsageSnapshot(() => { throw new Error('private quota error'); }, 5), { available: false });
});

test('manual role preferences carry into the plan while prior approved teams remain in history', () => {
  const f = fixture();
  f.command('override_assignment', { key: 'implementer:*', profileId: 'claude' }, 'user');
  f.command('publish_contract', { contract: contract() }, 'user');
  assert.equal(f.goal.team.assignments.find(assignment => assignment.key === 'implementer:A').profileId, 'claude');
  assert.equal(f.goal.team.assignments.find(assignment => assignment.key === 'implementer:A').manual, true);
  f.command('request_revision', { message: 'Refine the design' }, 'user');
  assert.equal(f.goal.team.approved, false); assert.equal(f.goal.teamHistory.length, 2);
});
