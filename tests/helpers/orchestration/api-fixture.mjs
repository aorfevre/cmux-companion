import Fastify from 'fastify';
import { OrchestrationStore } from '../../../server/orchestration/storage/store.mjs';
import { OrchestrationService } from '../../../server/orchestration/service.mjs';
import { BridgeAuthority } from '../../../server/orchestration/bridge-auth.mjs';
import { registerOrchestrationRoutes } from '../../../server/orchestration/routes.mjs';
import { BASE } from './domain-fixture.mjs';
import { AgentResults } from '../../../server/orchestration/agent-results.mjs';
import { ArtifactStore } from '../../../server/orchestration/storage/artifacts.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export const TOKEN = 'disposable-test-pairing-token-at-least-32-characters';
export const HEADERS = { host: 'localhost', origin: 'http://localhost', authorization: `Bearer ${TOKEN}` };
export const create = { id: 'create', goalId: 'goal', expectedVersion: 0, type: 'create_goal', payload: { repositoryId: 'repo', title: 'Goal', baseSha: BASE } };
export async function apiFixture(t, { resultIntake = false, readOnly = false, configuration, reconcile, cleanup } = {}) {
  const store = new OrchestrationStore({ path: ':memory:' });
  const service = new OrchestrationService({ store, repositoryIds: new Set(['repo']), agents: { capabilities: [{ role: 'planner', mode: 'interactive' }, { role: 'reviewer', mode: 'background' }] } });
  const bridgeAuth = new BridgeAuthority(store);
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const directory = resultIntake ? mkdtempSync(join(tmpdir(), 'orchestration-api-results-')) : null;
  const artifacts = directory ? new ArtifactStore({ directory }) : null;
  const results = artifacts ? new AgentResults({ service, artifacts }) : undefined;
  registerOrchestrationRoutes(app, { service, token: TOKEN, bridgeAuth, results, readOnly, configuration, reconcile, cleanup });
  t.after(async () => { await app.close(); store.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  await app.ready();
  const planner = () => {
    service.execute(create, { kind: 'user' });
    service.execute({ id: 'launch', goalId: 'goal', expectedVersion: 1, type: 'request_attempt', payload: { attemptId: 'planner', operationId: 'planner_operation', role: 'planner', conversationId: 'conversation' } }, { kind: 'system' });
    service.execute({ id: 'dispatch', goalId: 'goal', expectedVersion: 2, type: 'record_dispatch', payload: { attemptId: 'planner', identity: 'planner_process', worktree: '/tmp/private-context', branch: 'task' } }, { kind: 'system' });
    return bridgeAuth.issue('goal', 'planner');
  };
  return { app, store, service, bridgeAuth, planner, results, artifacts };
}
