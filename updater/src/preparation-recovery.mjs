import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { observeSupervisedProcess } from '../../server/orchestration/adapters/supervised-process.mjs';
import { requestId } from './control.mjs';

export async function reconcilePreparation({ paths, control, id, observe = observeSupervisedProcess }) {
  requestId(id);
  const state = control.read(), item = state.requests[id];
  if (state.activeId !== id || item?.status !== 'recovery_required' || item.backup) throw new Error('No matching preparation recovery');
  const directory = join(paths.stateRoot, 'builds', id);
  if (await realpath(directory) !== directory) throw new Error('Build evidence directory changed');
  const entries = await readdir(directory);
  if (!entries.length || entries.some(name => !/^[a-f0-9]{64}$/.test(name))) throw new Error('Build evidence is incomplete');
  for (const name of entries) {
    const outcome = await observe(join(directory, name));
    if (!outcome || outcome.workerState !== 'stopped') throw new Error('A build worker is still running or uncertain');
  }
  control.finish(id, { success: false, error: 'Build termination was verified. The existing application was preserved; explicitly retry the update when ready.' });
}
