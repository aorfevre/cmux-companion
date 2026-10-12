import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { Scheduler } from '../../../server/orchestration/scheduler.mjs';
import { contract, BASE } from './domain-fixture.mjs';

// The service is a real child process with one persistent SQLite journal.
// Provider inventory is a separate disposable adapter, not native acceptance.
const [directory, phase] = process.argv.slice(2);
const path = name => join(directory, name);
const read = name => existsSync(path(name)) ? JSON.parse(readFileSync(path(name), 'utf8')) : {};
const save = (name, value) => writeFileSync(path(name), JSON.stringify(value));
const trace = value => appendFileSync(path('trace.jsonl'), JSON.stringify({ phase, ...value }) + '\n');
const store = new OrchestrationStore({ path: path('state.sqlite') });
const agents = {
  capabilities: ['planner', 'implementer', 'reviewer'].map(role => ({ role, mode: role === 'planner' ? 'interactive' : 'background' })),
  async launch(request) {
    const identity = `worker_${request.operationId}`, workers = read('workers.json');
    trace({ kind: 'launch', role: request.attempt.role, operationId: request.operationId, conversationId: request.attempt.conversationId });
    workers[request.operationId] = { status: 'running', identity }; save('workers.json', workers);
    return { identity };
  },
  async observe(operationId) {
    trace({ kind: 'observe', operationId });
    if (phase === 'unknown') return { status: 'unknown', identity: null };
    return read('workers.json')[operationId] ?? { status: 'stopped', identity: null };
  },
  async terminate() { throw new Error('Conversation restart must not terminate its supervisor'); },
};
const service = new OrchestrationService({ store, agents, repositoryIds: new Set(['repo']) });
const execute = (id, type, payload, authority) => service.execute({ id, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, authority ?? { kind: 'user' });
const scheduler = new Scheduler({ service, planReviewEnabled: () => false, repositories: {
  async provision({ branch, baseSha }) { return { worktree: path('checkout'), branch, baseSha }; },
} });
if (phase === 'seed') execute('create', 'create_goal', { repositoryId: 'repo', title: 'Conversation restart', baseSha: BASE, experienceVersion: 2 });
await scheduler.start();
const supervisor = store.get('g').attempts.find(attempt => attempt.role === 'planner');
const authority = { kind: 'agent', goalId: 'g', role: 'planner', attemptId: supervisor.id, generation: supervisor.generation, revision: supervisor.revision };
if (phase === 'seed') {
  scheduler.paused = () => true; // Keep admission behind a deterministic crash barrier.
  execute('question', 'supervisor_question', { message: 'Which module?', replyTo: 1 }, authority);
  execute('answer', 'send_goal_message', { message: 'The first module.' });
  execute('answer-ack', 'supervisor_ack', { through: 3 }, authority);
  execute('answer-reply', 'supervisor_reply', { message: 'I will keep the scope to module A.', replyTo: 3 }, authority);
  const proposal = contract(); proposal.tasks = [proposal.tasks[0]];
  execute('proposal', 'supervisor_propose', { contract: proposal }, authority);
  execute('approve', 'approve', { revision: 1 });
  execute('dispatch', 'supervisor_dispatch', {}, authority);
  execute('worker-intent', 'request_attempt', { attemptId: 'worker', operationId: 'worker-launch', role: 'implementer', taskId: 'A', conversationId: 'worker-native-session' }, { kind: 'system' });
  execute('pause', 'pause_goal', {});
  const queued = { id: 'queued-steering', goalId: 'g', expectedVersion: store.get('g').version, type: 'send_goal_message', payload: { message: 'Preserve the exported function name.' } };
  save('message-command.json', queued);
  store.failpoint = point => {
    if (point !== 'after_commit') return;
    save('checkpoint.json', { journalId: store.journalId, goal: store.get('g'), operations: store.operations() });
    process.kill(process.pid, 'SIGKILL');
  };
  service.execute(queued, { kind: 'user' });
} else {
  const before = store.get('g');
  service.execute(read('message-command.json'), { kind: 'user' }); // Lost HTTP response replay.
  if (phase === 'resume') {
    execute('resume', 'resume_goal', {});
    await scheduler.tick();
    const message = store.get('g').conversation.messages.find(message => message.id === 'queued-steering');
    execute('steering-ack', 'supervisor_ack', { through: message.sequence }, authority);
    execute('steering-reply', 'supervisor_reply', { message: 'The exported name will be preserved.', replyTo: message.sequence }, authority);
    await scheduler.tick();
  }
  process.stdout.write(JSON.stringify({ journalId: store.journalId, before, goal: store.get('g'), operations: store.operations(), capacity: store.ownedCapacity('g', 'interactive') }));
  await scheduler.stop(); store.close();
}
