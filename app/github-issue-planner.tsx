"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { request } from "./image-attachments";
import type { PlanDraft } from "./worktree-planner";

type Repository = { id: string; name: string };
type Issue = { number: number; title: string; labels: string[]; url: string; updatedAt: string };
type TopicQuestion = { id: string; text: string; options: string[] };
type Topic = { id: string; title: string; goal: string; rationale: string; issueNumbers: number[]; questions: TopicQuestion[]; acceptanceCriteria: string[]; overlapRisk: string; dependencies: string[] };
type PlannerMode = "issues" | "topics";
type Analysis = { analysisId: string | null; mode?: PlannerMode; repository: { nameWithOwner: string; url: string | null; issuesUrl: string | null }; issues: Issue[]; topics: Topic[]; analyzedAt: string };
type PreparedRow = { topicId: string; title: string; issueNumbers: number[]; status: "planned" | "failed"; plan?: PlanDraft; error?: string };
type PrepareResult = { analysisId: string; results: PreparedRow[] };
type PreparedIssue = { issueNumber: number; title: string; status: "planned" | "failed"; plan?: PlanDraft; error?: string };
type PrepareIssueResult = { analysisId: string; result: PreparedIssue };
type LaunchResult = { requested: number; launchedTopics: number; launchedWorktrees: number; results: { planId: string; status: "launched" | "failed"; error?: string; result?: { deliveryMode?: string; launched: number; results: unknown[] } }[] };

function newTraceId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : "";
}

function useIssueProgress(traceId: string) {
  const [progress, setProgress] = useState<{ traceId: string; steps: string[]; elapsed: number }>({ traceId: "", steps: [], elapsed: 0 });
  useEffect(() => {
    if (!traceId) return;
    const startedAt = Date.now();
    const clock = setInterval(() => setProgress((current) => ({
      traceId,
      steps: current.traceId === traceId ? current.steps : [],
      elapsed: Math.floor((Date.now() - startedAt) / 1_000),
    })), 1_000);
    if (typeof EventSource === "undefined") return () => clearInterval(clock);
    const source = new EventSource(`/api/worktree-plans/progress/${traceId}`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.k === "done" || event.k === "error") { source.close(); clearInterval(clock); return; }
        if (event.t) setProgress((current) => {
          const text = String(event.t);
          const steps = current.traceId === traceId ? current.steps : [];
          return { traceId, elapsed: current.traceId === traceId ? current.elapsed : 0, steps: steps.at(-1) === text ? steps : [...steps, text].slice(-8) };
        });
      } catch { /* ignore malformed progress frames */ }
    };
    source.onerror = () => {};
    return () => { clearInterval(clock); source.close(); };
  }, [traceId]);
  return progress.traceId === traceId ? progress : { traceId, steps: [], elapsed: 0 };
}

function IssueProgress({ steps, elapsed, fallback, compact = false }: { steps: string[]; elapsed: number; fallback: string; compact?: boolean }) {
  const current = steps.at(-1) || fallback;
  return <div className={`issue-analyzing${compact ? " compact" : ""}`} role="status" aria-live="polite">
    <div className="issue-progress-current"><i /><div><strong>{current}</strong><p>{elapsed ? `${elapsed}s elapsed` : "Starting…"} · You can keep this window open</p></div></div>
    <div className="issue-activity-track" aria-hidden="true"><i /></div>
    {steps.length > 1 && <ul>{steps.slice(0, -1).map((step, index) => <li key={`${index}-${step}`}><span>✓</span>{step}</li>)}</ul>}
  </div>;
}

export function GitHubIssuePlannerSheet({ repository, onClose, onLaunched, onNotice }: { repository: Repository; onClose: () => void; onLaunched: () => Promise<void>; onNotice: (message: string) => void }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [mode, setMode] = useState<PlannerMode>("issues");
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [topicAnswers, setTopicAnswers] = useState<Record<string, string>>({});
  const [prepared, setPrepared] = useState<PreparedRow[]>([]);
  const [planAnswers, setPlanAnswers] = useState<Record<string, string>>({});
  const [launchResult, setLaunchResult] = useState<LaunchResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [traceId, setTraceId] = useState("");
  const progress = useIssueProgress(traceId);

  // `mode: "issues"` returns the open ticket list without the grouping wait. The
  // whole-backlog grouping stays one explicit action away, and sends no mode.
  const analyze = useCallback(async (nextMode: PlannerMode) => {
    setBusy("analyze"); setError(""); setAnalysis(null); setPrepared([]); setLaunchResult(null);
    setMode(nextMode); setSelectedIssue(null); setSelected(new Set());
    const nextTraceId = newTraceId(); setTraceId(nextTraceId);
    try {
      const body = nextMode === "issues"
        ? { repositoryId: repository.id, mode: "issues", traceId: nextTraceId }
        : { repositoryId: repository.id, traceId: nextTraceId };
      const result = await request<Analysis>("/api/github-topic-plans/analyze", { method: "POST", body: JSON.stringify(body) });
      setAnalysis(result);
      if (nextMode === "topics") setSelected(new Set(result.topics.map((topic) => topic.id)));
    } catch (cause) { setError(message(cause, "Could not analyze GitHub issues")); }
    finally { setBusy(""); setTraceId(""); }
  }, [repository.id]);

  useEffect(() => {
    const kickoff = setTimeout(() => { void analyze("issues"); }, 0);
    return () => clearTimeout(kickoff);
  }, [analyze]);

  const selectedTopics = useMemo(() => analysis?.topics.filter((topic) => selected.has(topic.id)) || [], [analysis, selected]);
  const readyPlans = prepared.filter((row) => row.status === "planned" && row.plan?.status === "ready" && row.plan.planStatus !== "launched");
  const waitingPlans = prepared.filter((row) => row.status === "planned" && row.plan?.status === "questions");
  const issueCount = new Set(selectedTopics.flatMap((topic) => topic.issueNumbers)).size;
  const unit = mode === "issues" ? "issue" : "topic";

  function toggleTopic(id: string) {
    setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  async function prepare() {
    if (!analysis?.analysisId || !selectedTopics.length) return;
    setBusy("prepare"); setError("");
    const nextTraceId = newTraceId(); setTraceId(nextTraceId);
    try {
      const topics = selectedTopics.map((topic) => ({
        id: topic.id,
        answers: Object.fromEntries(topic.questions.map((question) => [question.id, topicAnswers[`${topic.id}:${question.id}`] || ""]).filter(([, value]) => value)),
      }));
      const result = await request<PrepareResult>("/api/github-topic-plans/prepare", { method: "POST", body: JSON.stringify({ analysisId: analysis.analysisId, topics, traceId: nextTraceId }) });
      setPrepared(result.results);
      onNotice(`Created ${result.results.filter((row) => row.status === "planned").length} saved topic plan${result.results.length === 1 ? "" : "s"}`);
    } catch (cause) { setError(message(cause, "Could not create topic plans")); }
    finally { setBusy(""); setTraceId(""); }
  }

  async function prepareIssue() {
    if (!analysis?.analysisId || selectedIssue === null) return;
    setBusy("prepare-issue"); setError("");
    const nextTraceId = newTraceId(); setTraceId(nextTraceId);
    try {
      const result = await request<PrepareIssueResult>("/api/github-topic-plans/prepare-issue", { method: "POST", body: JSON.stringify({ analysisId: analysis.analysisId, issueNumber: selectedIssue, traceId: nextTraceId }) });
      const row = result.result;
      setPrepared([{ topicId: `issue-${row.issueNumber}`, title: row.title, issueNumbers: [row.issueNumber], status: row.status, plan: row.plan, error: row.error }]);
      if (row.status === "planned") onNotice(`Created a saved goal plan for #${row.issueNumber}`);
    } catch (cause) { setError(message(cause, "Could not create a plan for that issue")); }
    finally { setBusy(""); setTraceId(""); }
  }

  async function answerPlan(row: PreparedRow, skip = false) {
    if (!row.plan) return;
    setBusy(`answer:${row.plan.planId}`); setError("");
    try {
      const answers = row.plan.questions.map((question) => ({ id: question.id, text: planAnswers[`${row.plan?.planId}:${question.id}`] || "" })).filter((answer) => answer.text.trim());
      const plan = await request<PlanDraft>(`/api/worktree-plans/${row.plan.planId}/answers`, { method: "POST", body: JSON.stringify({ answers, skip }) });
      setPrepared((current) => current.map((item) => item.topicId === row.topicId ? { ...item, plan } : item));
    } catch (cause) { setError(message(cause, `Could not continue ${row.title}`)); }
    finally { setBusy(""); }
  }

  async function launchAll() {
    if (!readyPlans.length || waitingPlans.length) return;
    setBusy("launch"); setError("");
    const nextTraceId = newTraceId(); setTraceId(nextTraceId);
    try {
      const result = await request<LaunchResult>("/api/github-topic-plans/launch", { method: "POST", body: JSON.stringify({ planIds: readyPlans.map((row) => row.plan?.planId), traceId: nextTraceId }) });
      setLaunchResult(result);
      onNotice(`Launched ${result.launchedWorktrees} worktree session${result.launchedWorktrees === 1 ? "" : "s"} across ${result.launchedTopics} ${unit}${result.launchedTopics === 1 ? "" : "s"}`);
      await onLaunched();
    } catch (cause) { setError(message(cause, "Could not launch topic plans")); }
    finally { setBusy(""); setTraceId(""); }
  }

  const heading = launchResult
    ? (mode === "issues" ? "Issue launched" : "Topics launched")
    : prepared.length ? (mode === "issues" ? "Review issue plan" : "Review topic plans")
    : analysis ? (mode === "issues" ? "Pick an issue" : "Choose master topics")
    : "Plan GitHub issues";
  return <><button className="session-menu-backdrop" aria-label="Close GitHub issue planner" onClick={onClose} /><section className="worktree-launcher github-issue-planner" role="dialog" aria-modal="true" aria-label="Plan GitHub issues">
    <header><div><strong>{heading}</strong><span>{analysis?.repository.nameWithOwner || repository.name}</span></div><button type="button" aria-label="Close GitHub issue planner" onClick={onClose}>×</button></header>

    {busy === "analyze" && <IssueProgress {...progress} fallback="Opening repository…" />}
    {busy === "prepare" && <IssueProgress {...progress} compact fallback="Checking selected topics…" />}
    {busy === "prepare-issue" && <IssueProgress {...progress} compact fallback="Reading that issue…" />}
    {busy === "launch" && <IssueProgress {...progress} compact fallback="Preparing topic worktrees…" />}
    {error && <div className="apps-warning">{error}<button type="button" className="issue-retry" disabled={busy !== ""} onClick={() => { void analyze("issues"); }}>Reload open issues</button></div>}

    {analysis && !analysis.issues.length && <div className="issue-empty"><strong>No open issues</strong><p>{analysis.repository.nameWithOwner} has no open GitHub tickets.</p><button type="button" onClick={() => { void analyze(mode); }}>Refresh</button></div>}

    {analysis && mode === "topics" && analysis.issues.length > 0 && !analysis.topics.length && !prepared.length && <div className="issue-empty"><strong>No master topics</strong><p>The grouping pass produced no topic for {analysis.issues.length} open issue{analysis.issues.length === 1 ? "" : "s"}.</p><button type="button" disabled={busy !== ""} onClick={() => { void analyze("issues"); }}>Back to the issue list</button></div>}

    {analysis && mode === "issues" && analysis.issues.length > 0 && !prepared.length && <>
      <div className="issue-analysis-summary"><div><strong>{analysis.issues.length}</strong><span>open issues</span></div><div><strong>{selectedIssue === null ? "—" : `#${selectedIssue}`}</strong><span>selected</span></div><a href={analysis.repository.issuesUrl || "#"} target="_blank" rel="noreferrer">Open GitHub ↗</a></div>
      <div className="issue-mode-switch"><span>Plan one ticket at a time, or group the whole backlog first.</span><button type="button" disabled={busy !== ""} onClick={() => { void analyze("topics"); }}>Group all issues into topics</button></div>
      <div className="issue-list" role="radiogroup" aria-label="Open issues">{analysis.issues.map((issue) => <article className={`issue-row ${selectedIssue === issue.number ? "selected" : ""}`} key={issue.number}>
        <label className="issue-row-select"><input type="radio" name="github-issue" aria-label={`Select issue #${issue.number} ${issue.title}`} checked={selectedIssue === issue.number} onChange={() => setSelectedIssue(issue.number)} /><span><strong>{issue.title}</strong><small>#{issue.number} · updated {issue.updatedAt}</small></span></label>
        <div className="issue-row-meta">{issue.labels.map((label) => <em key={label}>{label}</em>)}<a href={issue.url} target="_blank" rel="noreferrer" aria-label={`Open issue #${issue.number} on GitHub`}>View on GitHub ↗</a></div>
      </article>)}</div>
      <section className="issue-launch-preview"><strong>{selectedIssue === null ? "No issue selected" : `Issue #${selectedIssue}`}</strong><span>{selectedIssue === null ? "Select one open ticket to plan." : "One saved goal plan, linked to that one issue."}</span><button type="button" className="primary-button" disabled={selectedIssue === null || busy !== ""} onClick={() => { void prepareIssue(); }}>{busy === "prepare-issue" ? "Planning issue…" : "Plan this issue"}</button></section>
    </>}

    {analysis && mode === "topics" && analysis.topics.length > 0 && !prepared.length && <>
      <div className="issue-analysis-summary"><div><strong>{analysis.issues.length}</strong><span>open issues</span></div><div><strong>{analysis.topics.length}</strong><span>master topics</span></div><a href={analysis.repository.issuesUrl || "#"} target="_blank" rel="noreferrer">Open GitHub ↗</a></div>
      <div className="issue-selection-actions"><button type="button" onClick={() => setSelected(new Set(analysis.topics.map((topic) => topic.id)))}>Select all</button><button type="button" onClick={() => setSelected(new Set())}>Clear</button><span>{selected.size} selected</span></div>
      <div className="issue-topics">{analysis.topics.map((topic) => <article className={`issue-topic ${selected.has(topic.id) ? "selected" : ""}`} key={topic.id}>
        <label className="issue-topic-select"><input type="checkbox" aria-label={`Select ${topic.title}`} checked={selected.has(topic.id)} onChange={() => toggleTopic(topic.id)} /><span><strong>{topic.title}</strong><small>{topic.issueNumbers.length} issue{topic.issueNumbers.length === 1 ? "" : "s"} · one final PR</small></span></label>
        <div className="issue-badges">{topic.issueNumbers.map((number) => { const issue = analysis.issues.find((item) => item.number === number); return <a key={number} href={issue?.url} target="_blank" rel="noreferrer" title={issue?.title}>#{number}</a>; })}</div>
        <p>{topic.goal}</p>
        {topic.rationale && <details><summary>Why grouped together</summary><p>{topic.rationale}</p></details>}
        {topic.overlapRisk && topic.overlapRisk.toLowerCase() !== "low" && <div className="issue-overlap"><strong>Overlap warning</strong><span>{topic.overlapRisk}</span></div>}
        {selected.has(topic.id) && topic.questions.length > 0 && <div className="issue-topic-questions">{topic.questions.map((question) => <div className="issue-question" key={question.id}><span>{question.text}</span>{question.options.length > 0 && <div>{question.options.map((option) => <button type="button" className={topicAnswers[`${topic.id}:${question.id}`] === option ? "selected" : ""} onClick={() => setTopicAnswers((current) => ({ ...current, [`${topic.id}:${question.id}`]: option }))} key={option}>{option}</button>)}</div>}<textarea aria-label={`Clarification: ${question.text}`} rows={2} maxLength={2_000} value={topicAnswers[`${topic.id}:${question.id}`] || ""} onChange={(event) => setTopicAnswers((current) => ({ ...current, [`${topic.id}:${question.id}`]: event.target.value }))} placeholder="Answer, or leave blank for the planner to decide" /></div>)}</div>}
      </article>)}</div>
      <section className="issue-launch-preview"><strong>{selectedTopics.length} topic PR{selectedTopics.length === 1 ? "" : "s"}</strong><span>{issueCount} linked issue{issueCount === 1 ? "" : "s"} will close when those PRs merge.</span><button type="button" className="primary-button" disabled={!selectedTopics.length || busy !== ""} onClick={() => { void prepare(); }}>{busy === "prepare" ? "Planning topics…" : `Create ${selectedTopics.length} goal plan${selectedTopics.length === 1 ? "" : "s"}`}</button></section>
    </>}

    {prepared.length > 0 && !launchResult && <>
      <p className="issue-plan-intro">{mode === "issues" ? "This issue is now a normal saved Plan a Goal. Resolve any follow-up question, review the task split, then launch it." : "Each topic is now a normal saved Plan a Goal. Resolve any follow-up question, review the task split, then launch every ready topic together."}</p>
      <div className="issue-prepared-plans">{prepared.map((row) => <article className={row.status === "failed" ? "failed" : row.plan?.status || ""} key={row.topicId}>
        <header><div><strong>{row.title}</strong><span>{row.issueNumbers.map((number) => `#${number}`).join(" · ")}</span></div><em>{row.status === "failed" ? "Failed" : row.plan?.status === "ready" ? `${row.plan.tasks.length} tasks` : "Needs answers"}</em></header>
        {row.error && <p className="issue-plan-error">{row.error}</p>}
        {row.plan?.status === "questions" && <div className="issue-followup">{row.plan.questions.map((question) => <div className="issue-question" key={question.id}><span>{question.text}</span>{question.options.length > 0 && <div>{question.options.map((option) => <button type="button" className={planAnswers[`${row.plan?.planId}:${question.id}`] === option ? "selected" : ""} onClick={() => setPlanAnswers((current) => ({ ...current, [`${row.plan?.planId}:${question.id}`]: option }))} key={option}>{option}</button>)}</div>}<textarea aria-label={`Plan question: ${question.text}`} rows={2} value={planAnswers[`${row.plan?.planId}:${question.id}`] || ""} onChange={(event) => setPlanAnswers((current) => ({ ...current, [`${row.plan?.planId}:${question.id}`]: event.target.value }))} /></div>)}<div><button type="button" disabled={busy !== ""} onClick={() => { void answerPlan(row, true); }}>Decide for me</button><button type="button" className="primary-button" disabled={busy !== ""} onClick={() => { void answerPlan(row); }}>{busy === `answer:${row.plan?.planId}` ? "Planning…" : "Send answers"}</button></div></div>}
        {row.plan?.status === "ready" && <ul>{row.plan.tasks.map((task) => <li key={task.id}><span>{task.title}</span><small>{task.agent === "claude" ? "Claude" : "Codex"} · {task.branch}</small></li>)}</ul>}
      </article>)}</div>
      <section className="issue-launch-preview"><strong>{readyPlans.length} {unit}{readyPlans.length === 1 ? "" : "s"} ready · {readyPlans.reduce((total, row) => total + Number(row.plan?.tasks.length || 0), 0)} worktrees</strong><span>{waitingPlans.length ? `${waitingPlans.length} ${unit}${waitingPlans.length === 1 ? " needs" : "s need"} answers before launch.` : `${readyPlans.length} combined or direct PR${readyPlans.length === 1 ? "" : "s"} will be created after the agents finish.`}</span><button type="button" className="primary-button" disabled={!readyPlans.length || waitingPlans.length > 0 || busy !== ""} onClick={() => { void launchAll(); }}>{busy === "launch" ? "Launching worktrees…" : `Launch ${readyPlans.length} ${unit}${readyPlans.length === 1 ? "" : "s"}`}</button></section>
    </>}

    {launchResult && <div className="issue-launched"><span>✓</span><strong>{launchResult.launchedTopics} {unit}{launchResult.launchedTopics === 1 ? "" : "s"} in flight</strong><p>{launchResult.launchedWorktrees} agents are working in isolated worktrees. Each {unit} will produce one final PR with its GitHub issue links.</p>{launchResult.results.some((row) => row.status === "failed") && <ul>{launchResult.results.filter((row) => row.status === "failed").map((row) => <li key={row.planId}>{row.error}</li>)}</ul>}<button type="button" className="primary-button" onClick={onClose}>View dashboard</button></div>}
  </section></>;
}

function message(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
