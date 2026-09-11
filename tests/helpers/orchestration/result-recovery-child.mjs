import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { ArtifactStore } from '../../../server/orchestration/storage/artifacts.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { AgentResults } from '../../../server/orchestration/agent-results.mjs';
import { FakeAgents } from './fake-agents.mjs';
import { contract, BASE } from './domain-fixture.mjs';

const [directory, role, crashAt] = process.argv.slice(2);
const store = new OrchestrationStore({ path: join(directory, 'state.sqlite') });
const service = new OrchestrationService({ store, agents: new FakeAgents(), repositoryIds: new Set(['repo']) });
let next = 0;
const command = (type, payload, kind = 'system') => service.execute({ id: `seed${++next}`, goalId: 'g', expectedVersion: store.get('g')?.version ?? 0, type, payload }, { kind });
if (!store.get('g')) {
  command('create_goal', { repositoryId: 'repo', title: 'Recover result', baseSha: BASE }, 'user');
  if (role === 'reviewer') command('publish_contract', { contract: contract() }, 'user');
  command('request_attempt', { role, attemptId: 'a', operationId: 'op', conversationId: 'conversation' });
  command('record_dispatch', { attemptId: 'a', identity: 'fixture_worker', worktree: join(directory, 'checkout'), branch: 'fixture' });
}
store.failpoint = (point) => {
  const status = store.get('g').results?.[0]?.status;
  const boundary = point === 'after_commit' && status === 'pending' ? 'received'
    : point === 'before_commit' && status === 'accepted' ? 'before_accept_commit'
      : point === 'after_commit' && status === 'accepted' ? 'accepted' : null;
  if (boundary !== crashAt) return;
  writeFileSync(join(directory, 'checkpoint'), boundary);
  process.kill(process.pid, 'SIGKILL');
};
const results = new AgentResults({ service, artifacts: new ArtifactStore({ directory: join(directory, 'artifacts') }) });
const attempt = store.get('g').attempts[0];
const output = role === 'planner' ? { contract: contract() } : { schemaVersion: 1, target: attempt.target, disposition: 'accept', findings: [] };
const raw = JSON.stringify({ schemaVersion: 1, goalId: 'g', attemptId: attempt.id, operationId: attempt.operationId, generation: attempt.generation, revision: attempt.revision, role, target: attempt.target, output });
results.receive({ kind: 'agent', goalId: 'g', attemptId: attempt.id, role, generation: attempt.generation, revision: attempt.revision }, 'result', raw);
results.drain();
const goal = store.get('g');
process.stdout.write(JSON.stringify({ disposition: goal.results[0].status, reviews: goal.reviews.length, contracts: goal.contracts.length, received: store.events().filter((event) => event.kind === 'agent_result_received').length, accepted: store.events().filter((event) => event.kind === 'agent_result_accepted').length }));
store.close();
