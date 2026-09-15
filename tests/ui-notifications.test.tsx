import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, test, vi } from 'vitest';
import { DeviceSettings } from '../app/settings/device-settings';
import { NotificationSettings } from '../app/settings/notifications';
import { UpdateNotice } from '../app/updates';
import { deviceProof, disablePush, pushHeaders, saveUpdateNotices } from '../app/notification-preferences';
const defaults={attention:true,complete:true,updates:true,discreet:true};
const initial=()=>({available:true,publicKey:'BA'+ 'a'.repeat(85),subscribed:false,preferences:{...defaults},lastAttempt:null as number|null,result:null as string|null});
function fixture(options:{denied?:boolean;failEnroll?:boolean;failUnsubscribe?:boolean;failRevoke?:boolean;subscribed?:boolean}={}){
  const state=initial();state.subscribed=Boolean(options.subscribed);const calls:{url:string;method:string;body:unknown}[]=[];
  const unsubscribe=vi.fn(async()=>!options.failUnsubscribe),subscription={toJSON:()=>({endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{}}),unsubscribe};
  const manager={getSubscription:vi.fn(async()=>options.subscribed?subscription:null),subscribe:vi.fn(async()=>subscription)};
  const registration={pushManager:manager};
  vi.stubGlobal('isSecureContext',true);vi.stubGlobal('PushManager',function(){});
  const permission=vi.fn(async()=>options.denied?'denied':'granted');vi.stubGlobal('Notification',{permission:options.denied?'denied':'default',requestPermission:permission});
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:vi.fn(async()=>registration),ready:Promise.resolve(registration),getRegistration:vi.fn(async()=>registration)}});
  vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
    const url=String(input),method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;calls.push({url,method,body});
    if(url==='/api/updater/updates')return new Response(JSON.stringify({candidate:{sha:'a'.repeat(40)},request:null}));
    if(url.endsWith('/subscription')&&method==='POST'){
      if(options.failEnroll)return new Response(JSON.stringify({error:'Cannot enroll'}),{status:500});state.subscribed=true;state.preferences=body.preferences;
    }
    if(url.endsWith('/preferences')&&method==='PATCH')state.preferences=body;
    if(url.endsWith('/subscription')&&method==='DELETE'){
      if(options.failRevoke)return new Response(JSON.stringify({error:'Offline'}),{status:503});state.subscribed=false;
    }
    if(url.endsWith('/revoke-all'))state.subscribed=false;
    if(url.endsWith('/test')){state.lastAttempt=1000;state.result='Accepted by push service';}
    return new Response(JSON.stringify(state));
  }));
  return {state,calls,permission,manager,unsubscribe};
}
afterEach(()=>{localStorage.clear();vi.unstubAllGlobals();Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:undefined});});
test('in-app preference persists, syncs consumers, retains Later and never changes updater policy',async()=>{
  fixture();render(<><NotificationSettings/><UpdateNotice/></>);const control=await screen.findByRole('switch',{name:/In-app update notices/});await screen.findByRole('link',{name:'View update'});
  await userEvent.click(control);assert.equal(screen.queryByRole('link',{name:'View update'}),null);assert.equal(localStorage.getItem('cmux-companion-update-notices'),'false');
  act(()=>saveUpdateNotices(true));await screen.findByRole('link',{name:'View update'});await userEvent.click(screen.getByRole('button',{name:'Later'}));
  act(()=>{saveUpdateNotices(false);saveUpdateNotices(true);window.dispatchEvent(new StorageEvent('storage'));});assert.equal(screen.queryByRole('link',{name:'View update'}),null);
  await userEvent.click(screen.getByRole('button',{name:'Show test in-app notice'}));assert.ok(screen.getByText(/This is a test notice/));await userEvent.click(screen.getByRole('button',{name:'Dismiss test notice'}));
});
test('explicit permission, enrollment, preferences, test and revoke-all operate on this subscription',async()=>{
  const f=fixture();render(<NotificationSettings/>);const enable=await screen.findByRole('button',{name:'Enable background notifications'});await waitFor(()=>assert.equal((enable as HTMLButtonElement).disabled,false));assert.equal(f.permission.mock.calls.length,0);
  await userEvent.click(enable);await screen.findByText('Background notifications registered.');assert.equal(f.permission.mock.calls.length,1);assert.ok(deviceProof());assert.equal(f.manager.subscribe.mock.calls.length,1);
  await userEvent.click(screen.getByRole('switch',{name:'Hide project and goal names'}));await screen.findByText('Saved for this subscription.');assert.equal(f.state.preferences.discreet,false);
  await userEvent.click(screen.getByRole('button',{name:'Send test notification'}));await screen.findByText('Accepted by push service');assert.ok(f.calls.some(x=>x.url.endsWith('/test')));
  await userEvent.click(screen.getByText('Lost device or subscription recovery'));await userEvent.click(screen.getByRole('button',{name:'Revoke all push subscriptions on this Mac'}));await userEvent.click(screen.getByRole('button',{name:'Cancel'}));
  await userEvent.click(screen.getByRole('button',{name:'Revoke all push subscriptions on this Mac'}));await userEvent.click(screen.getByRole('button',{name:'Confirm revoke all'}));await screen.findByText('All push subscriptions revoked.');assert.equal(f.state.subscribed,false);
});
test('denied permission never subscribes and registration failure cleans up only a new browser subscription',async()=>{
  const f=fixture({denied:true});const view=render(<NotificationSettings/>);await screen.findByText(/Permission is blocked/);assert.equal((screen.getByRole('button',{name:'Enable background notifications'})as HTMLButtonElement).disabled,true);assert.equal(f.manager.subscribe.mock.calls.length,0);view.unmount();
  const failed=fixture({failEnroll:true});render(<NotificationSettings/>);const enable=await screen.findByRole('button',{name:'Enable background notifications'});await waitFor(()=>assert.equal((enable as HTMLButtonElement).disabled,false));await userEvent.click(enable);await screen.findByRole('alert');assert.equal(failed.unsubscribe.mock.calls.length,1);assert.equal(failed.state.subscribed,false);
});
test('enrollment cleanup failure and browser storage failure remain visible',async()=>{
  const f=fixture({failEnroll:true,failUnsubscribe:true});render(<NotificationSettings/>);const enable=await screen.findByRole('button',{name:'Enable background notifications'});await waitFor(()=>assert.equal((enable as HTMLButtonElement).disabled,false));await userEvent.click(enable);await screen.findByText(/browser cleanup failed/);assert.equal(f.unsubscribe.mock.calls.length,1);
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('Denied');});await userEvent.click(screen.getByRole('switch',{name:/In-app update notices/}));await screen.findByText('This browser could not save the preference.');
});
test('disable attempts both server and browser cleanup even when one fails',async()=>{
  const f=fixture({subscribed:true,failRevoke:true,failUnsubscribe:true});deviceProof(true);await assert.rejects(disablePush(),/Server revocation failed.*Browser unsubscription failed/);assert.equal(f.unsubscribe.mock.calls.length,1);
  localStorage.clear();assert.deepEqual(pushHeaders(),{});assert.ok(pushHeaders(true)['x-companion-push-device']);assert.equal(deviceProof(),deviceProof());
});
test('unavailable APIs and unsupported browsers offer honest recovery without prompting',async()=>{
  fixture();vi.stubGlobal('isSecureContext',false);vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:404})));render(<NotificationSettings/>);await screen.findByRole('alert');assert.ok(screen.getByRole('button',{name:'Retry notification status'}));await userEvent.click(screen.getByRole('button',{name:'Retry notification status'}));await screen.findByRole('alert');assert.equal((screen.getByRole('button',{name:'Enable background notifications'})as HTMLButtonElement).disabled,true);
});

test('logout still succeeds and preserves an actionable message if server push revocation fails',async()=>{
  const f=fixture({subscribed:true,failRevoke:true});deviceProof(true);render(<DeviceSettings/>);await userEvent.click(screen.getByRole('button',{name:'Unpair this device'}));
  await screen.findByText(/Unpaired. Server revocation failed/);assert.ok(f.calls.some(x=>x.url==='/api/auth/logout'&&x.method==='POST'));assert.equal(f.unsubscribe.mock.calls.length,1);
});
