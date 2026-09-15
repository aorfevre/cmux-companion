import { isAuthorized, isSafeOrigin } from '../security.mjs';
import { deviceId, defaults } from './store.mjs';
import { invalid } from './transport.mjs';
export function registerNotificationRoutes(app, { service, token }) {
  const prefix = '/api/notifications', attempts = new Map();
  app.setErrorHandler((error, _request, reply) => reply.code(error.statusCode || 500).send({ error: error.statusCode ? error.message : 'Notification service unavailable' }));
  app.addHook('onRequest', async (req, reply) => {
    if (!req.routeOptions.url?.startsWith(prefix)) return;
    reply.header('Cache-Control', 'no-store');
    if (!isAuthorized(req, token)) return reply.code(401).send({ error: 'Pair this device to continue' });
    if (req.method !== 'GET' && !isSafeOrigin(req)) return reply.code(403).send({ error: 'Origin rejected' });
    if (req.method !== 'GET' && !service) return reply.code(503).send({ error: 'Notification service unavailable; check private storage and sender contact configuration' });
    if (req.method !== 'GET') {
      const now = service.now();
      for (const [key, value] of attempts) if (now - value.start > 60000) attempts.delete(key);
      const key = req.ip; const value = attempts.get(key) ?? { start: now, count: 0 }; value.count++; attempts.set(key, value);
      if (value.count > 60) return reply.code(429).send({ error: 'Too many notification requests; wait one minute' });
    }
  });
  const proof = req => req.headers['x-companion-push-device'];
  app.get(prefix, async req => service ? service.store.status(proof(req) ? deviceId(proof(req)) : null) : { available: false, publicKey: '', subscribed: false, preferences: defaults, lastAttempt: null, result: 'Notification service unavailable; check private storage and sender contact configuration' });
  app.post(`${prefix}/subscription`, { bodyLimit: 4096 }, async req => {
    if (!req.body || Object.keys(req.body).some(key => !['subscription','preferences'].includes(key))) throw invalid();
    return service.store.enroll(proof(req), req.body.subscription, req.body.preferences, { cursor: service.goals.cursor(), journal: service.goals.journalId });
  });
  app.patch(`${prefix}/preferences`, { bodyLimit: 1024 }, async req => service.store.configure(deviceId(proof(req)), req.body));
  app.delete(`${prefix}/subscription`, async req => { service.store.revoke(deviceId(proof(req))); return service.store.status(null); });
  app.post(`${prefix}/revoke-all`, { bodyLimit: 1024 }, async req => {
    if (req.body?.confirm !== 'revoke-all') throw invalid('Confirm revoking all push subscriptions');
    service.store.revokeAll(); return service.store.status(null);
  });
  app.post(`${prefix}/test`, { bodyLimit: 1024 }, async req => {
    service.store.test(deviceId(proof(req))); void service.tick().catch(() => {});
    return { queued: true };
  });
}
