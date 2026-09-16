"use client";
/* Navigation to the separately paired session dashboard requires a full document load. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, request } from '../api-request';
import type { goalView } from '../../server/orchestration/domain/state-view.mjs';
import type { Contract } from '../../server/orchestration/types';
import { MissionShell } from '../mission-shell';
import { ProjectPicker } from './project-picker';
import { GoalDetail } from './goal-detail';
import { GoalFleet, type GoalFilter } from './goal-fleet';

export type Goal = ReturnType<typeof goalView> & { lastActivity?: { kind: string; createdAt: string } | null };
export type Action = Goal['actions'][number];
type Snapshot = { goals: Goal[]; cursor: number; journalId: string; readOnly: boolean };
type Configuration = { suspensionReason?: string | null; readOnly: boolean; terminal: boolean; limits: { global: number; perGoal: number; planners: number }; capabilities: { role: string; mode: string }[]; repositories: { id: string; name?: string; devRepoName?: string; github?: string; enabled?: boolean; setupLabel?: string; baseSha: string | null; baseBranch: string | null; error: string | null }[] };
type Command = { id: string; goalId: string; expectedVersion: number; type: string; payload: Record<string, unknown> };
const prefix = '/api/orchestration';
const subscribeLocation = (changed: () => void) => { window.addEventListener('popstate', changed); return () => window.removeEventListener('popstate', changed); };
export function GoalBoard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [configuration, setConfiguration] = useState<Configuration | null>(null);
  const search = useSyncExternalStore(subscribeLocation, () => window.location.search, () => '');
  const [fleetFilter, setFleetFilter] = useState<GoalFilter>('All');
  const [selectionOverride, setSelected] = useState<string | null | undefined>();
  const selected = selectionOverride === undefined ? new URLSearchParams(search).get('goal') : selectionOverride;
  const [detail, setDetail] = useState<(Goal & { contracts: { revision: number; contract: Contract }[] }) | null>(null);
  const [auth, setAuth] = useState<'loading' | 'paired' | 'unpaired' | 'unavailable'>('loading');
  const [token, setToken] = useState(''), [title, setTitle] = useState(''), [repository, setRepository] = useState('');
  const needsOnly = new URLSearchParams(search).get('view') === 'needs';
  const [brief, setBrief] = useState('');
  const [attachments, setAttachments] = useState<{ name: string; data: string }[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [creating, setCreating] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null), createHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (creating) createHeading.current?.focus(); }, [creating]);
  const restoreCreateFocus = useRef(false);
  const closeCreation = () => { restoreCreateFocus.current = true; setCreating(false); };
  const [baseBranch, setBaseBranch] = useState('main');
  const [discoveryNotice, setDiscoveryNotice] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false);
  const [pending, setPending] = useState<Command | null>(null);
  useEffect(() => { if (!creating && !busy && restoreCreateFocus.current) { createButton.current?.focus(); restoreCreateFocus.current = false; } }, [creating, busy]);
  const submitting = useRef(false);
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
      setSnapshot(next); setConfiguration(config); setDetail(goal); setAuth('paired'); setConnectionError('');
    } catch (cause) {
      if (!mounted.current || sequence.current !== version || selection.current !== selected) return;
      if (cause instanceof ApiError && cause.status === 401) setAuth('unpaired');
      else { setAuth(current => current === 'paired' ? current : 'unavailable'); setConnectionError(cause instanceof Error ? cause.message : 'Could not refresh goals'); }
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
  useEffect(() => {
    if (auth !== 'paired') return;
    let active = true;
    void request<{ scans: Record<string, { partial: boolean; reason: string | null }> }>('/api/settings/dev-repos/reconcile', { method: 'POST', body: '{}' }).then(value => {
      if (!active) return;
      setDiscoveryNotice(Object.values(value.scans ?? {}).filter(scan => scan.partial).map(scan => scan.reason).join(' '));
      void refresh();
    }).catch(cause => {
      if (active && !(cause instanceof ApiError && cause.status === 404)) setDiscoveryNotice('Repositories could not be refreshed. Open Dev repos in Settings to retry.');
    });
    return () => { active = false; };
    // Opening the paired board reconciles once; selection and polling only read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);
  const submit = async (command: Command) => {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true); setError(''); setNotice(''); setPending(command);
    try {
      await request(`${prefix}/commands`, { method: 'POST', body: JSON.stringify(command) });
      setPending(null); setNotice('Saved. Showing the service’s current state.');
      if (command.type === 'create_goal') { setSelected(null); setTitle(''); setBrief(''); setAttachments([]); closeCreation(); setNotice('Goal saved. Its planning agent will start automatically.'); }
      await refresh();
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status < 500) setPending(null);
      setError(cause instanceof ApiError && cause.status === 409 && cause.code === 'VERSION_CONFLICT' ? 'The goal changed. Refreshed its current state; review it before trying again.' : cause instanceof Error ? cause.message : 'Request failed');
      await refresh();
      return false;
    } finally { submitting.current = false; setBusy(false); }
  };
  const act = (goal: Goal, action: Action) => submit({ id: crypto.randomUUID(), goalId: goal.id, expectedVersion: goal.version, type: action.type, payload: action.payload });
  const control = async (goal: Goal, action: 'terminal' | 'reconcile', attemptId?: string) => {
    setBusy(true); setError('');
    try { await request(`${prefix}/goals/${encodeURIComponent(goal.id)}/${action}`, { method: 'POST', body: JSON.stringify({ expectedVersion: goal.version, ...(attemptId ? { attemptId } : {}) }) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Control unavailable'); await refresh(); }
    finally { setBusy(false); }
  };
  const readOnly = Boolean(snapshot?.readOnly || configuration?.readOnly), disabled = busy || readingFiles || readOnly || Boolean(pending);
  const chosenRepo = configuration?.repositories.find(entry => entry.id === repository);
  const pendingRecovery = pending && <div className="orch-banner">The request outcome is uncertain. Retry the same request to reconcile its receipt. <button disabled={busy || readOnly} onClick={() => void submit(pending)}>Retry pending request</button></div>;
  return <MissionShell className="orchestration" active={needsOnly ? 'needs' : 'goals'}>
    <header className="orch-header"><a href="/">cmux companion</a><span role="status">{auth === 'paired' ? connected ? 'Live updates' : 'Reconnecting · polling' : 'Connect your Mac'}</span></header>
    {discoveryNotice && <p role="status">{discoveryNotice} <a href="/settings#dev-repos">Review Dev repos</a></p>}
    {!selected && <div className="orch-heading"><div><p className="orch-eyebrow">{selected ? "GOAL WORKSPACE" : needsOnly ? "DECISIONS" : "OPERATIONS / FLEET"}</p><h1>{selected ? "Goal workspace" : needsOnly ? "Needs You" : "Mission Control"}</h1><p>{selected ? "Plan, supervise and review delivery." : needsOnly ? "Questions, approvals and recovery decisions." : "Every goal, decision and active worker in one place."}</p></div></div>}
    {connectionError && <div role="alert" className="orch-error"><p>{connectionError}</p><button onClick={() => void refresh()}>Try again</button></div>}
    {!selected && <>{error && <p role="alert" className="orch-error">{error}</p>}{notice && <p role="status">{notice}</p>}</>}
    {auth === 'unpaired' ? <form className="orch-card" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try { await request(`${prefix}/pair`, { method: 'POST', body: JSON.stringify({ token: token.trim() }) }); setToken(''); await refresh(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Pairing failed'); } finally { setBusy(false); }
    }}><h2>Pair this device</h2><p className="pairing-help">The pairing code is the private token stored on your Mac. In a terminal on the Mac, run <code>npm run status -- --show-token</code> from the Companion checkout to print it. Do not share this code.</p><label>Pairing code<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required /></label><button disabled={busy}>Pair this device</button></form> : auth === 'unavailable' ? <section className="orch-card"><h2>Goals are unavailable</h2><p>Check your connection to the Mac and try again. If this is a new installation, complete <a href="/onboarding">goal setup</a>.</p></section> : auth === 'loading' ? <p>Connecting to your Mac…</p> : <>
      {readOnly && <p className="orch-banner">{configuration?.suspensionReason || 'Read-only mode · controls are disabled.'}</p>}
      {!selected && pendingRecovery}
      {!selected && <details className="orch-capacity"><summary>Execution capacity</summary>{configuration?.limits.global} execution agents · {configuration?.limits.perGoal} per goal · {configuration?.limits.planners} planners</details>}
      {Boolean(configuration?.repositories.length) && !configuration?.capabilities.some(entry => entry.role === 'planner') && <p className="orch-banner">Your planning agent is not ready. <a href="/settings#agents">Choose an agent</a> to start a goal.</p>}
      {!selected && <button ref={createButton} className="primary-button" aria-expanded={creating} aria-controls="goal-create" disabled={disabled} onClick={() => setCreating(true)}>Start a goal</button>}
      {creating && (configuration?.repositories.length ? <form id="goal-create" className="orch-card orch-create" onSubmit={event => { event.preventDefault(); if (!chosenRepo || disabled) return; void submit({ id: crypto.randomUUID(), goalId: crypto.randomUUID(), expectedVersion: 0, type: 'create_goal', payload: { ...(title.trim() ? { title: title.trim() } : {}), description: brief, ...(attachments.length ? { attachments } : {}), repositoryId: chosenRepo.id, baseBranch: baseBranch.trim() || 'main' } }); }}>
        <h2 ref={createHeading} tabIndex={-1}>Start a goal</h2><p>The agent will inspect the project and propose a plan with suitable verification checks.</p><p><a href="/settings">Manage projects and providers</a></p>{!configuration?.repositories.length && <p>Add your first project in <a href="/onboarding">setup</a> to start a goal.</p>}<ProjectPicker repositories={configuration.repositories} selected={repository} onSelect={setRepository} disabled={disabled} />
        <p className="project-context">Starts from freshly fetched {baseBranch.trim() || 'main'} in an isolated worktree.</p><details><summary>Advanced</summary><label>Base branch<input value={baseBranch} onChange={event => setBaseBranch(event.target.value)} disabled={disabled} placeholder="main" /></label></details>
        {chosenRepo?.error && <p role="alert">{chosenRepo.error} <a href={`/settings?repository=${encodeURIComponent(chosenRepo.id)}#dev-repos`}>Configure repository</a></p>}
        <label>Title (optional)<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} disabled={disabled} placeholder="A short name for this goal" /></label>
        <label>What should we accomplish?<textarea value={brief} maxLength={12000} onChange={event => setBrief(event.target.value)} disabled={disabled} required rows={3} /></label><p>Describe the outcome, constraints and relevant links.</p>
        <label>Reference files<input type="file" multiple disabled={disabled} onChange={async event => {
          const files = Array.from(event.target.files ?? []); event.target.value = '';
          if (!files.length) return;
          if (attachments.length + files.length > 8 || files.some(file => !file.size || file.size > 1024 * 1024)) { setError('Attach up to 8 nonempty files, at most 1 MiB each.'); return; }
          setReadingFiles(true); setError('');
          try {
            const added = await Promise.all(files.map(file => new Promise<{ name: string; data: string }>((resolve, reject) => {
              const reader = new FileReader(); reader.onerror = () => reject(new Error('Could not read the selected file.'));
              reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] }); reader.readAsDataURL(file);
            })));
            setAttachments(current => [...current, ...added]);
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read reference files.'); }
          finally { setReadingFiles(false); }
        }} /></label><p>UTF-8 text/source files or PNG, JPEG and WebP images. Up to 8 files, 1 MiB each.</p>
        {readingFiles && <p role="status">Reading files…</p>}
        {attachments.length > 0 && <ul aria-label="Selected references">{attachments.map((file, index) => <li key={`${index}:${file.name}`}>{file.name} <button type="button" disabled={disabled} onClick={() => setAttachments(current => current.filter((_, position) => position !== index))}>Remove {file.name}</button></li>)}</ul>}
        <button className="primary-button" disabled={disabled || !chosenRepo || Boolean(chosenRepo?.error) || !configuration?.capabilities.some(entry => entry.role === 'planner')}>Start goal</button> <button type="button" disabled={busy || Boolean(pending)} onClick={closeCreation}>Cancel</button>
      </form> : <section id="goal-create" className="orch-card"><h2 ref={createHeading} tabIndex={-1}>Start with your first goal</h2><p>Choose your repositories and an agent, then describe what you want done.</p><a className="primary-button" href="/onboarding">Set up goals</a> <button onClick={closeCreation}>Cancel</button></section>)}
      {!selected && <GoalFleet selectedFilter={fleetFilter} onFilterChange={setFleetFilter} goals={snapshot?.goals ?? []} needsOnly={needsOnly} select={id => { setSelected(id); setDetail(null); const url = new URL(location.href); url.searchParams.set('goal', id); history.replaceState(null, '', url); }} projectName={id => configuration?.repositories.find(repo => repo.id === id)?.name || id} />}
      {selected && <section className="mission-goal-workspace"><button onClick={() => { setSelected(null); setDetail(null); const url = new URL(location.href); url.searchParams.delete('goal'); history.replaceState(null, '', url); }}>← Back to {needsOnly ? 'Needs You' : 'Mission Control'}</button>{pendingRecovery}{error && <p role="alert" className="orch-error">{error}</p>}{notice && <p role="status">{notice}</p>}{detail ? <GoalDetail key={detail.id} goal={detail} disabled={disabled} terminal={Boolean(configuration?.terminal)} act={act} control={control} /> : <p>Loading goal…</p>}</section>}

    </>}
  </MissionShell>;
}
