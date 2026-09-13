'use client';
import { useRef, useState } from 'react';
import { FolderPicker } from './folder-picker';
import { request } from '../api-request';
import type { Check, DevRepo, Project, Settings } from './settings-panel';
type Inspected = Pick<Project, 'name' | 'path' | 'github' | 'remote'> & { suggestedChecks?: Check[]; error?: string };
type Scan = { repositories: Inspected[]; partial: boolean; reason: string | null };
export function DevRepositories({ draft, onChange, save, busy, onError, onNotice }: { draft: Settings; onChange: (value: Settings) => void; save: (value: Settings) => Promise<boolean>; busy: boolean; onError: (message: string) => void; onNotice: (message: string) => void }) {
  const [adding, setAdding] = useState(false), [name, setName] = useState(''), [path, setPath] = useState(''), [validated, setValidated] = useState<string | null>(null);
  const [working, setWorking] = useState(false), [scans, setScans] = useState<Record<string, Scan>>({}), [selected, setSelected] = useState<string[]>([]);
  const [openGroup, setOpenGroup] = useState<string | null>(null), [editing, setEditing] = useState<string | null>(null), [search, setSearch] = useState('');
  const [suggestions, setSuggestions] = useState<Record<string, Check[]>>({}), [individual, setIndividual] = useState(false), [individualPath, setIndividualPath] = useState('');
  const [picker, setPicker] = useState<'dev' | 'individual' | null>(null), [lastFolder, setLastFolder] = useState<string>(), [gitFolder, setGitFolder] = useState<string | null>(null);
  const savingRoot = useRef(false);
  const roots = draft.devRepos ?? [], disabled = busy || working;
  const failure = (cause: unknown) => onError(cause instanceof Error ? cause.message : 'Could not inspect this directory');
  async function scan(root: DevRepo) {
    setWorking(true); onError(''); setOpenGroup(root.id);
    try { const result = await request<Scan>(`/api/settings/dev-repos/${encodeURIComponent(root.id)}/scan`, { method: 'POST', body: '{}' }); setScans(current => ({ ...current, [root.id]: result })); }
    catch (cause) { failure(cause); } finally { setWorking(false); }
  }
  async function addRoot() {
    if (!validated || savingRoot.current) return;
    savingRoot.current = true;
    try {
      const root = { id: crypto.randomUUID(), name: name.trim(), path: validated };
      if (await save({ ...draft, devRepos: [...roots, root] })) { setAdding(false); setName(''); setPath(''); setValidated(null); await scan(root); }
    } finally { savingRoot.current = false; }
  }
  const updateProject = (id: string, change: Partial<Project>) => onChange({ ...draft, projects: draft.projects.map(project => project.id === id ? { ...project, ...change } : project) });
  async function openProject(project: Project) {
    setEditing(project.id); onError('');
    try { const result = await request<Inspected>('/api/settings/projects/inspect', { method: 'POST', body: JSON.stringify({ path: project.path }) }); setSuggestions(current => ({ ...current, [project.id]: result.suggestedChecks ?? [] })); }
    catch (cause) { failure(cause); }
  }
  async function addIndividual() {
    setWorking(true); onError('');
    try {
      const result = await request<Inspected>('/api/settings/projects/inspect', { method: 'POST', body: JSON.stringify({ path: individualPath }) });
      if (draft.projects.some(project => project.path === result.path)) throw new Error('This repository is already added.');
      const project: Project = { id: crypto.randomUUID(), name: result.name, path: result.path, github: result.github, remote: result.remote, enabled: true, checks: [] };
      onChange({ ...draft, projects: [...draft.projects, project] }); setEditing(project.id); setSuggestions(current => ({ ...current, [project.id]: result.suggestedChecks ?? [] })); setIndividualPath(''); setIndividual(false); onNotice('Repository inspected. Review its destination and checks, then save.');
    } catch (cause) { failure(cause); } finally { setWorking(false); }
  }
  async function chooseFolder(folder: { name: string; path: string }, signal?: AbortSignal) {
    if (picker === 'individual') { setIndividualPath(folder.path); setLastFolder(folder.path); setPicker(null); return; }
    let value: { path: string };
    try { value = await request<{ path: string }>('/api/settings/dev-repos/inspect', { method: 'POST', body: JSON.stringify({ path: folder.path }), signal }); }
    catch (cause) {
      if (signal?.aborted) return;
      if (cause instanceof Error && cause.message.includes('Git root')) { setGitFolder(folder.path); setLastFolder(folder.path); setPicker(null); return; }
      throw cause;
    }
    if (signal?.aborted) return;
    const baseName = folder.name.trim().slice(0, 150) || 'Dev repo';
    let suggested = baseName, suffix = 2;
    while (roots.some(root => root.name.toLowerCase() === suggested.toLowerCase())) suggested = `${baseName} ${suffix++}`;
    setName(suggested); setPath(value.path); setValidated(value.path); setGitFolder(null); setLastFolder(value.path); setPicker(null);
  }
  const project = draft.projects.find(entry => entry.id === editing);
  const matching = (entry: Project | Inspected, root?: DevRepo) => `${root?.name ?? ''} ${entry.name} ${entry.github ?? ''}`.toLowerCase().includes(search.toLowerCase());
  return <section><header className="settings-section-heading"><div><h2>Dev repos</h2><p>Folders containing Git repositories on your connected Mac.</p></div><button disabled={disabled} onClick={() => setAdding(!adding)}>Add Dev repo</button></header>
    {picker && <FolderPicker initialPath={lastFolder} onChoose={chooseFolder} onCancel={last => { if (last) setLastFolder(last); setPicker(null); }} />}
    {adding && <div className="settings-editor"><h3>Add a development folder</h3><p>Choose a folder containing your Git repositories. Its name fills in automatically.</p>
      <button disabled={disabled} onClick={() => setPicker('dev')}>{validated ? 'Choose another folder' : 'Choose folder'}</button>
      {gitFolder && <div role="status"><p>This is one repository. Add it individually, or choose its parent folder to group repositories.</p><button disabled={disabled} onClick={() => { setIndividualPath(gitFolder); setIndividual(true); setAdding(false); setGitFolder(null); }}>Add this individual repository</button></div>}
      <details><summary>Enter a path (advanced)</summary><label>Directory on this Mac<input placeholder="~/Developers" value={path} onChange={event => { setPath(event.target.value); setValidated(null); }} autoCapitalize="none" spellCheck={false} /></label>
        <button disabled={disabled || !path.trim()} onClick={() => { setWorking(true); onError(''); void chooseFolder({ name: path.split('/').filter(Boolean).at(-1) || 'Dev repo', path }).catch(failure).finally(() => setWorking(false)); }}>Validate directory</button>
      </details>
      {validated && <><p>Selected folder: <span className="settings-path">{validated}</span></p><label>Dev repo name<input value={name} onChange={event => setName(event.target.value)} /></label><p>You can rename this folder in Companion without changing it on your Mac.</p><button disabled={disabled || !name.trim()} onClick={() => void addRoot()}>Save Dev repo and discover</button></>}
      <button disabled={disabled} onClick={() => { setAdding(false); setValidated(null); setGitFolder(null); }}>Cancel</button>
    </div>}
    <label>Search repositories<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Folder, repository or GitHub owner" /></label>
    {!roots.length && <div className="settings-empty"><h3>Your repositories, organized</h3><p>Add a folder like karven or rekord, then choose which repositories Companion can use.</p></div>}
    {roots.map(root => <article className="dev-repo" key={root.id}><div className="settings-section-heading"><div><h3>{root.name}</h3><p className="settings-path">{root.path}</p></div><button disabled={disabled} onClick={() => void scan(root)}>{working && openGroup === root.id ? 'Discovering…' : 'Open / Refresh'}</button></div>
      <details><summary>Manage {root.name}</summary><label>Rename {root.name}<input value={root.name} onChange={event => onChange({ ...draft, devRepos: roots.map(entry => entry.id === root.id ? { ...entry, name: event.target.value } : entry) })} /></label><button disabled={disabled} onClick={() => { if (window.confirm(`Remove ${root.name}? Added repositories move to Individual repositories. Files and goals stay intact.`)) onChange({ ...draft, devRepos: roots.filter(entry => entry.id !== root.id), projects: draft.projects.map(entry => entry.devRepoId === root.id ? { ...entry, devRepoId: undefined } : entry) }); }}>Remove Dev repo</button></details>
      {draft.projects.filter(entry => entry.devRepoId === root.id && matching(entry, root)).map(entry => <RepositoryRow key={entry.id} project={entry} open={() => void openProject(entry)} />)}
      {openGroup === root.id && scans[root.id] && <div className="discovered-repos">{scans[root.id].partial && <p role="status">{scans[root.id].reason}</p>}{!scans[root.id].repositories.length && <p>No immediate-child Git repositories found. Nested folders and linked worktrees are excluded.</p>}
        {scans[root.id].repositories.filter(entry => matching(entry, root)).map(entry => {
          const added = draft.projects.some(project => project.path === entry.path);
          return <label className="discovery-row" key={entry.path} htmlFor={`discover-${root.id}-${entry.name}`}><input id={`discover-${root.id}-${entry.name}`} type="checkbox" disabled={disabled || added || Boolean(entry.error)} checked={added || selected.includes(entry.path)} onChange={event => setSelected(current => event.target.checked ? [...current, entry.path] : current.filter(path => path !== entry.path))} /><span>{entry.name}<span className="setting-description">{entry.error ? 'Needs attention: ' + entry.error : added ? 'Added' : entry.github ?? 'Available · GitHub destination needed'}</span></span></label>;
        })}
        <button disabled={disabled} onClick={() => setSelected(current => [...new Set([...current, ...scans[root.id].repositories.filter(entry => !entry.error && matching(entry, root) && !draft.projects.some(project => project.path === entry.path)).map(entry => entry.path)])])}>Select all available</button>
        <button disabled={disabled || !scans[root.id].repositories.some(entry => selected.includes(entry.path) && !draft.projects.some(project => project.path === entry.path))} onClick={() => {
          const entries = scans[root.id].repositories.filter(entry => !entry.error && selected.includes(entry.path) && !draft.projects.some(project => project.path === entry.path));
          const projects = entries.map(entry => ({ id: crypto.randomUUID(), name: entry.name, path: entry.path, github: entry.github, remote: entry.remote, devRepoId: root.id, enabled: true, checks: [] }));
          void save({ ...draft, projects: [...draft.projects, ...projects] }).then(saved => { if (saved) { setSelected([]); onNotice('Selected repositories added. Configure checks to enable goals.'); } });
        }}>Add selected repositories</button>
      </div>}
    </article>)}
    <article><div className="settings-section-heading"><h3>Individual repositories</h3><button disabled={disabled} onClick={() => setIndividual(!individual)}>Add individual repository</button></div>
      {individual && <div className="settings-editor"><button disabled={disabled} onClick={() => setPicker('individual')}>Choose repository folder</button>{individualPath && <p className="settings-path">{individualPath}</p>}<details><summary>Enter a repository path (advanced)</summary><label>Project directory<input value={individualPath} placeholder="~/Developers/my-repository" onChange={event => setIndividualPath(event.target.value)} autoCapitalize="none" spellCheck={false} /></label></details><button disabled={disabled || !individualPath.trim()} onClick={() => void addIndividual()}>Validate and add project</button><button disabled={disabled} onClick={() => setIndividual(false)}>Cancel</button></div>}
      {draft.projects.filter(entry => !entry.devRepoId && matching(entry)).map(entry => <RepositoryRow key={entry.id} project={entry} open={() => void openProject(entry)} />)}
    </article>
    {project && <article className="settings-editor" aria-label="Repository details"><h3>{project.name}</h3><p className="settings-path">{project.path}</p><fieldset disabled={disabled}><legend className="sr-only">Repository preferences</legend>
      <label>Repository name<input value={project.name} onChange={event => updateProject(project.id, { name: event.target.value })} /></label>
      <label className="preference-row"><span>Enabled for new work</span><input type="checkbox" role="switch" checked={project.enabled} onChange={event => updateProject(project.id, { enabled: event.target.checked })} /></label>
      <label>GitHub destination<input placeholder="owner/repository" value={project.github ?? ''} onChange={event => updateProject(project.id, { github: event.target.value || null })} /></label>
      <label>Git remote<input value={project.remote ?? ''} onChange={event => updateProject(project.id, { remote: event.target.value || null })} placeholder="git@github.com:owner/repository.git" /></label>
      <h4>Approved checks</h4><p>Choose commands agents may run. Suggestions read package.json; nothing runs until you start work.</p>
      {(suggestions[project.id] ?? []).map(check => { const exists = project.checks.some(entry => entry.executable === check.executable && JSON.stringify(entry.args) === JSON.stringify(check.args)); return <label className="discovery-row" key={check.id} htmlFor={`check-${check.id}`}><input id={`check-${check.id}`} type="checkbox" checked={exists} onChange={event => updateProject(project.id, { checks: event.target.checked ? [...project.checks, { id: `check-${crypto.randomUUID()}`, executable: check.executable, args: check.args }] : project.checks.filter(entry => !(entry.executable === check.executable && JSON.stringify(entry.args) === JSON.stringify(check.args))) })} /><span>{[check.executable, ...check.args].join(' ')}<code className="setting-description">{check.script}</code></span></label>; })}
      {!(suggestions[project.id] ?? []).length && <p>No npm scripts suggested. Add a check in Advanced verification.</p>}
      {project.checks.length > 0 && <ul>{project.checks.map(check => <li key={check.id}><code>{[check.executable, ...check.args].join(' ')}</code></li>)}</ul>}
      <details><summary>Advanced verification</summary>{project.checks.map((check, index) => <div key={index} className="settings-command">{(['id', 'executable'] as const).map(key => <label key={key}>{key === 'id' ? 'Check name' : 'Check executable'}<input value={check[key]} onChange={event => updateProject(project.id, { checks: project.checks.map((entry, position) => position === index ? { ...entry, [key]: event.target.value } : entry) })} /></label>)}<label>Check arguments (one per line)<textarea value={check.args.join('\n')} onChange={event => updateProject(project.id, { checks: project.checks.map((entry, position) => position === index ? { ...entry, args: event.target.value ? event.target.value.split('\n') : [] } : entry) })} /></label><button onClick={() => updateProject(project.id, { checks: project.checks.filter((_, position) => index !== position) })}>Remove check</button></div>)}<button onClick={() => updateProject(project.id, { checks: [...project.checks, { id: `check-${crypto.randomUUID()}`, executable: 'npm', args: ['test'] }] })}>Add verification command</button></details>
    </fieldset></article>}
  </section>;
}
function RepositoryRow({ project, open }: { project: Project; open: () => void }) { return <button className="repository-row" onClick={open}><span><strong>{project.name}</strong><span className="setting-description">{project.github ?? 'No GitHub destination'}</span></span><span className="status-badge">{!project.enabled ? 'Disabled' : project.github && project.remote && project.checks.length ? 'Repository configured' : 'Configure for goals'} ›</span></button>; }
