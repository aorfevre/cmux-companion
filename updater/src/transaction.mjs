// The engine owns this protocol across application restarts. All effects are
// injected, so failure/restart tests exercise the same state transitions as macOS.
export async function executeUpdate({ control, request, adapter }) {
  const id = request.id;
  const checkpoint = (phase, details = {}) => control.change(state => {
    if (state.activeId !== id) throw new Error('Update transaction ownership changed');
    Object.assign(state.requests[id], details, { phase });
  });
  let current = control.read().requests[id];
  if (current.status === 'recovery_required') return;
  try {
    if (['switching', 'restarting', 'health-checking', 'rolling-back', 'restoring'].includes(current.phase)) {
      throw new Error('Interrupted activation requires recovery');
    }
    if (current.phase !== 'accepted') {
      const release = await adapter.prepare(current.sha);
      await adapter.verifyFence(id, current.serviceId);
      const backup = current.backup ?? await adapter.backup(id, release);
      await adapter.verifyFence(id, current.serviceId);
      checkpoint('switching', { backup, previousSha: backup.previousSha });
      await adapter.activate(current.sha);
      checkpoint('restarting');
      await adapter.restart();
      checkpoint('health-checking');
      await adapter.health(current.sha);
      checkpoint('accepted');
    }
    // Once health acceptance is durable, an interrupted bootstrap refresh can
    // resume without switching or re-running application data migrations.
    await adapter.accept(current.sha);
    control.finish(id, { success: true });
  } catch (error) {
    if (error.code === 'OWNERSHIP_UNCERTAIN') {
      control.finish(id, { success: false, recoveryRequired: true, error: 'A release build may still be running. Maintenance remains active until its process evidence is reconciled.' }); return;
    }
    current = control.read().requests[id];
    const switched = ['switching', 'restarting', 'health-checking', 'rolling-back', 'restoring', 'accepted'].includes(current.phase);
    if (switched) {
      try {
        checkpoint('rolling-back');
        if (!current.backup || !current.previousSha) throw new Error('Recovery evidence unavailable');
        await adapter.stop();
        checkpoint('restoring');
        await adapter.restore(current.backup);
        await adapter.activate(current.previousSha);
        await adapter.restart();
        await adapter.health(current.previousSha);
        await adapter.accept(current.previousSha);
      } catch {
        control.finish(id, { success: false, recoveryRequired: true, error: 'Update and recovery could not be verified. Maintenance remains active; inspect the local recovery report.' });
        return;
      }
    }
    control.finish(id, { success: false, error: !switched && error.code === 'DATA_COMPATIBILITY' ? 'This update requires a supported data migration. The running version was preserved.' : switched ? 'The update failed; the previous version and its data were restored.' : 'The update could not be prepared safely. The running version was preserved.' });
  }
}

export async function updateCycle({ control, discover, revalidate, deployedSha, maintenance, adapter, now = Date.now(), intervalMs = 300000, id = () => crypto.randomUUID() }) {
  let state = control.read();
  if (state.activeId) return executeUpdate({ control, request: state.requests[state.activeId], adapter });
  if (state.fence) control.unfence(state.fence.id);
  if (state.checkRequested || !state.lastCheckAt || now - Date.parse(state.lastCheckAt) >= intervalMs) {
    try { control.checked(await discover(deployedSha), new Date(now).toISOString()); }
    catch { control.checked({ error: 'Update check unavailable. Verify repository access and GitHub CI, then try again.' }, new Date(now).toISOString()); }
  }
  state = control.read();
  if (state.automatic && state.candidate && !state.checkError && !state.suppressed.includes(state.candidate.sha) && !state.quarantined.includes(state.candidate.sha)
    && !Object.values(state.requests).some(item => ['queued', 'running', 'recovery_required'].includes(item.status))) {
    control.request({ id: id(), sha: state.candidate.sha, source: 'automatic', whenIdle: true });
  }
  const request = Object.values(control.read().requests).find(item => item.status === 'queued');
  if (!request) return;
  let fence;
  try { fence = await maintenance(request.id); } catch {
    control.change(state => { const item = state.requests[request.id]; if (item.status === 'queued') item.error = 'Cannot contact Companion to establish update readiness; check the local service connection'; });
    return;
  }
  if (!fence.ready) {
    control.change(state => { const item = state.requests[request.id]; if (item.status === 'queued') { item.error = typeof fence.reason === 'string' && fence.reason.length <= 1000 ? fence.reason : 'Waiting for Companion-managed work to finish'; if (!item.whenIdle) { item.status = 'cancelled'; item.error += '. Choose Update when ready to queue this update.'; } } });
    control.unfence(request.id); return;
  }
  try { await revalidate(deployedSha, request.sha); }
  catch { control.unfence(request.id); control.change(state => { const item = state.requests[request.id]; if (item.status === 'queued') { item.phase = 'waiting'; item.error = 'Waiting for successful CI and repository access'; } }); return; }
  try {
    control.start(request.id, fence.serviceId);
  } catch { control.unfence(request.id); return; }
  await executeUpdate({ control, request, adapter });
}
