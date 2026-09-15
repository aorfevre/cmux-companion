'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../api-request';
import { disablePush, pushHeaders, saveUpdateNotices, useUpdateNotices } from '../notification-preferences';
type Preferences = { attention: boolean; complete: boolean; updates: boolean; discreet: boolean };
type Status = { available: boolean; publicKey: string; subscribed: boolean; preferences: Preferences; lastAttempt: number | null; result: string | null };
function supported() { return typeof window !== 'undefined' && window.isSecureContext && 'Notification' in window && 'PushManager' in window && Boolean(navigator.serviceWorker); }
function keyBytes(value: string) { const text = atob(value.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(text, letter => letter.charCodeAt(0)); }
const initial = { attention: true, complete: true, updates: true, discreet: true };
export function NotificationSettings() {
  const notices = useUpdateNotices();
  const generation = useRef(0), busyRef = useRef(false);
  const [status, setStatus] = useState<Status | null>(null), [permission, setPermission] = useState('unknown');
  const [capable, setCapable] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [prefs, setPrefs] = useState<Preferences>(initial), [preview, setPreview] = useState(false), [confirm, setConfirm] = useState(false);
  const load = useCallback(async () => {
    const current = ++generation.current;
    setCapable(supported()); setPermission('Notification' in window ? Notification.permission : 'unsupported');
    const result = await request<Status>('/api/notifications', { headers: pushHeaders() }); if (current === generation.current) { setStatus(result); if (result.subscribed) setPrefs(result.preferences); }
  }, []);
  useEffect(() => {
    let live = true;
    const refresh = () => { if (live && !busyRef.current) void load().catch(() => { if (live) setError('Notification status is unavailable. Connect to your Mac and retry.'); }); };
    refresh(); const timer = setInterval(refresh, 5000); window.addEventListener('focus', refresh);
    return () => { live = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  async function perform(action: () => Promise<void>, success: string) {
    busyRef.current = true; generation.current++; setBusy(true); setError(''); setMessage('');
    try { await action(); setMessage(success); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Notification request failed'); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function enable() {
    if (!supported() || !status?.available) throw new Error('Background push is unavailable in this browser or installation.');
    const headers = pushHeaders(true); // Persist recovery proof before creating a browser subscription.
    const allowed = await Notification.requestPermission(); setPermission(allowed);
    if (allowed !== 'granted') throw new Error('Notifications were not allowed. Change the permission in browser or OS settings before retrying.');
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    let previous = await registration.pushManager.getSubscription();
    const oldKey = previous?.options?.applicationServerKey;
    if (oldKey && String(new Uint8Array(oldKey)) !== String(keyBytes(status.publicKey))) {
      if (!(await previous!.unsubscribe())) throw new Error('The old browser subscription could not be removed. Disable notifications and retry.');
      previous = null;
    }
    const subscription = previous ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) });
    try { await request('/api/notifications/subscription', { method: 'POST', headers, body: JSON.stringify({ subscription: subscription.toJSON(), preferences: prefs }) }); }
    catch (cause) {
      if (!previous) {
        try { if (!(await subscription.unsubscribe())) throw new Error(); }
        catch { throw new Error('Registration failed and browser cleanup failed. Disable notifications in browser settings, then retry.'); }
      }
      throw new Error(`${cause instanceof Error ? cause.message : 'Subscription registration failed'}. Retry enrollment; if the browser lost its management key, revoke all subscriptions and try again.`);
    }
  }
  return <section aria-label="Notification settings"><h2>Notifications</h2><p>Preferences apply to this browser or installed app. Other devices keep their own choices.</p>
    <label className="preference-row"><span>In-app update notices<span className="setting-description">Show update-available banners while Companion is open.</span></span><input role="switch" type="checkbox" checked={notices} onChange={event => { setError(''); try { saveUpdateNotices(event.target.checked); setMessage('Saved on this browser.'); } catch { setError('This browser could not save the preference.'); } }} /></label>
    <button onClick={() => setPreview(true)}>Show test in-app notice</button>
    {preview && <aside role="status">This is a test notice. <button onClick={() => setPreview(false)}>Dismiss test notice</button></aside>}
    <h3>Background notifications</h3>
    <p>Opt-in, off by default. Your Mac must be running, awake and online. OS settings, Focus modes and browser restrictions can delay or prevent display.</p>
    <p>Push travels through your browser vendor’s service. Opening private content still requires Tailscale and pairing. The vendor sees delivery metadata; notification text is encrypted in transit and may appear on your lock screen.</p>
    <p>On iPhone/iPad (iOS/iPadOS 16.4+), add Companion to the Home Screen and enable notifications from that installed app.</p>
    <p>Browser support: {capable ? 'available' : 'unavailable — use a supported browser over HTTPS or the installed iPhone app'}. Permission: {permission}. Subscription: {status?.subscribed ? 'registered with this Mac' : 'not registered'}.</p>
    {permission === 'denied' && <p>Permission is blocked. Open this site’s notification permissions in browser settings and check OS notification settings; this page cannot override them.</p>}
    {status && !status.available && <p>Background push is unavailable on this Mac. Check the notification store and sender contact configuration.</p>}
    {!status && <button disabled={busy} onClick={() => void perform(load, 'Status refreshed.')}>Retry notification status</button>}
    <fieldset disabled={busy}><legend>Notify me about</legend>
      {(['attention','complete','updates','discreet'] as const).map((key, index) => <label className="preference-row" key={key}><span>{['Needs your attention','Goal complete','Updates','Hide project and goal names'][index]}</span><input type="checkbox" role="switch" checked={prefs[key]} onChange={event => {
        const next = { ...prefs, [key]: event.target.checked };
        if (!status?.subscribed) setPrefs(next);
        else void perform(async () => { await request('/api/notifications/preferences', { method: 'PATCH', headers: pushHeaders(), body: JSON.stringify(next) }); }, 'Saved for this subscription.');
      }} /></label>)}
    </fieldset><p>Attention includes questions, approvals and recovery. Goal complete means the PR was confirmed merged. Updates includes eligible updates and installation results. Hidden names use generic text; changing privacy preferences affects future sends only.</p>
    <div className="update-actions"><button disabled={busy || !capable || !status?.available || permission === 'denied'} onClick={() => void perform(enable, 'Background notifications registered.')}>{status?.subscribed ? 'Repair browser subscription' : 'Enable background notifications'}</button>
      <button disabled={busy} onClick={() => void perform(() => disablePush(), 'This device’s background notifications are disabled.')}>Disable background notifications on this device</button>
      <button disabled={busy || !status?.subscribed} onClick={() => void perform(async () => { await request('/api/notifications/test', { method: 'POST', headers: pushHeaders(), body: '{}' }); }, 'Test queued. Provider acceptance does not prove OS display.')}>Send test notification</button></div>
    {status?.lastAttempt && <p>Last attempt: {new Date(status.lastAttempt).toLocaleString()}</p>}{status?.result && <p role="status">{status.result}</p>}
    <details><summary>Lost device or subscription recovery</summary><p>Pairing shares this Mac’s trust. Clearing a browser cookie alone does not revoke its push subscription. Revocation cannot retract notifications already accepted by the vendor or displayed.</p><button disabled={busy} onClick={() => setConfirm(true)}>Revoke all push subscriptions on this Mac</button>
      {confirm && <div role="group" aria-label="Confirm push revocation"><p>Every device will need to enable background notifications again.</p><button disabled={busy} onClick={() => void perform(async () => { await request('/api/notifications/revoke-all', { method: 'POST', body: JSON.stringify({ confirm: 'revoke-all' }) }); await disablePush({ serverRevoked: true }); setConfirm(false); }, 'All push subscriptions revoked.')}>Confirm revoke all</button><button onClick={() => setConfirm(false)}>Cancel</button></div>}</details>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
