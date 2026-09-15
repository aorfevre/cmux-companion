import { randomUUID } from 'node:crypto';
import { updateError } from '../updater/src/control.mjs';

export function managedWorkBlockers(runtime, handoff = []) {
  if (!runtime?.scheduler || !runtime.store) return ['Companion workflow state is unavailable'];
  const blockers = [];
  if (runtime.scheduler.startupJobs?.size) blockers.push('A goal repository fetch is still running');
  if (runtime.scheduler.verifications?.active.size) blockers.push('A verification process is still running');
  if (runtime.scheduler.publications?.active.size) blockers.push('A pull request publication is still running');
  if (runtime.store.operations().some(op => op.status !== 'completed')) blockers.push('A managed operation has not settled');
  for (const goal of runtime.store.list()) {
    if (goal.attempts.some(attempt => attempt.workerState !== 'stopped' && !handoff.some(entry => entry.goalId === goal.id && entry.operationId === attempt.operationId && entry.identity === attempt.identity && attempt.role === 'planner' && attempt.mode === 'interactive' && attempt.workerState === 'running' && attempt.status === 'running' && attempt.generation === goal.generation && attempt.revision === goal.revision))) blockers.push('A managed agent requires a verified handoff or completion');
    if (goal.verificationRuns?.some(run => run.workerState !== 'stopped')) blockers.push('A verification worker has not confirmed it stopped');
    if (goal.results?.some(result => result.status === 'pending')) blockers.push('A submitted agent result is awaiting reconciliation');
  }
  return [...new Set(blockers)];
}

export function managedWorkBusy(runtime, handoff = []) {
  return managedWorkBlockers(runtime, handoff).length > 0;
}

// A goal's lifecycle label and queued work are durable, resumable state. The
// maintenance fence pauses scheduler admission before awaiting its current sweep;
// only owned effects that are still running or unsettled block a restart.

// Installed before listen: HTTP mutations and scheduler admission
// both observe the same durable fence, including after an application restart.
export function installUpdateMaintenance({ runtime, control, serviceId = randomUUID() }) {
  let mutations = 0;
  const fenced = () => Boolean(control.read().fence);
  runtime.scheduler.paused = fenced;
  const handoff = () => control.read().fence?.handoff ?? [];
  runtime.updateHandoff = handoff;
  runtime.app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const path = request.routeOptions.url || request.url.split('?')[0];
    if (path.startsWith('/api/updater/') || path.startsWith('/api/auth/')) return;
    if (fenced()) return reply.code(503).send({ code: 'UPDATE_MAINTENANCE', error: 'An update is in progress; retry after reconnecting' });
    mutations++; request.updateMutation = true;
  });
  runtime.app.addHook('onResponse', async request => { if (request.updateMutation) { request.updateMutation = false; mutations--; } });
  function blockers() {
    return [...(mutations ? ['A Companion change request is still in progress'] : []), ...managedWorkBlockers(runtime, handoff())];
  }
  async function busy() {
    if (mutations || managedWorkBusy(runtime, handoff())) return true;
    // Standalone cmux agents live independently of Companion's service process.
    // Only effects owned by this service participate in its restart fence.
    return false;
  }
  return {
    serviceId,
    blockers,
    async adopt() {
      if (handoff().length) {
        const observed = await runtime.prepareHandoff(handoff());
        if (JSON.stringify(observed) !== JSON.stringify(handoff())) throw updateError('Preserved planning agent identity changed');
      }
    },
    async acquire(id) {
      control.fence(id, serviceId);
      try {
        await runtime.scheduler.sweep;
        // Non-terminal effects remain fenced. Only fully dispatched interactive
        // planners may supply continuity evidence, never a goal/status count.
        const transferable = runtime.store.list().flatMap(goal => goal.attempts.filter(attempt => attempt.workerState !== 'stopped').map(attempt => ({ goalId: goal.id, operationId: attempt.operationId, identity: attempt.identity })));
        if (!managedWorkBusy(runtime, transferable) && transferable.length) {
          const evidence = await runtime.prepareHandoff();
          control.change(state => { if (state.fence?.id !== id || state.fence.serviceId !== serviceId) throw updateError('Update fence changed'); state.fence.handoff = evidence; });
        }
        const waiting = blockers();
        if (waiting.length) { control.unfence(id); return { ready: false, serviceId, reason: waiting.join('; ') }; }
        // Include requests that entered before the fence while external evidence
        // was being collected; new requests cannot pass onRequest during it.
        if (mutations || managedWorkBusy(runtime, handoff())) throw updateError('Work changed during update admission');
        return { ready: true, serviceId };
      } catch (error) { control.unfence(id); return { ready: false, serviceId, reason: error?.code === 'HANDOFF_UNSUPPORTED' ? 'Existing planning agent needs update-compatible recovery; let it finish or use explicit operator recovery' : 'Unable to establish that Companion-managed work is safely idle' }; }
    },
    async verify(id, expectedServiceId) {
      const fence = control.read().fence;
      if (expectedServiceId !== serviceId || fence?.id !== id || fence.serviceId !== serviceId || await busy()) throw updateError('Update maintenance evidence changed');
      if (handoff().length && JSON.stringify(await runtime.prepareHandoff(handoff())) !== JSON.stringify(handoff())) throw updateError('Planning handoff changed');
      return { ready: true, serviceId };
    },
  };
}
