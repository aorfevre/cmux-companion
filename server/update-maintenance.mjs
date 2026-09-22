import { randomUUID } from 'node:crypto';
import { updateError } from '../updater/src/control.mjs';

export function managedWorkBlockerDetails(runtime, handoff = []) {
  if (!runtime?.scheduler || !runtime.store) return [{ code: 'workflow_unavailable', message: 'Companion workflow state is unavailable' }];
  const blockers = [];
  for (const [goalId] of runtime.scheduler.startupJobs ?? []) blockers.push({ code: 'repository_fetch', message: 'A goal repository fetch is still running', goalId });
  for (const [operationId, run] of runtime.scheduler.verifications?.active ?? []) blockers.push({ code: 'verification_process', message: 'A verification process is still running', operationId, goalId: run.goalId });
  for (const [operationId, run] of runtime.scheduler.publications?.active ?? []) blockers.push({ code: 'publication', message: 'A pull request publication is still running', operationId, goalId: run.goalId });
  for (const operation of runtime.store.operations()) if (operation.status !== 'completed') blockers.push({ code: 'managed_operation', message: 'A managed operation has not settled', operationId: operation.id, goalId: operation.goalId, state: operation.status });
  for (const goal of runtime.store.list()) {
    for (const attempt of goal.attempts) if (attempt.workerState !== 'stopped' && !handoff.some(entry => entry.goalId === goal.id && entry.operationId === attempt.operationId && entry.identity === attempt.identity && attempt.role === 'planner' && attempt.mode === 'interactive' && attempt.workerState === 'running' && attempt.status === 'running' && attempt.generation === goal.generation && attempt.revision === goal.revision)) blockers.push({ code: 'managed_agent', message: 'A managed agent requires a verified handoff or completion', goalId: goal.id, operationId: attempt.operationId, attemptId: attempt.id, state: attempt.workerState });
    for (const run of goal.verificationRuns ?? []) if (run.workerState !== 'stopped') blockers.push({ code: 'verification_worker', message: 'A verification worker has not confirmed it stopped', goalId: goal.id, operationId: run.operationId, state: run.workerState });
    for (const result of goal.results ?? []) if (result.status === 'pending') blockers.push({ code: 'pending_result', message: 'A submitted agent result is awaiting reconciliation', goalId: goal.id, operationId: result.operationId, attemptId: result.attemptId, resultId: result.id });
  }
  return blockers;
}

export function managedWorkBlockers(runtime, handoff = []) {
  return [...new Set(managedWorkBlockerDetails(runtime, handoff).map(blocker => blocker.message))];
}

export function managedWorkBusy(runtime, handoff = []) {
  return managedWorkBlockers(runtime, handoff).length > 0;
}

// A goal's lifecycle label and queued work are durable, resumable state. The
// maintenance fence pauses scheduler admission before awaiting its current sweep;
// only owned effects that are still running or unsettled block a restart.

// Installed before listen: HTTP mutations and scheduler admission
// both observe the same durable fence, including after an application restart.
export function installUpdateMaintenance({ runtime, control, serviceId = randomUUID(), now = Date.now }) {
  const mutations = new Map();
  const firstSeen = new Map();
  let logged = new Map();
  const fenced = () => Boolean(control.read().fence);
  runtime.scheduler.paused = fenced;
  const handoff = () => control.read().fence?.handoff ?? [];
  runtime.updateHandoff = handoff;
  runtime.app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
    const path = request.routeOptions.url || request.url.split('?')[0];
    if (path.startsWith('/api/updater/') || path.startsWith('/api/auth/')) return;
    if (fenced()) return reply.code(503).send({ code: 'UPDATE_MAINTENANCE', error: 'An update is in progress; retry after reconnecting' });
    const id = randomUUID();
    const startedAt = new Date(now()).toISOString();
    // Never use the raw URL, body, headers or a caller-controlled request ID.
    const record = { id, code: 'http_request', message: 'A Companion change request is still in progress', method: request.method, route: request.routeOptions.url || '(unmatched route)', startedAt, clientDisconnected: false };
    mutations.set(id, record); request.updateMutation = id;
    const disconnected = () => {
      if (reply.raw.writableFinished || !mutations.has(id)) return;
      record.clientDisconnected = true;
      diagnostics();
    };
    reply.raw.once('close', disconnected);
    request.raw.once('aborted', disconnected);
    request.updateDiagnosticCleanup = () => { reply.raw.off('close', disconnected); request.raw.off('aborted', disconnected); };
    diagnostics();
  });
  runtime.app.addHook('onResponse', async request => {
    if (request.updateMutation) {
      mutations.delete(request.updateMutation); request.updateMutation = null;
      request.updateDiagnosticCleanup?.(); diagnostics();
    }
  });
  function diagnostics() {
    const records = [...mutations.values(), ...managedWorkBlockerDetails(runtime, handoff()).map(detail => ({
      ...detail, id: JSON.stringify([detail.code, detail.goalId, detail.operationId, detail.attemptId, detail.resultId]),
    }))];
    const present = new Set(records.map(record => record.id));
    for (const id of firstSeen.keys()) if (!present.has(id)) firstSeen.delete(id);
    const next = new Map();
    const details = records.map(record => {
      if (!firstSeen.has(record.id)) firstSeen.set(record.id, new Date(now()).toISOString());
      const since = record.startedAt || firstSeen.get(record.id);
      const detail = { ...record, observedAt: since, elapsedMs: Math.max(0, now() - Date.parse(since)) };
      const signature = JSON.stringify(record);
      next.set(record.id, signature);
      if (logged.get(record.id) !== signature) runtime.app.log.info({ event: 'update_blocker_active', blocker: detail }, 'Companion update blocker active');
      return detail;
    });
    for (const [id, record] of logged) if (!next.has(id)) runtime.app.log.info({ event: 'update_blocker_cleared', blocker: JSON.parse(record) }, 'Companion update blocker cleared');
    logged = next;
    return details;
  }
  function blockers() {
    return [...new Set(diagnostics().map(detail => detail.message))];
  }
  async function busy() {
    if (mutations.size || managedWorkBusy(runtime, handoff())) return true;
    // Standalone cmux agents live independently of Companion's service process.
    // Only effects owned by this service participate in its restart fence.
    return false;
  }
  return {
    serviceId,
    blockers,
    diagnostics,
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
        if (mutations.size || managedWorkBusy(runtime, handoff())) throw updateError('Work changed during update admission');
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
