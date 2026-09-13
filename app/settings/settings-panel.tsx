'use client';
/* Settings navigation crosses the monitoring/orchestration page boundaries. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useState } from 'react';
import { ApiError, request } from '../api-request';
import { UpdateSettings } from '../updates';
import { ModelSelect } from '../model-settings';

type Provider = 'claude' | 'codex';
type Command = { executable: string; args: string[]; model: string };
type Check = { id: string; executable: string; args: string[] };
type Project = { id: string; name: string; path: string; enabled: boolean; github: string | null; remote: string | null; checks: Check[] };
export type Settings = {
  projects: Project[]; providers: Record<Provider, Command>; provider: Provider;
  tools: { cmux: string; tailscale: string; chrome: string };
  execution: { global: number; perGoal: number; planners: number; ceilingMs: number; idleMs: number; maxOutputBytes: number; killGraceMs: number };
  previews: { portStart: number; portEnd: number }; onboarding: { completed: boolean };
};
type Snapshot = { revision: number; settings: Settings; imported: boolean };
const executionLabels = { global: 'Background agents', perGoal: 'Agents per goal', planners: 'Concurrent planners', ceilingMs: 'Execution timeout (ms)', idleMs: 'Idle timeout (ms)', maxOutputBytes: 'Output limit (bytes)', killGraceMs: 'Stop grace period (ms)' };

export function LocalSettingsPanel({ onboarding = false }: { onboarding?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [draft, setDraft] = useState<Settings | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [unpaired, setUnpaired] = useState(false), [token, setToken] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [validation, setValidation] = useState<Partial<Record<Provider, string>>>({});
  const accept = (value: Snapshot) => { setSnapshot(value); setDraft(value.settings); setUnpaired(false); };
  const fail = (cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) setUnpaired(true);
    setError(cause instanceof Error ? cause.message : 'Could not update settings');
  };
  useEffect(() => {
    let active = true;
    request<Snapshot>('/api/settings/local').then(value => { if (active) accept(value); }).catch(cause => { if (active) fail(cause); });
    return () => { active = false; };
  }, []);
  async function reload() {
    setBusy(true); setError(''); setNotice('');
    try { accept(await request<Snapshot>('/api/settings/local', { method: 'GET' })); } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function pair(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await request('/api/auth/pair', { method: 'POST', body: JSON.stringify({ token }) }); setToken(''); await reload(); }
    catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function save(complete = false) {
    if (!draft || !snapshot) return;
    setBusy(true); setError(''); setNotice('');
    try {
      accept(await request<Snapshot>('/api/settings/local', { method: 'PUT', body: JSON.stringify({ expectedRevision: snapshot.revision, settings: { ...draft, onboarding: { completed: complete || draft.onboarding.completed } } }) }));
      setNotice(complete ? 'Setup complete. You can start a goal.' : 'Settings saved on this Mac.');
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function addProject() {
    if (!draft) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const project = await request<Pick<Project, 'path' | 'name' | 'github' | 'remote'>>('/api/settings/projects/inspect', { method: 'POST', body: JSON.stringify({ path: projectPath }) });
      if (draft.projects.some(entry => entry.path === project.path)) throw new Error('This project is already configured.');
      setDraft({ ...draft, projects: [...draft.projects, { ...project, id: crypto.randomUUID(), enabled: true, checks: [] }] }); setProjectPath('');
      setNotice('Project validated. Review its suggested destination and save settings.');
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  async function validate(provider: Provider) {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      const result = await request<{ ready: boolean; reason?: string }>('/api/settings/providers/validate', { method: 'POST', body: JSON.stringify({ provider, command: draft.providers[provider] }) });
      setValidation(current => ({ ...current, [provider]: result.ready ? 'Ready for new goals' : result.reason || 'Provider is not ready' }));
    } catch (cause) { fail(cause); } finally { setBusy(false); }
  }
  const updateProject = (id: string, change: Partial<Project>) => { if (draft) setDraft({ ...draft, projects: draft.projects.map(project => project.id === id ? { ...project, ...change } : project) }); };
  const updateProvider = (provider: Provider, change: Partial<Command>) => {
    if (draft) setDraft({ ...draft, providers: { ...draft.providers, [provider]: { ...draft.providers[provider], ...change } } });
    setValidation(current => ({ ...current, [provider]: '' }));
  };
  const setup = onboarding || draft && !draft.onboarding.completed;
  return <main className="local-settings-page">
    <nav aria-label="Settings navigation"><a href="/">Sessions</a><a href="/orchestration">Goals</a></nav>
    <p className="eyebrow">THIS MAC</p><h1>{setup ? 'Set up Companion' : 'Projects and settings'}</h1>
    <p>Connect your projects and choose how your agents run. Settings stay on this Mac and are shared by your paired devices.</p>
    {error && <div role="alert"><p>{error}</p>{!unpaired && <button disabled={busy} onClick={() => void reload()}>Reload saved settings</button>}</div>}
    {notice && <p role="status">{notice}</p>}
    {unpaired ? <form onSubmit={pair}><label>Pairing code<input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required /></label><button disabled={busy} type="submit">Pair this device</button></form>
      : !draft ? <p role="status">{error ? 'Settings could not be loaded.' : 'Loading settings…'}</p>
        : <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy}>
            <legend className="sr-only">Local configuration</legend>
            <section><h2>1. Projects</h2><p>Add the Git repository directory on your Mac. Disabling a project preserves its goals and files.</p>
              <label>Project directory<input placeholder="/absolute/path/to/project" value={projectPath} onChange={event => setProjectPath(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
              <button type="button" onClick={() => void addProject()} disabled={!projectPath.trim()}>Validate and add project</button>
              {!draft.projects.length && <p>No projects configured yet.</p>}
              {draft.projects.map(project => <article key={project.id} className="settings-project">
                <label>Project name<input value={project.name} onChange={event => updateProject(project.id, { name: event.target.value })} required /></label><p className="settings-path">{project.path}</p>
                <label className="settings-check"><input type="checkbox" checked={project.enabled} onChange={event => updateProject(project.id, { enabled: event.target.checked })} />Enabled for new goals</label>
                <label>GitHub destination<input placeholder="owner/repository" value={project.github ?? ''} onChange={event => updateProject(project.id, { github: event.target.value || null })} /></label>
                <label>Git remote<input placeholder="git@github.com:owner/repository.git" value={project.remote ?? ''} onChange={event => updateProject(project.id, { remote: event.target.value || null })} /></label>
                <h3>Verification commands</h3><p>Approve the checks agents can request for this project. Starting a goal requires a configured GitHub destination, remote and checks.</p>
                {project.checks.map((check, index) => <div className="settings-command" key={index}>
                  <label>Check name<input value={check.id} onChange={event => updateProject(project.id, { checks: project.checks.map((entry, position) => position === index ? { ...entry, id: event.target.value } : entry) })} required /></label>
                  <label>Check executable<input value={check.executable} onChange={event => updateProject(project.id, { checks: project.checks.map((entry, position) => position === index ? { ...entry, executable: event.target.value } : entry) })} required /></label>
                  <label>Check arguments (one per line)<textarea value={check.args.join('\n')} onChange={event => updateProject(project.id, { checks: project.checks.map((entry, position) => position === index ? { ...entry, args: event.target.value ? event.target.value.split('\n') : [] } : entry) })} /></label>
                  <button type="button" onClick={() => updateProject(project.id, { checks: project.checks.filter((_, position) => position !== index) })}>Remove check</button>
                </div>)}
                <button type="button" onClick={() => updateProject(project.id, { checks: [...project.checks, { id: `check-${project.checks.length + 1}`, executable: 'npm', args: ['test'] }] })}>Add verification command</button>
              </article>)}
            </section>
            <section><h2>2. Claude and Codex</h2><p>Use CCS or the provider’s direct command. Companion supplies the execution and permission options. Changes apply to new goals and sessions.</p>
              <label>Default provider<select value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value as Provider })}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
              {(['claude', 'codex'] as const).map(provider => <article key={provider}><h3>{provider === 'claude' ? 'Claude' : 'Codex'}</h3>
                <label>{provider} executable<input value={draft.providers[provider].executable} onChange={event => updateProvider(provider, { executable: event.target.value })} required autoCapitalize="none" spellCheck={false} /></label>
                <label>{provider} arguments (one per line)<textarea value={draft.providers[provider].args.join('\n')} onChange={event => updateProvider(provider, { args: event.target.value ? event.target.value.split('\n') : [] })} /></label>
                <ModelSelect label={`${provider} model`} provider={provider} value={draft.providers[provider].model} onChange={model => updateProvider(provider, { model })} />
                <p className="settings-path" aria-label={`${provider} command preview`}>{[draft.providers[provider].executable, ...draft.providers[provider].args].map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ')}</p>
                <button type="button" onClick={() => void validate(provider)}>Validate {provider}</button>{validation[provider] && <p role="status">{validation[provider]}</p>}
              </article>)}
            </section>
            <section><h2>3. Tools on this Mac</h2><p>Use an installed command name or absolute executable path. Missing tools can be configured later.</p>
              {(Object.keys(draft.tools) as (keyof Settings['tools'])[]).map(tool => <label key={tool}>{tool} executable<input value={draft.tools[tool]} onChange={event => setDraft({ ...draft, tools: { ...draft.tools, [tool]: event.target.value } })} required /></label>)}
            </section>
            <section><h2>Execution and previews</h2>
              {(Object.keys(executionLabels) as (keyof Settings['execution'])[]).map(key => <label key={key}>{executionLabels[key]}<input type="number" min="1" value={Number.isFinite(draft.execution[key]) ? draft.execution[key] : ''} onChange={event => setDraft({ ...draft, execution: { ...draft.execution, [key]: event.target.value === '' ? NaN : Number(event.target.value) } })} required /></label>)}
              {(['portStart', 'portEnd'] as const).map(key => <label key={key}>{key === 'portStart' ? 'First preview port' : 'Last preview port'}<input type="number" min="1024" max="65535" value={Number.isFinite(draft.previews[key]) ? draft.previews[key] : ''} onChange={event => setDraft({ ...draft, previews: { ...draft.previews, [key]: event.target.value === '' ? NaN : Number(event.target.value) } })} required /></label>)}
            </section>
            <div className="settings-save"><button type="submit">{busy ? 'Saving…' : 'Save settings'}</button>{setup && <button type="button" onClick={() => void save(true)}>Complete setup</button>}<a href="/orchestration">Go to goals</a></div>
          </fieldset>
        </form>}
  {draft && !unpaired && <UpdateSettings />}
  </main>;
}
