import { isAuthorized, isSafeOrigin, safeEqual } from './security.mjs';
import { requestId } from '../updater/src/control.mjs';
const object = (properties, required = Object.keys(properties)) => ({ body: { type: 'object', additionalProperties: false, properties, required } });
const id = { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,100}$' };
const sha = { type: 'string', pattern: '^[a-f0-9]{40}$' };

export function registerUpdateRoutes(app, { control, token, maintenance, requestCheck = () => control.check() }) {
  app.setErrorHandler((error, _request, reply) => {
    const status = error.validation ? 400 : error.statusCode || 500;
    return reply.code(status).send({ error: status < 500 ? error.message : 'Update service unavailable', code: 'UPDATE_REQUEST_FAILED' });
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url || request.url.split('?')[0];
    if (!path.startsWith('/api/updater/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!isAuthorized(request, token)) return reply.code(401).send({ error: 'Pair this device to continue' });
    if (request.method !== 'GET' && !isSafeOrigin(request)) return reply.code(403).send({ error: 'Origin rejected' });
  });
  app.get('/api/updater/updates', async () => ({ ...control.status(), blockers: maintenance?.blockers() ?? ['Companion workflow state is unavailable'] }));
  app.post('/api/updater/check', { schema: object({}) }, async () => { await requestCheck(); return control.status(); });
  app.patch('/api/updater/preferences', { schema: object({ revision: { type: 'integer', minimum: 0 }, automatic: { type: 'boolean' } }) }, async request => {
    control.policy(request.body.revision, request.body.automatic); return control.status();
  });
  app.post('/api/updater/requests', { schema: object({ id, sha, whenIdle: { type: 'boolean' } }) }, async request => {
    control.request(request.body); return control.status();
  });
  app.post('/api/updater/retry', { schema: object({ id, sha, whenIdle: { type: 'boolean' } }) }, async request => { control.retry(request.body); return control.status(); });
  app.post('/api/updater/cancel', { schema: object({ id }) }, async request => { control.cancel(request.body.id); return control.status(); });
  app.post('/api/updater/maintenance', { schema: object({ id, action: { enum: ['acquire', 'verify'] }, serviceId: { type: 'string', maxLength: 100 } }, ['id', 'action']) }, async (request, reply) => {
    // This operator handshake requires the private pairing credential, rather
    // than the browser's derived session cookie. No arbitrary command is accepted.
    if (!maintenance || !safeEqual(request.headers.authorization, `Bearer ${token}`)) return reply.code(403).send({ error: 'Updater credential required' });
    requestId(request.body.id);
    return request.body.action === 'acquire' ? maintenance.acquire(request.body.id) : maintenance.verify(request.body.id, request.body.serviceId);
  });
}
