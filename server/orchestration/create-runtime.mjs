import Fastify from 'fastify';
import { OrchestrationStore } from './storage/store.mjs';
import { ArtifactStore } from './storage/artifacts.mjs';
import { BridgeAuthority } from './bridge-auth.mjs';
import { OrchestrationService } from './service.mjs';
import { AgentResults } from './agent-results.mjs';
import { Scheduler } from './scheduler.mjs';
import { GitRepository } from './adapters/git.mjs';
import { GitIntegration } from './adapters/git-integration.mjs';
import { AgentCommits } from './adapters/agent-commits.mjs';
import { AgentTools } from './agent-tools.mjs';
import { VerificationRunner } from './adapters/verification.mjs';
import { JournalConsumer } from './event-consumers.mjs';
import { EventStream } from './event-stream.mjs';
import { registerOrchestrationRoutes } from './routes.mjs';
import { requireValue } from './domain/contracts.mjs';

/** One isolated composition. No legacy services, credential loaders or timers
 * are constructed implicitly; external adapters and storage are explicit inputs.
 * @param {{
 * storage: { database: string; artifacts: string; resources: string };
 * repositories: ReadonlyMap<string,string>; token: string; readOnly?: boolean;
 * createAgents: (context: { onResult: (request: import('./types.d.ts').LaunchRequest, raw: string) => void }) => import('./types.d.ts').AgentPort & { close(): Promise<void> };
 * resolveCheck: ConstructorParameters<typeof VerificationRunner>[0]['resolveCheck'];
 * createPublisher: (context: { repositories: GitRepository }) => import('./types.d.ts').PublicationPort;
 * consumers?: { id: string; from?: number; handle: ConstructorParameters<typeof JournalConsumer>[0]['handle'] }[];
 * limits?: { global?: number; perGoal?: number; planners?: number };
 * onError?: (error: unknown) => void;
 * }} options
 */
export async function createRuntime({ storage, repositories: configured, token, readOnly = false, createAgents, resolveCheck, createPublisher, consumers = [], limits, onError = () => {} }) {
  requireValue(typeof token === 'string' && token.length >= 32, 'Explicit private pairing token required');
  requireValue(typeof readOnly === 'boolean' && new Set(consumers.map((consumer) => consumer.id)).size === consumers.length, 'Invalid runtime configuration');
  for (const path of Object.values(storage)) requireValue(typeof path === 'string' && path.length > 0, 'Explicit storage paths required');
  const store = new OrchestrationStore({ path: storage.database });
  /** @param {unknown} error */ const report = (error) => { try { onError(error); } catch { /* diagnostic errors do not own lifecycle */ } };
  let acceptingResults = true;
  /** @type {AgentResults | undefined} */ let results;
  let agents;
  try {
    const artifacts = new ArtifactStore({ directory: storage.artifacts });
    const repositories = new GitRepository({ repositories: configured, directory: storage.resources, artifacts });
    agents = createAgents({ onResult: (request, raw) => {
      requireValue(acceptingResults && results, 'Runtime result intake is closed', 'NOT_READY');
      const { goalId, attempt } = request;
      results.receive({ kind: 'agent', goalId, attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision }, request.operationId, raw);
    } });
    const service = new OrchestrationService({ store, agents, repositoryIds: new Set(configured.keys()), limits });
    results = new AgentResults({ service, artifacts, repositories });
    const bridgeAuth = new BridgeAuthority(store);
    const stream = new EventStream({ store, onError: report });
    const subscribers = consumers.map((options) => new JournalConsumer({ ...options, store, onError: report }));
    store.onCommit = () => { stream.wake(); for (const subscriber of subscribers) subscriber.wake(); };
    const scheduler = new Scheduler({ service, repositories, integrations: new GitIntegration({ repositories }), verifier: new VerificationRunner({ repositories, resolveCheck }), publisher: createPublisher({ repositories }), results, onError: report });
    const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
    const agentTools = new AgentTools({ service, commits: new AgentCommits({ repositories }) });
    registerOrchestrationRoutes(app, { service, token, bridgeAuth, results, agentTools, stream, readOnly });
    const ownedAgents = agents;
    let started = false, closed = false, shutdownRequested = false;
    /** @type {Promise<string> | null} */ let binding = null;
    /** @type {Promise<void> | null} */ let starting = null;
    /** @type {Promise<void> | null} */ let closing = null;
    const runtime = {
      app, store, service, artifacts, repositories, results, bridgeAuth, scheduler, stream, subscribers,
      start() {
        requireValue(!binding, 'Runtime is binding its listener', 'ALREADY_RUNNING');
        return startWorkers();
      },
      /** Bind before starting background work. An occupied port never launches
       * agents or stops another process. @param {{ port?: number }} [options] */
      async listen({ port = 0 } = {}) {
        requireValue(!started && !starting && !binding && !shutdownRequested, 'Runtime is already started or closed', 'ALREADY_RUNNING');
        binding = app.listen({ host: '127.0.0.1', port });
        try {
          const address = await binding;
          await startWorkers(); return address;
        } catch (error) { await runtime.close(); throw error; } finally { binding = null; }
      },
      close() {
        if (closed) return Promise.resolve();
        if (closing) return closing;
        shutdownRequested = true;
        const startup = starting, listener = binding;
        closing = (async () => {
          await listener?.catch(report);
          await startup?.catch(report);
          stream.close(); await app.close();
          const stopped = await Promise.allSettled([scheduler.stop({ releaseOwnership: false }), ...subscribers.map((subscriber) => subscriber.stop())]);
          await ownedAgents.close();
          const failed = stopped.filter((entry) => entry.status === 'rejected');
          if (failed.length) throw new AggregateError(failed.map((entry) => entry.reason), 'Runtime services failed to stop');
          scheduler.ownership.release();
          acceptingResults = false; store.onCommit = () => {}; store.close(); closed = true; started = false;
        })().finally(() => { closing = null; });
        return closing;
      },
    };
    function startWorkers() {
        requireValue(!shutdownRequested, 'Runtime is closed', 'NOT_READY');
        if (started) return Promise.resolve();
        if (starting) return starting;
        starting = (async () => {
          await app.ready(); requireValue(!closing, 'Runtime is closing', 'NOT_READY');
          await scheduler.start({ releaseOwnershipOnFailure: false }); started = true; stream.start();
          // A notification sink cannot delay service readiness or prevent close
          // from stopping a continuously replenished consumer sweep.
          for (const subscriber of subscribers) void subscriber.start().catch(report);
        })().finally(() => { starting = null; });
        return starting;
    }
    return runtime;
  } catch (error) {
    // Factories must not start workers in constructors. Their close method only
    // detaches construction-time resources here; no scheduler has been started.
    acceptingResults = false;
    try { if (agents) await agents.close(); } finally { store.close(); }
    throw error;
  }
}
