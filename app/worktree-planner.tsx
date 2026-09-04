"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { PLANNER_ENGINES, reviewerEngine } from "../server/worktree-planner-options.mjs";
import { AttachmentReview, AttachmentStrip, imageReferences, ImagePickerButton, request, useImageAttachments } from "./image-attachments";
// One shared predicate: two copies had already drifted, so the sheet read
// "1 of 2 ready" while the group read 1/1.
import { readyCount } from "../server/delivery-contract.mjs";
import { PromptDisclosure } from "./prompt-markdown";

export type PlanAgent = "claude" | "codex";
export type PlanQuestion = { id: string; text: string; options: string[] };
export type CompletionReport = { criteria: string[]; verification: { check: string; status: "passed" | "failed" | "not_run" }[]; limitations: string[] };
export type PlanCriterion = { id: string; text: string; verification: string };
export type PlanSpec = { version?: number; outcome: string; inScope: string[]; nonGoals: string[]; constraints: string[]; assumptions: string[]; acceptanceCriteria: PlanCriterion[]; risks: { text: string; mitigation: string; level: string }[] };
export type PlanReadiness = { ready: boolean; errors: string[]; warnings: string[]; waves: string[][]; coverage: { criterionId: string; taskIds: string[] }[] };
export type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: PlanAgent; agentReason: string; type?: string; criterionIds?: string[]; dependsOn?: string[]; ownedAreas?: string[]; verification?: string[]; wave?: number; launchStatus?: string; deliveryStatus?: string; completionReport?: CompletionReport | null; evidenceStatus?: string | null; evidenceError?: string | null; changedFiles?: string[]; scopeWarnings?: string[]; workspaceId?: string | null; worktreePath?: string | null };
export type PlanImage = { path: string; name: string };
export type PlanRun = { planId: string; kind: string; phase: "running" | "done" | "failed"; step: string; error: string; startedAt: number; finishedAt: number | null };
export type PlannerProvider = "claude" | "codex";
export type PlannerEngine = { provider: PlannerProvider; model: string; effort: string; reviewer: boolean };
// The eight lifecycle ids come from server/goal-board.mjs. The board and the
// planner sheet read the same ids, so a card and its sheet never disagree.
export type GoalBoardStateId = "writing_spec" | "review_spec" | "waiting_for_dev" | "dev_in_progress" | "waiting_for_merge" | "blocked" | "merged" | "aborted";
// Every verdict server/goal-health.mjs can return, worst first. The sweep and
// the plan list both send one of these words and nothing else.
export type GoalHealth = "failed" | "dead" | "idle" | "needs_you" | "working" | "ready" | "integrated" | "queued" | "unknown";
export type GoalBoardStatus = "merged" | "aborted";
export type GoalBoardPrState = "OPEN" | "CLOSED" | "MERGED";
// Every plan payload carries these. `boardState` is the server's derivation,
// and the other fields are the structured evidence behind it.
export type GoalBoardFields = { boardState?: GoalBoardStateId | null; boardStatus?: GoalBoardStatus | null; boardChangedAt?: string | null; boardPrNumber?: number | null; boardPrUrl?: string | null; boardPrState?: GoalBoardPrState | null; boardPrObservedAt?: string | null; runStage?: string | null };
export type PlanSummary = { planId: string; repositoryId: string; repositoryName: string; goal: string; status: "draft" | "launched"; stage: "questions" | "ready"; running?: boolean; runPhase?: string | null; runStep?: string; runError?: string; lastError?: string | null; lastErrorAt?: string | null; issueNumbers?: number[]; deliveryMode?: "single" | "combined"; deliveryStatus?: string; deliveryError?: string | null; mergeStatus?: string | null; mergeWorkspaceId?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; round: number; taskCount: number; launchedCount: number; readyCount?: number; failedCount?: number; skippedCount?: number; queuedCount?: number; agentSplit?: { claude: number; codex: number }; workspaceIds?: string[]; health?: GoalHealth | null; healthReason?: string | null; stuckCount?: number | null; createdAt: string; updatedAt: string; launchedAt: string | null } & GoalBoardFields;
export type PlanDraft = { planId: string; repositoryId: string; repositoryName?: string; goal: string; running?: boolean; runPhase?: string | null; runStep?: string; runError?: string; lastError?: string | null; lastErrorAt?: string | null; images?: PlanImage[]; issueNumbers?: number[]; issueUrls?: string[]; deliveryPolicy?: "auto" | "combined"; engine?: PlannerEngine; round: number; status: "questions" | "ready"; stage?: "questions" | "ready"; planStatus?: "draft" | "launched"; contractVersion?: number; spec?: PlanSpec | null; readiness?: PlanReadiness | null; deliveryMode?: "single" | "combined"; deliveryStatus?: string; deliveryError?: string | null; integrationBranch?: string | null; integrationWorktreePath?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null; questions: PlanQuestion[]; tasks: PlanTask[]; createdAt?: string; updatedAt?: string; launchedAt?: string | null; base?: string; history?: unknown[] } & GoalBoardFields;
export type PlanLaunchRow = { id: string; title: string; branch: string; agent: string; status: "launched" | "failed" | "queued"; wave?: number; path?: string | null; workspace?: unknown; error?: string };
export type PlanLaunchResult = { planId: string; base: string; deliveryMode?: "single" | "combined"; launched: number; results: PlanLaunchRow[] };
type DeliveryResult = { planId: string; deliveryMode: "combined"; deliveryStatus: string; integrationBranch?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null };
type PlannerRepository = { id: string; name: string };

const LOST_SESSION = "The planner lost its session";
const AGENTS: PlanAgent[] = ["codex", "claude"];

function agentLabel(agent: string) { return agent === "claude" ? "Claude" : "Codex"; }
function modelLabel(provider: PlannerProvider, model: string) { return PLANNER_ENGINES.providers[provider].models.find((option) => option.id === model)?.label || model; }

// The sheet is a leaf with no socket in scope, so it opens its own stream. The
// round now runs in the background and streams on the plan id, which the server
// writes before the round starts, so a reopened sheet rejoins the same stream.
//
// `onEnd` fires on the "done" and "error" frames, which is how the sheet learns
// that a round it did not await has finished.
function usePlannerProgress(planId: string, onEnd?: () => void) {
  const [steps, setSteps] = useState<string[]>([]);
  // The callback closes over the draft, so it changes on every render. The ref
  // keeps the stream from tearing down and losing its replayed steps.
  const endRef = useRef(onEnd);
  useEffect(() => { endRef.current = onEnd; }, [onEnd]);
  useEffect(() => {
    if (!planId || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/worktree-plans/progress/${planId}`);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.k === "done" || event.k === "error") { source.close(); endRef.current?.(); return; }
        if (event.t) setSteps((current) => [...current, String(event.t)].slice(-8));
      } catch { /* a malformed frame is not worth failing the sheet over */ }
    };
    // EventSource retries on its own, and the replay buffer refills the list.
    source.onerror = () => {};
    return () => source.close();
  }, [planId]);
  return [steps, setSteps] as const;
}

// After the plan appears, the goal and its images leave the screen. This brings
// them back on demand, so a user can check eight tasks against what they asked.
function ContextReview({ goal, images }: { goal: string; images: { path: string; name: string; preview?: string }[] }) {
  if (!goal.trim() && !images.length) return null;
  return <div className="planner-context"><PromptDisclosure label="Your goal and attachments" summary={<>Your goal{images.length ? ` · ${images.length} image${images.length === 1 ? "" : "s"}` : ""}</>} text={goal}>
    <AttachmentReview attachments={images} />
  </PromptDisclosure></div>;
}

function ProgressSteps({ steps, waiting }: { steps: string[]; waiting: string }) {
  return <div className="planner-waiting"><span>{waiting}</span>{steps.length > 0 && <ul className="planner-progress">{steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ul>}</div>;
}

// A launched goal used to show its task states and nothing else, so a goal
// waiting on one task read as locked: the state was visible and the way out was
// not. Each waiting task now carries the same three recoveries the attention
// rail offers, plus the agent's live verdict so the user can tell a task that is
// still working from one that died an hour ago.
function DeliveryTasks({ tasks, planId, health, busy, confirming, onRelaunch, onSkip, onConfirm }: {
  tasks: PlanTask[]; planId: string; health: Record<string, TaskHealth>; busy: Record<string, boolean>;
  confirming: string; onRelaunch: (taskId: string, mode: "continue" | "restart") => void; onSkip: (taskId: string) => void; onConfirm: (key: string) => void;
}) {
  if (tasks.length === 0) return null;
  const { ready, total } = readyCount(tasks);
  return <><p className="planner-delivery-count">{ready} of {total} branches ready</p><ul className="planner-delivery-tasks" aria-label="Task delivery">{tasks.map((task) => {
    const state = taskState(task);
    const verdict = health[task.id];
    // Only a launched task that has not delivered can be recovered. A ready or
    // integrated task has nothing to redo, and a queued one has not started.
    const recoverable = task.launchStatus === "launched" && task.deliveryStatus !== "ready" && task.deliveryStatus !== "integrated";
    const relaunchKey = `relaunch:${task.id}`;
    const skipKey = `skip:${task.id}`;
    const working = busy[relaunchKey] === true || busy[skipKey] === true;
    return <li key={task.id}>
      <span>{task.title}</span>
      <code>{task.branch}</code>
      <em className={`delivery-${state.tone}`}>{state.label}</em>
      {verdict && <p className={`planner-delivery-health health-${verdict.health}`}>{verdict.reason}</p>}
      {recoverable && (confirming === `${planId}:${task.id}`
        ? <div className="planner-delivery-confirm"><span>Restart discards this task&rsquo;s branch and worktree, and everything its agent wrote. Continue keeps them.</span><div><button type="button" aria-label={`Cancel recovering ${task.title}`} onClick={() => onConfirm("")}>Cancel</button><button type="button" className="confirm-restart" aria-label={`Confirm restart ${task.title}`} disabled={working} onClick={() => onRelaunch(task.id, "restart")}>{busy[relaunchKey] ? "Restarting…" : "Confirm restart"}</button><button type="button" className="confirm-skip" aria-label={`Confirm skip ${task.title}`} disabled={working} onClick={() => onSkip(task.id)}>{busy[skipKey] ? "Skipping…" : "Skip this task"}</button></div></div>
        : <div className="planner-delivery-actions"><button type="button" aria-label={`Continue ${task.title}`} disabled={working} onClick={() => onRelaunch(task.id, "continue")}>{busy[relaunchKey] ? "Continuing…" : "Continue"}</button><button type="button" aria-label={`Restart or skip ${task.title}`} disabled={working} onClick={() => onConfirm(`${planId}:${task.id}`)}>Restart or skip…</button></div>)}
    </li>;
  })}</ul></>;
}

type TaskHealth = { health: string; reason: string };

function GoalPassport({ draft }: { draft: PlanDraft }) {
  const spec = draft.spec;
  if (!spec) return null;
  const readiness = draft.readiness;
  const waves = readiness?.waves?.length ? readiness.waves : [...new Set(draft.tasks.map((task) => task.wave || 0))].sort().map((wave) => draft.tasks.filter((task) => (task.wave || 0) === wave).map((task) => task.id));
  return <section className="goal-passport" aria-label="Goal passport">
    <header><div><small>DELIVERY CONTRACT</small><strong>{spec.outcome}</strong></div><em className={readiness?.ready === false ? "blocked" : "ready"}>{readiness?.ready === false ? "Needs work" : "Ready to code"}</em></header>
    {(readiness?.errors?.length || readiness?.warnings?.length) ? <div className="goal-passport-readiness">
      {readiness.errors?.map((item) => <p className="error" key={item}>{item}</p>)}
      {readiness.warnings?.map((item) => <p className="warning" key={item}>{item}</p>)}
    </div> : null}
    <div className="goal-passport-scope">
      <PassportList title="In scope" items={spec.inScope} empty="Defined by the outcome" />
      <PassportList title="Non-goals" items={spec.nonGoals} empty="None declared" />
      <PassportList title="Constraints" items={spec.constraints} empty="None declared" />
      <PassportList title="Assumptions" items={spec.assumptions} empty="None" />
    </div>
    {spec.risks?.length > 0 && <div className="goal-passport-block"><strong>Risks and mitigations</strong><ul className="goal-passport-risks">{spec.risks.map((risk, index) => <li key={`${index}-${risk.text}-${risk.mitigation}`}><em>{risk.level}</em><div><span>{risk.text}</span><small>{risk.mitigation || "No mitigation recorded"}</small></div></li>)}</ul></div>}
    <div className="goal-passport-block"><strong>Acceptance evidence</strong><ul className="goal-passport-criteria">{spec.acceptanceCriteria.map((criterion) => {
      const tasks = draft.tasks.filter((task) => task.criterionIds?.includes(criterion.id));
      const state = criterionState(tasks);
      return <li key={criterion.id}><code>{criterion.id}</code><div><span>{criterion.text}</span><small>{criterion.verification}</small><small>{tasks.map((task) => task.title).join(" · ") || "No task assigned"}</small></div><em className={state}>{state}</em></li>;
    })}</ul></div>
    <div className="goal-passport-block"><strong>Workflow</strong><ol className="goal-passport-waves">{waves.map((wave, index) => <li key={`${index}-${wave.join("-")}`}><span>Wave {index + 1}</span><div>{wave.map((id) => { const task = draft.tasks.find((item) => item.id === id); return <b key={id}>{task?.title || id}</b>; })}</div></li>)}</ol></div>
    <div className="goal-passport-block"><strong>Task plan</strong><ul className="goal-passport-task-plan">{draft.tasks.map((task) => <li key={task.id}><span>{task.title}</span><small>Owns: {task.ownedAreas?.join(", ") || "Not declared"}</small><small>Depends on: {task.dependsOn?.join(", ") || "None"}</small><small>Verify: {task.verification?.join(" · ") || "Not declared"}</small></li>)}</ul></div>
    {draft.tasks.some((task) => task.completionReport || task.evidenceError || task.scopeWarnings?.length) && <div className="goal-passport-block"><strong>Task evidence</strong><ul className="goal-passport-evidence">{draft.tasks.filter((task) => task.completionReport || task.evidenceError || task.scopeWarnings?.length).map((task) => <li key={task.id}><span>{task.title}</span>{task.completionReport?.verification.map((item) => <small key={`${item.check}-${item.status}`}>{item.check}: <b className={item.status}>{item.status}</b></small>)}{task.completionReport?.limitations.map((item) => <small className="limitation" key={item}>Limitation: {item}</small>)}{task.scopeWarnings?.map((item) => <small className="warning" key={item}>Outside ownership: {item}</small>)}{task.evidenceError && <small className="error">{task.evidenceError}</small>}</li>)}</ul></div>}
  </section>;
}

function PassportList({ title, items, empty }: { title: string; items?: string[]; empty: string }) {
  return <div><strong>{title}</strong>{items?.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <small>{empty}</small>}</div>;
}

function criterionState(tasks: PlanTask[]) {
  if (tasks.length && tasks.every((task) => task.deliveryStatus === "integrated")) return "integrated";
  if (tasks.length && tasks.every((task) => task.evidenceStatus === "ready" || task.deliveryStatus === "ready" || task.deliveryStatus === "integrated")) return "completed";
  return "planned";
}

function compactPath(path: string) { return path.replace(/^\/Users\/[^/]+/, "~"); }
function relativeTime(timestamp?: string) { const value = timestamp ? Date.parse(timestamp) : NaN; if (!Number.isFinite(value)) return "now"; const seconds = Math.max(0, Math.round((Date.now() - value) / 1000)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }

function normalizedDraft(draft: PlanDraft): PlanDraft {
  const storedStatus = String(draft.status || "");
  const stage = draft.stage === "ready" || draft.stage === "questions" ? draft.stage : storedStatus === "ready" ? "ready" : "questions";
  const planStatus = storedStatus === "launched" ? "launched" : draft.planStatus || "draft";
  return { ...draft, status: stage, planStatus, questions: draft.questions || [], tasks: draft.tasks || [] };
}

// The banner is the only thing that tells a reader why every control is gone.
function TerminalGoalBanner({ status, plan }: { status: GoalBoardStatus; plan: PlanDraft }) {
  const link = goalPrLink(plan);
  return <section className={`planner-terminal-banner ${status}`} aria-label={status === "merged" ? "Merged goal" : "Aborted goal"}>
    <strong>{status === "merged" ? "This goal is merged" : "This goal was aborted"}</strong>
    <p>{status === "merged"
      ? "Its pull request is merged, so the plan below is a record. No further round, launch or assembly runs on it."
      : "Its specification round and cmux sessions were cancelled. Its worktrees and branches were kept, so the plan below is a record."}</p>
    {plan.boardChangedAt && <small>{status === "merged" ? "Merged" : "Aborted"} {relativeTime(plan.boardChangedAt)} ago</small>}
    {link && <a className="planner-terminal-pr" href={link.url} target="_blank" rel="noreferrer">{link.label}</a>}
  </section>;
}

export function WorktreePlannerSheet({ repository, initialPlanId = "", onClose, onLaunched, onNotice }: { repository: PlannerRepository; initialPlanId?: string; onClose: () => void; onLaunched: () => Promise<void>; onNotice: (message: string) => void }) {
  const [goal, setGoal] = useState("");
  const [provider, setProvider] = useState<PlannerProvider>(PLANNER_ENGINES.defaultProvider as PlannerProvider);
  const [model, setModel] = useState<string>(PLANNER_ENGINES.defaultModel);
  const [effort, setEffort] = useState<string>(PLANNER_ENGINES.defaultEffort);
  const [reviewer, setReviewer] = useState(false);
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [result, setResult] = useState<PlanLaunchResult | null>(null);
  const [busy, setBusy] = useState<"" | "plan" | "answer" | "edit" | "launch" | "assemble" | "feedback">("");
  // Keyed per task, not one shared string: one task relaunching must not
  // disable the recovery buttons of every other task on the sheet.
  const [taskBusy, setTaskBusy] = useState<Record<string, boolean>>({});
  const [taskHealth, setTaskHealth] = useState<Record<string, TaskHealth>>({});
  const [confirmTask, setConfirmTask] = useState("");
  const [error, setError] = useState("");
  // The reviewer's rejection. It is cleared by receive(), so a finished round
  // never leaves the previous complaint in the box.
  const [feedback, setFeedback] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const { attachments, uploading, inputRef, addImages, pasteImages, removeImage } = useImageAttachments(onNotice);

  const receive = useCallback((next: PlanDraft) => { setDraft(normalizedDraft(next)); setResult(null); setAnswers({}); setError(""); setFeedback(""); setRejecting(false); }, []);

  // The round is no longer awaited, so the sheet reloads the plan when its
  // progress stream closes. That is what turns the live steps into a question
  // list or a task list.
  const reload = useCallback(async (planId: string) => {
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(planId)}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read the finished round"); }
  }, [receive]);

  const running = draft?.running === true;
  const [steps, setSteps] = usePlannerProgress(running ? draft.planId : "", () => { if (draft) void reload(draft.planId); });

  // The "done" frame is the fast path. This poll is the safety net for the
  // reopened sheet whose round ended while no stream was attached.
  useEffect(() => {
    if (!running || !draft) return;
    const planId = draft.planId;
    const poll = setInterval(() => { void reload(planId); }, 7_000);
    return () => clearInterval(poll);
  }, [running, draft, reload]);

  const fail = useCallback((cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback;
    if (message.startsWith(LOST_SESSION)) { setDraft(null); setAnswers({}); setResult(null); }
    setError(message);
  }, []);

  // Still used by the notification deep link, which opens one saved goal
  // straight into this sheet.
  const openPlan = useCallback(async (planId: string) => {
    setError("");
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(planId)}`)); }
    catch (cause) { fail(cause, "Could not open this goal"); }
  }, [fail, receive]);

  useEffect(() => {
    if (!initialPlanId) return;
    const kickoff = setTimeout(() => { void openPlan(initialPlanId); }, 0);
    return () => clearTimeout(kickoff);
  }, [initialPlanId, openPlan]);

  function newGoal() {
    attachments.forEach((attachment) => removeImage(attachment.path));
    setGoal(""); setDraft(null); setResult(null); setAnswers({}); setError(""); setFeedback(""); setRejecting(false);
  }

  // The round runs in the background, so this answers as soon as the plan row
  // exists. Submitting a goal is therefore fire and forget: the sheet closes,
  // a notice says the goal is planning, and the board carries it from there. A
  // failed submit keeps the sheet open, because only this sheet can show it.
  async function plan(event: FormEvent) {
    event.preventDefault();
    setBusy("plan"); setError(""); setSteps([]);
    try {
      receive(await request<PlanDraft>("/api/worktree-plans", { method: "POST", body: JSON.stringify({ repositoryId: repository.id, goal: goal.trim(), images: imageReferences(attachments), engine: { provider, model, effort, reviewer }, background: true }) }));
      onNotice(`Planning this goal on ${repository.name}. It appears in Writing Spec.`);
      onClose();
    }
    catch (cause) { fail(cause, "Could not plan this goal"); }
    finally { setBusy(""); }
  }

  async function answer(body: Record<string, unknown>) {
    if (!draft) return;
    setBusy("answer"); setError(""); setSteps([]);
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}/answers`, { method: "POST", body: JSON.stringify({ ...body, background: true }) })); }
    catch (cause) { fail(cause, "Could not send those answers"); }
    finally { setBusy(""); }
  }

  // The reviewer rejected the split. This starts a fresh planner round on the
  // same plan, so it behaves exactly like an answer: background, streamed, and
  // reloaded when the round ends.
  async function reject() {
    if (!draft || !feedback.trim()) return;
    setBusy("feedback"); setError(""); setSteps([]);
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}/feedback`, { method: "POST", body: JSON.stringify({ text: feedback.trim(), background: true }) })); }
    catch (cause) { fail(cause, "Could not send that feedback"); }
    finally { setBusy(""); }
  }

  // A companion restart leaves a plan at round zero with no round to watch.
  async function rerun() {
    if (!draft) return;
    setBusy("plan"); setError(""); setSteps([]);
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}/run`, { method: "POST", body: "{}" })); }
    catch (cause) { fail(cause, "Could not start this round again"); }
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

  // The verdict for each task, so a waiting task says whether its agent is
  // running or dead. Read once when a launched plan opens and after each
  // recovery: it costs a cmux round trip, so it does not poll here.
  const loadTaskHealth = useCallback(async (planId: string) => {
    try {
      const report = await request<{ tasks: { id: string; health: string; reason: string }[] }>(`/api/worktree-plans/${encodeURIComponent(planId)}/health`);
      setTaskHealth(Object.fromEntries((report.tasks || []).map((task) => [task.id, { health: task.health, reason: task.reason }])));
    } catch { setTaskHealth({}); }
  }, []);

  useEffect(() => {
    if (draft?.planStatus !== "launched" || !draft.planId) return;
    // Deferred by one tick, like the other loaders in this file, so the fetch
    // does not write state inside the effect's own render pass.
    const planId = draft.planId;
    const kickoff = setTimeout(() => { void loadTaskHealth(planId); }, 0);
    return () => clearTimeout(kickoff);
  }, [draft?.planStatus, draft?.planId, loadTaskHealth]);

  // One task starts again without abandoning the goal. `continue` keeps the
  // worktree and its work; `restart` discards both, so it confirms first.
  async function relaunchTask(taskId: string, mode: "continue" | "restart") {
    if (!draft) return;
    const key = `relaunch:${taskId}`;
    setTaskBusy((current) => ({ ...current, [key]: true })); setError("");
    try {
      // A crashed agent usually leaves its workspace open at a shell prompt, so
      // closing it here saves a trip to cmux. A task the sweep still reports as
      // working is never closed by a button labelled Continue.
      const verdict = taskHealth[taskId]?.health;
      const closeLive = verdict !== undefined && verdict !== "working" && verdict !== "needs_you";
      await request(`/api/worktree-plans/${draft.planId}/tasks/${encodeURIComponent(taskId)}/relaunch`, { method: "POST", body: JSON.stringify({ mode, closeLive }) });
      setConfirmTask("");
      receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}`));
      await loadTaskHealth(draft.planId);
      onNotice(mode === "restart" ? "Restarted the task from its base branch" : "Continued the task in its existing worktree");
    } catch (cause) { fail(cause, "Could not relaunch this task"); }
    finally { setTaskBusy((current) => ({ ...current, [key]: false })); }
  }

  async function skipTask(taskId: string) {
    if (!draft) return;
    const key = `skip:${taskId}`;
    setTaskBusy((current) => ({ ...current, [key]: true })); setError("");
    try {
      await request(`/api/worktree-plans/${draft.planId}/tasks/${encodeURIComponent(taskId)}/skip`, { method: "POST", body: JSON.stringify({ reason: "Skipped from the goal sheet" }) });
      setConfirmTask("");
      receive(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}`));
      await loadTaskHealth(draft.planId);
      onNotice("Skipped the task, so the goal can assemble without it");
    } catch (cause) { fail(cause, "Could not skip this task"); }
    finally { setTaskBusy((current) => ({ ...current, [key]: false })); }
  }

  // The local attachments still hold their preview data URLs, so prefer them
  // over the draft's paths for as long as this sheet is open.
  const reviewImages = attachments.length ? attachments : draft?.images || [];
  const reviewGoal = draft?.goal || goal;
  const failed = result?.results.filter((row) => row.status === "failed") || [];
  const canRetry = Boolean(result) && result?.launched === 0;
  const launchedPlan = draft?.planStatus === "launched";
  // Merged and aborted goals stay readable and deletable. Every mutating
  // control is suppressed, and the state comes from the persisted lifecycle
  // rather than from `status`, which only says draft or launched.
  const terminal = draft ? terminalStatus(draft) : null;
  // A round that never finished: the plan exists, no round is watching it, and
  // it holds neither a question nor a task. A companion restart does this.
  const stalled = Boolean(draft && !running && !launchedPlan && !terminal && draft.round === 0 && !draft.questions.length && !draft.tasks.length);
  // Why it stopped. runError is this process's memory of a round that just
  // failed and expires within a minute; lastError is the copy the plan row
  // keeps. Without either, a restart really is the likeliest cause.
  const stalledReason = draft?.runError || draft?.lastError || "";
  const heading = result ? "Launch result" : terminal ? terminal === "merged" ? "Merged goal" : "Aborted goal" : running ? "Planning this goal" : stalled ? "Planning stopped" : launchedPlan ? "Launched goal" : draft?.status === "ready" ? "Review the plan" : draft ? "A few questions" : "Plan a goal";
  // Every action on a plan needs its ccs session, and one round already owns it.
  const locked = running || busy !== "" || terminal !== null;
  const providerOptions = PLANNER_ENGINES.providers[provider];
  const reviewerConfig = reviewerEngine(provider);
  const reviewerProvider = reviewerConfig.provider as PlannerProvider;
  const reviewerOptions = PLANNER_ENGINES.providers[reviewerProvider];

  // A goal takes minutes to write and a round takes minutes to answer, so a
  // mis-tap outside the sheet must not throw both away. The header button and
  // the Done button are the ways out.
  return <><div className="session-menu-backdrop" /><form className="worktree-launcher worktree-planner-sheet" role="dialog" aria-modal="true" aria-label="Plan a goal" onSubmit={(event) => event.preventDefault()}>
    <header><div><strong>{heading}</strong><span>{repository.name}</span></div><button type="button" aria-label="Close goal planner sheet" onClick={onClose}>×</button></header>
    {(draft || result) && <button type="button" className="planner-new-goal" disabled={busy !== ""} onClick={newGoal}>← New goal</button>}
    {draft && !result && terminal && <TerminalGoalBanner status={terminal} plan={draft} />}
    {!draft && !result && <>
      <label className="worktree-task"><span>Goal</span><textarea aria-label="Goal" value={goal} onChange={(event) => setGoal(event.target.value)} onPaste={pasteImages} rows={5} maxLength={4_000} placeholder="Describe the outcome you want across parallel worktrees…" /></label>
      <AttachmentStrip attachments={attachments} onRemove={removeImage} />
      <section className="planner-engine-config" aria-label="Planner configuration">
        <header><strong>Planner</strong><span>{providerOptions.label} ({providerOptions.family}) · {model === PLANNER_ENGINES.defaultModel ? "CCS default model" : modelLabel(provider, model)}</span></header>
        <div className="planner-engine-controls">
          <label><span>Engine</span><select aria-label="Planner engine" value={provider} onChange={(event) => { setProvider(event.target.value as PlannerProvider); setModel(PLANNER_ENGINES.defaultModel); }}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
          <label><span>Model</span><select aria-label="Planner model" value={model} onChange={(event) => setModel(event.target.value)}>{providerOptions.models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
          <label><span>Effort</span><select aria-label="Planner effort" value={effort} onChange={(event) => setEffort(event.target.value)}>{PLANNER_ENGINES.efforts.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        </div>
        <label className="planner-reviewer-toggle"><input type="checkbox" aria-label="Add a reviewer pass" checked={reviewer} onChange={(event) => setReviewer(event.target.checked)} /><span>Add a reviewer pass</span></label>
        {reviewer && <p className="planner-reviewer-identity">Reviewer: {reviewerOptions.label} ({reviewerOptions.family}) · {modelLabel(reviewerProvider, reviewerConfig.model)} · {reviewerConfig.effort} effort</p>}
      </section>
      {error && <p className="worktree-action-error">{error}</p>}
      {busy === "plan" && <p className="planner-waiting">Starting the round…</p>}
      <div className="worktree-launch-actions"><ImagePickerButton attachments={attachments} disabled={busy === "plan" || uploading > 0} inputRef={inputRef} label="Choose goal images" onFiles={(files) => { void addImages(files); }} /><button type="button" className="primary-button" disabled={busy === "plan" || uploading > 0 || !goal.trim()} onClick={plan}>{busy === "plan" ? "Planning…" : uploading ? `Uploading ${uploading}…` : "Plan this goal"}</button></div>
    </>}
    {draft && !result && running && <section className="planner-running" aria-label="Planning in progress">
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <ProgressSteps steps={steps} waiting={draft.round === 0 ? "Reading the repository. The first round is the slowest, because it starts a fresh session." : "Thinking about your answers."} />
      <p className="planner-background-note">This round runs on the companion, not in this sheet. Close it and plan another goal. A notification arrives when this one is ready.</p>
      <div className="planner-actions"><button type="button" onClick={onClose}>Close and keep planning</button></div>
    </section>}
    {draft && !result && stalled && <section className="planner-stalled" aria-label="Planning stopped">
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <p className="planner-background-note">This round stopped before it produced anything.{stalledReason ? "" : " A companion restart does this."} The goal is saved, so it can run again.</p>
      {stalledReason && <p className="planner-stalled-reason">{stalledReason}{draft.lastErrorAt ? <span> · {relativeTime(draft.lastErrorAt)} ago</span> : null}</p>}
      {error && <p className="worktree-action-error">{error}</p>}
      <div className="planner-actions"><button type="button" className="primary-button" disabled={busy !== ""} onClick={() => { void rerun(); }}>{busy === "plan" ? "Starting…" : "Plan this goal again"}</button></div>
    </section>}
    {draft && !result && !running && !stalled && draft.status === "questions" && <>
      <p className="planner-round">Round {draft.round}</p>
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <div className="planner-questions">{draft.questions.map((question) => <div className="planner-question" key={question.id}>
        <label><span>{question.text}</span><textarea aria-label={question.text} value={answers[question.id] || ""} readOnly={launchedPlan || terminal !== null} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} rows={2} maxLength={2_000} /></label>
        {question.options.length > 0 && <div className="planner-options">{question.options.map((option) => <button type="button" key={option} aria-label={`Answer ${question.text} with ${option}`} className={answers[question.id] === option ? "selected" : ""} disabled={launchedPlan || terminal !== null} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>)}</div>}
      </div>)}</div>
      {error && <p className="worktree-action-error">{error}</p>}
      {launchedPlan || terminal ? <p className="planner-launched-note">{terminal ? "This goal is closed. Its questions and answers are read-only." : "This goal was already launched. Its questions and answers are read-only."}</p> : <div className="planner-actions"><button type="button" disabled={locked} onClick={() => answer({ skip: true })}>Skip questions</button><button type="button" className="primary-button" disabled={locked} onClick={() => answer({ answers: draft.questions.map((question) => ({ id: question.id, text: answers[question.id] || "" })).filter((entry) => entry.text.trim()) })}>{busy === "answer" ? "Sending…" : "Answer"}</button></div>}
    </>}
    {draft && !result && !running && !stalled && draft.status === "ready" && <>
      <p className="planner-round">Round {draft.round} · {draft.tasks.length} task{draft.tasks.length === 1 ? "" : "s"}</p>
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <GoalPassport draft={draft} />
      {draft.tasks.length > 1 && <section className="planner-delivery-mode" aria-label="Combined pull request delivery"><strong>One combined PR</strong><p>Task agents commit and push isolated branches. Companion pins their commits and starts a merge agent that resolves conflicts, verifies against a baseline, and opens one pull request.</p></section>}
      <div className="planner-tasks">{draft.tasks.map((task) => <article className="planner-task" key={task.id}>
        <header><strong>{task.title}</strong>{!launchedPlan && !terminal && <button type="button" className="planner-remove-task" aria-label={`Remove ${task.title}`} disabled={locked || draft.tasks.length < 2} onClick={() => editTasks(draft.tasks.filter((item) => item.id !== task.id))}>×</button>}</header>
        <code className="planner-branch">{task.branch}</code>
        <div className="planner-agent" role="group" aria-label={`Agent for ${task.title}`}>{AGENTS.map((option) => <button type="button" key={option} aria-label={`Use ${agentLabel(option)} for ${task.title}`} aria-pressed={task.agent === option} className={task.agent === option ? "selected" : ""} disabled={locked || launchedPlan} onClick={() => editTasks(draft.tasks.map((item) => item.id === task.id ? { ...item, agent: option } : item))}>{agentLabel(option)}</button>)}</div>
        <small className="planner-agent-reason">{task.agentReason}</small>
        <PromptDisclosure label={`Prompt for ${task.title}`} summary="Prompt" text={task.prompt} />
      </article>)}</div>
      {busy === "launch" && <p className="planner-waiting">Creating worktrees and starting sessions. This can take a minute.</p>}
      {!launchedPlan && !terminal && <section className="planner-reject" aria-label="Reject this plan">
        {rejecting ? <>
          <label><span>What is wrong with this split?</span><textarea aria-label="What is wrong with this split?" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} maxLength={2_000} placeholder="Tasks 2 and 3 touch the same file, so they cannot run in parallel…" /></label>
          <p>This starts a new planner round. It replaces every task above with a fresh split.</p>
          <div className="planner-actions"><button type="button" disabled={locked} onClick={() => { setRejecting(false); setFeedback(""); }}>Cancel</button><button type="button" className="primary-button" disabled={locked || !feedback.trim()} onClick={() => { void reject(); }}>{busy === "feedback" ? "Sending…" : "Analyse this goal again"}</button></div>
        </> : <button type="button" className="planner-reject-open" disabled={locked} onClick={() => setRejecting(true)}>This plan is wrong</button>}
      </section>}
      {error && <p className="worktree-action-error">{error}</p>}
      {terminal ? <section className="planner-delivery-status" aria-label="Recorded delivery status"><strong>{terminal === "merged" ? "Merged" : "Aborted"}</strong><DeliveryTasks tasks={draft.tasks} planId={draft.planId} health={taskHealth} busy={taskBusy} confirming={confirmTask} onRelaunch={(taskId, mode) => { void relaunchTask(taskId, mode); }} onSkip={(taskId) => { void skipTask(taskId); }} onConfirm={setConfirmTask} />{draft.integrationBranch && <code>{draft.integrationBranch}</code>}{draft.deliveryError && <p>{draft.deliveryError}</p>}</section>
        : launchedPlan ? draft.deliveryMode === "combined" ? <section className="planner-delivery-status" aria-label="Combined delivery status"><strong>{draft.finalPrUrl ? "Combined PR ready" : deliveryLabel(draft.deliveryStatus)}</strong><DeliveryTasks tasks={draft.tasks} planId={draft.planId} health={taskHealth} busy={taskBusy} confirming={confirmTask} onRelaunch={(taskId, mode) => { void relaunchTask(taskId, mode); }} onSkip={(taskId) => { void skipTask(taskId); }} onConfirm={setConfirmTask} />{draft.integrationBranch && <code>{draft.integrationBranch}</code>}{draft.deliveryError && <p>{draft.deliveryError}</p>}{draft.finalPrUrl ? <a href={draft.finalPrUrl} target="_blank" rel="noreferrer">Open PR{draft.finalPrNumber ? ` #${draft.finalPrNumber}` : ""}</a> : <button type="button" className="primary-button" disabled={locked} onClick={() => { void assemble(); }}>{busy === "assemble" ? "Checking branches…" : "Check & build combined PR"}</button>}</section> : <p className="planner-launched-note">This goal was already launched. The saved plan is read-only.</p>
        : <button type="button" className="primary-button" disabled={locked} onClick={launch}>{busy === "launch" ? "Launching…" : launchLabel(draft)}</button>}
    </>}
    {result && <>
      <p className="planner-round">Branched from <code>{result.base}</code> · {result.launched} of {result.results.length} started</p>
      {result.deliveryMode === "combined" && <section className="planner-delivery-mode" aria-label="Combined pull request delivery"><strong>One combined PR</strong><p>Each agent will commit and push its task branch without opening a PR. When every branch is ready, a merge agent will resolve conflicts and open one pull request.</p></section>}
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <div className="planner-results">{result.results.map((row) => <div className={`planner-result ${row.status}`} key={row.id}>
        <header><strong>{row.title}</strong><em>{row.status === "launched" ? "Launched" : row.status === "queued" ? `Queued · wave ${(row.wave || 0) + 1}` : "Failed"}</em></header>
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

// A terminal goal is decided by its persisted lifecycle only. A launched plan
// with a merged pull request is not terminal until the server records it.
export function terminalStatus(plan: { boardStatus?: GoalBoardStatus | null }) {
  return plan.boardStatus === "merged" || plan.boardStatus === "aborted" ? plan.boardStatus : null;
}

// The observed pull request is the board's evidence. The final PR is the one
// the merge agent opened. Either one is worth a link.
export function goalPrLink(plan: { boardPrUrl?: string | null; boardPrNumber?: number | null; finalPrUrl?: string | null; finalPrNumber?: number | null }) {
  const url = plan.boardPrUrl || plan.finalPrUrl || "";
  if (!url) return null;
  const number = plan.boardPrUrl ? plan.boardPrNumber : plan.finalPrNumber;
  return { url, label: number ? `Open PR #${number}` : "Open PR" };
}

function deliveryLabel(status?: string) {
  if (status === "assembling") return "A merge agent is assembling this goal";
  if (status === "blocked") return "Combined delivery needs attention";
  if (status === "pr_open") return "Combined PR ready";
  return "Waiting for task branches";
}

function taskState(task: PlanTask) {
  if (task.launchStatus === "queued") return { label: `Queued · wave ${(task.wave || 0) + 1}`, tone: "queued" };
  if (task.launchStatus && task.launchStatus !== "launched") return { label: "Not launched", tone: "not-launched" };
  if (task.deliveryStatus === "integrated") return { label: "Merged", tone: "merged" };
  if (task.deliveryStatus === "ready") return { label: "Ready", tone: "ready" };
  return { label: "Waiting", tone: "waiting" };
}

function launchLabel(draft: PlanDraft) {
  const waves = draft.readiness?.waves || [];
  if (waves.length > 1) {
    const count = waves[0]?.length || draft.tasks.filter((task) => (task.wave || 0) === 0).length;
    return `Start workflow · ${count} session${count === 1 ? "" : "s"} in wave 1`;
  }
  return `Launch ${draft.tasks.length} session${draft.tasks.length === 1 ? "" : "s"}`;
}
