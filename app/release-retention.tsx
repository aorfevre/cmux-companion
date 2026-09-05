"use client";
import { useState } from "react";
import { request } from "./image-attachments";

type Entry = { path: string; target: string; sha: string; eligible: boolean; reasons: string[]; estimatedBytes: number | null };
type Result = { at: string; results: { path: string; outcome: string; reason?: string }[] };
type State = { policy: { enabled: boolean; intervalHours: number }; history: Result[] };
export function ReleaseRetentionPanel() {
  const [state, setState] = useState<State | null>(null);
  const [preview, setPreview] = useState<{ previewId: string; entries: Entry[]; errors: { target: string; error: string }[] } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action = async (work: () => Promise<void>) => { setBusy(true); setError(""); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Release retention unavailable"); } finally { setBusy(false); } };
  const configure = (patch: { enabled?: boolean; intervalHours?: number }) => action(async () => { await request("/api/worktree-cleanup/releases", { method: "PATCH", body: JSON.stringify(patch) }); setState(await request<State>("/api/worktree-cleanup/releases")); setPreview(null); });
  return <details onToggle={(event) => { if (event.currentTarget.open && !state) void action(async () => setState(await request<State>("/api/worktree-cleanup/releases"))); }}>
    <summary>Managed release retention (updater)</summary>
    <p>Retain the current release, rollback target, two additional previous successful releases, and latest failed candidate. Unknown legacy outcomes and foreign locks are protected. Removal deletes the release and its build artifacts.</p>
    {state && <fieldset disabled={busy}><legend>Release schedule</legend><label><input type="checkbox" checked={state.policy.enabled} onChange={(event) => { void configure({ enabled: event.target.checked }); }} />Enable automatic release deletion</label><label>Interval (hours)<input aria-label="Release cleanup interval (hours)" type="number" min="1" max="365" defaultValue={state.policy.intervalHours} onBlur={(event) => { if (Number(event.target.value) !== state.policy.intervalHours) void configure({ intervalHours: Number(event.target.value) }); }} /></label></fieldset>}
    <button type="button" disabled={busy} onClick={() => { void action(async () => { setPreview(await request("/api/worktree-cleanup/releases/preview", { method: "POST", body: "{}" })); setSelected([]); }); }}>Preview release retention</button>
    {preview && <><ul>{preview.entries.map((entry) => <li key={entry.path}><label><input type="checkbox" disabled={busy || !entry.eligible} checked={selected.includes(entry.path)} aria-label={`Select release ${entry.sha}`} onChange={(event) => setSelected(event.target.checked ? [...selected, entry.path] : selected.filter((path) => path !== entry.path))} />{entry.target} {entry.sha.slice(0, 12)}: {entry.reasons.join("; ")}{entry.estimatedBytes === null ? "" : ` · ${(entry.estimatedBytes / 1024 ** 3).toFixed(2)} GB`}</label><small>{entry.path}</small></li>)}</ul>{preview.errors.map((item) => <p key={item.target}>{item.target}: {item.error}</p>)}<button type="button" disabled={busy || !selected.length} onClick={() => { void action(async () => { await request("/api/worktree-cleanup/releases/run", { method: "POST", body: JSON.stringify({ previewId: preview.previewId, ids: selected }) }); setState(await request<State>("/api/worktree-cleanup/releases")); setPreview(null); setSelected([]); }); }}>Run release cleanup</button></>}
    {error && <p role="alert">{error}</p>}
    {state && <details><summary>Release cleanup history ({state.history.length})</summary>{state.history.map((run) => <div key={run.at}>{run.at}<ul>{run.results.map((entry) => <li key={entry.path}>{entry.outcome}: {entry.path} {entry.reason}</li>)}</ul></div>)}</details>}
  </details>;
}
