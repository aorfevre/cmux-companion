"use client";
/* Navigation to the separately paired session dashboard requires a full document load. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../api-request';
import type { goalView } from '../../server/orchestration/domain/state-view.mjs';
import type { Contract } from '../../server/orchestration/types';
import { GoalDetail } from './goal-detail';

export type Goal = ReturnType<typeof goalView>;
export type Action = Goal['actions'][number];
type Snapshot = { goals: Goal[]; cursor: number; journalId: string; readOnly: boolean };
type Configuration = { suspensionReason?: string | null; readOnly: boolean; terminal: boolean; limits: { global: number; perGoal: number; planners: number }; capabilities: { role: string; mode: string }[]; repositories: { id: string; name?: string; baseSha: string | null; baseBranch: string | null; error: string | null }[] };
type Command = { id: string; goalId: string; expectedVersion: number; type: string; payload: Record<string, unknown> };
const prefix = '/api/orchestration';
export function GoalBoard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<(Goal & { contracts: { revision: number; contract: Contract }[] }) | null>(null);
  const [auth, setAuth] = useState<'loading' | 'paired' | 'unpaired'>('loading');
  const [token, setToken] = useState(''), [title, setTitle] = useState(''), [repository, setRepository] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  const sequence = useRef(0), mounted = useRef(false), selection = useRef(selected);
  useEffect(() => { selection.current = selected; }, [selected]);
  const refresh = useCallback(async () => {
    if (selection.current !== selected) return;
    const version = ++sequence.current;
    try {
      const [next, config, goal] = await Promise.all([
        request<Snapshot>(`${prefix}/snapshot`), request<Configuration>(`${prefix}/configuration`),
        selected ? request<Goal & { contracts: { revision: number; contract: Contract }[] }>(`${prefix}/goals/${encodeURIComponent(selected)}`) : Promise.resolve(null),
      ]);
      if (!mounted.current || sequence.current !== version || selection.current !== selected) return;
      setSnapshot(next); setConfiguration(config); setDetail(goal); setAuth('paired');
    } catch (cause) {
      if (!mounted.current || sequence.current !== version || selection.current !== selected) return;
      if (cause instanceof ApiError && cause.status === 401) setAuth('unpaired');
      else setError(cause instanceof Error ? cause.message : 'Could not refresh goals');
    }
  }, [selected]);
  useEffect(() => {
    mounted.current = true; const kickoff = setTimeout(() => void refresh(), 0);
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    return () => { mounted.current = false; clearTimeout(kickoff); clearInterval(poll); };
  }, [refresh]);
  useEffect(() => {
    if (auth !== 'paired') return;
    const events = new EventSource(`${prefix}/stream`);
    const changed = () => { setConnected(true); void refresh(); };
    events.onopen = () => { setConnected(true); void refresh(); };
    events.onerror = () => setConnected(false);
    for (const type of ['snapshot', 'events', 'resync']) events.addEventListener(type, changed);
    return () => events.close();
  }, [auth, refresh]);
  const submit = async (command: Command) => {
    setBusy(true); setError(''); setNotice(''); setPending(command);
    try {
      await request(`${prefix}/commands`, { method: 'POST', body: JSON.stringify(command) });
      setPending(null); setNotice('Saved. Showing the service’s current state.');
      if (command.type === 'create_goal') { setSelected(command.goalId); setTitle(''); }
      await refresh();
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) setPending(null);
      setError(cause instanceof ApiError && cause.status === 409 && cause.code === 'VERSION_CONFLICT' ? 'The goal changed. Refreshed its current state; review it before trying again.' : cause instanceof Error ? cause.message : 'Request failed');
      await refresh();
      return false;
    } finally { setBusy(false); }
  };
  const act = (goal: Goal, action: Action) => submit({ id: crypto.randomUUID(), goalId: goal.id, expectedVersion: goal.version, type: action.type, payload: action.payload });
  const control = async (goal: Goal, action: 'terminal' | 'reconcile', attemptId?: string) => {
    setBusy(true); setError('');
    try { await request(`${prefix}/goals/${encodeURIComponent(goal.id)}/${action}`, { method: 'POST', body: JSON.stringify({ expectedVersion: goal.version, ...(attemptId ? { attemptId } : {}) }) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Control unavailable'); await refresh(); }
    finally { setBusy(false); }
  };
  const readOnly = Boolean(snapshot?.readOnly || configuration?.readOnly), disabled = busy || readOnly || Boolean(pending);
  const chosenRepo = configuration?.repositories.find((entry) => entry.id === repository) ?? configuration?.repositories[0];
  return <main className="orchestration">
    <header className="orch-header"><a href="/">cmux companion</a><span role="status">{auth === 'paired' ? connected ? 'Live updates' : 'Reconnecting · polling' : 'Orchestration'}</span></header>
    <div className="orch-heading"><div><p className="orch-eyebrow">GOAL WORKSPACE</p><h1>From intent to reviewed work.</h1><p>Plan together. Build in parallel. Review one combined result.</p></div></div>
    {error && <p role="alert" className="orch-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {auth === 'unpaired' ? <form className="orch-card" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await request(`${prefix}/pair`, { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); await refresh(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Pairing failed'); } finally { setBusy(false); }
    }}><h2>Pair this device</h2><label>Pairing token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /></label><button disabled={busy}>Pair device</button></form> : auth === 'loading' ? <p>Connecting to the orchestration service…</p> : <>
      {readOnly && <p className="orch-banner">{configuration?.suspensionReason || 'Read-only mode · controls are disabled.'}</p>}
      {pending && <div className="orch-banner">The request outcome is uncertain. Retry the same request to reconcile its receipt. <button disabled={busy || readOnly} onClick={() => void submit(pending)}>Retry pending request</button></div>}
      <div className="orch-capacity">Capacity: {configuration?.limits.global} background · {configuration?.limits.perGoal} per goal · {configuration?.limits.planners} planners</div>
      {!configuration?.capabilities.some(entry => entry.role === 'planner') && <p className="orch-banner">Interactive planning is unavailable with this adapter configuration.</p>}
      <form className="orch-card orch-create" onSubmit={event => { event.preventDefault(); if (!chosenRepo?.baseSha || !chosenRepo.baseBranch) return; void submit({ id: crypto.randomUUID(), goalId: crypto.randomUUID(), expectedVersion: 0, type: 'create_goal', payload: { title, repositoryId: chosenRepo.id, baseSha: chosenRepo.baseSha, baseBranch: chosenRepo.baseBranch } }); }}>
        <h2>Start a goal</h2><p><a href="/settings">Manage projects and providers</a></p>{!configuration?.repositories.length && <p>Add your first project in <a href="/onboarding">setup</a> to start a goal.</p>}<label>Repository<select disabled={disabled} value={chosenRepo?.id ?? ''} onChange={event => setRepository(event.target.value)}>{configuration?.repositories.map(entry => <option key={entry.id} value={entry.id}>{entry.name ?? entry.id}{entry.baseBranch ? ` · ${entry.baseBranch}` : ' · unavailable'}</option>)}</select></label>
        {chosenRepo?.error && <p role="alert">{chosenRepo.error}</p>}
        <label>What should we accomplish?<textarea value={title} maxLength={500} onChange={event => setTitle(event.target.value)} disabled={disabled} required rows={3} /></label>
        <button disabled={disabled || !chosenRepo?.baseSha || Boolean(chosenRepo?.error) || !configuration?.capabilities.some(entry => entry.role === 'planner')}>Start planning</button>
      </form>
      <div className="orch-workspace"><nav className="orch-goals" aria-label="Goals"><h2>Your goals</h2>{snapshot?.goals.length === 0 && <p>No goals yet. Start with a clear outcome.</p>}{snapshot?.goals.map(goal => <button key={goal.id} aria-current={selected === goal.id ? 'true' : undefined} onClick={() => { setSelected(goal.id); setDetail(null); }}><strong>{goal.title}</strong><span>{goal.status.replaceAll('_', ' ')} · revision {goal.revision}</span></button>)}</nav>
        {selected ? detail ? <GoalDetail key={detail.id} goal={detail} disabled={disabled} terminal={Boolean(configuration?.terminal)} act={act} control={control} /> : <p>Loading goal…</p> : <section className="orch-card"><h2>One goal, one source of truth.</h2><p>Select a goal to inspect its plan, dependency graph, independent reviews and delivery evidence.</p></section>}
      </div>
    </>}
  </main>;
}
