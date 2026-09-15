import { isAuthorized, isSafeOrigin, safeEqual, sessionCookie } from '../security.mjs';
import { DomainError, identifier, integer, object, requireValue } from './domain/contracts.mjs';
import { parseCommand, USER_COMMANDS, AGENT_COMMANDS } from './domain/commands.mjs';
import { eventView } from './domain/event-view.mjs';
import { goalView } from './domain/state-view.mjs';

import { REFERENCE_BODY_BYTES } from './domain/goal-references.mjs';

const PREFIX = '/api/orchestration';
/** @param {import('fastify').FastifyInstance} app
 * @param {{ service: import('./service.mjs').OrchestrationService; token: string; bridgeAuth: import('./bridge-auth.mjs').BridgeAuthority; references?: import('./goal-references.mjs').GoalReferences; results?: import('./agent-results.mjs').AgentResults; agentTools?: import('./agent-tools.mjs').AgentTools; stream?: import('./event-stream.mjs').EventStream; readOnly?: boolean; suspension?: () => string | null; configuration?: () => Promise<unknown>; reconcile?: () => Promise<void>; cleanup?: import('./cleanup.mjs').ResourceCleanup; beforeCommand?: (command: import('./types.d.ts').Command) => Promise<void> }} options
 */
export function registerOrchestrationRoutes(app, { service, token, bridgeAuth, references, results, agentTools, stream, readOnly = false, suspension = () => null, configuration, reconcile, cleanup, beforeCommand }) {
  requireValue(token.length >= 32, 'Pairing token must contain at least 32 characters');
  /** @type {Map<string, { count: number; until: number }>} */
  const pairingAttempts = new Map();
  app.addHook('onRequest', async (request, reply) => {
    // Fastify matches decoded paths. Security follows the registered route,
    // never the caller's raw spelling (for example /api/%6frchestration/...).
    const routePath = request.routeOptions.url;
    if (!routePath?.startsWith(PREFIX)) return;
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && !isSafeOrigin(request)) return reply.code(403).send({ code: 'BAD_ORIGIN', error: 'Origin rejected' });
    if ([`${PREFIX}/pair`, `${PREFIX}/agent/commands`, `${PREFIX}/agent/status`, `${PREFIX}/agent/ready`, `${PREFIX}/agent/results`, `${PREFIX}/agent/commit`, `${PREFIX}/agent/references/:referenceId`].includes(routePath)) return;
    if (!isAuthorized(request, token)) return reply.code(401).send({ code: 'UNAUTHORIZED', error: 'Pair this device to continue' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      const code = error.code;
      const status = code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404
        : /CONFLICT|STALE|UNCERTAIN|TERMINAL|NOT_READY|ALREADY_RUNNING|REVIEW_REQUIRED|RETRY_REQUIRED|CAPACITY_FULL|CURSOR_EXPIRED/.test(code) ? 409 : 400;
      return reply.code(status).send({ code, error: error.message });
    }
    // Provider errors and raw request bodies may contain private input; never echo them.
    return reply.code((/** @type {{statusCode?: number}} */ (error)).statusCode === 413 ? 413 : 500).send({ code: 'REQUEST_FAILED', error: 'The request could not be completed' });
  });
  app.post(`${PREFIX}/pair`, { bodyLimit: 1024 }, async (request, reply) => {
    const now = Date.now();
    for (const [key, entry] of pairingAttempts) if (entry.until < now) pairingAttempts.delete(key);
    const entry = pairingAttempts.get(request.ip) ?? { count: 0, until: now + 15 * 60_000 };
    entry.count++; pairingAttempts.set(request.ip, entry);
    if (entry.count > 10) return reply.code(429).send({ code: 'RATE_LIMITED', error: 'Too many pairing attempts' });
    const supplied = /** @type {{token?: unknown}} */ (request.body)?.token;
    if (typeof supplied !== 'string' || !safeEqual(supplied, token)) return reply.code(401).send({ code: 'UNAUTHORIZED', error: 'Invalid pairing token' });
    pairingAttempts.delete(request.ip);
    return reply.header('Set-Cookie', sessionCookie(request, token)).send({ paired: true });
  });
  app.get(`${PREFIX}/configuration`, async () => ({ limits: service.limits, capabilities: service.agents.capabilities, terminal: Boolean(service.agents.open), readOnly: Boolean(readOnly || suspension()), suspensionReason: suspension(), repositories: configuration ? await configuration() : [] }));
  app.post(`${PREFIX}/goals/:id/reconcile`, async (request) => {
    requireValue(!(readOnly || suspension()) && reconcile, 'Reconciliation is unavailable', 'FORBIDDEN');
    const goal = service.store.get(/** @type {{id:string}} */ (request.params).id), input = object(request.body);
    requireValue(goal && input.expectedVersion === goal.version, 'Goal version changed', 'VERSION_CONFLICT');
    await reconcile(); return { reconciled: true };
  });
  app.get(`${PREFIX}/goals/:id/cleanup`, async request => {
    requireValue(cleanup, 'Cleanup is unavailable', 'NOT_READY');
    return cleanup.preview(/** @type {{id:string}} */ (request.params).id);
  });
  app.post(`${PREFIX}/goals/:id/cleanup`, async request => {
    requireValue(!(readOnly || suspension()) && cleanup, 'Cleanup is unavailable', 'FORBIDDEN');
    const input = object(request.body);
    return cleanup.execute({ goalId: /** @type {{id:string}} */ (request.params).id, expectedVersion: integer(input.expectedVersion), attemptId: identifier(input.attemptId) });
  });
  app.get(`${PREFIX}/snapshot`, async () => {
    const snapshot = service.store.snapshot(); return { goals: snapshot.goals.map(goal => ({ ...goalView(goal), lastActivity: service.store.activity(goal.id, { limit: 1, meaningful: true }).events[0] ?? null })), cursor: snapshot.cursor, journalId: service.store.journalId, readOnly: Boolean(readOnly || suspension()) };
  });
  app.get(`${PREFIX}/goals/:id`, async (request) => {
    const id = /** @type {{id: string}} */ (request.params).id;
    const goal = service.store.get(id); requireValue(goal, 'Goal not found', 'NOT_FOUND');
    return { ...goalView(goal), contracts: goal.contracts };
  });
  app.get(`${PREFIX}/goals/:id/activity`, async request => {
    const id = /** @type {{id:string}} */ (request.params).id;
    const goal = service.store.get(id);
    requireValue(goal && service.repositoryIds.has(goal.repositoryId), 'Goal is unavailable', 'NOT_FOUND');
    const query = /** @type {{before?:string}} */ (request.query);
    return service.store.activity(id, { ...(query.before === undefined ? {} : { before: Number(query.before) }) });
  });
  app.get(`${PREFIX}/goals/:id/checks/:artifactId`, async request => {
    const { id, artifactId } = /** @type {{id:string;artifactId:string}} */ (request.params);
    const goal = service.store.get(id);
    requireValue(goal && service.repositoryIds.has(goal.repositoryId), 'Goal is unavailable', 'NOT_FOUND');
    const verifications = [goal.verification, ...(goal.verificationRuns ?? []).map(run => run.result?.verification)].filter(Boolean);
    const verification = verifications.find(entry => entry?.checks.some(check => check.artifactId === artifactId));
    requireValue(verification, 'Check evidence is unavailable', 'NOT_FOUND');
    requireValue(results, 'Check evidence is unavailable', 'NOT_READY');
    const evidence = JSON.parse(results.artifacts.get(artifactId).toString('utf8'));
    requireValue(evidence.headSha === verification.headSha && verification.checks.some(check => check.id === evidence.checkId && check.artifactId === artifactId), 'Check evidence target changed', 'STALE_TARGET');
    // Explicit projection: never return the execution environment or agent result
    // envelopes. Check output is displayed only on deliberate user inspection.
    return { checkId: String(evidence.checkId), headSha: verification.headSha, code: typeof evidence.code === 'string' ? evidence.code : '',
      stdout: typeof evidence.outcome?.stdout === 'string' ? evidence.outcome.stdout.slice(0, 262144) : '',
      stderr: typeof evidence.outcome?.stderr === 'string' ? evidence.outcome.stderr.slice(0, 262144) : '',
      truncated: [evidence.outcome?.stdout, evidence.outcome?.stderr].some(value => typeof value === 'string' && value.length > 262144) };
  });
  app.get(`${PREFIX}/goals/:id/references/:referenceId`, async (request, reply) => {
    const { id, referenceId } = /** @type {{id:string; referenceId:string}} */ (request.params);
    const goal = service.store.get(id);
    requireValue(goal && service.repositoryIds.has(goal.repositoryId), 'Goal is unavailable', 'NOT_FOUND');
    requireValue(references, 'References are unavailable', 'NOT_READY');
    const { reference, bytes } = references.read(goal, referenceId);
    return reply.type(reference.mimeType).header('Content-Disposition', `${reference.mimeType === 'text/plain' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(reference.name)}`).send(bytes);
  });
  app.post(`${PREFIX}/goals/:id/terminal`, async (request) => {
    requireValue(!(readOnly || suspension()), 'This client interface is read-only', 'FORBIDDEN');
    const goal = service.store.get(/** @type {{id:string}} */ (request.params).id);
    requireValue(goal && service.repositoryIds.has(goal.repositoryId), 'Goal is unavailable', 'NOT_FOUND');
    const input = object(request.body);
    requireValue(Object.keys(input).length === 2 && Number.isSafeInteger(input.expectedVersion) && input.expectedVersion === goal.version, 'Goal version changed', 'VERSION_CONFLICT');
    const attempt = goal.attempts.find((entry) => entry.id === input.attemptId);
    requireValue(!['aborted', 'merged', 'delivered'].includes(goal.status) && attempt && ['running', 'succeeded'].includes(attempt.status) && attempt.generation === goal.generation && attempt.revision === goal.revision && attempt.workerState === 'running', 'Owned agent terminal is unavailable', 'NOT_READY');
    requireValue(service.ownership && service.agents.open, 'Native terminal is unavailable', 'UNSUPPORTED_CAPABILITY');
    service.ownership.assertOwned(); await service.agents.open(attempt.operationId);
    return { opened: true };
  });
  app.get(`${PREFIX}/events`, async (request) => {
    const query = /** @type {{ since?: string; limit?: string }} */ (request.query);
    return { events: service.store.events({ since: Number(query.since ?? 0), limit: Number(query.limit ?? 100) }).map(eventView), journalId: service.store.journalId };
  });
  if (stream) app.get(`${PREFIX}/stream`, async (request, reply) => {
    const token = request.headers['last-event-id'];
    requireValue(token === undefined || typeof token === 'string', 'Invalid event cursor');
    const initial = stream.prepare(token);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    stream.attach(reply.raw, initial);
  });
  app.post(`${PREFIX}/commands`, { bodyLimit: REFERENCE_BODY_BYTES }, async (request) => {
    requireValue(!(readOnly || suspension()), 'This client interface is read-only', 'FORBIDDEN');
    let command = parseCommand(request.body);
    requireValue(USER_COMMANDS.has(command.type), 'Command is not available to this client', 'FORBIDDEN');
    if (command.type === 'create_goal') {
      const payload = object(command.payload);
      requireValue(payload.teamConfiguration === undefined, 'Team configuration is supplied by the service', 'FORBIDDEN');
      command = { ...command, payload: { ...payload, contractSchema: 2 } };
      requireValue(service.repositoryIds.has(String(payload.repositoryId)), 'Repository is not allowed', 'FORBIDDEN');
      requireValue(references || (payload.attachments === undefined && payload.references === undefined), 'Reference uploads are unavailable', 'UNSUPPORTED_CAPABILITY');
      if (references) { service.ownership?.assertOwned(); command = references.prepare(command); }
    }
    await beforeCommand?.(command);
    const result = service.execute(command, { kind: 'user' });
    return { goal: goalView(result.goal), cursor: result.cursor };
  });
  /** @param {import('fastify').FastifyRequest} request */
  function agentAuthority(request) {
    requireValue(!suspension(), 'Restore the saved project directory and restart Companion', 'NOT_READY');
    const header = request.headers.authorization ?? '';
    requireValue(header.startsWith('Bearer '), 'Agent credential required', 'UNAUTHORIZED');
    return bridgeAuth.authenticate(header.slice(7));
  }
  app.get(`${PREFIX}/agent/ready`, async (request, reply) => {
    const header = request.headers.authorization ?? '';
    requireValue(header.startsWith('Bearer '), 'Agent credential required', 'UNAUTHORIZED');
    const authority = bridgeAuth.ready(header.slice(7)), goal = service.store.get(authority.goalId);
    requireValue(goal && service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
    requireValue(service.ownership, 'Scheduler ownership is unavailable', 'OWNERSHIP_UNCERTAIN');
    service.ownership.assertOwned();
    return reply.code(204).send();
  });
  app.get(`${PREFIX}/agent/status`, async (request) => {
    const authority = agentAuthority(request), goal = service.store.get(authority.goalId);
    requireValue(goal, 'Goal not found', 'NOT_FOUND');
    return { ...goalView(goal), contracts: goal.contracts };
  });
  app.get(`${PREFIX}/agent/references/:referenceId`, async request => {
    const authority = agentAuthority(request), goal = service.store.get(authority.goalId);
    requireValue(goal && service.repositoryIds.has(goal.repositoryId), 'Repository is no longer allowed', 'FORBIDDEN');
    requireValue(references, 'References are unavailable', 'NOT_READY');
    const { reference, bytes } = references.read(goal, /** @type {{referenceId:string}} */ (request.params).referenceId);
    const offset = integer(Number(/** @type {{offset?:string}} */ (request.query).offset ?? 0));
    if (reference.mimeType !== 'text/plain') {
      requireValue(offset === 0, 'Images do not support an offset');
      return { ...reference, data: bytes.toString('base64') };
    }
    const content = bytes.toString('utf8');
    requireValue(offset <= content.length, 'Reference offset is outside the text');
    const end = Math.min(offset + 16000, content.length);
    return { ...reference, text: content.slice(offset, end), offset, nextOffset: end < content.length ? end : null };
  });
  app.post(`${PREFIX}/agent/commit`, async (request) => {
    const authority = agentAuthority(request);
    requireValue(agentTools, 'Scoped commit tools are unavailable', 'UNSUPPORTED_CAPABILITY');
    return agentTools.commit(authority, request.body);
  });
  app.post(`${PREFIX}/agent/results`, { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const header = request.headers.authorization ?? '';
    requireValue(header.startsWith('Bearer '), 'Agent credential required', 'UNAUTHORIZED');
    const credential = header.slice(7), binding = bridgeAuth.receiptAuthority(credential);
    requireValue(results, 'Structured result intake is unavailable', 'UNSUPPORTED_CAPABILITY');
    const input = object(request.body);
    requireValue(Object.keys(input).length === 2 && Object.hasOwn(input, 'id') && Object.hasOwn(input, 'raw') && typeof input.id === 'string' && typeof input.raw === 'string', 'Expected result id and raw output');
    const received = results.receipt(binding, input.id, input.raw)
      ?? results.receive(bridgeAuth.authenticate(credential), input.id, input.raw);
    requireValue(received, 'Result receipt unavailable');
    // A durable receipt is not workflow acceptance. Raw output, artifact paths and
    // provider credentials never appear in this response.
    return reply.code(202).send({ id: received.id, status: received.status, code: received.code });
  });
  app.post(`${PREFIX}/agent/commands`, async (request) => {
    const authority = agentAuthority(request), command = parseCommand(request.body);
    requireValue(command.goalId === authority.goalId && AGENT_COMMANDS[authority.role].has(command.type), 'Agent command is outside its authority', 'FORBIDDEN');
    if (command.type === 'submit_candidate' || command.type === 'submit_integration_repair') {
      // Candidate mutations use the durable structured-result endpoint, where
      // trusted Git proof precedes acceptance. Direct commands cannot bypass it.
      throw new DomainError('UNSUPPORTED_CAPABILITY', 'Submit candidate evidence through the structured result endpoint');
    }
    const result = service.execute(command, authority);
    return { goal: goalView(result.goal), cursor: result.cursor };
  });
}
