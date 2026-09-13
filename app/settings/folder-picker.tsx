'use client';
import { useEffect, useRef, useState } from 'react';
import { request } from '../api-request';
type Folder = { name: string; path: string };
export type FolderListing = { macName: string; path: string; name: string; parent: string | null; roots: Folder[]; breadcrumbs: Folder[]; folders: Folder[]; partial: boolean; examined: number };
export function FolderPicker({ initialPath, onChoose, onCancel }: { initialPath?: string; onChoose: (folder: Folder, signal: AbortSignal) => Promise<void>; onCancel: (path?: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), sequence = useRef(0), selecting = useRef(false);
  const selectionRequest = useRef<AbortController | null>(null);
  const [path, setPath] = useState(initialPath), [filter, setFilter] = useState(''), [retry, setRetry] = useState(0);
  const [listing, setListing] = useState<FolderListing | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const pendingSelection = selectionRequest;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { pendingSelection.current?.abort(); previous?.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(), version = ++sequence.current;
    void request<FolderListing>('/api/settings/folders', { method: 'POST', body: JSON.stringify({ ...(path ? { path } : {}), filter }), signal: controller.signal }).then(value => {
      if (version === sequence.current && !controller.signal.aborted) { setListing(value); setError(''); }
    }).catch(cause => { if (version === sequence.current && !controller.signal.aborted) setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : 'Cannot reach your Mac. Check the connection and retry.'); })
      .finally(() => { if (version === sequence.current && !controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [path, filter, retry]);
  function navigate(next?: string) { setLoading(true); setError(''); setPath(next); setFilter(''); setRetry(value => value + 1); }
  function cancel() { selectionRequest.current?.abort(); sequence.current++; onCancel(listing?.path); }
  async function choose() {
    if (!listing || loading || selecting.current) return;
    selecting.current = true; setBusy(true); setError('');
    const version = sequence.current;
    const controller = new AbortController(); selectionRequest.current = controller;
    try { await onChoose({ name: listing.name, path: listing.path }, controller.signal); }
    catch (cause) { if (sequence.current === version) setError(cause instanceof Error ? cause.message : 'Cannot use this folder. Choose another folder.'); }
    finally { selecting.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="folder-picker" aria-labelledby="folder-picker-title" onCancel={event => { event.preventDefault(); cancel(); }}>
    <header><h2 id="folder-picker-title">Choose a folder</h2><p>Folders on {listing?.macName || 'your connected Mac'}. Open a folder, then choose Use this folder.</p></header>
    <div className="folder-picker-body"><fieldset disabled={busy}><legend className="sr-only">Folder explorer</legend>
      <nav aria-label="Folder locations"><button type="button" onClick={() => navigate()}>Home</button>{listing?.roots.filter(root => root.name !== 'Home').map(root => <button type="button" key={root.path} onClick={() => navigate(root.path)}>{root.name}</button>)}</nav>
      <nav aria-label="Folder breadcrumbs">{listing?.breadcrumbs.slice(1).map(folder => <button type="button" key={folder.path} aria-current={folder.path === listing.path ? 'location' : undefined} onClick={() => navigate(folder.path)}>{folder.name}</button>)}</nav>
      <button type="button" disabled={!listing?.parent} onClick={() => navigate(listing?.parent ?? undefined)}>↑ Up one folder</button>
      <label>Filter folder names<input type="search" value={filter} onChange={event => { setLoading(true); setFilter(event.target.value); }} /></label>
      {loading ? <p role="status">Opening folder…</p> : error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => { setLoading(true); setRetry(value => value + 1); }}>Retry</button><button type="button" onClick={() => navigate(listing?.parent ?? undefined)}>Go back</button></div> : <>
        <p className="settings-path">{listing?.breadcrumbs.map(folder => folder.name).join(' / ')}</p>
        <div className="folder-list" aria-label="Folders">{listing?.folders.map(folder => <button type="button" key={folder.path} onClick={() => navigate(folder.path)}><span aria-hidden="true">▱</span><span>{folder.name}</span><span aria-hidden="true">›</span></button>)}</div>
        {!listing?.folders.length && <p>{filter ? 'No matching folders in these results. Clear the filter or go back.' : 'No visible subfolders. You can use this folder or go back.'}</p>}
        {listing?.partial && <p role="status">Showing partial results after checking {listing.examined} entries. Filter these results or choose another folder; more folders may exist on the Mac.</p>}
      </>}
    </fieldset></div>
    <footer><button type="button" onClick={cancel}>Cancel</button><button type="button" className="primary-button" disabled={loading || busy || !listing || Boolean(error)} onClick={() => void choose()}>{busy ? 'Checking folder…' : 'Use this folder'}</button></footer>
  </dialog>;
}
