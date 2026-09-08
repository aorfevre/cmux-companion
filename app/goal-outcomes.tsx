"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { request } from "./image-attachments";
import type { PlanDraft } from "./worktree-planner";

export type AnalysisReport = { planId: string; version: number; approvalRevision: number; title: string; markdown: string; baseSha: string | null; createdAt: string; codingGoalId: string | null };
export type GoalReview = { id: string; kind: "planner" | "code" | "analysis"; target: string; status: string; result: string | null; error: string | null; acknowledgedAt: string | null };

function ReportMarkdown({ children }: { children: string }) {
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => /^https?:\/\//i.test(href || "") ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>,
    img: ({ alt }) => <span>{alt || "Report image omitted"}</span>,
  }}>{children}</ReactMarkdown></div>;
}

export function GoalOutcomes({ draft, onReceive, onLinked, readOnly = false }: { readOnly?: boolean; draft: PlanDraft; onReceive: (draft: PlanDraft) => void; onLinked: (draft: PlanDraft) => Promise<void> | void }) {
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const active = useRef(false);
  const [error, setError] = useState("");
  const reports = draft.analysisReports || [];
  const selected = reports.find((report) => report.version === version) || reports[0];
  const reviews = draft.reviews || [];
  const base = `/api/goal-sessions/${encodeURIComponent(draft.planId)}`;
  async function act(action: string, body: object) {
    if (readOnly || active.current) return;
    active.current = true;
    setBusy(action); setError("");
    try {
      const result = await request<PlanDraft>(`${base}/${action}`, { method: "POST", body: JSON.stringify(body) });
      if (action === "launch-coding") {
        if (result.goalSessionError) throw new Error(`Linked coding goal ${result.planId}: ${result.goalSessionError}. Open the saved goal for recovery; retry will not create a duplicate.`);
        if (!result.goalSessionWorkspaceId) throw new Error("The linked goal has no conversation workspace yet. Open its saved goal for recovery.");
        await onLinked(result);
      } else onReceive(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Goal action failed"); }
    finally { active.current = false; setBusy(""); }
  }
  return <>
    {draft.sourceAnalysis && <p>From analysis {draft.sourceAnalysis.planId} · version {draft.sourceAnalysis.version}. This coding goal requires its own approval.</p>}
    {selected && <section className="planner-delivery-status" aria-label="Analysis report">
      <header><strong>Analysis ready · {selected.title}</strong></header>
      <label>Report version <select aria-label="Analysis report version" value={selected.version} onChange={(event) => setVersion(Number(event.target.value))}>{reports.map((report) => <option value={report.version} key={report.version}>Version {report.version}{report === reports[0] ? " (latest)" : ""}</option>)}</select></label>
      <p>Scope revision {selected.approvalRevision} · repository base <code>{selected.baseSha || "not recorded"}</code></p>
      <ReportMarkdown>{selected.markdown}</ReportMarkdown>
      <div className="planner-actions">
        <a href={`${base}/analysis/${selected.version}/download`} download>Download Markdown</a>
        <button type="button" disabled={readOnly || Boolean(busy) || Boolean(draft.boardStatus) || draft.goalSessionState !== "analysis_ready" || reviews.some((review) => review.kind === "analysis" && review.target === String(selected.version))} onClick={() => { void act("challenge-analysis", { version: selected.version }); }}>Challenge the analysis</button>
        <button type="button" disabled={readOnly || Boolean(busy) || Boolean(draft.boardStatus) || draft.goalSessionState !== "analysis_ready"} onClick={() => { void act("launch-coding", { version: selected.version }); }}>{selected.codingGoalId ? "Open linked coding goal" : "Launch coding goal"}</button>
      </div>
      <p>Challenge saves a separate critique without changing this report. Coding starts a new discovery, not automatic implementation. To revise this report, return to its analyst conversation.</p>
    </section>}
    {reviews.length > 0 && <section className="planner-delivery-status" aria-label="Independent reviews">
      <strong>Independent reviews · advisory</strong>
      {reviews.map((review) => {
        const historical = review.kind === "planner" ? review.target !== String(draft.proposalRevision) : review.kind === "analysis" ? review.target !== String(reports[0]?.version) : review.status === "stale";
        return <article key={review.id}>
          <h4>{review.kind === "planner" ? "Planner review" : review.kind === "analysis" ? "Analysis critique" : "Code review"} · {review.kind === "code" ? "commit" : "version"} {review.target} · {review.status}{historical ? " (historical target)" : ""}</h4>
          {review.error && <p role="status">{review.error}</p>}
          {review.result && <ReportMarkdown>{review.result}</ReportMarkdown>}
          {review.acknowledgedAt && <p>Review failure acknowledged; this is not a passed review.</p>}
          {(!historical || (review.kind === "analysis" && reports.some((report) => String(report.version) === review.target))) && !draft.boardStatus && <div className="planner-actions">
            {review.status === "failed" && <button type="button" disabled={readOnly || Boolean(busy)} onClick={() => { void act("reviews/retry", { reviewId: review.id }); }}>Retry {review.kind} review</button>}
            {review.kind === "planner" && review.status === "failed" && !review.acknowledgedAt && <button type="button" disabled={readOnly || Boolean(busy)} onClick={() => { void act("reviews/acknowledge", { reviewId: review.id }); }}>Acknowledge failed review</button>}
            {["uncertain", "posting"].includes(review.status) && <button type="button" disabled={readOnly || Boolean(busy)} onClick={() => { void act("reviews/reconcile", { reviewId: review.id }); }}>Reconcile review</button>}
          </div>}
        </article>;
      })}
    </section>}
    {draft.goalType !== "analysis" && draft.reviewOptions?.codeReview && draft.boardPrState === "OPEN" && !draft.boardStatus && <button type="button" disabled={readOnly || Boolean(busy)} onClick={() => { void act("reviews/code", {}); }}>Review current PR commit</button>}
    {busy && <p role="status">Saving goal action…</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
