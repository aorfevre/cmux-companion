import { join } from 'node:path';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { GitRepository } from '../../../server/orchestration/adapters/git.mjs';
import { ArtifactStore } from '../../../server/orchestration/storage/artifacts.mjs';
import { ResourceCleanup } from '../../../server/orchestration/cleanup.mjs';
export async function cleanupFixture(repo, failpoint = () => {}) {
  const store = new OrchestrationStore({ path: join(repo.directory, 'cleanup.sqlite') });
  const service = new OrchestrationService({ store, repositoryIds: new Set(['repo']), agents: { capabilities: [{ role: 'planner', mode: 'interactive' }] } });
  const artifacts = new ArtifactStore({ directory: join(repo.directory, 'artifacts') });
  const repositories = new GitRepository({ repositories: new Map([['repo', repo.repository]]), directory: join(repo.directory, 'resources'), artifacts });
  let count = 0;
  const command = (type, payload = {}, kind = 'system') => service.execute({ id: `cmd${++count}`, goalId: 'goal', expectedVersion: store.get('goal')?.version ?? 0, type, payload }, { kind });
  if (!store.get('goal')) {
    command('create_goal', { repositoryId: 'repo', title: 'cleanup', baseSha: repo.baseSha }, 'user');
    command('request_attempt', { attemptId: 'planner', operationId: 'planner_operation', role: 'planner', conversationId: 'conversation' });
    const resource = await repositories.provision({ operationId: 'planner_operation', repositoryId: 'repo', branch: 'companion/goal/planner', baseSha: repo.baseSha });
    command('record_dispatch', { attemptId: 'planner', identity: 'fake_process', ...resource });
    command('abort', {}, 'user'); command('record_stopped', { attemptId: 'planner' });
    for (const operation of store.operations()) store.advanceOperation(operation.id, operation.status, 'completed');
  }
  const cleanup = new ResourceCleanup({ service, repositories, assertOwned() {}, failpoint });
  return { store, service, repositories, artifacts, cleanup, input: { goalId: 'goal', expectedVersion: store.get('goal').version, attemptId: 'planner' } };
}
