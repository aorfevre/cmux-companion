import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { Scheduler } from '../../../server/orchestration/scheduler.mjs';

const [directory, crashAt] = process.argv.slice(2);
const inventory = join(directory, 'workers.json'), launches = join(directory, 'launches.txt');
function crash(point) {
  if (point !== crashAt) return;
  writeFileSync(join(directory, 'checkpoint'), point);
  process.kill(process.pid, 'SIGKILL');
}
const store = new OrchestrationStore({ path: join(directory, 'state.sqlite'), now: () => new Date(100000).toISOString() });
const agents = {
  capabilities: [{ role: 'planner', mode: 'interactive' }],
  async launch(request) {
    const identity = `worker_${request.operationId}`;
    appendFileSync(launches, `${request.operationId}\n`);
    writeFileSync(inventory, JSON.stringify({ [request.operationId]: { status: 'running', identity } }));
    crash('sent'); return { identity };
  },
  async observe(operationId) {
    const workers = existsSync(inventory) ? JSON.parse(readFileSync(inventory, 'utf8')) : {};
    return workers[operationId] ?? { status: 'stopped', identity: null };
  },
  async terminate() { throw new Error('No termination expected'); },
};
const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
const command = (id, type, payload, kind = 'system') => service.execute({ id, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, { kind });
if (!store.get('g')) {
  command('create', 'create_goal', { repositoryId: 'repo', title: 'Automatic recovery', baseSha: 'a'.repeat(40), experienceVersion: 2 }, 'user');
  command('old', 'request_attempt', { attemptId: 'old', operationId: 'old', role: 'planner', conversationId: 'old' });
  command('dispatch', 'record_dispatch', { attemptId: 'old', identity: 'old', worktree: join(directory, 'old'), branch: 'goal/old' });
  command('stopped', 'record_stopped', { attemptId: 'old' });
  store.advanceOperation('old', 'pending', 'completed');
}
store.failpoint = point => {
  if (point !== 'after_commit') return;
  const decision = store.get('g').recoveryPolicy.decisions.at(-1);
  if (decision?.state === 'scheduled') crash('reserved');
  if (decision?.state === 'applied') crash('applied');
};
if (!store.get('g').recoveryPolicy.decisions.length) command('reserve', 'schedule_goal_recovery', { now: 0 });
const decision = store.get('g').recoveryPolicy.decisions[0];
if (decision.state === 'scheduled') command('apply', 'apply_goal_recovery', { decisionId: decision.id, now: 100000 });
const scheduler = new Scheduler({ service, repositories: {
  async provision({ branch, baseSha }) { return { worktree: join(directory, 'replacement'), branch, baseSha }; },
} });
await scheduler.start(); await scheduler.tick();
process.stdout.write(JSON.stringify({ goal: store.get('g'), capacity: store.executionCapacity('g'), operations: store.operations() }));
await scheduler.stop(); store.close();
