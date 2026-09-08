"use client";
import { useCallback, useEffect, useState } from "react";
import { request } from "./api-request";
import type { AgentCapacity } from "./agent-capacity";

export type BurstCandidate = { repositoryId: string; repositoryName: string; goal: string | null; rationale: string | null; evidence: string[]; sizeEstimate: string | null; status: "scanning" | "proposed" | "failed" | "approved" | "declined"; reason: string | null; planId: string | null; updatedAt: string };
export type Burst = { burstId: string; status: "scanning" | "ready" | "closed"; createdAt: string; updatedAt: string; capacitySnapshot: unknown; candidates: BurstCandidate[] };
type CreateResult = Burst | { status: "no_starred_repositories"; message: string; burstId: null };

const READ_ONLY_HINT = "Read-only mode is on. Enable input in Settings to approve, decline or rescan.";

// A live weekly window is the one signal worth a banner. The banner is a
// shortcut to the same create action the sheet has; nothing starts by itself.
export function BurstBanner({ capacity, now, onStart }: { capacity: AgentCapacity | null; now: number; onStart: () => void }) {
  const live = (capacity?.providers || []).some((provider) => provider.accounts.some((account) => account.opportunity && Date.parse(account.opportunity.resetAt || "") > now));
  if (!live) return null;
  return <section className="burst-banner" aria-label="Burst opportunity">
    <div><strong>Quota window open</strong><p>At least 20% weekly quota resets within 24 hours. Scan every starred repository and propose one goal each.</p></div>
    <button type="button" className="primary-button" onClick={onStart}>Start a burst</button>
  </section>;
}

export function BurstPlanSheet({ readOnly, onClose, onOpenGoal, autoStart = false }: { readOnly: boolean; onClose: () => void; onOpenGoal: (repositoryId: string, planId: string) => void; autoStart?: boolean }) {
  const [burst, setBurst] = useState<Burst | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [goals, setGoals] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  const applyDetail = useCallback((detail: Burst) => {
    setBurst(detail);
    setGoals((current) => Object.fromEntries(detail.candidates.map((c) => [c.repositoryId, current[c.repositoryId] ?? c.goal ?? ""])));
  }, []);

  const load = useCallback(async () => {
    try {
      const list = await request<{ bursts: Burst[] }>("/api/bursts");
      const latest = list.bursts[0] || null;
      if (!latest) { setBurst(null); return; }
      const detail = await request<Burst>(`/api/bursts/${latest.burstId}`);
      applyDetail(detail);
    } catch (cause) { setError((cause as Error).message); }
    finally { setLoaded(true); }
  }, [applyDetail]);

  const start = useCallback(async () => {
    setBusy("create"); setError(""); setNotice("");
    try {
      const result = await request<CreateResult>("/api/bursts", { method: "POST", body: "{}" });
      if (result.status === "no_starred_repositories") { setNotice(result.message); return; }
      const detail = await request<Burst>(`/api/bursts/${result.burstId}`);
      applyDetail(detail);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  }, [applyDetail]);

  useEffect(() => { const timer = setTimeout(load, 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!autoStart || !loaded || burst) return;
    const timer = setTimeout(start, 0);
    return () => clearTimeout(timer);
  }, [autoStart, loaded, burst, start]);
  useEffect(() => {
    if (burst?.status !== "scanning") return;
    const poll = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(poll);
  }, [burst?.status, load]);

  async function act(candidate: BurstCandidate, action: "approve" | "decline" | "rescan") {
    setBusy(`${action}:${candidate.repositoryId}`); setError("");
    try {
      const body = action === "approve" ? JSON.stringify({ goal: goals[candidate.repositoryId] || candidate.goal || "" }) : "{}";
      const updated = await request<BurstCandidate>(`/api/bursts/${burst!.burstId}/candidates/${candidate.repositoryId}/${action}`, { method: "POST", body });
      setBurst((current) => current ? { ...current, candidates: current.candidates.map((c) => c.repositoryId === updated.repositoryId ? updated : c) } : current);
      if (action === "rescan") await load();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  }

  return <><button type="button" className="session-menu-backdrop" aria-label="Close burst plan" onClick={onClose} /><section className="worktree-launcher worktree-planner-sheet burst-sheet" role="dialog" aria-modal="true" aria-label="Burst plan">
    <header className="worktree-launcher-header"><div><h2>Burst</h2><p>One proposed goal per starred repository. Approve a candidate to start its goal session; the spec still needs your approval there.</p></div><button type="button" className="text-button" onClick={onClose}>Close</button></header>
    {readOnly && <p className="burst-readonly" role="status">{READ_ONLY_HINT}</p>}
    {error && <p className="worktree-action-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!loaded && <p>Reading bursts…</p>}
    {loaded && !burst && <div className="empty-card"><span>⚡</span><strong>No burst yet</strong><p>Scan every starred repository and propose one goal each.</p><button type="button" className="primary-button" disabled={busy === "create"} onClick={() => { void start(); }}>{busy === "create" ? "Starting…" : "Start a burst"}</button></div>}
    {burst && <>
      <p className="burst-status" role="status">{burst.status === "scanning" ? "Scanning starred repositories… this page refreshes every 5 seconds." : burst.status === "closed" ? "Every candidate is decided." : "Review each candidate below."}</p>
      <ul className="burst-candidates">{burst.candidates.map((candidate) => {
        const name = candidate.repositoryName;
        const proposed = candidate.status === "proposed";
        return <li key={candidate.repositoryId} className={`burst-candidate ${candidate.status}`}>
          <header><span className="repo-icon">{name.slice(0, 1).toUpperCase()}</span><strong>{name}</strong><em>{candidateLabel(candidate)}</em></header>
          {candidate.status === "scanning" && <p>Reading the repository…</p>}
          {candidate.status === "failed" && <p className="burst-reason">{candidate.reason}</p>}
          {(proposed || candidate.status === "approved" || candidate.status === "declined") && <>
            {proposed ? <label className="worktree-task"><span>Goal</span><textarea aria-label={`Goal for ${name}`} rows={3} maxLength={8_000} value={goals[candidate.repositoryId] ?? ""} onChange={(event) => setGoals((current) => ({ ...current, [candidate.repositoryId]: event.target.value }))} /></label> : <p className="burst-goal">{candidate.goal}</p>}
            {candidate.rationale && <p className="burst-rationale">{candidate.rationale}</p>}
            {candidate.evidence.length > 0 && <ul className="burst-evidence">{candidate.evidence.map((item, index) => <li key={index}><code>{item}</code></li>)}</ul>}
            {candidate.sizeEstimate && <small>Estimated size: {candidate.sizeEstimate}</small>}
          </>}
          <footer>
            {candidate.status === "approved" && candidate.planId && <button type="button" className="text-button" aria-label={`Open goal for ${name}`} onClick={() => onOpenGoal(candidate.repositoryId, candidate.planId!)}>Open goal</button>}
            {proposed && <button type="button" className="primary-button" aria-label={`Approve ${name}`} disabled={readOnly || busy !== "" || !(goals[candidate.repositoryId] || "").trim()} onClick={() => { void act(candidate, "approve"); }}>{busy === `approve:${candidate.repositoryId}` ? "Starting goal…" : "Approve"}</button>}
            {(proposed || candidate.status === "failed") && <button type="button" className="text-button" aria-label={`Decline ${name}`} disabled={readOnly || busy !== ""} onClick={() => { void act(candidate, "decline"); }}>Decline</button>}
            {candidate.status !== "scanning" && candidate.status !== "approved" && <button type="button" className="text-button" aria-label={`Rescan ${name}`} disabled={readOnly || busy !== ""} onClick={() => { void act(candidate, "rescan"); }}>Rescan</button>}
          </footer>
        </li>;
      })}</ul>
      {burst.status !== "scanning" && <button type="button" className="text-button" disabled={readOnly || busy === "create"} onClick={() => { void start(); }}>Start a new burst</button>}
    </>}
  </section></>;
}

function candidateLabel(candidate: BurstCandidate) {
  if (candidate.status === "scanning") return "Scanning";
  if (candidate.status === "proposed") return "Proposed";
  if (candidate.status === "approved") return "Goal started";
  if (candidate.status === "declined") return "Declined";
  return "Scan failed";
}
