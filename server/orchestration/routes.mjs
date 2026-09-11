import { isAuthorized, isSafeOrigin, safeEqual, sessionCookie } from '../security.mjs';
import { DomainError, requireValue } from './domain/contracts.mjs';
import { parseCommand, USER_COMMANDS, AGENT_COMMANDS } from './domain/commands.mjs';
import { goalView } from './domain/state-view.mjs';

const PREFIX = '/api/orchestration';
/** @param {import('fastify').FastifyInstance} app
 * @param {{ service: import('./service.mjs').OrchestrationService; token: string; bridgeAuth: import('./bridge-auth.mjs').BridgeAuthority }} options
 */
export function registerOrchestrationRoutes(app, { service, token, bridgeAuth }) {
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
    if ([`${PREFIX}/pair`, `${PREFIX}/agent/commands`, `${PREFIX}/agent/status`].includes(routePath)) return;
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
  app.get(`${PREFIX}/snapshot`, async () => {
    const snapshot = service.store.snapshot(); return { goals: snapshot.goals.map(goalView), cursor: snapshot.cursor };
  });
  app.get(`${PREFIX}/goals/:id`, async (request) => {
    const id = /** @type {{id: string}} */ (request.params).id;
    const goal = service.store.get(id); requireValue(goal, 'Goal not found', 'NOT_FOUND');
    return { ...goalView(goal), contracts: goal.contracts };
  });
  app.get(`${PREFIX}/events`, async (request) => {
    const query = /** @type {{ since?: string; limit?: string }} */ (request.query);
    return { events: service.store.events({ since: Number(query.since ?? 0), limit: Number(query.limit ?? 100) }) };
  });
  app.post(`${PREFIX}/commands`, async (request) => {
    const command = parseCommand(request.body);
    requireValue(USER_COMMANDS.has(command.type), 'Command is not available to this client', 'FORBIDDEN');
    const result = service.execute(command, { kind: 'user' });
    return { goal: goalView(result.goal), cursor: result.cursor };
  });
  /** @param {import('fastify').FastifyRequest} request */
  function agentAuthority(request) {
    const header = request.headers.authorization ?? '';
    requireValue(header.startsWith('Bearer '), 'Agent credential required', 'UNAUTHORIZED');
    return bridgeAuth.authenticate(header.slice(7));
  }
  app.get(`${PREFIX}/agent/status`, async (request) => {
    const authority = agentAuthority(request), goal = service.store.get(authority.goalId);
    requireValue(goal, 'Goal not found', 'NOT_FOUND');
    return { ...goalView(goal), contracts: goal.contracts };
  });
  app.post(`${PREFIX}/agent/commands`, async (request) => {
    const authority = agentAuthority(request), command = parseCommand(request.body);
    requireValue(command.goalId === authority.goalId && AGENT_COMMANDS[authority.role].has(command.type), 'Agent command is outside its authority', 'FORBIDDEN');
    if (command.type === 'submit_candidate' || command.type === 'submit_integration_repair') {
      // Git evidence adapters are connected in T07/T08. Fail closed until then.
      throw new DomainError('UNSUPPORTED_CAPABILITY', 'Repository evidence verification is unavailable');
    }
    const result = service.execute(command, authority);
    return { goal: goalView(result.goal), cursor: result.cursor };
  });
}
