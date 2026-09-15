import https from 'node:https';
import { ECDH } from 'node:crypto';
import { lookup } from 'node:dns';
import { promisify } from 'node:util';
import ipaddr from 'ipaddr.js';
import webPush from 'web-push';

const providers = new Map([
  ['fcm.googleapis.com', ['/fcm/send/', '/wp/']],
  ['updates.push.services.mozilla.com', ['/wpush/v2/']],
  ['web.push.apple.com', ['/']],
]);
export function invalid(message = 'Invalid notification request', statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function endpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) throw invalid('Unsupported push endpoint');
  let url; try { url = new URL(value); } catch { throw invalid('Unsupported push endpoint'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search || !providers.get(url.hostname)?.some(prefix => url.pathname.startsWith(prefix) && url.pathname.length > prefix.length)) throw invalid('Unsupported push endpoint');
  return url;
}
export function subscription(value) {
  endpoint(value?.endpoint);
  const keys = value?.keys;
  for (const [name, size] of [['p256dh', 65], ['auth', 16]]) {
    if (typeof keys?.[name] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(keys[name]) || Buffer.from(keys[name], 'base64url').length !== size) throw invalid('Invalid push subscription keys');
  }
  if (Buffer.from(keys.p256dh, 'base64url')[0] !== 4) throw invalid('Invalid push subscription key');
  try { ECDH.convertKey(Buffer.from(keys.p256dh, 'base64url'), 'prime256v1'); } catch { throw invalid('Invalid push subscription key'); }
  return { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
export function publicAddress(address) {
  try { return !address.includes('%') && ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function restrictedLookup(resolve = promisify(lookup)) {
  return (host, options, callback) => {
    if (!providers.has(host)) return callback(invalid('Unsupported push provider'));
    resolve(host, { all: true, verbatim: true }).then(records => {
      if (!records.length || records.some(record => !publicAddress(record.address))) throw invalid('Push provider address rejected');
      const matching = records.filter(record => !options.family || record.family === options.family);
      if (!matching.length) throw invalid('Push provider address unavailable');
      if (options.all) callback(null, matching); else callback(null, matching[0].address, matching[0].family);
    }).catch(() => callback(invalid('Push provider address unavailable')));
  };
}
export function createPushTransport({ request = https.request, resolve, contact = 'mailto:aorfevre@gmail.com' } = {}) {
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw invalid('Set a valid CMUX_COMPANION_PUSH_CONTACT mailto address');
  return async (target, payload, identity, ttl) => {
    const url = endpoint(target.endpoint);
    const details = webPush.generateRequestDetails(subscription(target), JSON.stringify(payload), {
      TTL: Math.max(0, Math.min(86400, Math.floor(ttl))), contentEncoding: 'aes128gcm',
      vapidDetails: { subject: contact, publicKey: identity.publicKey, privateKey: identity.privateKey },
    });
    return new Promise((resolveResult, reject) => {
      const req = request(url, { method: 'POST', headers: details.headers, agent: false, lookup: restrictedLookup(resolve), signal: AbortSignal.timeout(15000) }, response => {
        const status = response.statusCode || 500;
        const raw = response.headers['retry-after'];
        const seconds = typeof raw === 'string' ? (/^\d+$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000) : 0;
        const retryAfter = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 3600)) : 0;
        response.destroy(); resolveResult({ status, retryAfter });
      });
      req.on('error', () => reject(invalid('Push provider unavailable', 503)));
      req.end(details.body);
    });
  };
}
export const generateIdentity = () => webPush.generateVAPIDKeys();
