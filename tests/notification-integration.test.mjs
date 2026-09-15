import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createECDH } from 'node:crypto';
import { createRuntime } from '../server/orchestration/create-runtime.mjs';
import { attachNotifications } from '../server/notifications/service.mjs';
import { defaults, deviceId } from '../server/notifications/store.mjs';
import { FakeAgents } from './helpers/orchestration/fake-agents.mjs';
import { TOKEN, create } from './helpers/orchestration/api-fixture.mjs';
import { contract } from './helpers/orchestration/domain-fixture.mjs';

test('real journal notifications survive restart and core rollback without rotating keys or replaying accepted work',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'companion-push-integration-'));let runtime;
  t.after(async()=>{await runtime?.close();rmSync(directory,{recursive:true,force:true});});
  const sent=[],proof='p'.repeat(43),database=join(directory,'state.sqlite');
  const open=async(contact)=>{
    const agents=Object.assign(new FakeAgents(),{close:async()=>{}});
    runtime=await createRuntime({storage:{database,artifacts:join(directory,'artifacts'),resources:join(directory,'resources')},repositories:new Map(),token:TOKEN,createAgents:()=>agents,resolveCheck:()=>{throw new Error('unused');},createPublisher:()=>({publish:async()=>{throw new Error('unused');}}),suspension:()=> 'notification fixture'});
    const service=await attachNotifications({runtime,directory,token:TOKEN,contact,send:async(_target,payload)=>{sent.push(payload);return{status:201};}});
    await runtime.listen({port:0});return service;
  };
  let service=await open();const key=createECDH('prime256v1');key.generateKeys();
  service.store.enroll(proof,{endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:key.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,1).toString('base64url')}},defaults,{cursor:runtime.store.cursor(),journal:runtime.store.journalId});
  const identity=service.store.meta('identity');runtime.store.apply(create,{kind:'user'});await runtime.subscribers[0].tick();
  runtime.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');copyFileSync(database,join(directory,'before.sqlite'));
  runtime.store.apply({id:'publish',goalId:'goal',expectedVersion:1,type:'publish_contract',payload:{contract:contract()}},{kind:'user'});
  await runtime.subscribers[0].tick();await service.tick();assert.equal(sent.length,1);assert.match(sent[0].url,/goal=goal/);
  await runtime.close();service=await open();assert.deepEqual(service.store.meta('identity'),identity);assert.ok(service.store.status(deviceId(proof)).subscribed);await runtime.subscribers[0].tick();await service.tick();assert.equal(sent.length,1);
  await runtime.close();copyFileSync(join(directory,'before.sqlite'),database);service=await open();assert.deepEqual(service.store.meta('identity'),identity);await runtime.subscribers[0].tick();await service.tick();assert.equal(sent.length,1);
  runtime.store.apply({id:'publish',goalId:'goal',expectedVersion:1,type:'publish_contract',payload:{contract:contract()}},{kind:'user'});await runtime.subscribers[0].tick();await service.tick();assert.equal(sent.length,1,'rollback must not replay an accepted milestone');
  service.store.db.exec('PRAGMA user_version=2');
  await Promise.all([runtime.close(),runtime.close()]);
  service=await open(); assert.equal(service,null);
  const status=await runtime.app.inject({url:'/api/notifications',headers:{authorization:`Bearer ${TOKEN}`}});assert.equal(status.statusCode,200);assert.equal(status.json().available,false);
  const core=await runtime.app.inject({url:'/api/orchestration/snapshot',headers:{authorization:`Bearer ${TOKEN}`}});assert.equal(core.statusCode,200,'unsupported notification schema cannot block core startup');
});
