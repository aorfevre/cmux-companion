"use client";
import { useCallback, useEffect, useState } from "react";
import { request } from "./api-request";
import { WorktreeCleanupPanel } from "./worktree-cleanup";

type Entry = { id: string; path: string; repository?: string; branch: string | null; classification: string; eligible: boolean; reasons: string[]; estimatedBytes: number | null };
type Preview = { previewId: string; generatedAt: string; roots: string[]; repositoryCount: number; entries: Entry[]; errors: { path: string; error: string }[]; summary: { candidates: number; protected: number; estimatedBytes: number } };
type Result = { results: { path: string; outcome: string; reason?: string }[] };
const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

export function WorktreeOverview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<"scan" | "run" | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const scan = useCallback(async () => {
    setBusy("scan"); setError(""); setConfirm(false); setPreview(null);
    try { setPreview(await request<Preview>("/api/worktree-cleanup/preview", { method: "POST", body: "{}" })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not scan worktrees"); }
    finally { setBusy(null); }
  }, []);
  useEffect(() => { const timer = setTimeout(() => { void scan(); }, 0); return () => clearTimeout(timer); }, [scan]);
  async function collect() {
    if (!preview || busy) return;
    setBusy("run"); setError(""); setConfirm(false);
    try {
      const next = await request<Result>("/api/worktree-cleanup/run", { method: "POST", body: JSON.stringify({ previewId: preview.previewId, ids: preview.entries.filter((entry) => entry.eligible).map((entry) => entry.id), prune: [] }) });
      setResult(next);
      await scan();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Garbage collection failed");
      setPreview(null); // A failed or uncertain request must be rescanned before another run.
    } finally { setBusy(null); }
  }
  const entries = preview?.entries || [];
  const development = entries.filter((entry) => entry.classification === "development").length;
  const visible = entries.filter((entry) => (filter === "all" || (filter === "eligible" ? entry.eligible : !entry.eligible)) && `${entry.path} ${entry.repository || ""} ${entry.branch || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="subpage worktree-overview" aria-label="Worktree overview">
    <header className="page-kicker"><div><p className="eyebrow">LOCAL CHECKOUTS</p><h1>Worktrees</h1></div><button className="text-button" disabled={Boolean(busy)} onClick={() => { void scan(); }}>{busy === "scan" ? "Scanning…" : "Refresh inventory"}</button></header>
    <p>See what is filling your development folders and collect finished worktrees now.</p>
    <div className="worktree-counts" aria-label="Worktree counts">
      <div><strong>{preview ? entries.length : "—"}</strong><span>Registered checkouts</span></div>
      <div><strong>{preview ? development : "—"}</strong><span>Development worktrees</span></div>
      <div><strong>{preview ? preview.summary.candidates : "—"}</strong><span>Eligible for collection</span></div>
      <div><strong>{preview ? preview.summary.protected : "—"}</strong><span>Protected or retained</span></div>
    </div>
    {busy === "scan" && <p role="status">Scanning repositories, worktree status and active sessions…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <section className="collection-result" aria-label="Garbage collection result"><h2>Last collection</h2><p role="status">{result.results.filter((entry) => entry.outcome === "removed").length} removed · {result.results.filter((entry) => entry.outcome === "skipped").length} skipped · {result.results.filter((entry) => entry.outcome === "failed").length} failed</p><details><summary>View results</summary><ul>{result.results.map((entry, index) => <li key={index}>{entry.outcome}: {entry.path}{entry.reason && ` — ${entry.reason}`}</li>)}</ul></details></section>}
    {preview && <>
      <p>{preview.repositoryCount} repositories · scanned {new Date(preview.generatedAt).toLocaleString()} · approximately {size(preview.summary.estimatedBytes)} reclaimable.</p>
      <details><summary>Scanned folders</summary><ul>{preview.roots.map((root) => <li key={root}>{root}</li>)}</ul><p>Counts include Git-registered checkouts, primary repositories, managed releases and missing registrations. Ordinary directories are not deletion candidates.</p></details>
      {preview.errors.length > 0 && <section role="status"><strong>Inventory is incomplete</strong>{preview.errors.map((entry) => <p key={entry.path}>{entry.path}: {entry.error}</p>)}</section>}
      <section className="collection-action" aria-label="Garbage collection"><h2>Garbage collection</h2><p>Run now without enabling the automatic schedule. Only eligible finished checkouts and their known build output are removed; branches are kept. Active, dirty, unmerged and otherwise protected worktrees stay in place.</p>
        {confirm ? <><p>Remove all {preview.summary.candidates} eligible worktrees shown in this inventory? Search and filters do not limit collection. Every candidate is checked again before removal.</p><button disabled={Boolean(busy)} onClick={() => setConfirm(false)}>Cancel</button><button className="primary-button" disabled={Boolean(busy)} onClick={() => { void collect(); }}>Confirm garbage collection</button></> : <button className="primary-button" disabled={Boolean(busy) || preview.summary.candidates === 0} onClick={() => setConfirm(true)}>{busy === "run" ? "Collecting…" : `Run garbage collection (${preview.summary.candidates})`}</button>}
        {preview.summary.candidates === 0 && <p>No worktrees currently qualify. Review the reasons below; cleanup does not bypass protection or grace periods.</p>}
      </section>
      <div className="worktree-overview-filters"><label>Find a worktree<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Repository, branch or path" /></label><label>Show<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All checkouts</option><option value="eligible">Eligible</option><option value="protected">Protected or retained</option></select></label></div>
      <p>{visible.length} of {entries.length} checkouts shown</p>
      <ul className="worktree-overview-list">{visible.map((entry) => <li key={entry.id}><div><strong>{entry.repository || entry.branch || entry.classification}</strong><span className={entry.eligible ? "eligible" : "retained"}>{entry.eligible ? "Eligible" : "Protected"}</span></div><p>{entry.branch || entry.classification}</p><code>{entry.path}</code><p>{entry.reasons.join(" · ")}</p>{entry.estimatedBytes !== null && <small>Estimated size: {size(entry.estimatedBytes)}</small>}</li>)}</ul>
    </>}
    <WorktreeCleanupPanel />
  </section>;
}
