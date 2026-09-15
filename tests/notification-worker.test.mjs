import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function fixture(clients=[]) {
  const handlers={},shown=[],opened=[];
  vm.runInNewContext(source,{URL,self:{location:{origin:'https://mac.example.test'},addEventListener:(name,fn)=>{handlers[name]=fn;},registration:{showNotification:async(...args)=>shown.push(args)},clients:{matchAll:async()=>clients,openWindow:async url=>opened.push(url)}}});
  return {shown,opened,async dispatch(name,event){const waits=[];handlers[name]({...event,waitUntil:p=>waits.push(p)});await Promise.all(waits);}};
}
test('push events display with no open clients and hostile click payloads cannot navigate off-origin',async()=>{
  const f=fixture();await f.dispatch('push',{data:{json:()=>({title:'Needs attention',body:'Open app',url:'/orchestration?goal=goal-1',tag:`companion-${'a'.repeat(32)}`})}});assert.equal(f.shown[0][0],'Needs attention');assert.equal(f.shown[0][1].data.url,'/orchestration?goal=goal-1');
  let closed=false;await f.dispatch('notificationclick',{notification:{data:{url:'https://evil.test/steal'},close:()=>{closed=true;}}});assert.ok(closed);assert.deepEqual(f.opened,['https://mac.example.test/orchestration']);
  for(const url of ['//evil.test','/settings#updates','/settings#notifications','/orchestration?goal=../bad','/orchestration?goal=a&action=approve'])await f.dispatch('notificationclick',{notification:{data:{url},close(){}}});
  assert.equal(f.opened.some(x=>x.includes('evil')||x.includes('approve')),false);
});
test('malformed pushes use safe copy and click focuses only a same-origin navigated client',async()=>{
  const focused=[],navigated=[];const f=fixture([{url:'https://evil.test/',navigate(){throw new Error('must not use');}},{url:'https://mac.example.test/',navigate:async url=>{navigated.push(url);return{focus:async()=>focused.push(true)};}}]);
  await f.dispatch('push',{data:{json(){throw new Error();}}});assert.equal(f.shown[0][0],'Companion notification');
  await f.dispatch('push',{data:{json:()=>({title:'x'.repeat(1000),body:'x'.repeat(1000),tag:'hostile'})}});assert.equal(f.shown[1][1].tag,'companion-notification');
  await f.dispatch('notificationclick',{notification:{data:{url:'/settings#updates'},close(){}}});assert.deepEqual(focused,[true]);assert.equal(navigated[0],'https://mac.example.test/settings#updates');assert.equal(f.opened.length,0);
  const failed=fixture([{url:'https://mac.example.test',navigate:async()=>{throw new Error();}}]);await failed.dispatch('notificationclick',{notification:{close(){}}});assert.equal(failed.opened.length,1);
});
