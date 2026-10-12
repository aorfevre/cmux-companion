'use client';
import { useEffect, useState } from 'react';
import type { GoalChanges as Changes } from '../../server/orchestration/types';
import { useOwnedRead } from '../use-owned-read';

export function GoalChanges({ goalId, headSha }: { goalId: string; headSha: string }) {
  const [open, setOpen] = useState(false);
  const { value, error, refresh } = useOwnedRead<Changes | null>(open ? `/api/orchestration/goals/${encodeURIComponent(goalId)}/changes?head=${encodeURIComponent(headSha)}` : null, null);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  const evidence = value?.headSha === headSha ? value : null;
  return <section aria-label="Changed files and diff" className="mission-check-evidence">
    <button aria-expanded={open} onClick={() => setOpen(current => !current)}>{open ? 'Hide changes' : 'Inspect changes'}</button>
    {open && <>
      {error && <p role="alert">{error} <button onClick={() => void refresh(true)}>Retry changes</button></p>}
      {!evidence && !error && <p>Loading changes…</p>}
      {evidence && <>
        <p>{evidence.fileCount} changed file{evidence.fileCount === 1 ? '' : 's'} · <code>{evidence.baseSha.slice(0, 12)}</code> → <code>{evidence.headSha.slice(0, 12)}</code></p>
        <ul>{evidence.files.map(file => <li key={file.path}><code>{file.path}</code> · {({ A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed' } as Record<string, string>)[file.status] || file.status}</li>)}</ul>
        {evidence.filesTruncated && <p>Showing the first 1,000 files.</p>}
        {evidence.patchUnavailable ? <p role="alert">The patch could not be loaded; inspect this commit locally before approving publication.</p> : <pre aria-label="Integrated diff">{evidence.patch || 'No changes from the goal base.'}</pre>}
        {evidence.patchTruncated && <p>Diff shortened to 256 KiB; inspect the full commit locally before approving publication.</p>}
      </>}
    </>}
  </section>;
}
