import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { contract, HEAD_A } from './domain-fixture.mjs';
import { planTarget } from '../../../server/orchestration/domain/transitions.mjs';
import { Scheduler } from '../../../server/orchestration/scheduler.mjs';

// Persistent external inventory survives the service process, like a provider's
// operation lookup. It is deliberately separate from the workflow database.
const [directory, crashAt, role = 'planner'] = process.argv.slice(2);
const inventory = join(directory, 'workers.json'), launches = join(directory, 'launches.txt');
function crash(point) {
  if (point !== crashAt) return;
  writeFileSync(join(directory, 'checkpoint'), point);
  process.kill(process.pid, 'SIGKILL');
}
const store = new OrchestrationStore({ path: join(directory, 'state.sqlite') });
const agents = {
  capabilities: ['planner', 'reviewer', 'implementer', 'integrator'].map(role => ({ role, mode: role === 'planner' ? 'interactive' : 'background' })),
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
  async terminate(identity) {
    crash('termination_sent');
    const workers = JSON.parse(readFileSync(inventory, 'utf8'));
    for (const worker of Object.values(workers)) if (worker.identity === identity) worker.status = 'stopped';
    writeFileSync(inventory, JSON.stringify(workers)); crash('termination_success');
  },
};
const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
if (!store.get('g')) service.execute({ id: 'create', goalId: 'g', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'recovery', baseSha: 'a'.repeat(40) } }, { kind: 'user' });
if (role !== 'planner' && store.get('g').revision === 0) {
  let id = 0;
  const command = (type, payload, kind = 'system') => service.execute({ id: `seed${++id}`, goalId: 'g', expectedVersion: store.get('g').version, type, payload }, { kind });
  const request = (attemptId, role, taskId = null) => command('request_attempt', { attemptId, operationId: `seed_${attemptId}`, role, taskId, conversationId: `conversation_${attemptId}` });
  const dispatch = attemptId => command('record_dispatch', { attemptId, identity: `seed_${attemptId}`, worktree: join(directory, attemptId), branch: `companion/g/${attemptId}` });
  const review = (attemptId, target) => { command('record_review', { attemptId, reviewId: `review_${attemptId}`, review: { schemaVersion: 1, target, disposition: 'accept', findings: [] } }); command('record_stopped', { attemptId }); };
  const value = contract(); value.tasks = [value.tasks[0]];
  command('publish_contract', { contract: value }, 'user');
  if (role !== 'reviewer') {
    request('seed_review', 'reviewer'); dispatch('seed_review'); review('seed_review', planTarget(store.get('g')));
    command('approve', { revision: 1 }, 'user');
  }
  if (role === 'integrator') {
    request('seed_implementation', 'implementer', 'A'); dispatch('seed_implementation');
    command('confirm_candidate', { attemptId: 'seed_implementation', headSha: HEAD_A }); command('record_stopped', { attemptId: 'seed_implementation' });
    request('seed_task_review', 'reviewer', 'A'); dispatch('seed_task_review'); review('seed_task_review', HEAD_A);
    command('request_integration', { taskId: 'A', operationId: 'seed_integration' }); command('record_integration_conflict', { operationId: 'seed_integration' });
      command('recover_goal', { holdId: store.get('g').hold.id }, 'user');
  }
  for (const operation of store.operations()) store.advanceOperation(operation.id, operation.status, 'completed');
}

store.failpoint = (point) => {
  if (point !== 'after_commit') return;
  const attempt = store.get('g').attempts.filter(attempt => !attempt.id.startsWith('seed_')).at(-1);
  if (!attempt) return;
  if (store.get('g').status === 'aborted') crash('abort_committed');
  if (attempt.workerState === 'pending') crash('intent');
  if (store.db.prepare("SELECT id FROM operations WHERE id=? AND status='completed'").get(attempt.operationId)) crash('completion');
};
const scheduler = new Scheduler({ service, repositories: {
  async provision({ branch, baseSha }) { return { worktree: join(directory, 'checkout'), branch, baseSha }; },
  async provisionRepair({ attempt }) { return { worktree: join(directory, 'checkout'), branch: `companion/g/${attempt.id}`, baseSha: attempt.baseSha }; },
}, integrations: { async provisionRepair({ attempt }) { return { worktree: join(directory, 'checkout'), branch: `companion/g/${attempt.id}`, baseSha: attempt.baseSha }; } } });
await scheduler.start();
if (['abort_committed', 'termination_sent', 'termination_success'].includes(crashAt) && store.get('g').status !== 'aborted') {
  service.execute({ id: 'abort', goalId: 'g', expectedVersion: store.get('g').version, type: 'abort', payload: {} }, { kind: 'user' });
  await scheduler.tick();
}
process.stdout.write(JSON.stringify({ status: store.get('g').status, attempt: store.get('g').attempts.filter(attempt => !attempt.id.startsWith('seed_')).at(-1), capacity: store.ownedCapacity('g', role === 'planner' ? 'interactive' : 'background'), operations: store.operations() }));
await scheduler.stop(); store.close();
