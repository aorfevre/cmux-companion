"use client";
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, request } from '../api-request';

type Project = { id: string; name?: string; devRepoName?: string; github?: string };
type Favorites = { revision: number; ids: string[] };
export function ProjectPicker({ repositories, selected, onSelect, disabled }: { repositories: Project[]; selected: string; onSelect: (id: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false), [all, setAll] = useState(false), [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState<Favorites | null>(null), [saving, setSaving] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null), searchInput = useRef<HTMLInputElement>(null), generation = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && container.current?.contains(event.target as Node)) {
        event.preventDefault(); setOpen(false); trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    searchInput.current?.focus();
    let active = true;
    const version = ++generation.current;
    void request<Favorites>('/api/settings/favorites').then(value => { if (active && version === generation.current) { setFavorites(value); setError(''); } }).catch(() => { if (active && version === generation.current) setError('Favorites could not be loaded. Close and reopen the picker to retry.'); });
    return () => { active = false; };
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const toggle = async (project: Project) => {
    if (!favorites || saving) return;
    ++generation.current;
    setSaving(true); setError(''); setMessage('Saving…');
    try {
      const next = await request<Favorites>(`/api/settings/projects/${encodeURIComponent(project.id)}/favorite`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: favorites.revision, favorite: !favorites.ids.includes(project.id) }) });
      ++generation.current; setFavorites(next); setMessage('Saved on this Mac.'); searchInput.current?.focus();
    } catch (cause) {
      setMessage('');
      if (cause instanceof ApiError && cause.status === 409) {
        try { setFavorites(await request<Favorites>('/api/settings/favorites')); setError('Settings changed. Favorites refreshed; click the star again to retry.'); }
        catch { setFavorites(null); setError('Favorites could not be refreshed. Close and reopen the picker to retry.'); }
      } else setError('Favorite could not be saved. Click the star to retry.');
    } finally { setSaving(false); }
  };
  const sorted = [...repositories].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || (a.devRepoName ?? '').localeCompare(b.devRepoName ?? '') || a.id.localeCompare(b.id));
  const isFavorite = (project: Project) => favorites?.ids.includes(project.id) ?? false;
  const matches = (project: Project) => `${project.name ?? project.id} ${project.devRepoName ?? ''} ${project.github ?? ''}`.toLowerCase().includes(search.trim().toLowerCase());
  const starred = sorted.filter(project => isFavorite(project) && matches(project)), others = sorted.filter(project => !isFavorite(project));
  const groups = [...new Set(others.map(project => project.devRepoName ?? 'Individual projects'))].sort();
  const chosen = repositories.find(project => project.id === selected);
  const row = (project: Project) => <div className="project-picker-row" key={project.id}>
    <button type="button" className="project-choice" aria-label={`${project.name ?? project.id} ${project.devRepoName ?? 'Individual project'}`} aria-pressed={project.id === selected} disabled={disabled} onClick={() => { onSelect(project.id); close(); }}><strong>{project.name ?? project.id}</strong><small>{project.devRepoName ?? 'Individual project'}</small></button>
    <button type="button" className="project-star" aria-label={`${isFavorite(project) ? 'Remove from' : 'Add to'} favorites: ${project.name ?? project.id} (${project.devRepoName ?? 'Individual project'})`} aria-pressed={isFavorite(project)} disabled={disabled || saving || !favorites} onClick={() => void toggle(project)}><span aria-hidden="true">{isFavorite(project) ? '★' : '☆'}</span></button>
  </div>;
  return <div className="project-picker" role="group" aria-label="Project selection" ref={container}>
    <span id={`${id}-label`} className="project-field-label">Project</span>
    <button type="button" className="project-picker-trigger" ref={trigger} aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled} onClick={() => { if (open) close(); else { setAll(false); setSearch(''); setMessage(''); setOpen(true); } }}><span id={`${id}-value`}><strong>{chosen?.name ?? chosen?.id ?? 'Choose a project'}</strong>{' '}{chosen && <small>{chosen.devRepoName ?? 'Individual project'}</small>}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button>
    {open && <section id={`${id}-panel`} aria-label="Choose a project" className="project-picker-panel">
      <label>Search projects<input ref={searchInput} type="search" onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} value={search} onChange={event => setSearch(event.target.value)} placeholder="Project, folder or GitHub owner" /></label>
      <p className="project-context">Favorites are shared across devices connected to this Mac.</p>
      {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      {!favorites && !error && <p role="status">Loading favorites…</p>}
      <div className="project-picker-results">
        <h3>Favorites</h3>{starred.map(row)}
        {!starred.length && <p>{sorted.some(isFavorite) ? 'No matching favorites.' : 'No favorite projects yet. Show all projects and select a star.'}</p>}
        {all && groups.map(group => { const entries = others.filter(project => (project.devRepoName ?? 'Individual projects') === group && matches(project)); return entries.length ? <section key={group} aria-label={group}><h3>{group}</h3>{entries.map(row)}</section> : null; })}
        {all && !others.some(matches) && <p>No other matching projects.</p>}
      </div>
      <button type="button" className="project-show-all" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Hide other projects' : `Show all projects (${others.length})`}</button>
    </section>}
  </div>;
}
