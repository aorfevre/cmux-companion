'use client';
import { useEffect, useState } from 'react';
import { useOwnedRead } from '../use-owned-read';
type Evidence = { checkId: string; headSha: string; code: string; stdout: string; stderr: string; truncated: boolean };
export function CheckEvidence({ goalId, artifactId }: { goalId: string; artifactId: string }) {
  const [open, setOpen] = useState(false);
  const { value, error, refresh } = useOwnedRead<Evidence | null>(open ? `/api/orchestration/goals/${encodeURIComponent(goalId)}/checks/${encodeURIComponent(artifactId)}` : null, null);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  return <div className="mission-check-evidence"><button aria-expanded={open} onClick={() => setOpen(current => !current)}>{open ? 'Hide check output' : 'Inspect check output'}</button>
    {open && <>{error && <p role="alert">{error} <button onClick={() => void refresh(true)}>Retry evidence</button></p>}{!value && !error && <p>Loading check output…</p>}{value && <><p>Head <code>{value.headSha}</code>{value.code && ` · ${value.code}`}</p><pre aria-label="Check output">{[value.stdout, value.stderr].filter(Boolean).join('\n') || 'No output recorded.'}</pre>{value.truncated && <p>Output shortened to 256 KiB per stream.</p>}</>}</>}
  </div>;
}
