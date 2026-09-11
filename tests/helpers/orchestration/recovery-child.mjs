import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { Scheduler } from '../../../server/orchestration/scheduler.mjs';

// Persistent external inventory survives the service process, like a provider's
// operation lookup. It is deliberately separate from the workflow database.
const [directory, crashAt] = process.argv.slice(2);
const inventory = join(directory, 'workers.json'), launches = join(directory, 'launches.txt');
function crash(point) {
  if (point !== crashAt) return;
  writeFileSync(join(directory, 'checkpoint'), point);
  process.kill(process.pid, 'SIGKILL');
}
const store = new OrchestrationStore({ path: join(directory, 'state.sqlite') });
const agents = {
  capabilities: [{ role: 'planner', mode: 'interactive' }],
  async launch(request) {
    const identity = `worker_${request.operationId}`;
    appendFileSync(launches, `${request.operationId}\n`);
    writeFileSync(inventory, JSON.stringify({ [request.operationId]: { status: 'running', identity } }));
    crash('dispatch');
    return { identity };
  },
  async observe(operationId) {
    const workers = existsSync(inventory) ? JSON.parse(readFileSync(inventory, 'utf8')) : {};
    return workers[operationId] ?? { status: 'stopped', identity: null };
  },
  async terminate() { throw new Error('Termination is not part of this recovery scenario'); },
};
const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
if (!store.get('g')) service.execute({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'recovery', baseSha: 'a'.repeat(40) } }, { kind: 'user' });
store.failpoint = (point) => {
  if (point !== 'after_commit') return;
  const attempt = store.get('g').attempts[0];
  if (!attempt) return;
  if (attempt.workerState === 'pending') crash('intent');
  if (store.db.prepare("SELECT id FROM operations WHERE status='completed'").get()) crash('completion');
};
const scheduler = new Scheduler({ service, repositories: {
  async provision({ branch, baseSha }) { return { worktree: join(directory, 'checkout'), branch, baseSha }; },
} });
await scheduler.start();
process.stdout.write(JSON.stringify({ attempt: store.get('g').attempts[0], capacity: store.ownedCapacity('g', 'interactive'), operations: store.operations() }));
await scheduler.stop(); store.close();
