import { array, identifier, identifiers, object, requireValue, text } from './contracts.mjs';
export const TEAM_ROLES = /** @type {const} */ (['planner', 'implementer', 'reviewer', 'integrator']);
/** Every dispatchable role. A composition that omits one cannot start that
 * work, so each agent port declares its capability from this list. */
export const ROLES = /** @type {const} */ (['planner', 'implementer', 'reviewer', 'integrator', 'review_fixer']);
/** The planner is the only interactive role; every other role runs in the background.
 * @param {import('../types.d.ts').Role} role */
export const roleMode = (role) => role === 'planner' ? 'interactive' : 'background';
/** @param {unknown} value @returns {import('../types.d.ts').TeamConfiguration} */
export function parseTeamConfiguration(value) {
  const input = object(value), defaults = object(input.defaults);
  const profiles = array(input.profiles, 50).map(entry => {
    const profile = object(entry), capacity = object(profile.capacity), roles = identifiers(profile.roles);
    requireValue(['claude', 'codex'].includes(String(profile.provider)) && roles.length > 0 && roles.every(role => TEAM_ROLES.includes(/** @type {import('../types.d.ts').TeamRole} */ (role))), 'Invalid profile eligibility');
    requireValue(typeof profile.ready === 'boolean', 'Missing profile readiness');
    requireValue(capacity.remainingPercent === null || (typeof capacity.remainingPercent === 'number' && Number.isFinite(capacity.remainingPercent) && capacity.remainingPercent >= 0 && capacity.remainingPercent <= 100), 'Invalid remaining capacity');
    return { id: identifier(profile.id), label: text(profile.label, 160), provider: /** @type {'claude'|'codex'} */ (profile.provider), model: text(profile.model, 160), roles: /** @type {import('../types.d.ts').TeamRole[]} */ (roles), ready: profile.ready,
      reason: text(profile.reason, 1000), capacity: { remainingPercent: /** @type {number|null} */ (capacity.remainingPercent), source: text(capacity.source, 100), checkedAt: capacity.checkedAt === null ? null : text(capacity.checkedAt, 100), reason: text(capacity.reason, 1000) } };
  });
  requireValue(profiles.length > 0 && new Set(profiles.map(profile => profile.id)).size === profiles.length, 'Profiles must be nonempty and unique');
  /** @type {Record<import('../types.d.ts').TeamRole,string>} */ const preferred = { planner: '', implementer: '', reviewer: '', integrator: '' };
  for (const role of TEAM_ROLES) { preferred[role] = identifier(defaults[role]); requireValue(profiles.some(profile => profile.id === preferred[role] && profile.roles.includes(role)), 'Default profile is not eligible for its role'); }
  return { profiles, defaults: preferred, capturedAt: text(input.capturedAt, 100) };
}
/** @param {import('../types.d.ts').TeamRole} role @param {string|null} taskId */
export const assignmentKey = (role, taskId) => `${role}:${taskId ?? '*'}`;
/** @param {import('../types.d.ts').TeamConfiguration} config @param {import('../types.d.ts').TeamRole} role @param {string|null} taskId @returns {import('../types.d.ts').TeamAssignment} */
export function suggestAssignment(config, role, taskId) {
  const eligible = config.profiles.filter(profile => profile.ready && profile.roles.includes(role) && profile.capacity.remainingPercent !== 0);
  const rank = (/** @type {typeof eligible[number]} */ profile) => (profile.capacity.remainingPercent === null ? 0 : 100 + profile.capacity.remainingPercent) + (profile.id === config.defaults[role] ? 0.5 : 0);
  const profile = eligible.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id))[0];
  return { key: assignmentKey(role, taskId), role, taskId, profileId: profile?.id ?? null, manual: false,
    reason: profile ? `${profile.label} is eligible for ${role}. ${profile.capacity.remainingPercent === null ? 'Capacity is unknown; using the configured preference among eligible profiles.' : `${profile.capacity.remainingPercent}% remaining in the saved capacity snapshot.`}${profile.id === config.defaults[role] ? ' Preferred for this role.' : ''}` : `No ready, non-exhausted profile is available for ${role}. Choose an eligible profile explicitly or correct Setup for a new goal.` };
}
/** @param {import('../types.d.ts').Goal} goal */
export function proposeTeam(goal) {
  const config = goal.teamConfiguration; if (!config) return;
  const previous = goal.team;
  /** @param {import('../types.d.ts').TeamRole} role @param {string|null} taskId */
  const choose = (role, taskId) => {
    const manual = previous?.assignments.find(entry => entry.manual && entry.key === assignmentKey(role, taskId)) ?? previous?.assignments.find(entry => entry.manual && entry.key === assignmentKey(role, null));
    return manual && config.profiles.some(profile => profile.id === manual.profileId && profile.ready && profile.roles.includes(role)) ? { ...structuredClone(manual), key: assignmentKey(role, taskId), taskId } : suggestAssignment(config, role, taskId);
  };
  const assignments = TEAM_ROLES.filter(role => role !== 'implementer' || !goal.tasks.length).map(role => choose(role, null));
  for (const task of goal.tasks) for (const role of /** @type {const} */ (['implementer', 'reviewer'])) assignments.push(choose(role, task.id));
  if (previous) (goal.teamHistory ??= []).push(structuredClone(previous));
  goal.team = { revision: goal.revision, approved: false, assignments, changes: [] };
}
/** The review fixer has no configured team role; it reuses the integrator profile.
 * @param {import('../types.d.ts').Goal} goal @param {import('../types.d.ts').Role} role @param {string|null} taskId */
export function assignmentFor(goal, role, taskId) {
  const lookup = /** @type {import('../types.d.ts').TeamRole} */ (role === 'review_fixer' ? 'integrator' : role);
  const assignment = goal.team?.assignments.find(entry => entry.key === assignmentKey(lookup, taskId)) ?? goal.team?.assignments.find(entry => entry.key === assignmentKey(lookup, null));
  if (!goal.teamConfiguration) return undefined;
  requireValue(assignment?.profileId, 'Choose a ready team profile before dispatch', 'NOT_READY');
  const profile = goal.teamConfiguration.profiles.find(entry => entry.id === assignment.profileId);
  requireValue(profile && profile.ready && profile.roles.includes(lookup), 'Assigned profile is not ready for this role', 'NOT_READY');
  return { ...structuredClone(assignment), provider: profile.provider, model: profile.model, label: profile.label };
}
/** Explicit edits affect only future attempts. Their recorded snapshots never change.
 * @param {import('../types.d.ts').Goal} goal @param {unknown} key @param {unknown} profileId */
export function validateAssignmentOverride(goal, key, profileId) {
  requireValue(goal.team && goal.teamConfiguration && ['discovering', 'awaiting_approval', 'building'].includes(goal.status), 'Team assignment is unavailable', 'NOT_READY');
  const assignment = goal.team.assignments.find(entry => entry.key === key);
  const profile = goal.teamConfiguration.profiles.find(entry => entry.id === profileId);
  requireValue(assignment && profile && profile.ready && profile.roles.includes(assignment.role), 'Choose a ready eligible profile', 'FORBIDDEN');
  requireValue(!goal.attempts.some(attempt => attempt.assignment?.key === key && attempt.workerState !== 'stopped'), 'The assigned worker must stop before choosing its replacement', 'NOT_READY');
  return { assignment, profile };
}
/** @param {import('../types.d.ts').Goal} goal @param {unknown} key @param {unknown} profileId @param {string} commandId */
export function overrideAssignment(goal, key, profileId, commandId) {
  const { assignment, profile } = validateAssignmentOverride(goal, key, profileId);
  requireValue(goal.team, 'Team unavailable');
  const before = assignment.profileId;
  assignment.profileId = profile.id; assignment.manual = true; assignment.reason = `Manually selected ${profile.label}. ${profile.capacity.reason}`;
  goal.team.changes.push({ commandId, key: assignment.key, from: before, to: profile.id });
}
