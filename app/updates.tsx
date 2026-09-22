'use client';
/* Settings spans independently rendered application routes. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useUpdateNotices } from './notification-preferences';
import { request } from './api-request';

type Candidate = { sha: string; changesUrl: string };
type UpdateRequest = { id: string; sha: string; source: 'manual' | 'automatic'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'recovery_required'; phase: string; error: string | null };
type UpdateBlocker = { id: string; code: string; message: string; observedAt: string; elapsedMs: number; method?: string; route?: string; clientDisconnected?: boolean; goalId?: string; operationId?: string; attemptId?: string; resultId?: string; state?: string };
export type Updates = { blockerDetails?: UpdateBlocker[]; blockers?: string[]; available: boolean; revision: number; automatic: boolean; candidate: Candidate | null; observedSha: string | null; deployedSha: string | null; lastCheckAt: string | null; checkError: string | null; checking: boolean; maintenance: boolean; request: UpdateRequest | null };
const endpoint = '/api/updater/updates';
function useUpdates() {
  const [status, setStatus] = useState<Updates | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = ++generation.current;
    try { const next = await request<Updates>(endpoint); if (generation.current === current) { setStatus(next); setLoadError(''); setLoading(false); } }
    catch { if (generation.current === current) { setLoadError('Could not check update status. Try again.'); setLoading(false); } }
  }, []);
  useEffect(() => { const invalidate = () => { generation.current++; }; const kickoff = setTimeout(() => void load(), 0), poll = setInterval(() => void load(), 5000); return () => { invalidate(); clearTimeout(kickoff); clearInterval(poll); }; }, [load]);
  const accept = (next: Updates) => { generation.current++; setStatus(next); };
  return { status, load, accept, loading, loadError };
}
export function UpdateNotice() {
  const enabled = useUpdateNotices();
  const { status } = useUpdates();
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem('cmux-update-dismissed'); } catch { return null; } });
  const candidate = status?.candidate;
  if (!enabled || !candidate || candidate.sha === dismissed || status?.request?.status === 'running') return null;
  return <aside className="update-notice" aria-label="Update notification"><span>Update available</span><a href="/settings#updates">View update</a><button onClick={() => { setDismissed(candidate.sha); try { localStorage.setItem('cmux-update-dismissed', candidate.sha); } catch { /* Dismiss for this page if storage is unavailable. */ } }}>Later</button></aside>;
}
const phaseLabels: Record<string, string> = { waiting: 'Waiting to update', preparing: 'Preparing update', verifying: 'Verifying update', switching: 'Activating update', restarting: 'Restarting Companion', 'health-checking': 'Checking startup', accepted: 'Finishing update', 'rolling-back': 'Recovering previous version', restoring: 'Restoring previous data', succeeded: 'Update complete', failed: 'Update failed', recovery_required: 'Recovery needs attention' };
export function UpdateSettings({ readOnly }: { readOnly?: boolean }) {
  const { status, load, accept, loading, loadError } = useUpdates();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [unlocked, setUnlocked] = useState(false), [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<{ candidate: Candidate; whenIdle: boolean; id: string } | null>(null);
  const protectedMode = readOnly ?? !unlocked;
  useEffect(() => { if (window.location.hash === '#updates') document.getElementById('updates')?.scrollIntoView(); }, []);
  async function mutate(path: string, body: unknown, method = 'POST') {
    if (protectedMode || busy) return;
    setBusy(true); setError(''); setNotice('Saving…');
    try { accept(await request<Updates>(path, { method, body: JSON.stringify(body) })); setConfirmation(null); setNotice('Saved.'); }
    catch (cause) { setNotice(''); setError(cause instanceof Error ? cause.message : 'Update request failed'); void load(); }
    finally { setBusy(false); }
  }
  const active = status?.request && ['queued', 'running', 'recovery_required'].includes(status.request.status);
  const candidate = status?.candidate;
  return <section id="updates" className="update-settings" aria-label="Companion updates">
    <h2>Companion updates</h2>
    {loadError && <p role="alert">{loadError} <button type="button" onClick={() => void load()}>Retry update status</button></p>}
    {loading ? <p role="status">Loading update status…</p> : !status?.available ? <p>Update controls are unavailable. An installed bundled updater is required.</p> : <>
      <p className="update-version">Installed <code>{status.deployedSha?.slice(0, 7) || 'unknown'}</code>{status.lastCheckAt && <> · Last checked {new Date(status.lastCheckAt).toLocaleString()}</>}</p>
      <button type="button" disabled={busy || status.checking || protectedMode} onClick={() => void mutate('/api/updater/check', {})}>{status.checking ? 'Checking for updates…' : 'Check for updates'}</button>
      {readOnly === undefined && <label className="update-toggle"><input type="checkbox" checked={unlocked} onChange={event => setUnlocked(event.target.checked)} />Allow update changes on this device</label>}
      {readOnly === true && <p>Turn off read-only protection to change updates.</p>}
      <label className="update-toggle"><input type="checkbox" role="switch" checked={status.automatic} disabled={busy || protectedMode} onChange={event => void mutate('/api/updater/preferences', { revision: status.revision, automatic: event.target.checked }, 'PATCH')} />Automatic installation</label>
      <p>Off by default. When enabled, install updates that pass CI once Companion can restart safely. Existing cmux sessions and supported planning terminals remain open; Companion briefly reconnects.</p>
      {candidate ? <div className="update-candidate"><p>Update available: <code>{candidate.sha.slice(0, 7)}</code> · <a href={candidate.changesUrl} target="_blank" rel="noreferrer">View changes</a></p>
        {!active && <div className="update-actions"><button type="button" disabled={busy || protectedMode} onClick={() => setConfirmation({ candidate, whenIdle: false, id: crypto.randomUUID() })}>{status.request?.status === 'failed' && status.request.sha === candidate.sha ? 'Retry update' : 'Update now'}</button><button type="button" disabled={busy || protectedMode} onClick={() => setConfirmation({ candidate, whenIdle: true, id: crypto.randomUUID() })}>Update when ready</button></div>}
      </div> : !status.checkError && <p>{status.observedSha && status.observedSha !== status.deployedSha ? 'A newer main commit is awaiting successful checks.' : 'No eligible updates available.'}</p>}
      {confirmation && <div className="update-confirmation" role="group" aria-label="Confirm update">
        <p>Install commit <code>{confirmation.candidate.sha.slice(0, 7)}</code>{confirmation.whenIdle ? ' when Companion can restart safely' : ''}? Companion will briefly reconnect. Existing cmux sessions remain open.</p>
        <button type="button" disabled={busy || protectedMode} onClick={() => void mutate(status.request?.status === 'failed' && status.request.sha === confirmation.candidate.sha ? '/api/updater/retry' : '/api/updater/requests', { id: confirmation.id, sha: confirmation.candidate.sha, whenIdle: confirmation.whenIdle })}>{busy ? 'Requesting…' : 'Confirm installation'}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
      </div>}
      {status.request && <div className="update-request" aria-live="polite"><p>{status.request.status === 'queued' ? 'Waiting to update' : status.request.status === 'cancelled' ? 'Queued update cancelled' : phaseLabels[status.request.phase] || status.request.phase} · <code>{status.request.sha.slice(0, 7)}</code></p>
        {status.request.source === 'automatic' && status.request.status === 'queued' && <p>Queued by automatic installation.</p>}
        {status.request.status === 'queued' && <button type="button" disabled={busy || protectedMode} onClick={() => void mutate('/api/updater/cancel', { id: status.request!.id })}>Cancel queued update</button>}
        {status.request.status === 'running' && !status.automatic && <p>This transaction has started and will finish or recover safely. Future automatic installations are off.</p>}
        {status.request.error && <p role="alert">{status.request.error}</p>}
      </div>}
      <div className="update-readiness" aria-label="Update readiness">
        <h3>{status.blockers?.length || status.blockerDetails?.length ? 'What is preventing a restart' : 'Restart readiness'}</h3>
        <p>These checks concern Companion-owned work. Ordinary cmux sessions do not block a restart.</p>
        {status.blockerDetails?.length ? <ul>{status.blockerDetails.map(blocker => <li key={blocker.id}>
          <strong>{blocker.message}</strong>
          <p>Observed for {blockerDuration(blocker.elapsedMs)}{blocker.state ? ` · ${blocker.state}` : ''}</p>
          {blocker.clientDisconnected && <p>Client disconnected. Completion is unconfirmed; this may be a stale request. Disconnection alone does not prove the action stopped.</p>}
          {blocker.code === 'managed_agent' && <p>Supported planning terminals are checked for safe handoff during installation.</p>}
          <details><summary>Diagnostic details</summary><dl>
            <dt>Blocker</dt><dd><code>{blocker.code}</code></dd>
            <dt>Observed since</dt><dd><time dateTime={blocker.observedAt}>{new Date(blocker.observedAt).toLocaleString()}</time></dd>
            {blocker.method && <><dt>Request</dt><dd><code>{blocker.method} {blocker.route}</code></dd><dt>Diagnostic request ID</dt><dd><code>{blocker.id}</code></dd><dt>Client</dt><dd>{blocker.clientDisconnected ? 'Disconnected' : 'No disconnect observed'}</dd></>}
            {blocker.goalId && <><dt>Goal ID</dt><dd><code>{blocker.goalId}</code></dd></>}
            {blocker.operationId && <><dt>Operation ID</dt><dd><code>{blocker.operationId}</code></dd></>}
            {blocker.attemptId && <><dt>Attempt ID</dt><dd><code>{blocker.attemptId}</code></dd></>}
            {blocker.resultId && <><dt>Result ID</dt><dd><code>{blocker.resultId}</code></dd></>}
          </dl></details>
        </li>)}</ul> : status.blockers?.length ? <ul>{status.blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul> : <p>{status.blockers ? 'No active restart blockers. Update eligibility and CI checks still apply.' : 'Detailed readiness is unavailable from this service version.'}</p>}
      </div>
      {status.checkError && <p role="alert">{status.checkError}</p>}
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

function blockerDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
