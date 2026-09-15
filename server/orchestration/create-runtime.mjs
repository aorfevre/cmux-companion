import Fastify from 'fastify';
import { join } from 'node:path';
import { GoalReferences } from './goal-references.mjs';
import { ResourceCleanup } from './cleanup.mjs';
import { nativeBinding } from './adapters/native-background.mjs';
import { rolePrompt } from './adapters/role-prompts.mjs';
import { OrchestrationStore } from './storage/store.mjs';
import { ArtifactStore } from './storage/artifacts.mjs';
import { BridgeAuthority } from './bridge-auth.mjs';
import { OrchestrationService } from './service.mjs';
import { AgentResults } from './agent-results.mjs';
import { Scheduler } from './scheduler.mjs';
import { GitRepository, git } from './adapters/git.mjs';
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
 * createAgents: (context: { locate: (key: {operationId?: string; identity?:string}) => import('./types.d.ts').Mode | null; describe: (request: import('./types.d.ts').LaunchRequest) => import('./adapters/native-inputs.mjs').NativeDescription; onResult: (request: import('./types.d.ts').LaunchRequest, raw: string) => void }) => import('./types.d.ts').AgentPort & { close(options?: {preserve?: import('./types.d.ts').LaunchRequest[]}): Promise<void> };
 * resolveCheck: ConstructorParameters<typeof VerificationRunner>[0]['resolveCheck'];
 * createPublisher: (context: { repositories: GitRepository }) => import('./types.d.ts').PublicationPort;
 * consumers?: { id: string; from?: number; handle: ConstructorParameters<typeof JournalConsumer>[0]['handle'] }[];
 * limits?: { global?: number; perGoal?: number; planners?: number };
 * onError?: (error: unknown) => void;
 * logLevel?: string;
 * planReviewEnabled?: () => boolean;
 * suspension?: () => string | null;
 * prepareGoal?: (goal: import('./types.d.ts').Goal) => Promise<string>;
 * beforeCommand?: (command: import('./types.d.ts').Command) => Promise<void>;
 * projectStatus?: (id: string) => { name?: string; error?: string | null; enabled?: boolean };
 * goalLimits?: (goalId: string) => { global: number; perGoal: number; planners: number };
 * }} options
 */
export async function createRuntime({ storage, repositories: configured, token, readOnly = false, createAgents, resolveCheck, createPublisher, consumers = [], limits, logLevel, planReviewEnabled, suspension = () => null, prepareGoal, beforeCommand, projectStatus, goalLimits, onError = () => {} }) {
  requireValue(typeof token === 'string' && token.length >= 32, 'Explicit private pairing token required');
  requireValue(typeof readOnly === 'boolean' && new Set(consumers.map((consumer) => consumer.id)).size === consumers.length, 'Invalid runtime configuration');
  for (const path of Object.values(storage)) requireValue(typeof path === 'string' && path.length > 0, 'Explicit storage paths required');
  const store = new OrchestrationStore({ path: storage.database });
  /** @param {unknown} error */ const report = (error) => { try { onError(error); } catch { /* diagnostic errors do not own lifecycle */ } };
  let acceptingResults = true;
  /** @type {AgentResults | undefined} */ let results;
  let agents;
  /** @type {((request: import('./types.d.ts').LaunchRequest) => import('./adapters/native-inputs.mjs').NativeDescription) | undefined} */ let describe;
  try {
    const references = new GoalReferences({ directory: join(storage.artifacts, 'references') });
    const artifacts = new ArtifactStore({ directory: storage.artifacts });
    const repositories = new GitRepository({ repositories: configured, directory: storage.resources, artifacts });
    agents = createAgents({ locate: ({ operationId, identity }) => store.list().flatMap((goal) => goal.attempts).find((attempt) => operationId ? attempt.operationId === operationId : identity ? attempt.identity === identity : false)?.mode ?? null, describe: (request) => { requireValue(describe, 'Runtime context is not ready', 'NOT_READY'); return describe(request); }, onResult: (request, raw) => {
      requireValue(acceptingResults && results, 'Runtime result intake is closed', 'NOT_READY');
      const { goalId, attempt } = request;
      results.receive({ kind: 'agent', goalId, attemptId: attempt.id, role: attempt.role, generation: attempt.generation, revision: attempt.revision }, request.operationId, raw);
    } });
    const service = new OrchestrationService({ store, agents, repositoryIds: new Set(configured.keys()), limits, goalLimits });
    results = new AgentResults({ service, artifacts, repositories });
    const bridgeAuth = new BridgeAuthority(store);
    const stream = new EventStream({ store, onError: report });
    const subscribers = consumers.map((options) => new JournalConsumer({ ...options, store, onError: report }));
    store.onCommit = () => { stream.wake(); for (const subscriber of subscribers) subscriber.wake(); };
    const scheduler = new Scheduler({ service, repositories, planReviewEnabled, prepareGoal, integrations: new GitIntegration({ repositories }), verifier: new VerificationRunner({ repositories, resolveCheck }), publisher: createPublisher({ repositories }), results, onError: report });
    const app = Fastify({ logger: logLevel ? { level: logLevel, redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-companion-push-device"]', 'res.headers["set-cookie"]'] } : false, bodyLimit: 2 * 1024 * 1024, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
    const cleanup = new ResourceCleanup({ service, repositories, assertOwned: () => scheduler.ownership.assertOwned() });
    const agentTools = new AgentTools({ service, commits: new AgentCommits({ repositories }) });
    registerOrchestrationRoutes(app, { references, service, token, bridgeAuth, results, agentTools, stream, readOnly, suspension, cleanup, beforeCommand, reconcile: async () => { scheduler.ownership.assertOwned(); await scheduler.tick(); }, configuration: async () => Promise.all([...configured.keys()].map(async (id) => {
      try {
        const { repository } = await repositories.repository(id);
        let baseBranch;
        try { baseBranch = (await git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
        catch (error) {
          // Detached HEAD is a valid source checkout: new goals fetch their own
          // base and never depend on moving this checkout onto a local branch.
          if (!prepareGoal || /** @type {{ exitCode?: unknown }} */ (error).exitCode !== 1) throw error;
          baseBranch = 'main';
        }
        const baseSha = await repositories.ref(repository, `refs/heads/${baseBranch}`);
        return { id, baseBranch, baseSha, error: null, ...projectStatus?.(id) };
      } catch { return { id, ...projectStatus?.(id), baseBranch: null, baseSha: null, error: 'Repository branch is unavailable' }; }
    })) });
    describe = (request) => {
      requireValue(!shutdownRequested && service.ownership, 'Runtime launch is unavailable', 'NOT_READY');
      service.ownership.assertOwned();
      const address = app.server.address();
      requireValue(address && typeof address !== 'string' && address.address === '127.0.0.1', 'Native launch requires a bound loopback listener', 'NOT_READY');
      const goal = store.get(request.goalId), attempt = goal?.attempts.find((entry) => entry.id === request.attempt.id);
      requireValue(goal && attempt && configured.has(goal.repositoryId)
        && JSON.stringify(nativeBinding({ goalId: goal.id, operationId: request.operationId, attempt })) === JSON.stringify(nativeBinding(request)),
      'Native launch context changed', 'STALE_ATTEMPT');
      const prompt = rolePrompt(goal, attempt);
      const credential = bridgeAuth.issueForDispatch(goal.id, attempt.id, request.operationId);
      const activation = { endpoint: `http://127.0.0.1:${address.port}`, credential };
      return { prompt, plannerName: goal.plannerName, activation, bridge: activation };
    };
    const ownedAgents = agents;
    let started = false, closed = false, shutdownRequested = false;
    /** @type {Promise<string> | null} */ let binding = null;
    /** @type {Promise<void> | null} */ let starting = null;
    /** @type {Promise<void> | null} */ let closing = null;
    const runtime = {
      app, store, service, artifacts, repositories, results, bridgeAuth, scheduler, stream, subscribers,
      /** The maintenance installer supplies only an authenticated durable fence. */
      handoffEndpoint: '',
      updateHandoff: /** @type {() => import('./types.d.ts').HandoffIdentity[]} */ (() => []),
      /** @param {import('./types.d.ts').HandoffIdentity[] | null} [expected] */
      async prepareHandoff(expected = null) {
        const requests = handoffRequests(expected);
        requireValue(!requests.length || ownedAgents.prepareHandoff, 'Existing planning agent needs update-compatible recovery', 'HANDOFF_UNSUPPORTED');
        const identities = [];
        for (const request of requests) {
          const evidence = await ownedAgents.prepareHandoff?.(request);
          requireValue(evidence && (!runtime.handoffEndpoint || evidence.endpoint === runtime.handoffEndpoint), 'Handoff endpoint changed', 'OWNERSHIP_UNCERTAIN');
          const row = store.db.prepare('SELECT authority FROM agent_credentials WHERE digest=? AND revoked=0').get(evidence.credentialDigest);
          const authority = row ? JSON.parse(String(row.authority)) : null;
          requireValue(authority && authority.goalId === request.goalId && authority.attemptId === request.attempt.id && authority.generation === request.attempt.generation && authority.revision === request.attempt.revision && authority.role === 'planner', 'Handoff credential changed', 'OWNERSHIP_UNCERTAIN');
          identities.push(evidence);
        }
        return /** @type {import('./types.d.ts').HandoffIdentity[]} */ (identities);
      },
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
          await ownedAgents.close({ preserve: handoffRequests(runtime.updateHandoff()) });
          const failed = stopped.filter((entry) => entry.status === 'rejected');
          if (failed.length) throw new AggregateError(failed.map((entry) => entry.reason), 'Runtime services failed to stop');
          scheduler.ownership.release();
          acceptingResults = false; store.onCommit = () => {}; store.close(); closed = true; started = false;
        })().finally(() => { closing = null; });
        return closing;
      },
    };
    /** @param {import('./types.d.ts').HandoffIdentity[] | null} expected */
    function handoffRequests(expected) {
      const requests = store.list().flatMap(goal => goal.attempts.filter(attempt => expected
        ? expected.some(entry => entry.goalId === goal.id && entry.operationId === attempt.operationId && entry.identity === attempt.identity)
        : attempt.workerState !== 'stopped').map(attempt => ({ goalId: goal.id, operationId: attempt.operationId, attempt })));
      if (expected) requireValue(requests.length === expected.length, 'Handoff ledger identity changed', 'OWNERSHIP_UNCERTAIN');
      return requests;
    }
    function startWorkers() {
        requireValue(!shutdownRequested, 'Runtime is closed', 'NOT_READY');
        if (started) return Promise.resolve();
        if (starting) return starting;
        starting = (async () => {
          await app.ready(); requireValue(!closing, 'Runtime is closing', 'NOT_READY');
          if (!suspension()) await scheduler.start({ releaseOwnershipOnFailure: false });
          started = true; stream.start();
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
