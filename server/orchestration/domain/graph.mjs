import { parseWaves, currentWave } from './waves.mjs';
import { array, identifier, identifiers, object, requireValue, text } from './contracts.mjs';

/** Owned areas are literal repository-relative files/directories, never shell globs. @param {unknown} value */
export function ownedArea(value) {
  const path = text(value, 500).replace(/\/$/, '');
  requireValue(!path.startsWith('/') && ![...path].some((char) => char.charCodeAt(0) < 32 || '\\:*?[]{}'.includes(char)), 'Owned areas must be literal relative paths');
  requireValue(path.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git'), 'Unsafe owned area');
  return path;
}
/** @param {string} left @param {string} right */
const overlaps = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

/** @param {unknown} value @returns {import('../types.d.ts').Contract} */
export function parseContract(value) {
  const input = object(value);
  requireValue(input.schemaVersion === 1 || input.schemaVersion === 2, 'Unsupported contract schema');
  const criteria = array(input.criteria).map((entry) => {
    const item = object(entry);
    return { id: identifier(item.id), text: text(item.text), verification: identifier(item.verification) };
  });
  requireValue(criteria.length > 0 && new Set(criteria.map((item) => item.id)).size === criteria.length, 'Criteria must be nonempty and unique');
  const verification = array(input.verification, 30).map((entry) => {
    const check = object(entry);
    const argv = array(check.argv, 100).map((arg) => text(arg, 1000));
    requireValue(argv.length > 0, 'Verification needs an executable');
    return { id: identifier(check.id), argv };
  });
  requireValue(verification.length > 0 && new Set(verification.map((check) => check.id)).size === verification.length, 'Checks must be nonempty and unique');
  const checks = new Set(verification.map((check) => check.id));
  requireValue(criteria.every((criterion) => checks.has(criterion.verification)), 'Criterion references an unknown check');
  const tasks = array(input.tasks, 100).map((entry) => {
    const task = object(entry);
    requireValue(task.integrationPolicy === undefined || task.integrationPolicy === null || task.integrationPolicy === 'serialize', 'Unknown integration policy');
    return {
      id: identifier(task.id), title: text(task.title, 200), prompt: text(task.prompt, 16000),
      dependsOn: identifiers(task.dependsOn), ownedAreas: array(task.ownedAreas).map(ownedArea),
      criterionIds: identifiers(task.criterionIds), ...(input.schemaVersion === 2 ? { resources: identifiers(task.resources) } : {}),
      integrationPolicy: /** @type {'serialize' | null} */ (task.integrationPolicy ?? null),
    };
  });
  validateGraph(tasks, criteria.map((criterion) => criterion.id));
  return { schemaVersion: input.schemaVersion, ...(input.schemaVersion === 2 ? { waves: parseWaves(input.waves, tasks, verification) } : {}), outcome: text(input.outcome), scope: array(input.scope).map((item) => text(item)), exclusions: array(input.exclusions).map((item) => text(item)), criteria, verification, tasks };
}

/** @param {import('../types.d.ts').TaskContract[]} tasks @param {string[]} criterionIds */
export function validateGraph(tasks, criterionIds) {
  requireValue(tasks.length > 0, 'A contract needs tasks');
  const byId = new Map(tasks.map((task) => [task.id, task]));
  requireValue(byId.size === tasks.length, 'Duplicate task ids');
  const criteria = new Set(criterionIds), owned = new Set();
  for (const task of tasks) {
    requireValue(task.dependsOn.every((id) => byId.has(id)), 'Unknown dependency');
    requireValue(task.ownedAreas.length > 0 && new Set(task.ownedAreas).size === task.ownedAreas.length, 'Task needs unique owned areas');
    requireValue(task.criterionIds.length > 0 && task.criterionIds.every((id) => criteria.has(id)), 'Task needs valid criteria');
    task.criterionIds.forEach((id) => owned.add(id));
  }
  requireValue(criterionIds.every((id) => owned.has(id)), 'Unowned acceptance criterion');
  /** @type {Map<string, Set<string>>} */
  const ancestors = new Map();
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @param {string} id @returns {Set<string>} */
  function visit(id) {
    const known = ancestors.get(id);
    if (known) return known;
    requireValue(!visiting.has(id), 'Cyclic dependencies');
    visiting.add(id);
    const task = byId.get(id);
    requireValue(task, 'Unknown dependency');
    const result = new Set(task.dependsOn);
    for (const dependency of task.dependsOn) for (const ancestor of visit(dependency)) result.add(ancestor);
    visiting.delete(id); ancestors.set(id, result); return result;
  }
  tasks.forEach((task) => visit(task.id));
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i], b = tasks[j];
    if (!a.ownedAreas.some((left) => b.ownedAreas.some((right) => overlaps(left, right)))) continue;
    requireValue(visit(a.id).has(b.id) || visit(b.id).has(a.id) || (a.integrationPolicy === 'serialize' && b.integrationPolicy === 'serialize'), 'Overlapping tasks need ordering or explicit serialized integration');
  }
}
/** @param {import('../types.d.ts').Goal} goal */
export function readyTasks(goal) {
  if (goal.hold || goal.status !== 'building' || goal.approvedRevision !== goal.revision) return [];
  const integrated = new Set(goal.tasks.filter((task) => task.status === 'integrated').map((task) => task.id));
  const wave = currentWave(goal);
  return goal.tasks.filter((task) => (!wave || wave.taskIds.includes(task.id)) && (task.status === 'pending' || (task.status === 'repair_required' && task.repairCount < task.repairLimit)) && task.dependsOn.every((id) => integrated.has(id)));
}
