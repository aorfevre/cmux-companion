import { randomUUID } from 'node:crypto';
import { updateError } from '../updater/src/control.mjs';

export function managedWorkBusy(runtime) {
  if (!runtime?.scheduler || !runtime.store) return true;
  if (runtime.scheduler.verifications?.active.size || runtime.scheduler.publications?.active.size) return true;
  if (runtime.store.operations().some(op => op.status !== 'completed')) return true;
  return runtime.store.list().some(goal => goal.attempts.some(attempt => attempt.workerState !== 'stopped')
    || goal.verificationRuns?.some(run => run.workerState !== 'stopped')
    || ['discovering', 'building', 'ready_to_publish'].includes(goal.status));
}

// Installed before listen: HTTP mutations, scheduler admission and prompt draining
// all observe the same durable fence, including after an application restart.
export function installUpdateMaintenance({ runtime, control, promptQueue, serviceId = randomUUID() }) {
  let mutations = 0;
  const fenced = () => Boolean(control.read().fence);
  runtime.scheduler.paused = fenced;
  if (promptQueue) promptQueue.paused = fenced;
  runtime.app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const path = request.routeOptions.url || request.url.split('?')[0];
    if (path.startsWith('/api/updater/') || path.startsWith('/api/auth/')) return;
    if (fenced()) return reply.code(503).send({ code: 'UPDATE_MAINTENANCE', error: 'An update is in progress; retry after reconnecting' });
    mutations++; request.updateMutation = true;
  });
  runtime.app.addHook('onResponse', async request => { if (request.updateMutation) { request.updateMutation = false; mutations--; } });
  async function busy() {
    if (mutations || managedWorkBusy(runtime) || promptQueue?.inFlight.size) return true;
    // Standalone cmux agents live independently of Companion's service process.
    // Only effects owned by this service participate in its restart fence.
    return false;
  }
  return {
    serviceId,
    async acquire(id) {
      control.fence(id, serviceId);
      try {
        await runtime.scheduler.sweep;
        if (await busy()) { control.unfence(id); return { ready: false, serviceId, reason: 'Waiting for Companion-managed work to finish' }; }
        // Include requests that entered before the fence while external evidence
        // was being collected; new requests cannot pass onRequest during it.
        if (mutations || managedWorkBusy(runtime) || promptQueue?.inFlight.size) throw updateError('Work changed during update admission');
        return { ready: true, serviceId };
      } catch { control.unfence(id); return { ready: false, serviceId, reason: 'Unable to establish that Companion-managed work is safely idle' }; }
    },
    async verify(id, expectedServiceId) {
      const fence = control.read().fence;
      if (expectedServiceId !== serviceId || fence?.id !== id || fence.serviceId !== serviceId || await busy()) throw updateError('Update maintenance evidence changed');
      return { ready: true, serviceId };
    },
  };
}
