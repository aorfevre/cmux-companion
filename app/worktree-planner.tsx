"use client";

import { FormEvent, useState } from "react";

export type PlanAgent = "claude" | "codex";
export type PlanQuestion = { id: string; text: string; options: string[] };
export type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: PlanAgent; agentReason: string };
export type PlanDraft = { planId: string; repositoryId: string; goal: string; round: number; status: "questions" | "ready"; questions: PlanQuestion[]; tasks: PlanTask[] };
export type PlanLaunchRow = { id: string; title: string; branch: string; agent: string; status: "launched" | "failed"; path?: string | null; workspace?: unknown; error?: string };
export type PlanLaunchResult = { planId: string; base: string; launched: number; results: PlanLaunchRow[] };
type PlannerRepository = { id: string; name: string };

const LOST_SESSION = "The planner lost its session";
const AGENTS: PlanAgent[] = ["codex", "claude"];

function agentLabel(agent: string) { return agent === "claude" ? "Claude" : "Codex"; }
function compactPath(path: string) { return path.replace(/^\/Users\/[^/]+/, "~"); }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...(init?.body != null ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export function WorktreePlannerSheet({ repository, onClose, onLaunched, onNotice }: { repository: PlannerRepository; onClose: () => void; onLaunched: () => Promise<void>; onNotice: (message: string) => void }) {
  const [goal, setGoal] = useState("");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PlanLaunchResult | null>(null);
  const [busy, setBusy] = useState<"" | "plan" | "answer" | "edit" | "launch">("");
  const [error, setError] = useState("");

  function receive(next: PlanDraft) { setDraft(next); setAnswers({}); setError(""); }

  function fail(cause: unknown, fallback: string) {
    const message = cause instanceof Error ? cause.message : fallback;
    if (message.startsWith(LOST_SESSION)) { setDraft(null); setAnswers({}); setResult(null); }
    setError(message);
  }

  async function plan(event: FormEvent) {
    event.preventDefault();
    setBusy("plan"); setError("");
    try { receive(await request<PlanDraft>("/api/worktree-plans", { method: "POST", body: JSON.stringify({ repositoryId: repository.id, goal: goal.trim() }) })); }
    catch (cause) { fail(cause, "Could not plan this goal"); }
    finally { setBusy(""); }
  }

  async function answer(body: unknown) {
    if (!draft) return;
    setBusy("answer"); setError("");
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}/answers`, { method: "POST", body: JSON.stringify(body) })); }
    catch (cause) { fail(cause, "Could not send those answers"); }
    finally { setBusy(""); }
  }

  async function editTasks(tasks: PlanTask[]) {
    if (!draft) return;
    setBusy("edit"); setError("");
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}`, { method: "PATCH", body: JSON.stringify({ tasks }) })); }
    catch (cause) { fail(cause, "Could not update this plan"); }
    finally { setBusy(""); }
  }

  async function launch() {
    if (!draft || busy) return;
    setBusy("launch"); setError("");
    try {
      const launchResult = await request<PlanLaunchResult>(`/api/worktree-plans/${draft.planId}/launch`, { method: "POST", body: "{}" });
      setResult(launchResult);
      if (launchResult.launched > 0) { onNotice(`Launched ${launchResult.launched} session${launchResult.launched === 1 ? "" : "s"} from ${launchResult.base}`); await onLaunched(); }
    } catch (cause) { fail(cause, "Could not launch this plan"); }
    finally { setBusy(""); }
  }

  const failed = result?.results.filter((row) => row.status === "failed") || [];
  const canRetry = Boolean(result) && result?.launched === 0;
  const heading = result ? "Launch result" : draft?.status === "ready" ? "Review the plan" : draft ? "A few questions" : "Plan a goal";

  return <><button className="session-menu-backdrop" aria-label="Close goal planner" onClick={onClose} /><form className="worktree-launcher worktree-planner-sheet" role="dialog" aria-modal="true" aria-label="Plan a goal" onSubmit={(event) => event.preventDefault()}>
    <header><div><strong>{heading}</strong><span>{repository.name}</span></div><button type="button" aria-label="Close goal planner sheet" onClick={onClose}>×</button></header>
    {!draft && !result && <>
      <label className="worktree-task"><span>Goal</span><textarea aria-label="Goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={5} maxLength={4_000} placeholder="Describe the outcome you want across parallel worktrees…" /></label>
      {error && <p className="worktree-action-error">{error}</p>}
      <button type="button" className="primary-button" disabled={busy === "plan" || !goal.trim()} onClick={plan}>{busy === "plan" ? "Planning…" : "Plan this goal"}</button>
    </>}
    {draft && !result && draft.status === "questions" && <>
      <p className="planner-round">Round {draft.round}</p>
      <div className="planner-questions">{draft.questions.map((question) => <div className="planner-question" key={question.id}>
        <label><span>{question.text}</span><textarea aria-label={question.text} value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} rows={2} maxLength={2_000} /></label>
        {question.options.length > 0 && <div className="planner-options">{question.options.map((option) => <button type="button" key={option} aria-label={`Answer ${question.text} with ${option}`} className={answers[question.id] === option ? "selected" : ""} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>)}</div>}
      </div>)}</div>
      {error && <p className="worktree-action-error">{error}</p>}
      <div className="planner-actions"><button type="button" disabled={busy === "answer"} onClick={() => answer({ skip: true })}>Skip questions</button><button type="button" className="primary-button" disabled={busy === "answer"} onClick={() => answer({ answers: draft.questions.map((question) => ({ id: question.id, text: answers[question.id] || "" })).filter((entry) => entry.text.trim()) })}>{busy === "answer" ? "Sending…" : "Answer"}</button></div>
    </>}
    {draft && !result && draft.status === "ready" && <>
      <p className="planner-round">Round {draft.round} · {draft.tasks.length} task{draft.tasks.length === 1 ? "" : "s"}</p>
      <div className="planner-tasks">{draft.tasks.map((task) => <article className="planner-task" key={task.id}>
        <header><strong>{task.title}</strong><button type="button" className="planner-remove-task" aria-label={`Remove ${task.title}`} disabled={busy === "edit" || draft.tasks.length < 2} onClick={() => editTasks(draft.tasks.filter((item) => item.id !== task.id))}>×</button></header>
        <code className="planner-branch">{task.branch}</code>
        <div className="planner-agent" role="group" aria-label={`Agent for ${task.title}`}>{AGENTS.map((option) => <button type="button" key={option} aria-label={`Use ${agentLabel(option)} for ${task.title}`} aria-pressed={task.agent === option} className={task.agent === option ? "selected" : ""} disabled={busy === "edit"} onClick={() => editTasks(draft.tasks.map((item) => item.id === task.id ? { ...item, agent: option } : item))}>{agentLabel(option)}</button>)}</div>
        <small className="planner-agent-reason">{task.agentReason}</small>
        <details className="planner-prompt"><summary aria-label={`Prompt for ${task.title}`}>Prompt</summary><p>{task.prompt}</p></details>
      </article>)}</div>
      {busy === "launch" && <p className="planner-waiting">Creating worktrees and starting sessions. This can take a minute.</p>}
      {error && <p className="worktree-action-error">{error}</p>}
      <button type="button" className="primary-button" disabled={busy !== ""} onClick={launch}>{busy === "launch" ? "Launching…" : `Launch ${draft.tasks.length} session${draft.tasks.length === 1 ? "" : "s"}`}</button>
    </>}
    {result && <>
      <p className="planner-round">Branched from <code>{result.base}</code> · {result.launched} of {result.results.length} started</p>
      <div className="planner-results">{result.results.map((row) => <div className={`planner-result ${row.status}`} key={row.id}>
        <header><strong>{row.title}</strong><em>{row.status === "launched" ? "Launched" : "Failed"}</em></header>
        <code className="planner-branch">{row.branch}</code><small>{agentLabel(row.agent)}</small>
        {row.status === "failed" && row.error && <small className="planner-result-error">{row.error}</small>}
        {row.status === "failed" && row.path && <small className="planner-result-leftover">Its worktree is still on disk at <code>{compactPath(row.path)}</code>, with no session. Remove it from the dashboard before reusing this branch.</small>}
      </div>)}</div>
      {busy === "launch" && <p className="planner-waiting">Creating worktrees and starting sessions. This can take a minute.</p>}
      {error && <p className="worktree-action-error">{error}</p>}
      {failed.length > 0 && !canRetry && <p className="planner-no-retry">This plan is spent because part of it started. Finish the rest from the dashboard by creating those worktrees yourself.</p>}
      <div className="planner-actions">{canRetry && <button type="button" className="primary-button" disabled={busy === "launch"} onClick={launch}>{busy === "launch" ? "Launching…" : "Try again"}</button>}<button type="button" onClick={onClose}>Done</button></div>
    </>}
  </form></>;
}
