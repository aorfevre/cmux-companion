import { array, identifier, identifiers, object, requireValue, text } from './contracts.mjs';
/** @typedef {import('../types.d.ts').Goal} Goal */
/** Validate the human-approved barriers, including shared resource ownership.
 * @param {unknown} value @param {import('../types.d.ts').TaskContract[]} tasks @param {import('../types.d.ts').Check[]} checks
 * @returns {import('../types.d.ts').WaveContract[]} */
export function parseWaves(value, tasks, checks) {
  const waves = array(value, 100).map(entry => {
    const wave = object(entry);
    return { id: identifier(wave.id), title: text(wave.title, 200), taskIds: identifiers(wave.taskIds), checkIds: identifiers(wave.checkIds) };
  });
  requireValue(waves.length > 0 && new Set(waves.map(wave => wave.id)).size === waves.length, 'Waves must be nonempty and unique');
  const membership = new Map(), byId = new Map(tasks.map(task => [task.id, task]));
  for (const [index, wave] of waves.entries()) {
    requireValue(wave.taskIds.length > 0 && wave.checkIds.length > 0 && wave.checkIds.every(id => checks.some(check => check.id === id)), 'Each wave needs tasks and approved checks');
    for (const id of wave.taskIds) { requireValue(byId.has(id) && !membership.has(id), 'Every task must belong to exactly one wave'); membership.set(id, index); }
    for (let i = 0; i < wave.taskIds.length; i++) for (let j = i + 1; j < wave.taskIds.length; j++) {
      const a = byId.get(wave.taskIds[i]), b = byId.get(wave.taskIds[j]);
      requireValue(a && b, 'Unknown wave task');
      requireValue(!a.ownedAreas.some(left => b.ownedAreas.some(right => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))), 'Tasks in one wave must own independent paths');
      requireValue(!(a.resources ?? []).some(resource => b.resources?.includes(resource)), 'Tasks in one wave must own independent shared resources');
    }
  }
  requireValue(membership.size === tasks.length, 'Every task must belong to exactly one wave');
  for (const task of tasks) requireValue(task.dependsOn.every(id => membership.get(id) < membership.get(task.id)), 'Dependencies must belong to earlier waves');
  const final = waves[waves.length - 1];
  requireValue(checks.every(check => final.checkIds.includes(check.id)), 'The final wave must run every required check');
  return waves;
}
/** @param {Goal} goal */
export function currentWave(goal) {
  const waves = goal.contracts.find(entry => entry.revision === goal.revision)?.contract.waves;
  return waves?.find((wave, index) => !goal.waveResults?.some(result => result.waveId === wave.id && result.generation === goal.generation && result.revision === goal.revision && (index < waves.length - 1 || (result.headSha === goal.integrationHead && goal.verification?.headSha === goal.integrationHead && goal.verification.checks.every(check => check.passed))))) ?? null;
}
/** The legacy journal contract has a single final verification boundary.
 * @param {Goal} goal */
export function integratedWaveReady(goal) {
  const wave = currentWave(goal);
  return !goal.integration && goal.tasks.length > 0 && (wave ? goal.tasks.filter(task => wave.taskIds.includes(task.id)) : goal.tasks).every(task => task.status === 'integrated');
}
/** @param {Goal} goal */
export function waveChecks(goal) {
  const contract = goal.contracts.find(entry => entry.revision === goal.revision)?.contract;
  requireValue(contract, 'Contract unavailable');
  const wave = currentWave(goal);
  return wave ? contract.verification.filter(check => wave.checkIds.includes(check.id)) : contract.verification;
}
/** Record the exact checked barrier in the same transaction as its receipt.
 * Later integration must not erase evidence authorizing the next wave.
 * @param {Goal} goal @param {string | undefined} waveId */
export function acceptWaveVerification(goal, waveId) {
  const wave = currentWave(goal);
  if (!wave || wave.id !== waveId || !integratedWaveReady(goal) || goal.verification?.headSha !== goal.integrationHead || !goal.verification.checks.every(check => check.passed)) return;
  (goal.waveResults ??= []).push({ waveId, generation: goal.generation, revision: goal.revision, headSha: goal.integrationHead });
}

/** Stable identity also after the final barrier passes. @param {Goal} goal */
export function verificationWaveId(goal) {
  return currentWave(goal)?.id ?? goal.contracts.find(entry => entry.revision === goal.revision)?.contract.waves?.at(-1)?.id;
}
