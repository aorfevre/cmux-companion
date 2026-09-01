"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AttachmentReview, AttachmentStrip, imageReferences, ImagePickerButton, request, useImageAttachments } from "./image-attachments";

export type PlanAgent = "claude" | "codex";
export type PlanQuestion = { id: string; text: string; options: string[] };
export type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: PlanAgent; agentReason: string };
export type PlanImage = { path: string; name: string };
export type PlanSummary = { planId: string; repositoryId: string; repositoryName: string; goal: string; status: "draft" | "launched"; stage: "questions" | "ready"; deliveryMode?: "single" | "combined"; deliveryStatus?: string; finalPrNumber?: number | null; finalPrUrl?: string | null; round: number; taskCount: number; launchedCount: number; createdAt: string; updatedAt: string; launchedAt: string | null };
export type PlanDraft = { planId: string; repositoryId: string; repositoryName?: string; goal: string; images?: PlanImage[]; round: number; status: "questions" | "ready"; stage?: "questions" | "ready"; planStatus?: "draft" | "launched"; deliveryMode?: "single" | "combined"; deliveryStatus?: string; deliveryError?: string | null; integrationBranch?: string | null; integrationWorktreePath?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null; questions: PlanQuestion[]; tasks: PlanTask[]; createdAt?: string; updatedAt?: string; launchedAt?: string | null; base?: string; history?: unknown[] };
export type PlanLaunchRow = { id: string; title: string; branch: string; agent: string; status: "launched" | "failed"; path?: string | null; workspace?: unknown; error?: string };
export type PlanLaunchResult = { planId: string; base: string; deliveryMode?: "single" | "combined"; launched: number; results: PlanLaunchRow[] };
type DeliveryResult = { planId: string; deliveryMode: "combined"; deliveryStatus: string; integrationBranch?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null };
type PlannerRepository = { id: string; name: string };

const LOST_SESSION = "The planner lost its session";
const AGENTS: PlanAgent[] = ["codex", "claude"];

function agentLabel(agent: string) { return agent === "claude" ? "Claude" : "Codex"; }

// The sheet is a leaf with no socket in scope, so it opens its own stream. The
// trace id exists before the request because round one, the slow one, has no
// plan id until it finishes.
function usePlannerProgress(traceId: string) {
  const [steps, setSteps] = useState<string[]>([]);
  useEffect(() => {
    if (!traceId || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/worktree-plans/progress/${traceId}`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.k === "done" || event.k === "error") { source.close(); return; }
        if (event.t) setSteps((current) => [...current, String(event.t)].slice(-8));
      } catch { /* a malformed frame is not worth failing the sheet over */ }
    };
    // EventSource retries on its own, and the replay buffer refills the list.
    source.onerror = () => {};
    return () => source.close();
  }, [traceId]);
  return [steps, setSteps] as const;
}

// After the plan appears, the goal and its images leave the screen. This brings
// them back on demand, so a user can check eight tasks against what they asked.
function ContextReview({ goal, images }: { goal: string; images: { path: string; name: string; preview?: string }[] }) {
  if (!goal.trim() && !images.length) return null;
  return <details className="planner-prompt planner-context"><summary aria-label="Your goal and attachments">Your goal{images.length ? ` · ${images.length} image${images.length === 1 ? "" : "s"}` : ""}</summary>
    <p>{goal}</p>
    <AttachmentReview attachments={images} />
  </details>;
}

function ProgressSteps({ steps, waiting }: { steps: string[]; waiting: string }) {
  return <div className="planner-waiting"><span>{waiting}</span>{steps.length > 0 && <ul className="planner-progress">{steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ul>}</div>;
}

function newTraceId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : "";
}
function compactPath(path: string) { return path.replace(/^\/Users\/[^/]+/, "~"); }
function relativeTime(timestamp?: string) { const value = timestamp ? Date.parse(timestamp) : NaN; if (!Number.isFinite(value)) return "now"; const seconds = Math.max(0, Math.round((Date.now() - value) / 1000)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }

function normalizedDraft(draft: PlanDraft): PlanDraft {
  const storedStatus = String(draft.status || "");
  const stage = draft.stage === "ready" || draft.stage === "questions" ? draft.stage : storedStatus === "ready" ? "ready" : "questions";
  const planStatus = storedStatus === "launched" ? "launched" : draft.planStatus || "draft";
  return { ...draft, status: stage, planStatus, questions: draft.questions || [], tasks: draft.tasks || [] };
}

export function WorktreePlannerSheet({ repository, initialPlanId = "", onClose, onLaunched, onNotice }: { repository: PlannerRepository; initialPlanId?: string; onClose: () => void; onLaunched: () => Promise<void>; onNotice: (message: string) => void }) {
  const [goal, setGoal] = useState("");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PlanLaunchResult | null>(null);
  const [busy, setBusy] = useState<"" | "plan" | "answer" | "edit" | "launch" | "assemble">("");
  const [openingPlanId, setOpeningPlanId] = useState("");
  const [deletingPlanId, setDeletingPlanId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const [error, setError] = useState("");
  const [traceId, setTraceId] = useState("");
  const { attachments, uploading, inputRef, addImages, pasteImages, removeImage } = useImageAttachments(onNotice);
  const [steps, setSteps] = usePlannerProgress(traceId);

  const receive = useCallback((next: PlanDraft) => { setDraft(normalizedDraft(next)); setResult(null); setAnswers({}); setError(""); }, []);

  const fail = useCallback((cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback;
    if (message.startsWith(LOST_SESSION)) { setDraft(null); setAnswers({}); setResult(null); }
    setError(message);
  }, []);

  const loadPlans = useCallback(async () => {
    try {
      const response = await request<{ plans: PlanSummary[] }>(`/api/worktree-plans?repositoryId=${encodeURIComponent(repository.id)}`);
      setPlans(Array.isArray(response.plans) ? response.plans : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load saved goals"); }
  }, [repository.id]);

  const openPlan = useCallback(async (planId: string) => {
    setOpeningPlanId(planId); setError("");
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(planId)}`)); }
    catch (cause) { fail(cause, "Could not open this goal"); }
    finally { setOpeningPlanId(""); }
  }, [fail, receive]);

  useEffect(() => {
    const kickoff = setTimeout(() => {
      void loadPlans();
      if (initialPlanId) void openPlan(initialPlanId);
    }, 0);
    return () => clearTimeout(kickoff);
  }, [initialPlanId, loadPlans, openPlan]);

  async function deletePlan(planId: string) {
    setDeletingPlanId(planId); setError("");
    try {
      await request<{ deleted: true }>(`/api/worktree-plans/${encodeURIComponent(planId)}`, { method: "DELETE" });
      setPlans((current) => current.filter((plan) => plan.planId !== planId));
      setConfirmDeleteId("");
    } catch (cause) { fail(cause, "Could not delete this goal"); }
    finally { setDeletingPlanId(""); }
  }

  function newGoal() {
    attachments.forEach((attachment) => removeImage(attachment.path));
    setGoal(""); setDraft(null); setResult(null); setAnswers({}); setError(""); setConfirmDeleteId("");
    void loadPlans();
  }

  async function plan(event: FormEvent) {
    event.preventDefault();
    const trace = newTraceId();
    setBusy("plan"); setError(""); setSteps([]); setTraceId(trace);
    try { receive(await request<PlanDraft>("/api/worktree-plans", { method: "POST", body: JSON.stringify({ repositoryId: repository.id, goal: goal.trim(), images: imageReferences(attachments), traceId: trace }) })); }
    catch (cause) { fail(cause, "Could not plan this goal"); }
    finally { setBusy(""); setTraceId(""); }
  }

  async function answer(body: Record<string, unknown>) {
    if (!draft) return;
    const trace = newTraceId();
    setBusy("answer"); setError(""); setSteps([]); setTraceId(trace);
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}/answers`, { method: "POST", body: JSON.stringify({ ...body, traceId: trace }) })); }
    catch (cause) { fail(cause, "Could not send those answers"); }
    finally { setBusy(""); setTraceId(""); }
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
      const response = await request<Omit<PlanLaunchResult, "launched"> & { launched?: number }>(`/api/worktree-plans/${draft.planId}/launch`, { method: "POST", body: "{}" });
      const launchResult = { ...response, launched: response.launched ?? response.results.filter((row) => row.status === "launched").length };
      setResult(launchResult);
      if (launchResult.launched > 0) { onNotice(`Launched ${launchResult.launched} session${launchResult.launched === 1 ? "" : "s"} from ${launchResult.base}`); await onLaunched(); }
    } catch (cause) { fail(cause, "Could not launch this plan"); }
    finally { setBusy(""); }
  }

  async function assemble() {
    if (!draft || busy) return;
    setBusy("assemble"); setError("");
    try {
      const delivery = await request<DeliveryResult>(`/api/worktree-plans/${draft.planId}/assemble`, { method: "POST", body: "{}" });
      const refreshed = await request<PlanDraft>(`/api/worktree-plans/${draft.planId}`);
      receive(refreshed);
      if (delivery.finalPrUrl) onNotice(`Combined PR #${delivery.finalPrNumber || ""} is ready`.trim());
    } catch (cause) { fail(cause, "Could not build the combined pull request"); }
    finally { setBusy(""); }
  }

  // The local attachments still hold their preview data URLs, so prefer them
  // over the draft's paths for as long as this sheet is open.
  const reviewImages = attachments.length ? attachments : draft?.images || [];
  const reviewGoal = draft?.goal || goal;
  const failed = result?.results.filter((row) => row.status === "failed") || [];
  const canRetry = Boolean(result) && result?.launched === 0;
  const launchedPlan = draft?.planStatus === "launched";
  const heading = result ? "Launch result" : launchedPlan ? "Launched goal" : draft?.status === "ready" ? "Review the plan" : draft ? "A few questions" : "Plan a goal";

  // A goal takes minutes to write and a round takes minutes to answer, so a
  // mis-tap outside the sheet must not throw both away. The header button and
  // the Done button are the ways out.
  return <><div className="session-menu-backdrop" /><form className="worktree-launcher worktree-planner-sheet" role="dialog" aria-modal="true" aria-label="Plan a goal" onSubmit={(event) => event.preventDefault()}>
    <header><div><strong>{heading}</strong><span>{repository.name}</span></div><button type="button" aria-label="Close goal planner sheet" onClick={onClose}>×</button></header>
    {(draft || result) && <button type="button" className="planner-new-goal" disabled={busy !== ""} onClick={newGoal}>← New goal</button>}
    {!draft && !result && <>
      {plans.length > 0 && <section className="planner-saved" aria-label="Saved goals"><strong>Saved goals</strong><div>{plans.map((saved) => <article className="planner-saved-row" key={saved.planId}>
        <div className="planner-saved-copy"><div><p>{saved.goal}</p><span className={`planner-status ${saved.status}`}>{saved.status === "draft" ? "Draft" : "Launched"}</span></div><small>round {saved.round} · {saved.taskCount} task{saved.taskCount === 1 ? "" : "s"} · {relativeTime(saved.updatedAt)}</small></div>
        {confirmDeleteId === saved.planId ? <div className="planner-delete-confirm"><button type="button" disabled={deletingPlanId === saved.planId} aria-label={`Cancel deleting ${saved.goal}`} onClick={() => setConfirmDeleteId("")}>Cancel</button><button type="button" className="confirm-delete" disabled={deletingPlanId === saved.planId} aria-label={`Confirm delete ${saved.goal}`} onClick={() => { void deletePlan(saved.planId); }}>{deletingPlanId === saved.planId ? "Deleting…" : "Confirm delete"}</button></div> : <div className="planner-saved-actions"><button type="button" className="planner-open-plan" disabled={openingPlanId !== "" || deletingPlanId !== ""} aria-label={`${saved.status === "draft" ? "Resume" : "View"} ${saved.goal}`} onClick={() => { void openPlan(saved.planId); }}>{openingPlanId === saved.planId ? "Opening…" : saved.status === "draft" ? "Resume" : "View"}</button><button type="button" className="planner-delete-plan" disabled={openingPlanId !== "" || deletingPlanId !== ""} aria-label={`Delete ${saved.goal}`} onClick={() => setConfirmDeleteId(saved.planId)}>Delete</button></div>}
      </article>)}</div></section>}
      <label className="worktree-task"><span>Goal</span><textarea aria-label="Goal" value={goal} onChange={(event) => setGoal(event.target.value)} onPaste={pasteImages} rows={5} maxLength={4_000} placeholder="Describe the outcome you want across parallel worktrees…" /></label>
      <AttachmentStrip attachments={attachments} onRemove={removeImage} />
      {error && <p className="worktree-action-error">{error}</p>}
      {busy === "plan" && <ProgressSteps steps={steps} waiting="Reading the repository. The first round is the slowest, because it starts a fresh session." />}
      <div className="worktree-launch-actions"><ImagePickerButton attachments={attachments} disabled={busy === "plan" || uploading > 0} inputRef={inputRef} label="Choose goal images" onFiles={(files) => { void addImages(files); }} /><button type="button" className="primary-button" disabled={busy === "plan" || uploading > 0 || !goal.trim()} onClick={plan}>{busy === "plan" ? "Planning…" : uploading ? `Uploading ${uploading}…` : "Plan this goal"}</button></div>
    </>}
    {draft && !result && draft.status === "questions" && <>
      <p className="planner-round">Round {draft.round}</p>
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <div className="planner-questions">{draft.questions.map((question) => <div className="planner-question" key={question.id}>
        <label><span>{question.text}</span><textarea aria-label={question.text} value={answers[question.id] || ""} readOnly={launchedPlan} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} rows={2} maxLength={2_000} /></label>
        {question.options.length > 0 && <div className="planner-options">{question.options.map((option) => <button type="button" key={option} aria-label={`Answer ${question.text} with ${option}`} className={answers[question.id] === option ? "selected" : ""} disabled={launchedPlan} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>)}</div>}
      </div>)}</div>
      {busy === "answer" && <ProgressSteps steps={steps} waiting="Thinking about your answers." />}
      {error && <p className="worktree-action-error">{error}</p>}
      {launchedPlan ? <p className="planner-launched-note">This goal was already launched. Its questions and answers are read-only.</p> : <div className="planner-actions"><button type="button" disabled={busy === "answer"} onClick={() => answer({ skip: true })}>Skip questions</button><button type="button" className="primary-button" disabled={busy === "answer"} onClick={() => answer({ answers: draft.questions.map((question) => ({ id: question.id, text: answers[question.id] || "" })).filter((entry) => entry.text.trim()) })}>{busy === "answer" ? "Sending…" : "Answer"}</button></div>}
    </>}
    {draft && !result && draft.status === "ready" && <>
      <p className="planner-round">Round {draft.round} · {draft.tasks.length} task{draft.tasks.length === 1 ? "" : "s"}</p>
      <ContextReview goal={reviewGoal} images={reviewImages} />
      {draft.tasks.length > 1 && <section className="planner-delivery-mode" aria-label="Combined pull request delivery"><strong>One combined PR</strong><p>Task agents commit and push isolated branches. Companion pins their commits, assembles them on a fresh goal branch, runs the repository verification gate, and opens one pull request.</p></section>}
      <div className="planner-tasks">{draft.tasks.map((task) => <article className="planner-task" key={task.id}>
        <header><strong>{task.title}</strong>{!launchedPlan && <button type="button" className="planner-remove-task" aria-label={`Remove ${task.title}`} disabled={busy === "edit" || draft.tasks.length < 2} onClick={() => editTasks(draft.tasks.filter((item) => item.id !== task.id))}>×</button>}</header>
        <code className="planner-branch">{task.branch}</code>
        <div className="planner-agent" role="group" aria-label={`Agent for ${task.title}`}>{AGENTS.map((option) => <button type="button" key={option} aria-label={`Use ${agentLabel(option)} for ${task.title}`} aria-pressed={task.agent === option} className={task.agent === option ? "selected" : ""} disabled={busy === "edit" || launchedPlan} onClick={() => editTasks(draft.tasks.map((item) => item.id === task.id ? { ...item, agent: option } : item))}>{agentLabel(option)}</button>)}</div>
        <small className="planner-agent-reason">{task.agentReason}</small>
        <details className="planner-prompt"><summary aria-label={`Prompt for ${task.title}`}>Prompt</summary><p>{task.prompt}</p></details>
      </article>)}</div>
      {busy === "launch" && <p className="planner-waiting">Creating worktrees and starting sessions. This can take a minute.</p>}
      {error && <p className="worktree-action-error">{error}</p>}
      {launchedPlan ? draft.deliveryMode === "combined" ? <section className="planner-delivery-status" aria-label="Combined delivery status"><strong>{draft.finalPrUrl ? "Combined PR ready" : deliveryLabel(draft.deliveryStatus)}</strong>{draft.integrationBranch && <code>{draft.integrationBranch}</code>}{draft.deliveryError && <p>{draft.deliveryError}</p>}{draft.finalPrUrl ? <a href={draft.finalPrUrl} target="_blank" rel="noreferrer">Open PR{draft.finalPrNumber ? ` #${draft.finalPrNumber}` : ""}</a> : <button type="button" className="primary-button" disabled={busy !== ""} onClick={() => { void assemble(); }}>{busy === "assemble" ? "Checking branches…" : "Check & build combined PR"}</button>}</section> : <p className="planner-launched-note">This goal was already launched. The saved plan is read-only.</p> : <button type="button" className="primary-button" disabled={busy !== ""} onClick={launch}>{busy === "launch" ? "Launching…" : `Launch ${draft.tasks.length} session${draft.tasks.length === 1 ? "" : "s"}`}</button>}
    </>}
    {result && <>
      <p className="planner-round">Branched from <code>{result.base}</code> · {result.launched} of {result.results.length} started</p>
      {result.deliveryMode === "combined" && <section className="planner-delivery-mode" aria-label="Combined pull request delivery"><strong>One combined PR</strong><p>Each agent will commit and push its task branch without opening a PR. When every branch is ready, Companion will assemble and verify the goal branch automatically.</p></section>}
      <ContextReview goal={reviewGoal} images={reviewImages} />
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

function deliveryLabel(status?: string) {
  if (status === "assembling") return "Assembling task branches";
  if (status === "blocked") return "Combined delivery needs attention";
  if (status === "pr_open") return "Combined PR ready";
  return "Waiting for task branches";
}
