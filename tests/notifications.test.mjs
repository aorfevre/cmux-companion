import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { NotificationStore, defaults, deviceId, preferences } from '../server/notifications/store.mjs';
import { Notifications, attention } from '../server/notifications/service.mjs';
import { registerNotificationRoutes } from '../server/notifications/routes.mjs';
import { createPushTransport, endpoint, subscription, publicAddress, restrictedLookup, generateIdentity } from '../server/notifications/transport.mjs';
const token = 'a'.repeat(40), proof = 'b'.repeat(43), proof2 = 'c'.repeat(43);
function target(suffix='test') { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); return { endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } }; }
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-push-')); let now = 100000; const store = new NotificationStore({ directory, token, now: () => now });
  t.after(() => { try { store.close(); } catch { /* Reopen/rotation cases may have already closed this handle. */ } rmSync(directory, { recursive: true, force: true }); });
  const goal = { id: 'goal-one', title: 'Private project', status: 'discovering', generation: 1, revision: 0 }, goals = { journalId: 'journal-one', cursor: () => 3, get: id => id === goal.id ? goal : null };
  const sent = []; let update = { available: true, candidate: null, request: null };
  const service = new Notifications({ store, goals, now: () => now, updateStatus: () => update, send: async (...args) => { sent.push(args); return { status: 201 }; } });
  return { directory, store, service, goal, goals, sent, advance: ms => { now += ms; }, update: value => { update = value; }, enroll: (key=proof, destination=target(), prefs=defaults) => store.enroll(key, destination, prefs, { cursor: 3, journal: goals.journalId }) };
}
test('push transport validates vendor URLs, curve keys and public DNS at connection time', async () => {
  for (const url of ['http://fcm.googleapis.com/fcm/send/x','https://fcm.googleapis.com.evil.test/fcm/send/x','https://127.0.0.1/x','https://fcm.googleapis.com:8443/fcm/send/x','https://u:p@fcm.googleapis.com/fcm/send/x','https://fcm.googleapis.com/fcm/send/x?q=1','https://fcm.googleapis.com/fcm/send/x#x','bad', null]) assert.throws(() => endpoint(url));
  for (const url of ['https://fcm.googleapis.com/fcm/send/a','https://updates.push.services.mozilla.com/wpush/v2/b','https://web.push.apple.com/c']) assert.ok(endpoint(url));
  for (const address of ['127.0.0.1','10.1.2.3','100.64.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fc00::1','fe80::1','::','bad','fe80::1%en0','192.168.1.1']) assert.equal(publicAddress(address), false, address);
  assert.ok(publicAddress('8.8.8.8')); assert.ok(publicAddress('2606:4700:4700::1111'));
  assert.throws(() => subscription({ endpoint: target().endpoint, keys: {} }));
  assert.throws(() => subscription({ ...target(), keys: { auth: Buffer.alloc(16).toString('base64url'), p256dh: Buffer.from([4,...Buffer.alloc(64)]).toString('base64url') } }));
  const lookup = (records, options={}) => new Promise((resolve,reject) => restrictedLookup(async () => records)('fcm.googleapis.com', options, (error, ...result) => error ? reject(error) : resolve(result)));
  await assert.rejects(lookup([{ address: '127.0.0.1', family: 4 }])); await assert.rejects(lookup([])); await assert.rejects(lookup([{ address: '8.8.8.8', family: 4 }], { family: 6 }));
  assert.deepEqual(await lookup([{ address: '8.8.8.8', family: 4 }]), ['8.8.8.8',4]);
  assert.deepEqual(await lookup([{ address: '8.8.8.8', family: 4 }], { all: true }), [[{ address:'8.8.8.8',family:4 }]]);
  await assert.rejects(new Promise((resolve,reject) => restrictedLookup()('evil.test', {}, e => e ? reject(e) : resolve())));
  assert.throws(() => createPushTransport({ contact:'not-an-email' }));
});
test('encrypted push requests use pinned lookup, no pooling/redirects, bounded timeout and sanitized network errors', async () => {
  let captured;
  const send = createPushTransport({ request: (url, options, callback) => {
    const req = new EventEmitter(); req.end = body => { captured = { url, options, body }; callback({ statusCode: 302, headers: { 'retry-after': '999999' }, destroy() {} }); }; return req;
  } });
  const result = await send(target(), { title: 'Secret title' }, generateIdentity(), 90);
  assert.equal(result.status, 302); assert.equal(result.retryAfter,3600); assert.equal(captured.options.agent,false); assert.ok(captured.options.lookup); assert.ok(captured.options.signal); assert.equal(captured.options.headers.TTL,90); assert.equal(captured.body.includes(Buffer.from('Secret title')),false);
  const failing = createPushTransport({ request: () => { const req = new EventEmitter(); req.end = () => req.emit('error', new Error('PRIVATE ENDPOINT')); return req; } });
  await assert.rejects(failing(target(), {}, generateIdentity(), 2), { message: 'Push provider unavailable' });
});
test('private identity survives reopen and pairing rotation revokes subscriptions without rotating VAPID', t => {
  const f=fixture(t); f.enroll(); const identity=f.store.meta('identity'); assert.equal(statSync(join(f.directory,'notifications.sqlite')).mode & 0o777,0o600);
  const second=new NotificationStore({directory:f.directory,token}); assert.deepEqual(second.meta('identity'),identity); assert.equal(second.all().length,1); second.close();
  const rotated=new NotificationStore({directory:f.directory,token:'z'.repeat(40)}); assert.equal(rotated.all().length,0); assert.deepEqual(rotated.meta('identity'),identity); rotated.close();
  assert.throws(()=>deviceId('short')); assert.throws(()=>preferences({...defaults,evil:true}));
  const bad=join(f.directory,'bad'); writeFileSync(bad,'x'); const linked=join(f.directory,'linked'); symlinkSync(bad,linked); assert.throws(()=>new NotificationStore({directory:linked,token}));
});
test('device capabilities cannot take over endpoints and revocation cancels durable pending sends', async t => {
  const f=fixture(t), destination=target(); f.enroll(proof,destination); assert.throws(()=>f.enroll(proof2,destination),/another management key/);
  f.enroll(proof2,target('second')); assert.equal(f.store.status(deviceId(proof)).subscribed,true); assert.equal(JSON.stringify(f.store.status(deviceId(proof))).includes('endpoint'),false);
  f.store.configure(deviceId(proof),{...defaults,attention:false}); assert.throws(()=>f.store.configure(deviceId('d'.repeat(43)),defaults),/not found/);
  f.store.enqueue({key:'event',kind:'attention'}); assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
  f.store.revoke(deviceId(proof2)); assert.equal(f.store.claim(),null); f.store.revokeAll(); assert.equal(f.store.all().length,0);
});
test('journal enrollment, deduplication, discreet payloads and resolved attention avoid old/private notifications', async t => {
  const f=fixture(t);f.enroll();f.goal.clarification={question:'SECRET QUESTION'};
  f.service.event({id:3,goalId:f.goal.id,kind:'clarification_requested'});assert.equal(f.store.claim(),null);
  const event={id:4,goalId:f.goal.id,kind:'clarification_requested'};f.service.event(event);f.service.event(event);await f.service.tick();assert.equal(f.sent.length,1);
  assert.equal(JSON.stringify(f.sent[0][1]).includes('Private'),false);assert.equal(JSON.stringify(f.sent[0][1]).includes('SECRET'),false);assert.match(f.sent[0][1].url,/goal=goal-one/);
  f.goal.generation++;f.service.event({...event,id:5});f.goal.clarification.answer='resolved';await f.service.tick();assert.equal(f.sent.length,1);
  f.goal.status='merged';f.service.event({...event,id:6,kind:'pr_merged'});f.store.configure(deviceId(proof),{...defaults,discreet:false});await f.service.tick();assert.equal(f.sent[1][1].body,'Private project');
  f.service.event({...event,id:7,kind:'goal_renamed'});await f.service.tick();assert.equal(f.sent.length,2);
});
test('updater observation has a baseline, dedupes eligible candidates and rechecks current state', async t => {
  const f=fixture(t);f.enroll();await f.service.tick();f.update({available:true,candidate:{sha:'a'.repeat(40)},request:null});await f.service.tick();await f.service.tick();assert.equal(f.sent.length,1);
  f.update({available:true,candidate:{sha:'b'.repeat(40)},request:null});f.service.observeUpdates();f.update({available:true,candidate:null,request:{id:'r',status:'succeeded'}});await f.service.tick();assert.equal(f.sent.length,2);assert.equal(f.sent[1][1].title,'Companion updated');
  f.update({available:true,candidate:null,request:{id:'r2',status:'failed'}});await f.service.tick();assert.equal(f.sent[2][1].title,'Companion update needs attention');
});
test('leases, retries, expiry, preference cancellation and permanent rejection are bounded', async t => {
  const f=fixture(t);f.enroll();const id=deviceId(proof);f.store.test(id);assert.throws(()=>f.store.test(id),/one minute/);
  const row=f.store.claim();assert.equal(f.store.claim(),null);f.advance(31000);const reclaimed=f.store.claim();assert.notEqual(reclaimed.lease,row.lease);f.store.finish(row,{status:201});assert.ok(f.store.active(reclaimed));f.store.finish(reclaimed,{status:503});assert.equal(f.store.claim(),null);
  f.advance(61000);const retry=f.store.claim();f.store.finish(retry,{status:400});assert.equal(f.store.status(id).result,'Push was not accepted; check notification setup');
  f.store.enqueue({key:'expire',kind:'test',device:id,lifetime:1});f.advance(2);assert.equal(f.store.claim(),null);
  f.store.enqueue({key:'cancel',kind:'attention'});const cancelled=f.store.claim();f.store.configure(id,{...defaults,attention:false});assert.equal(f.store.active(cancelled),false);
  f.store.test(id);const removed=f.store.claim();f.store.finish(removed,{status:410});assert.equal(f.store.status(id).subscribed,false);
  f.enroll();f.store.test(id);f.service.send=async()=>{throw new Error('private transport error');};await f.service.tick();assert.match(f.store.status(id).result,/retry scheduled/);f.advance(8*86400000);f.store.prune();assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
});
test('attention categories and shutdown are independent from scheduler commands', async t => {
  assert.equal(attention(null),null);assert.equal(attention({status:'aborted'}),null);assert.equal(attention({hold:{id:'h'}}),'hold:h');assert.equal(attention({startup:{status:'failed'},generation:2}),'startup:2');assert.equal(attention({status:'awaiting_approval',revision:2}),'plan:2');assert.equal(attention({status:'ready_to_publish',integrationHead:'sha'}),'publish:sha');
  const f=fixture(t);f.enroll();f.service.start();await f.service.stop();await f.service.tick();assert.equal(f.sent.length,0);
});
test('notification routes require pairing, origin and per-device proof, with bounded subscription/test controls', async t => {
  const f=fixture(t), app=Fastify();t.after(()=>app.close());await app.register(app=>registerNotificationRoutes(app,{service:f.service,token}));
  const headers={authorization:`Bearer ${token}`,host:'mac.example.test',origin:'https://mac.example.test','x-forwarded-proto':'https','x-companion-push-device':proof};
  // Direct requests use HTTP in fixtures; avoid trusting absent proxy identity.
  headers.origin='http://mac.example.test';delete headers['x-forwarded-proto'];
  assert.equal((await app.inject({url:'/api/notifications'})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/api/notifications/test',headers:{...headers,origin:'https://evil.test'},payload:{}})).statusCode,403);
  const enrolled=await app.inject({method:'POST',url:'/api/notifications/subscription',headers,payload:{subscription:target(),preferences:defaults}});assert.equal(enrolled.statusCode,200,enrolled.body);
  assert.equal((await app.inject({url:'/api/notifications',headers})).json().subscribed,true);
  assert.equal((await app.inject({method:'PATCH',url:'/api/notifications/preferences',headers,payload:{...defaults,updates:false}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/notifications/test',headers,payload:{}})).statusCode,200);await f.service.tick();
  assert.equal((await app.inject({method:'POST',url:'/api/notifications/revoke-all',headers,payload:{}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/api/notifications/revoke-all',headers,payload:{confirm:'revoke-all'}})).statusCode,200);
  assert.equal((await app.inject({method:'DELETE',url:'/api/notifications/subscription',headers})).statusCode,200);
});

test('subscription and pending queue limits, exhausted claims and schema guards fail safely', t => {
  const f=fixture(t);f.enroll();const id=deviceId(proof);
  for(let i=0;i<110;i++)f.store.enqueue({key:`bounded-${i}`,kind:'test',device:id});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE status='queued'").get().n,100);assert.match(f.store.status(id).result,/queue full/);
  f.store.db.prepare('UPDATE outbox SET attempts=5').run();assert.equal(f.store.claim(),null);
  for(let i=0;i<31;i++)f.enroll(Buffer.alloc(32,i+1).toString('base64url'),target(`device${i}`));
  assert.throws(()=>f.enroll('x'.repeat(43),target('overflow')),/limit reached/);
  f.store.db.exec('PRAGMA user_version=2');assert.throws(()=>new NotificationStore({directory:f.directory,token}),/newer Companion/);f.store.db.exec('PRAGMA user_version=1');
});

test('a retried startup failure notifies again and replaces older unsent attention',async t=>{
  const f=fixture(t);f.enroll();f.goal.startup={status:'failed'};
  f.service.event({id:4,kind:'goal_startup_failed',goalId:f.goal.id});await f.service.tick();assert.equal(f.sent.length,1);
  f.goal.startup={status:'pending'};await f.service.tick();f.goal.startup={status:'failed'};
  f.service.event({id:6,kind:'goal_startup_failed',goalId:f.goal.id});f.service.event({id:8,kind:'goal_startup_failed',goalId:f.goal.id});await f.service.tick();assert.equal(f.sent.length,2);
  f.service.event({id:8,kind:'goal_startup_failed',goalId:f.goal.id});await f.service.tick();assert.equal(f.sent.length,2);
  f.advance(7200000);f.service.event({id:9,kind:'goal_startup_failed',goalId:f.goal.id,createdAt:new Date(0).toISOString()});assert.equal(f.store.claim(),null);
});
