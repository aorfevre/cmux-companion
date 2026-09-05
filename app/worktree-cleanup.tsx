"use client";
import { ReleaseRetentionPanel } from "./release-retention";
import { useState } from "react";
import { request } from "./image-attachments";

type Policy = { enabled: boolean; intervalHours: number; graceDays: number; pruneEnabled: boolean; pruneGraceDays: number };
type Entry = { id: string; path: string; branch: string | null; classification: string; eligible: boolean; reasons: string[]; estimatedBytes: number | null; ignoredOutput?: string[] };
type History = { at: string; estimatedReclaimedBytes?: number; results: { path: string; outcome: string; reason?: string }[] };
type Status = { policy: Policy; history: History[] };
type Preview = { previewId: string; entries: Entry[]; errors: { path: string; error: string }[]; summary: { candidates: number; protected: number; estimatedBytes: number }; prune: { common: string; repositoryPath: string; paths: string[]; eligible: boolean; reason: string }[] };
const bytes = (value: number) => `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;

export function WorktreeCleanupPanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [prune, setPrune] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Cleanup failed"); }
    finally { setBusy(false); }
  };
  const configure = (patch: Partial<Policy>) => action(async () => {
    const next = await request<{ policy: Policy }>("/api/worktree-cleanup", { method: "PATCH", body: JSON.stringify(patch) });
    setStatus((old) => ({ policy: next.policy, history: old?.history || [] }));
    setPreview(null); setSelected([]); setPrune([]);
  });
  return <section className="cleanup-panel" aria-label="Worktree cleanup">
    <button type="button" className="text-button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void action(async () => setStatus(await request<Status>("/api/worktree-cleanup"))); }}>Worktree cleanup</button>
    {open && <div className="cleanup-content">
      <h2>Worktree cleanup</h2>
      <p>Review both development roots and every registered worktree. Removal deletes the checkout and ignored build output, including node_modules, dist, build, .next, coverage, .turbo and Wrangler deployment metadata/logs. Git branches are kept. Untracked files, other ignored files, submodules and active work are protected.</p>
      {status && <fieldset disabled={busy}><legend>Automatic cleanup</legend>
        <label><input type="checkbox" checked={status.policy.enabled} onChange={(event) => { void configure({ enabled: event.target.checked }); }} />Enable automatic development worktree deletion</label>
        <label>Grace period (days)<input aria-label="Grace period (days)" type="number" min="0" max="365" defaultValue={status.policy.graceDays} onBlur={(event) => { if (Number(event.target.value) !== status.policy.graceDays) void configure({ graceDays: Number(event.target.value) }); }} /></label>
        <label>Schedule (hours)<input aria-label="Schedule (hours)" type="number" min="1" max="365" defaultValue={status.policy.intervalHours} onBlur={(event) => { if (Number(event.target.value) !== status.policy.intervalHours) void configure({ intervalHours: Number(event.target.value) }); }} /></label>
        <label><input type="checkbox" checked={status.policy.pruneEnabled} onChange={(event) => { void configure({ pruneEnabled: event.target.checked }); }} />Allow Git to prune expired missing registrations</label>
        <label>Prune grace (days)<input aria-label="Prune grace (days)" type="number" min="1" max="365" defaultValue={status.policy.pruneGraceDays} onBlur={(event) => { if (Number(event.target.value) !== status.policy.pruneGraceDays) void configure({ pruneGraceDays: Number(event.target.value) }); }} /></label>
        <p>{status.policy.enabled ? "Automatic deletion enabled" : "Automatic deletion disabled"}. Verified merged goal PRs qualify immediately. Other merged worktrees use the grace period from their first eligible observation. Managed releases have a separate updater retention policy.</p>
      </fieldset>}
      <button type="button" disabled={busy} onClick={() => { void action(async () => { const result = await request<Preview>("/api/worktree-cleanup/preview", { method: "POST", body: "{}" }); setPreview(result); setSelected([]); setPrune([]); setNotice(""); }); }}>{busy ? "Checking…" : "Preview cleanup"}</button>
      {preview && <>
        <p>{preview.summary.candidates} eligible · {preview.summary.protected} protected · approximately {bytes(preview.summary.estimatedBytes)} reclaimable</p>
        <div className="cleanup-inventory"><table><thead><tr><th>Select</th><th>Worktree</th><th>Policy decision</th><th>Estimated space</th></tr></thead><tbody>{preview.entries.map((entry) => <tr key={entry.id}><td><input type="checkbox" aria-label={`Select ${entry.path}`} disabled={!entry.eligible || busy} checked={selected.includes(entry.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, entry.id] : selected.filter((id) => id !== entry.id))} /></td><td><strong>{entry.branch || entry.classification}</strong><small>{entry.path}</small></td><td>{entry.eligible ? "Eligible" : "Protected"}: {entry.reasons.join("; ")}</td><td>{entry.estimatedBytes === null ? "Unknown" : bytes(entry.estimatedBytes)}</td></tr>)}</tbody></table></div>
        {preview.prune.length > 0 && <fieldset><legend>Stale registrations (Git prune)</legend>{preview.prune.map((entry) => <label key={entry.common}><input type="checkbox" disabled={!entry.eligible || busy} checked={prune.includes(entry.common)} onChange={(event) => setPrune(event.target.checked ? [...prune, entry.common] : prune.filter((id) => id !== entry.common))} />{entry.repositoryPath}: {entry.reason}. {entry.paths.join(", ")}</label>)}</fieldset>}
        {preview.errors.map((entry) => <p role="status" key={entry.path}>{entry.path}: {entry.error}</p>)}
        <p>Run cleanup removes only your selected candidates after checking them again. It also runs selected repository-wide Git prune operations. Physical disk savings may differ on APFS.</p>
        <button type="button" disabled={busy || (!selected.length && !prune.length)} onClick={() => { void action(async () => {
          const result = await request<History>("/api/worktree-cleanup/run", { method: "POST", body: JSON.stringify({ previewId: preview.previewId, ids: selected, prune }) });
          setNotice(`${result.results.filter((entry) => entry.outcome === "removed").length} worktrees removed; ${result.results.filter((entry) => ["failed", "skipped"].includes(entry.outcome)).length} skipped or failed.`);
          setPreview(null); setSelected([]); setPrune([]); setStatus(await request<Status>("/api/worktree-cleanup"));
        }); }}>Run cleanup</button>
      </>}
      {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      <ReleaseRetentionPanel />
      {status && <details><summary>Cleanup history ({status.history.length})</summary>{status.history.map((run) => <div key={run.at}><strong>{new Date(run.at).toLocaleString()} · estimated {bytes(run.estimatedReclaimedBytes || 0)} reclaimed</strong><ul>{run.results.map((entry, index) => <li key={index}>{entry.outcome}: {entry.path}{entry.reason ? ` — ${entry.reason}` : ""}</li>)}</ul></div>)}</details>}
    </div>}
  </section>;
}
