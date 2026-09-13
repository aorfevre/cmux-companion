'use client';
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../api-request';
import { UpdateSettings } from '../updates';
import { ModelSelect, ModelSettingsPanel } from '../model-settings';
import { LastUpdateStamp } from '../last-update';
import { AppNavigation } from '../navigation';
import { DeviceSettings } from './device-settings';
import { PushSettings } from './notifications';
import { ReleaseRetentionPanel } from '../release-retention';
import { DeploymentHealth } from '../deployment-health';
import { DevRepositories } from './dev-repositories';
export type Provider = 'claude' | 'codex';
export type Command = { executable: string; args: string[]; model: string };
export type Check = { id: string; executable: string; args: string[]; script?: string };
export type Project = { id: string; name: string; path: string; enabled: boolean; github: string | null; remote: string | null; checks: Check[]; devRepoId?: string };
export type DevRepo = { id: string; name: string; path: string };
export type Settings = {
  devRepos?: DevRepo[]; projects: Project[]; providers: Record<Provider, Command>; provider: Provider;
  tools: { cmux: string; tailscale: string; chrome: string };
  execution: { global: number; perGoal: number; planners: number; ceilingMs: number; idleMs: number; maxOutputBytes: number; killGraceMs: number };
  previews: { portStart: number; portEnd: number }; onboarding: { completed: boolean };
};
type Snapshot = { revision: number; settings: Settings; imported: boolean };
const categories = { general: 'General', 'dev-repos': 'Dev repos', agents: 'Agents', notifications: 'Notifications', updates: 'Updates', advanced: 'Advanced' };
type Category = keyof typeof categories;
const editable: Partial<Record<Category, (keyof Settings)[]>> = { 'dev-repos': ['devRepos', 'projects'], agents: ['provider', 'providers'], advanced: ['tools', 'execution', 'previews'] };
function categoryFromLocation(): Category | null { const hash = typeof window === 'undefined' ? '' : location.hash.slice(1); return hash in categories ? hash as Category : null; }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function LocalSettingsPanel({ onboarding = false }: { onboarding?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [draft, setDraft] = useState<Settings | null>(null);
  const [category, setCategory] = useState<Category | null>(onboarding ? 'dev-repos' : null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [unpaired, setUnpaired] = useState(false), [token, setToken] = useState(''), [legacy, setLegacy] = useState(false);
  const [ready, setReady] = useState(false);
  const [conflict, setConflict] = useState<Snapshot | null>(null);
  const [validation, setValidation] = useState<Partial<Record<Provider, string>>>({});
  const dirty = Boolean(draft && snapshot && !equal(draft, snapshot.settings));
  const dirtyRef = useRef(dirty), snapshotRef = useRef(snapshot), categoryRef = useRef(category);
  useEffect(() => { dirtyRef.current = dirty; snapshotRef.current = snapshot; categoryRef.current = category; }, [dirty, snapshot, category]);
  const accept = (value: Snapshot) => { const normalized = { ...value, settings: { ...value.settings, devRepos: value.settings.devRepos ?? [] } }; setSnapshot(normalized); setDraft(structuredClone(normalized.settings)); setUnpaired(false); setConflict(null); };
  const fail = (cause: unknown) => { if (cause instanceof ApiError && cause.status === 401) setUnpaired(true); setError(cause instanceof Error ? cause.message : 'Could not update settings'); };
  useEffect(() => {
    let active = true;
    navigator.serviceWorker?.register?.("/sw.js").catch(() => {});
    void Promise.resolve().then(() => { if (active) { setCategory(categoryFromLocation() ?? (onboarding ? 'dev-repos' : null)); setReady(true); } });
    request<Snapshot>('/api/settings/local').then(value => { if (active) accept(value); }).catch(cause => { if (active) { if (cause instanceof ApiError && cause.status === 404) setLegacy(true); else fail(cause); } });
    const before = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    const hash = () => { if (!dirtyRef.current || window.confirm('Discard unsaved changes? Cancel to stay.')) { if (snapshotRef.current) setDraft(structuredClone(snapshotRef.current.settings)); setConflict(null); setCategory(categoryFromLocation()); } else history.pushState(null, '', `/settings${categoryRef.current ? '#' + categoryRef.current : ''}`); };
    const link = (event: MouseEvent) => { const anchor = (event.target as Element).closest?.('a[href]'); if (anchor && dirtyRef.current) { if (!window.confirm('Discard unsaved changes? Cancel to stay.')) event.preventDefault(); else dirtyRef.current = false; } };
    window.addEventListener('beforeunload', before); window.addEventListener('popstate', hash); document.addEventListener('click', link, true);
    return () => { active = false; window.removeEventListener('beforeunload', before); window.removeEventListener('popstate', hash); document.removeEventListener('click', link, true); };
  }, [onboarding]);
  function navigate(next: Category | null) {
    if (dirty && !window.confirm('Discard unsaved changes? Cancel to stay.')) return;
    if (snapshot) setDraft(structuredClone(snapshot.settings));
    setError(''); setNotice(''); setConflict(null); setCategory(next); history.pushState(null, '', next ? `/settings#${next}` : '/settings');
  }
  async function save(value = draft, complete = false, overwrite = false): Promise<boolean> {
    if (!value || !snapshot) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      const latest = await request<Snapshot>('/api/settings/local', { method: 'GET' }); latest.settings.devRepos ??= [];
      const keys = (Object.keys(value) as (keyof Settings)[]).filter(key => !equal(value[key], snapshot.settings[key]));
      if (!overwrite && keys.some(key => !equal(latest.settings[key], snapshot.settings[key]))) { setConflict(latest); setError('These settings changed on another device. Your draft is safe. Review the differences before saving.'); return false; }
      const changes = Object.fromEntries(keys.filter(key => key !== 'onboarding').map(key => [key, value[key]]));
      const result = complete
        ? await request<Snapshot>('/api/settings/local', { method: 'PUT', body: JSON.stringify({ expectedRevision: latest.revision, settings: { ...latest.settings, ...changes, onboarding: { completed: true } } }) })
        : await request<Snapshot>('/api/settings/local', { method: 'PATCH', body: JSON.stringify({ expectedRevision: latest.revision, changes }) });
      accept(result); setNotice(complete ? 'Setup complete. You can start a goal.' : 'Saved on this Mac.'); return true;
    } catch (cause) { fail(cause); return false; } finally { setBusy(false); }
  }
  async function validate(provider: Provider) {
    if (!draft) return; setBusy(true); setError('');
    try { const result = await request<{ ready: boolean; reason?: string }>('/api/settings/providers/validate', { method: 'POST', body: JSON.stringify({ provider, command: draft.providers[provider] }) }); setValidation(current => ({ ...current, [provider]: result.ready ? 'Ready for new goals' : result.reason || 'Provider is not ready' })); }
    catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  const changeProvider = (provider: Provider, change: Partial<Command>) => { if (draft) setDraft({ ...draft, providers: { ...draft.providers, [provider]: { ...draft.providers[provider], ...change } } }); setValidation(current => ({ ...current, [provider]: '' })); };
  const setup = onboarding || draft && !draft.onboarding.completed;
  return <main className="local-settings-page"><AppNavigation active="settings" /><header className="settings-header"><p className="eyebrow">COMPANION</p><h1>{setup ? 'Set up Companion' : 'Settings'}</h1><LastUpdateStamp /></header>
    {setup && draft && <aside className="setup-progress"><strong>Get ready for your first goal</strong><p>1. Add repositories → 2. Choose an agent → 3. Review readiness</p><button type="button" onClick={() => navigate('dev-repos')}>Repositories</button> <button type="button" onClick={() => navigate('agents')}>Choose an agent</button> <button type="button" disabled={busy || dirty} onClick={() => void save(draft, true)}>Complete setup</button><a href="/">Continue to sessions</a></aside>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {unpaired ? <form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await request('/api/auth/pair', { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); accept(await request<Snapshot>('/api/settings/local')); } catch (cause) { fail(cause); } finally { setBusy(false); } }}><h2>Pair this device</h2><label>Pairing code<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label><button disabled={busy}>Pair this device</button></form> : <div className={`settings-layout ${category ? 'has-category' : ''}`}>
      <nav className="settings-categories" aria-label="Settings categories">{(Object.keys(categories) as Category[]).map(key => <button key={key} disabled={!ready} aria-current={category === key ? 'page' : undefined} onClick={() => navigate(key)}>{categories[key]}<span aria-hidden="true">›</span></button>)}</nav>
      <div className="settings-content"><button className="settings-back" onClick={() => navigate(null)}>← All settings</button>
        {!category ? <div className="settings-welcome"><h2>Make Companion yours</h2><p>Choose a category to get started.</p></div> : <>
          {category === 'general' && <DeviceSettings />}
          {category === 'notifications' && <section><h2>Notifications</h2><p>Alerts for this browser’s subscription.</p><PushSettings onNotice={setNotice} /></section>}
          {category === 'updates' && <><UpdateSettings /><details><summary>Advanced update options</summary><ReleaseRetentionPanel /></details></>}
          {legacy && category === 'advanced' && <section><h2>Advanced</h2><a href="/?view=apps">Local apps and preview links</a><DeploymentHealth /></section>}
          {legacy && category === 'agents' && <><a href="/?view=usage">View account usage</a><ModelSettingsPanel /></>}
          {!draft && editable[category] && !legacy && <p role="status">{error ? 'Settings could not be loaded.' : 'Loading settings…'}</p>}
          {draft && <>
            {category === 'dev-repos' && <DevRepositories draft={draft} onChange={setDraft} save={save} busy={busy} onError={setError} onNotice={setNotice} />}
            {category === 'agents' && <section><h2>Agents</h2><p>Shared on this Mac. Changes apply to new goals and sessions.</p><a href="/?view=usage">View account usage</a><fieldset disabled={busy}><legend className="sr-only">Agent preferences</legend><label>Default provider<select value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value as Provider })}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
              {(['claude', 'codex'] as const).map(provider => <article key={provider}><h3>{provider === 'claude' ? 'Claude' : 'Codex'}</h3><label>{provider} connection<select value={draft.providers[provider].executable.split('/').at(-1) === 'ccs' ? 'ccs' : 'direct'} onChange={event => changeProvider(provider, event.target.value === 'ccs' ? { executable: 'ccs', args: [provider] } : { executable: provider, args: [] })}><option value="ccs">CCS profile</option><option value="direct">Direct CLI</option></select></label>
                {draft.providers[provider].executable.split('/').at(-1) === 'ccs' && <label>{provider} profile<input value={draft.providers[provider].args[0] ?? ''} onChange={event => changeProvider(provider, { args: [event.target.value] })} /></label>}
                <ModelSelect label={`${provider} model`} provider={provider} value={draft.providers[provider].model} onChange={model => changeProvider(provider, { model })} />
                <details><summary>Advanced command location</summary><label>{provider} executable<input value={draft.providers[provider].executable} onChange={event => changeProvider(provider, { executable: event.target.value })} autoCapitalize="none" spellCheck={false} /></label></details>
                <button type="button" onClick={() => void validate(provider)}>Validate {provider}</button>{validation[provider] && <p role="status">{validation[provider]}</p>}
              </article>)}</fieldset></section>}
            {category === 'advanced' && <section><h2>Advanced</h2><p>Shared on this Mac. Defaults are suitable for most workspaces.</p><a href="/?view=apps">Local apps and preview links</a><fieldset disabled={busy}><legend>Agent capacity</legend>{(['global', 'perGoal', 'planners'] as const).map((key, index) => <label key={key}>{['Background agents', 'Agents per goal', 'Concurrent planners'][index]}<input type="number" min="1" value={draft.execution[key]} onChange={event => setDraft({ ...draft, execution: { ...draft.execution, [key]: Number(event.target.value) } })} /></label>)}</fieldset>
              <details><summary>Time limits and output</summary>{(['ceilingMs', 'idleMs', 'killGraceMs', 'maxOutputBytes'] as const).map((key, index) => <label key={key}>{['Execution timeout (minutes)', 'Idle timeout (seconds)', 'Stop grace period (seconds)', 'Output limit (KiB)'][index]}<input type="number" min="1" value={draft.execution[key] / [60000, 1000, 1000, 1024][index]} onChange={event => setDraft({ ...draft, execution: { ...draft.execution, [key]: Number(event.target.value) * [60000, 1000, 1000, 1024][index] } })} /></label>)}</details>
              <details><summary>Tools and preview ports</summary>{(Object.keys(draft.tools) as (keyof Settings['tools'])[]).map(tool => <label key={tool}>{tool} executable<input value={draft.tools[tool]} onChange={event => setDraft({ ...draft, tools: { ...draft.tools, [tool]: event.target.value } })} /></label>)}{(['portStart', 'portEnd'] as const).map(key => <label key={key}>{key === 'portStart' ? 'First preview port' : 'Last preview port'}<input type="number" min="1024" max="65535" value={draft.previews[key]} onChange={event => setDraft({ ...draft, previews: { ...draft.previews, [key]: Number(event.target.value) } })} /></label>)}</details><DeploymentHealth /></section>}
            {conflict && <section className="settings-conflict"><h3>Review changes</h3>{(editable[category] ?? []).filter(key => !equal(draft[key], conflict.settings[key])).map(key => <details key={key}><summary>{key}: saved and your draft</summary><strong>Saved on this Mac</strong><pre>{JSON.stringify(conflict.settings[key], null, 2)}</pre><strong>Your draft</strong><pre>{JSON.stringify(draft[key], null, 2)}</pre></details>)}<button disabled={busy} onClick={() => { setSnapshot(conflict); setConflict(null); setError(''); }}>Keep draft for another review</button><button disabled={busy} onClick={() => accept(conflict)}>Use saved settings</button></section>}
            {editable[category] && dirty && <footer className="settings-save"><span role="status">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span><button type="button" disabled={busy || !dirty || Boolean(conflict)} onClick={() => void save()}>Save changes</button><button type="button" disabled={busy || !dirty} onClick={() => { setDraft(structuredClone(snapshot!.settings)); setConflict(null); setError(''); }}>Discard changes</button></footer>}
          </>}
        </>}
      </div>
    </div>}
  </main>;
}
