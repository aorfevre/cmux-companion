import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { ArtifactStore } from '../../../server/orchestration/storage/artifacts.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { AgentResults } from '../../../server/orchestration/agent-results.mjs';
import { planTarget } from '../../../server/orchestration/domain/transitions.mjs';
import { FakeAgents } from './fake-agents.mjs';
import { contract, BASE, HEAD_A, HEAD_B } from './domain-fixture.mjs';

const [directory, role, crashAt] = process.argv.slice(2);
const store = new OrchestrationStore({ path: join(directory, 'state.sqlite') });
const service = new OrchestrationService({ store, agents: new FakeAgents(), repositoryIds: new Set(['repo']) });
let next = 0;
const command = (type, payload, kind = 'system') => service.execute({ id: `seed${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, { kind });
if (!store.get('g')) {
  command('create_goal', { repositoryId: 'repo', title: 'Recover result', baseSha: BASE }, 'user');
  if (role !== 'planner') command('publish_contract', { contract: contract() }, 'user');
  if (['implementer', 'integrator'].includes(role)) {
    const request = (id, role, taskId = null) => command('request_attempt', { role, taskId, attemptId: id, operationId: `op_${id}`, conversationId: `conversation_${id}` });
    const dispatch = id => command('record_dispatch', { attemptId: id, identity: `worker_${id}`, worktree: join(directory, id), branch: `companion/g/${id}` });
    const review = (id, target) => { command('record_review', { attemptId: id, reviewId: `review_${id}`, review: { schemaVersion: 1, target, disposition: 'accept', findings: [] } }); command('record_stopped', { attemptId: id }); };
    request('plan_review', 'reviewer'); dispatch('plan_review'); review('plan_review', planTarget(store.get('g'))); command('approve', { revision: 1 }, 'user');
    if (role === 'integrator') {
      request('implementation', 'implementer', 'A'); dispatch('implementation'); command('confirm_candidate', { attemptId: 'implementation', headSha: HEAD_A }); command('record_stopped', { attemptId: 'implementation' });
      request('task_review', 'reviewer', 'A'); dispatch('task_review'); review('task_review', HEAD_A);
      command('request_integration', { taskId: 'A', operationId: 'integration' }); command('record_integration_conflict', { operationId: 'integration' });
      command('recover_goal', { holdId: store.get('g').hold.id }, 'user');
    }
  }
  command('request_attempt', { role, taskId: role === 'implementer' ? 'A' : null, attemptId: 'a', operationId: 'op', conversationId: 'conversation' });
  command('record_dispatch', { attemptId: 'a', identity: 'fixture_worker', worktree: join(directory, 'checkout'), branch: 'fixture' });
}
store.failpoint = (point) => {
  const submission = store.get('g').results?.[0];
  const status = submission?.repair ? 'accepted' : submission?.status;
  const boundary = point === 'after_commit' && status === 'pending' ? 'received'
    : point === 'before_commit' && status === 'accepted' ? 'before_accept_commit'
      : point === 'after_commit' && status === 'accepted' ? 'accepted' : null;
  if (boundary !== crashAt) return;
  writeFileSync(join(directory, 'checkpoint'), boundary);
  process.kill(process.pid, 'SIGKILL');
};
const artifacts = new ArtifactStore({ directory: join(directory, 'artifacts') });
// Isolate durable inbox acceptance; the separate real-Git crash suite validates proof creation.
const results = new AgentResults({ service, artifacts, repositories: { candidate: async ({ headSha }) => ({ headSha, artifactId: artifacts.put(JSON.stringify({ fixture: true, headSha })).id }) } });
const attempt = store.get('g').attempts.find(attempt => attempt.id === 'a');
const output = role === 'planner' ? { contract: contract() } : ['implementer', 'integrator'].includes(role) ? { headSha: HEAD_B, summary: 'Fixture result', evidence: [], ...(role === 'integrator' ? { operationId: 'integration' } : {}) } : { schemaVersion: 1, target: attempt.target, disposition: 'accept', findings: [] };
const raw = JSON.stringify({ schemaVersion: 1, goalId: 'g', attemptId: attempt.id, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role, target: attempt.target, output });
results.receive({ kind: 'agent', goalId: 'g', attemptId: attempt.id, role, generation: attempt.generation, revision: attempt.revision }, 'result', raw);
await results.drain();
const goal = store.get('g');
process.stdout.write(JSON.stringify({ disposition: goal.results[0].status, reviews: goal.reviews.length, contracts: goal.contracts.length, repairPrepared: Boolean(goal.results[0].repair), received: store.events().filter((event) => event.kind === 'agent_result_received').length, accepted: store.events().filter((event) => event.kind === 'agent_result_accepted').length }));
store.close();
