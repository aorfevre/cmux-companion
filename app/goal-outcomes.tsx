"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { request } from "./image-attachments";
import type { PlanDraft } from "./worktree-planner";

export type AnalysisReport = { planId: string; version: number; approvalRevision: number; title: string; markdown: string; baseSha: string | null; createdAt: string; codingGoalId: string | null };
export type ReviewFinding = { id: string; severity: "high" | "medium" | "low" | "note"; title: string; evidence: string; suggestion: string };
export type ReviewDecision = { findingId: string; verdict: "agree" | "disagree"; comment: string; updatedAt?: string };
export type GoalReview = { id: string; kind: "planner" | "code" | "analysis"; target: string; status: string; result: string | null; error: string | null; acknowledgedAt: string | null; findings?: ReviewFinding[]; decisions?: ReviewDecision[]; decisionsSentAt?: string | null };

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
  async function send(method: "PUT" | "POST", path: string, body: object) {
    if (readOnly || active.current) return;
    active.current = true;
    setBusy(path); setError("");
    try { onReceive(await request<PlanDraft>(`${base}/${path}`, { method, body: JSON.stringify(body) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Goal action failed"); }
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
        const findings = review.kind === "planner" ? review.findings || [] : [];
        const decisions = new Map((review.decisions || []).map((decision) => [decision.findingId, decision]));
        const decidable = review.kind === "planner" && review.status === "completed" && !historical && !review.decisionsSentAt && !draft.boardStatus;
        const decidedCount = findings.filter((finding) => decisions.has(finding.id)).length;
        const canSend = decidable && decidedCount === findings.length && findings.some((finding) => decisions.get(finding.id)?.verdict === "agree");
        return <article key={review.id}>
          <h4>{review.kind === "planner" ? "Planner review" : review.kind === "analysis" ? "Analysis critique" : "Code review"} · {review.kind === "code" ? "commit" : "version"} {review.target} · {review.status}{historical ? " (historical target)" : ""}</h4>
          {review.error && <p role="status">{review.error}</p>}
          {findings.length > 0 ? <>
            {findings.map((finding) => <FindingCard key={finding.id} finding={finding} decision={decisions.get(finding.id) || null} editable={decidable && !readOnly && !busy} onDecide={(verdict, comment) => { void send("PUT", `reviews/${review.id}/decisions/${encodeURIComponent(finding.id)}`, { verdict, comment }); }} />)}
            {decidable && <div className="review-decisions-footer">
              <p>{decidedCount} of {findings.length} decided</p>
              {decidedCount === findings.length && !canSend && <p>Agree with at least one finding to send, or approve the proposal.</p>}
              <button type="button" className="primary-button" disabled={readOnly || Boolean(busy) || !canSend} onClick={() => { void send("POST", `reviews/${review.id}/send-decisions`, { generation: draft.goalSessionGeneration, revision: draft.proposalRevision }); }}>Send decisions to planner</button>
            </div>}
            {review.decisionsSentAt && <p>Decisions sent {new Date(review.decisionsSentAt).toLocaleString()}.</p>}
            {review.result && <details><summary>Full review text</summary><ReportMarkdown>{review.result}</ReportMarkdown></details>}
          </> : review.result && <ReportMarkdown>{review.result}</ReportMarkdown>}
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

// One card per reviewer finding. Each pick saves at once; the comment saves
// on blur once a verdict exists, so a phone never loses a half-typed note.
function FindingCard({ finding, decision, editable, onDecide }: { finding: ReviewFinding; decision: ReviewDecision | null; editable: boolean; onDecide: (verdict: "agree" | "disagree", comment: string) => void }) {
  const [comment, setComment] = useState(decision?.comment || "");
  const verdict = decision?.verdict || null;
  return <article className={`review-finding severity-${finding.severity}`} aria-label={finding.title}>
    <header><span className="severity-badge">{finding.severity}</span><strong>{finding.title}</strong></header>
    {finding.evidence && <ReportMarkdown>{finding.evidence}</ReportMarkdown>}
    {finding.suggestion && <p><b>Suggestion:</b> {finding.suggestion}</p>}
    {editable ? <div className="review-decision">
      <div role="radiogroup" aria-label={`Decision on ${finding.title}`}>
        <label><input type="radio" name={`decision-${finding.id}`} aria-label={`Agree with ${finding.title}`} checked={verdict === "agree"} onChange={() => onDecide("agree", comment.trim())} /> Agree</label>
        <label><input type="radio" name={`decision-${finding.id}`} aria-label={`Disagree with ${finding.title}`} checked={verdict === "disagree"} onChange={() => onDecide("disagree", comment.trim())} /> Disagree</label>
      </div>
      <textarea aria-label={`Comment on ${finding.title}`} placeholder="Optional comment for the planner" maxLength={1_000} rows={2} value={comment} onChange={(event) => setComment(event.target.value)} onBlur={() => { if (verdict && comment.trim() !== (decision?.comment || "")) onDecide(verdict, comment.trim()); }} />
    </div> : decision && <p className="review-decision-saved">{decision.verdict === "agree" ? "Agreed" : "Disagreed"}{decision.comment ? ` · ${decision.comment}` : ""}</p>}
  </article>;
}
