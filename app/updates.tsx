'use client';
/* Settings spans independently rendered application routes. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './api-request';

type Candidate = { sha: string; changesUrl: string };
type UpdateRequest = { id: string; sha: string; source: 'manual' | 'automatic'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required'; phase: string; error: string | null };
export type Updates = { available: boolean; revision: number; automatic: boolean; candidate: Candidate | null; observedSha: string | null; deployedSha: string | null; lastCheckAt: string | null; checkError: string | null; checking: boolean; maintenance: boolean; request: UpdateRequest | null };
const endpoint = '/api/updater/updates';
function useUpdates() {
  const [status, setStatus] = useState<Updates | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try { const next = await request<Updates>(endpoint); if (generation.current === current) setStatus(next); }
    catch { if (generation.current === current) setStatus(null); }
  }, []);
  useEffect(() => { const invalidate = () => { generation.current++; }; const kickoff = setTimeout(() => void load(), 0), poll = setInterval(() => void load(), 5000); return () => { invalidate(); clearTimeout(kickoff); clearInterval(poll); }; }, [load]);
  const accept = (next: Updates) => { generation.current++; setStatus(next); };
  return { status, load, accept };
}
export function UpdateNotice() {
  const { status } = useUpdates();
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem('cmux-update-dismissed'); } catch { return null; } });
  const candidate = status?.candidate;
  if (!candidate || candidate.sha === dismissed || status?.request?.status === 'running') return null;
  return <aside className="update-notice" aria-label="Update notification"><span>Update available</span><a href="/settings#updates">View update</a><button onClick={() => { setDismissed(candidate.sha); try { localStorage.setItem('cmux-update-dismissed', candidate.sha); } catch { /* Dismiss for this page if storage is unavailable. */ } }}>Later</button></aside>;
}
const phaseLabels: Record<string, string> = { waiting: 'Waiting to update', preparing: 'Preparing update', verifying: 'Verifying update', switching: 'Activating update', restarting: 'Restarting Companion', 'health-checking': 'Checking startup', accepted: 'Finishing update', 'rolling-back': 'Recovering previous version', restoring: 'Restoring previous data', succeeded: 'Update complete', failed: 'Update failed', recovery_required: 'Recovery needs attention' };
export function UpdateSettings({ readOnly }: { readOnly?: boolean }) {
  const { status, load, accept } = useUpdates();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [confirmation, setConfirmation] = useState<{ candidate: Candidate; whenIdle: boolean; id: string } | null>(null);
  const protectedMode = readOnly ?? !unlocked;
  useEffect(() => { if (window.location.hash === '#updates') document.getElementById('updates')?.scrollIntoView(); }, []);
  async function mutate(path: string, body: unknown, method = 'POST') {
    if (protectedMode || busy) return;
    setBusy(true); setError('');
    try { accept(await request<Updates>(path, { method, body: JSON.stringify(body) })); setConfirmation(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Update request failed'); void load(); }
    finally { setBusy(false); }
  }
  const active = status?.request && ['queued', 'running', 'recovery_required'].includes(status.request.status);
  const candidate = status?.candidate;
  return <section id="updates" className="update-settings" aria-label="Companion updates">
    <h2>Companion updates</h2>
    {!status?.available ? <p>Update controls are unavailable. An installed bundled updater is required.</p> : <>
      <p>Installed <code>{status.deployedSha?.slice(0, 7) || 'unknown'}</code>{status.lastCheckAt && <> · Last checked {new Date(status.lastCheckAt).toLocaleString()}</>}</p>
      <button type="button" disabled={busy || status.checking || protectedMode} onClick={() => void mutate('/api/updater/check', {})}>{status.checking ? 'Checking for updates…' : 'Check for updates'}</button>
      {readOnly === undefined && <label className="update-toggle"><input type="checkbox" checked={unlocked} onChange={event => setUnlocked(event.target.checked)} />Allow update changes on this device</label>}
      {readOnly === true && <p>Turn off read-only protection to change updates.</p>}
      <label className="update-toggle"><input type="checkbox" role="switch" checked={status.automatic} disabled={busy || protectedMode} onChange={event => void mutate('/api/updater/preferences', { revision: status.revision, automatic: event.target.checked }, 'PATCH')} />Automatic installation</label>
      <p>Off by default. When enabled, install updates that pass CI once agents are idle. Companion briefly reconnects.</p>
      {candidate ? <div><p>Update available: <code>{candidate.sha.slice(0, 7)}</code> · <a href={candidate.changesUrl} target="_blank" rel="noreferrer">View changes</a></p>
        {!active && <div className="update-actions"><button type="button" disabled={busy || protectedMode} onClick={() => setConfirmation({ candidate, whenIdle: false, id: crypto.randomUUID() })}>{status.request?.status === 'failed' && status.request.sha === candidate.sha ? 'Retry update' : 'Update now'}</button><button type="button" disabled={busy || protectedMode} onClick={() => setConfirmation({ candidate, whenIdle: true, id: crypto.randomUUID() })}>Update when idle</button></div>}
      </div> : !status.checkError && <p>{status.observedSha && status.observedSha !== status.deployedSha ? 'A newer main commit is awaiting successful checks.' : 'No eligible updates available.'}</p>}
      {confirmation && <div className="update-confirmation" role="group" aria-label="Confirm update">
        <p>Install commit <code>{confirmation.candidate.sha.slice(0, 7)}</code>{confirmation.whenIdle ? ' when agents finish' : ''}? Companion will briefly reconnect. Existing cmux sessions remain open.</p>
        <button type="button" disabled={busy || protectedMode} onClick={() => void mutate(status.request?.status === 'failed' && status.request.sha === confirmation.candidate.sha ? '/api/updater/retry' : '/api/updater/requests', { id: confirmation.id, sha: confirmation.candidate.sha, whenIdle: confirmation.whenIdle })}>{busy ? 'Requesting…' : 'Confirm installation'}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
      </div>}
      {status.request && <div aria-live="polite"><p>{status.request.status === 'queued' ? 'Waiting for agents and update checks' : status.request.status === 'cancelled' ? 'Queued update cancelled' : phaseLabels[status.request.phase] || status.request.phase} · <code>{status.request.sha.slice(0, 7)}</code></p>
        {status.request.source === 'automatic' && status.request.status === 'queued' && <p>Queued by automatic installation.</p>}
        {status.request.status === 'queued' && <button type="button" disabled={busy || protectedMode} onClick={() => void mutate('/api/updater/cancel', { id: status.request!.id })}>Cancel queued update</button>}
        {status.request.status === 'running' && !status.automatic && <p>This transaction has started and will finish or recover safely. Future automatic installations are off.</p>}
        {status.request.error && <p role="alert">{status.request.error}</p>}
      </div>}
      {status.checkError && <p role="alert">{status.checkError}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
