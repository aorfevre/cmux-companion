"use client";

import { goalPopupUrl } from "./goal-popup-url";
import { BUILTIN_MODEL_ROLES, ModelRoles, ModelSelect, ModelSettingsStatus } from "./model-settings";
import { REVIEW_AGENTS, REVIEW_OPTIONS } from "../server/review-options.mjs";
import { DEV_SETUP_GOAL } from "./dev-setup-goal";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { canRetryOnFreshBranch } from "../server/worktree-errors.mjs";
import { PLANNER_ENGINES, reviewerEngine, SPEC_OPTIONS } from "../server/worktree-planner-options.mjs";
import { AttachmentReview, AttachmentStrip, imageReferences, ImagePickerButton, request, useImageAttachments } from "./image-attachments";
// One shared predicate: two copies had already drifted, so the sheet read
// "1 of 2 ready" while the group read 1/1.
import { readyCount } from "../server/delivery-contract.mjs";
import { PromptDisclosure } from "./prompt-markdown";
import { DesignArtifacts, DesignArtifact } from "./spec-artifacts";

export type ReviewOptions = { codeReview: boolean; reviewer: "claude" | "codex"; reviewerModel: string };
export type PlanAgent = "claude" | "codex";
export type PlanQuestion = { id: string; text: string; options: string[] };
export type CompletionReport = { criteria: string[]; verification: { check: string; status: "passed" | "failed" | "not_run" }[]; limitations: string[] };
export type PlanCriterion = { id: string; text: string; verification: string };
// The six specification-rigor requests. The keys and their order come from
// SPEC_OPTIONS, so the sheet cannot offer a request the server refuses.
export type SpecOptionId = "unitTests" | "e2eTests" | "edgeCases" | "refactorPass" | "screenMocks" | "flowcharts";
export type SpecOptions = Record<SpecOptionId, boolean>;
export type SpecOptionCatalogEntry = { id: SpecOptionId; label: string; hint: string };
export type PlanOptionEvidence = { status: "planned" | "not_applicable"; rationale: string; taskIds: string[]; criterionIds: string[] };
// The server derives this. The sheet only displays it, so a status here is
// never re-computed from readiness warning prose.
export type PlanOptionCoverage = { id: SpecOptionId; requested: boolean; status: "not_requested" | "covered" | "not_applicable" | "missing"; message: string };
export type PlanSpec = { version?: number; outcome: string; inScope: string[]; nonGoals: string[]; constraints: string[]; assumptions: string[]; acceptanceCriteria: PlanCriterion[]; risks: { text: string; mitigation: string; level: string }[]; optionEvidence?: Partial<Record<SpecOptionId, PlanOptionEvidence>>; designArtifacts?: DesignArtifact[] };
export type PlanReadiness = { ready: boolean; errors: string[]; warnings: string[]; waves: string[][]; coverage: { criterionId: string; taskIds: string[] }[]; optionCoverage?: PlanOptionCoverage[] };
export type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: PlanAgent; agentReason: string; type?: string; criterionIds?: string[]; dependsOn?: string[]; ownedAreas?: string[]; verification?: string[]; wave?: number; launchStatus?: string; launchReason?: string | null; launchError?: string | null; deliveryStatus?: string; completionReport?: CompletionReport | null; evidenceStatus?: string | null; evidenceError?: string | null; changedFiles?: string[]; scopeWarnings?: string[]; workspaceId?: string | null; worktreePath?: string | null };
// One question and its answer, attached to the contract round it examined. The
// round is what keeps a suggestion from an older split out of the current one.
export type PlanDiscussion = { question: string; answer: string; contractImpact: "none" | "revision_suggested"; suggestion: string; round: number; createdAt: string };
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
export type PlanSummary = { planId: string; repositoryId: string; repositoryName: string; goal: string; status: "draft" | "launched"; stage: "questions" | "ready"; running?: boolean; launching?: boolean; runPhase?: string | null; runStep?: string; runError?: string; lastError?: string | null; lastErrorAt?: string | null; issueNumbers?: number[]; followupCount?: number; deliveryMode?: "single" | "combined"; deliveryStatus?: string; deliveryError?: string | null; mergeStatus?: string | null; mergeWorkspaceId?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; round: number; taskCount: number; launchedCount: number; readyCount?: number; failedCount?: number; skippedCount?: number; queuedCount?: number; agentSplit?: { claude: number; codex: number }; workspaceIds?: string[]; health?: GoalHealth | null; healthReason?: string | null; stuckCount?: number | null; createdAt: string; updatedAt: string; launchedAt: string | null } & GoalBoardFields;
export type GoalProposal = { intendedBehavior?: string; scope?: string[]; assumptions?: string[]; verification?: string[] };
export type PlanDraft = { planId: string; repositoryId: string; repositoryName?: string; goal: string; running?: boolean; launching?: boolean; runPhase?: string | null; runStep?: string; runError?: string; lastError?: string | null; lastErrorAt?: string | null; images?: PlanImage[]; issueNumbers?: number[]; issueUrls?: string[]; deliveryPolicy?: "auto" | "combined"; engine?: PlannerEngine; specOptions?: SpecOptions; round: number; status: "questions" | "ready"; stage?: "questions" | "ready"; planStatus?: "draft" | "launched"; contractVersion?: number; spec?: PlanSpec | null; readiness?: PlanReadiness | null; deliveryMode?: "single" | "combined"; deliveryStatus?: string; deliveryError?: string | null; integrationBranch?: string | null; integrationWorktreePath?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null; questions: PlanQuestion[]; tasks: PlanTask[]; discussion?: PlanDiscussion[]; createdAt?: string; updatedAt?: string; launchedAt?: string | null; base?: string; history?: unknown[]; workflow?: "planned" | "goal_session"; goalSessionState?: string | null; goalSessionWorkspaceId?: string | null; goalSessionGeneration?: number; proposalRevision?: number; proposal?: GoalProposal | null; approvalRevision?: number | null; transitionStatus?: string | null; goalSessionError?: string | null } & GoalBoardFields;
export type PlanLaunchRow = { id: string; title: string; branch: string; agent: string; status: "launched" | "failed" | "queued"; wave?: number; path?: string | null; workspace?: unknown; error?: string };
export type PlanLaunchResult = { planId: string; base: string; deliveryMode?: "single" | "combined"; launched: number; results: PlanLaunchRow[] };
export type TaskRelaunchResult = { branch?: string; launchReason?: string | null };
type DeliveryResult = { planId: string; deliveryMode: "combined"; deliveryStatus: string; integrationBranch?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null };
type PlannerRepository = { id: string; name: string };

const LOST_SESSION = "The planner lost its session";
const AGENTS: PlanAgent[] = ["codex", "claude"];
// One typed view of the shared catalog. The module is plain JavaScript, so the
// cast happens once here rather than at every use.
const SPEC_OPTION_CATALOG = SPEC_OPTIONS.options as readonly SpecOptionCatalogEntry[];
const SPEC_OPTION_DEFAULTS = SPEC_OPTIONS.defaults as SpecOptions;
const SPEC_OPTION_LABELS: Record<SpecOptionId, string> = SPEC_OPTION_CATALOG.reduce((labels, option) => ({ ...labels, [option.id]: option.label }), {} as Record<SpecOptionId, string>);
const COVERAGE_LABELS: Record<string, string> = { covered: "Covered", not_applicable: "Not applicable", missing: "Missing" };
// The server refuses the thirteenth question, so the sheet stops offering one
// at twelve and says the same sentence rather than waiting for the 400.
const MAX_DISCUSSION = 12;
const DISCUSSION_CAP_NOTE = `This plan has been questioned ${MAX_DISCUSSION} times. Reject it and re-plan instead`;

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

function GoalSessionProposal({ draft, busy, onApprove, onRequestChanges }: { draft: PlanDraft; busy: boolean; onApprove: () => void; onRequestChanges: (text: string) => void }) {
  const [changes, setChanges] = useState("");
  const proposal = draft.proposal;
  if (!proposal || draft.goalSessionState !== "awaiting_approval") {
    const message = draft.goalSessionError || (draft.transitionStatus === "uncertain"
      ? "The implementation handoff is uncertain. Companion will not send it again automatically."
      : draft.goalSessionState === "implementing" ? "Implementation is continuing in the same managed goal session."
        : "The agent is investigating in the visible cmux session. Reply there to steer it.");
    return <section className="planner-delivery-status" aria-label="Goal session status"><strong>Goal session</strong><p>{message}</p></section>;
  }
  return <section className="planner-delivery-status" aria-label="Proposal awaiting approval"><strong>Proposal revision {draft.proposalRevision}</strong><p>{proposal.intendedBehavior || draft.goal}</p>
    {proposal.scope?.length ? <p>Scope: {proposal.scope.join(" · ")}</p> : null}
    {proposal.assumptions?.length ? <p>Assumptions: {proposal.assumptions.join(" · ")}</p> : null}
    {proposal.verification?.length ? <p>Try and verify: {proposal.verification.join(" · ")}</p> : null}
    <p>Approve this exact revision to enable implementation. Type feedback in the goal session to request a revision.</p>
    <label><span>Request changes</span><textarea aria-label="Request proposal changes" value={changes} maxLength={4_000} rows={3} onChange={(event) => setChanges(event.target.value)} /></label>
    <div className="planner-actions"><button type="button" disabled={busy || !changes.trim()} onClick={() => onRequestChanges(changes.trim())}>Request changes</button><button type="button" className="primary-button" disabled={busy} onClick={onApprove}>{busy ? "Approving…" : "Approve and implement"}</button></div>
  </section>;
}

// A launched goal used to show its task states and nothing else, so a goal
// waiting on one task read as locked: the state was visible and the way out was
// not. Each waiting task now carries the same three recoveries the attention
// rail offers, plus the agent's live verdict so the user can tell a task that is
// still working from one that died an hour ago.
function DeliveryTasks({ tasks, planId, health, busy, confirming, onRelaunch, onSkip, onConfirm }: {
  tasks: PlanTask[]; planId: string; health: Record<string, TaskHealth>; busy: Record<string, boolean>;
  confirming: string; onRelaunch: (taskId: string, mode: "continue" | "restart" | "rebranch") => void; onSkip: (taskId: string) => void; onConfirm: (key: string) => void;
}) {
  if (tasks.length === 0) return null;
  const { ready, total } = readyCount(tasks);
  return <><p className="planner-delivery-count">{ready} of {total} branches ready</p><ul className="planner-delivery-tasks" aria-label="Task delivery">{tasks.map((task) => {
    const state = taskState(task);
    const verdict = health[task.id];
    // Only a launched task that has not delivered can be recovered. A ready or
    // integrated task has nothing to redo, and a queued one has not started.
    const recoverable = task.launchStatus === "launched" && task.deliveryStatus !== "ready" && task.deliveryStatus !== "integrated";
    const rebranchable = task.launchStatus === "failed" && canRetryOnFreshBranch(verdict?.launchReason ?? task.launchReason);
    const relaunchKey = `relaunch:${task.id}`;
    const skipKey = `skip:${task.id}`;
    const working = busy[relaunchKey] === true || busy[skipKey] === true;
    return <li key={task.id}>
      <span>{task.title}</span>
      <code>{task.branch}</code>
      <em className={`delivery-${state.tone}`}>{state.label}</em>
      {verdict && <p className={`planner-delivery-health health-${verdict.health}`}>{verdict.reason}</p>}
      {rebranchable && <><p>Retry from this task&rsquo;s base on a fresh branch; the blocked branch stays untouched.</p><div className="planner-delivery-actions"><button type="button" aria-label={`Retry on new branch for ${task.title}`} disabled={working} onClick={() => onRelaunch(task.id, "rebranch")}>{busy[relaunchKey] ? "Retrying on new branch…" : "Retry on new branch"}</button></div></>}
      {recoverable && (confirming === `${planId}:${task.id}`
        ? <div className="planner-delivery-confirm"><span>Restart discards this task&rsquo;s branch and worktree, and everything its agent wrote. Continue keeps them.</span><div><button type="button" aria-label={`Cancel recovering ${task.title}`} onClick={() => onConfirm("")}>Cancel</button><button type="button" className="confirm-restart" aria-label={`Confirm restart ${task.title}`} disabled={working} onClick={() => onRelaunch(task.id, "restart")}>{busy[relaunchKey] ? "Restarting…" : "Confirm restart"}</button><button type="button" className="confirm-skip" aria-label={`Confirm skip ${task.title}`} disabled={working} onClick={() => onSkip(task.id)}>{busy[skipKey] ? "Skipping…" : "Skip this task"}</button></div></div>
        : <div className="planner-delivery-actions"><button type="button" aria-label={`Continue ${task.title}`} disabled={working} onClick={() => onRelaunch(task.id, "continue")}>{busy[relaunchKey] ? "Continuing…" : "Continue"}</button><button type="button" aria-label={`Restart or skip ${task.title}`} disabled={working} onClick={() => onConfirm(`${planId}:${task.id}`)}>Restart or skip…</button></div>)}
    </li>;
  })}</ul></>;
}

type TaskHealth = { health: string; reason: string; launchReason?: string | null; branch?: string; session?: { id: string } | null };

function GoalPassport({ draft }: { draft: PlanDraft }) {
  const spec = draft.spec;
  if (!spec) return null;
  const readiness = draft.readiness;
  const waves = readiness?.waves?.length ? readiness.waves : [...new Set(draft.tasks.map((task) => task.wave || 0))].sort().map((wave) => draft.tasks.filter((task) => (task.wave || 0) === wave).map((task) => task.id));
  // The server already decided each status. Reading the warning strings here
  // would produce a second, drifting source of truth.
  const requestedCoverage = (readiness?.optionCoverage || []).filter((entry) => entry?.requested === true);
  const artifacts = spec.designArtifacts || [];
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
    {requestedCoverage.length > 0 && <div className="goal-passport-block"><strong>Specification coverage</strong><ul className="goal-passport-options">{requestedCoverage.map((entry) => <li key={entry.id} className={`coverage-${entry.status}`}>
      <span>{SPEC_OPTION_LABELS[entry.id] || entry.id}</span>
      <small>{entry.message || "No detail recorded"}</small>
      <em className={`coverage-${entry.status}`}>{COVERAGE_LABELS[entry.status] || entry.status}</em>
    </li>)}</ul></div>}
    {artifacts.length > 0 && <div className="goal-passport-block"><strong>Design artifacts</strong><DesignArtifacts artifacts={artifacts} /></div>}
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

// The durable thread beneath the passport. Every entry names the contract round
// it examined, because a suggestion written against round 2 is not advice about
// round 3. Only the current round therefore offers a handoff into the rejection
// panel; an older one stays readable and inert.
//
// Question and answer are model prose. They are rendered as text children with
// their line breaks preserved by CSS, so no Markdown and no markup ever runs.
function DiscussionThread({ entries, round, actionable, onUseSuggestion }: { entries: PlanDiscussion[]; round: number; actionable: boolean; onUseSuggestion: (suggestion: string) => void }) {
  if (entries.length === 0) return null;
  return <ol className="planner-discussion-list" aria-label="Discussion history">{entries.map((entry, index) => {
    const historical = entry.round !== round;
    const suggestion = entry.contractImpact === "revision_suggested" ? entry.suggestion?.trim() || "" : "";
    return <li key={`${entry.createdAt}-${index}`} className={historical ? "planner-discussion-entry historical" : "planner-discussion-entry current"}>
      <header><span className="planner-discussion-round">Round {entry.round}</span>{historical && <em className="planner-discussion-historical">Earlier contract round</em>}</header>
      <p className="planner-discussion-question"><b>You asked</b><span>{entry.question}</span></p>
      <p className="planner-discussion-answer"><b>The planner answered</b><span>{entry.answer || "No answer was recorded yet."}</span></p>
      {suggestion && <div className="planner-discussion-suggestion">
        <b>Suggested revision</b><span>{suggestion}</span>
        {/* A suggestion written against an older split cannot be acted on: it
            describes a contract that no longer exists. */}
        {actionable && !historical
          ? <button type="button" className="planner-discussion-use" onClick={() => onUseSuggestion(suggestion)}>Use this suggestion</button>
          : <small>{historical ? "This suggestion examined an earlier contract round, so it cannot be applied." : "This goal is closed to further planning rounds."}</small>}
      </div>}
    </li>;
  })}</ol>;
}

function PassportList({ title, items, empty }: { title: string; items?: string[]; empty: string }) {
  return <div><strong>{title}</strong>{items?.length ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <small>{empty}</small>}</div>;
}

function criterionState(tasks: PlanTask[]) {
  if (tasks.length && tasks.every((task) => task.deliveryStatus === "integrated")) return "integrated";
  if (tasks.length && tasks.every((task) => task.evidenceStatus === "ready" || task.deliveryStatus === "ready" || task.deliveryStatus === "integrated")) return "completed";
  return "planned";
}

function relativeTime(timestamp?: string) { const value = timestamp ? Date.parse(timestamp) : NaN; if (!Number.isFinite(value)) return "now"; const seconds = Math.max(0, Math.round((Date.now() - value) / 1000)); if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds / 60)}m`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`; return `${Math.floor(seconds / 86400)}d`; }

function normalizedDraft(draft: PlanDraft): PlanDraft {
  const storedStatus = String(draft.status || "");
  const stage = draft.stage === "ready" || draft.stage === "questions" ? draft.stage : storedStatus === "ready" ? "ready" : "questions";
  const planStatus = storedStatus === "launched" ? "launched" : draft.planStatus || "draft";
  return { ...draft, status: stage, planStatus, questions: draft.questions || [], tasks: draft.tasks || [], discussion: draft.discussion || [] };
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

export function WorktreePlannerSheet({ repository, initialPlanId = "", initialGoal = "", initialDraft, onNewGoal, onPlanResolved, onGoalSessionStarted, onClose, onNotice }: { repository: PlannerRepository; initialPlanId?: string; initialGoal?: string; initialDraft?: PlanDraft; onNewGoal?: () => void; onPlanResolved?: (draft: PlanDraft) => void; onGoalSessionStarted?: (draft: PlanDraft) => Promise<void> | void; onClose: () => void; onNotice: (message: string) => void }) {
  const [goal, setGoal] = useState(initialGoal);
  const [modelRoles, setModelRoles] = useState<ModelRoles>(BUILTIN_MODEL_ROLES);
  const [modelWarning, setModelWarning] = useState("");
  const [modelDefaultsLoading, setModelDefaultsLoading] = useState(true);
  const engineEdited = useRef(false);
  const reviewEdited = useRef(false);
  const [provider, setProvider] = useState<PlannerProvider>(PLANNER_ENGINES.defaultProvider as PlannerProvider);
  const [model, setModel] = useState<string>(PLANNER_ENGINES.defaultModel);
  const [effort, setEffort] = useState<string>(PLANNER_ENGINES.defaultEffort);
  const [reviewer, setReviewer] = useState(false);
  const [reviewOptions, setReviewOptions] = useState<ReviewOptions>({ ...REVIEW_OPTIONS.defaults });
  useEffect(() => {
    let active = true;
    request<ModelSettingsStatus>("/api/settings/models").then((value) => {
      if (!value.roles?.planner) throw new Error("Model settings unavailable");
      if (!active) return;
      setModelRoles(value.roles);
      setModelWarning(value.warning || "");
      if (!engineEdited.current) {
        const selected = value.roles.planner.provider!;
        setProvider(selected); setModel(value.roles.planner.models[selected]);
      }
      if (!reviewEdited.current) setReviewOptions((current) => ({ ...current, reviewerModel: value.roles.codeReviewer.models[current.reviewer] }));
    }).catch(() => { if (active) setModelWarning("Saved model defaults could not be loaded. Built-in defaults are shown."); })
      .finally(() => { if (active) setModelDefaultsLoading(false); });
    return () => { active = false; };
  }, []);
  // All six requests live in one object so the POST body, the reset and the
  // checkbox row can never disagree about which keys exist.
  const [specOptions, setSpecOptions] = useState<SpecOptions>(() => ({ ...SPEC_OPTION_DEFAULTS }));
  const [draft, setDraft] = useState<PlanDraft | null>(() => initialDraft ? normalizedDraft(initialDraft) : null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"" | "plan" | "answer" | "edit" | "assemble" | "feedback" | "discuss">("");
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
  // The composer for a question about the finished contract. It empties only
  // once the companion has accepted the question, so a refused POST never
  // loses what the user typed.
  const [question, setQuestion] = useState("");
  const feedbackRef = useRef<HTMLTextAreaElement | null>(null);
  const { attachments, uploading, inputRef, addImages, pasteImages, removeImage } = useImageAttachments(onNotice);

  const receive = useCallback((next: PlanDraft) => { setDraft(normalizedDraft(next)); setAnswers({}); setError(""); setFeedback(""); setRejecting(false); onPlanResolved?.(next); }, [onPlanResolved]);

  // The 202 that starts a discussion describes the same contract, not a new
  // one, and it carries no answer yet. Passing it through receive() would blank
  // a thread the sheet has already loaded, so the known entries are kept
  // whenever the response omits them.
  const receiveDiscussStart = useCallback((next: PlanDraft) => {
    setDraft((current) => {
      const keepKnown = !next.discussion && current?.discussion;
      return normalizedDraft(keepKnown ? { ...next, discussion: current.discussion } : next);
    });
    setError("");
  }, []);

  // The round is no longer awaited, so the sheet reloads the plan when its
  // progress stream closes. That is what turns the live steps into a question
  // list or a task list.
  const reload = useCallback(async (planId: string) => {
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(planId)}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read the finished round"); }
  }, [receive]);

  const running = draft?.running === true;
  // A discussion round examines the finished contract; it never rewrites one.
  // The full-page planning view would therefore hide the very thing the
  // question is about, so this case keeps the ready view on screen.
  const discussing = running && draft?.runStage === "discussing";
  const [steps, setSteps] = usePlannerProgress(running ? draft.planId : "", () => { if (draft) void reload(draft.planId); });

  // The "done" frame is the fast path. This poll is the safety net for the
  // reopened sheet whose round ended while no stream was attached.
  useEffect(() => {
    if (!running || !draft) return;
    const planId = draft.planId;
    const poll = setInterval(() => { void reload(planId); }, 7_000);
    return () => clearInterval(poll);
  }, [running, draft, reload]);

  // The managed runner is a cmux process, not a PlannerRuns child. Poll its
  // durable state while this sheet is open so a published proposal becomes an
  // actionable card without pretending an SSE stream owns the terminal.
  useEffect(() => {
    if (draft?.workflow !== "goal_session") return;
    const poll = setInterval(() => { void reload(draft.planId); }, 2_500);
    return () => clearInterval(poll);
  }, [draft?.workflow, draft?.planId, reload]);

  const fail = useCallback((cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback;
    if (message.startsWith(LOST_SESSION)) { setDraft(null); setAnswers({}); }
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
    if (!initialPlanId || initialDraft) return;
    const kickoff = setTimeout(() => { void openPlan(initialPlanId); }, 0);
    return () => clearTimeout(kickoff);
  }, [initialPlanId, initialDraft, openPlan]);

  function newGoal() {
    attachments.forEach((attachment) => removeImage(attachment.path));
    if (onNewGoal) { onNewGoal(); return; }
    setGoal(""); setDraft(null); setAnswers({}); setError(""); setFeedback(""); setRejecting(false); setQuestion(""); setSpecOptions({ ...SPEC_OPTION_DEFAULTS }); setReviewOptions({ ...REVIEW_OPTIONS.defaults });
  }

  // The round runs in the background, so this answers as soon as the plan row
  // exists. Submitting a goal is therefore fire and forget: the sheet closes,
  // a notice says the goal is planning, and the board carries it from there. A
  // failed submit keeps the sheet open, because only this sheet can show it.
  async function plan(event: FormEvent) {
    event.preventDefault();
    setBusy("plan"); setError(""); setSteps([]);
    try {
      receive(await request<PlanDraft>("/api/worktree-plans", { method: "POST", body: JSON.stringify({ repositoryId: repository.id, goal: goal.trim(), images: imageReferences(attachments), engine: { provider, model, effort, reviewer }, specOptions, reviewOptions, background: true }) }));
      onNotice(`Planning this goal on ${repository.name}. It appears in Writing Spec.`);
      onClose();
    }
    catch (cause) { fail(cause, "Could not plan this goal"); }
    finally { setBusy(""); }
  }

  async function startGoalSession() {
    setBusy("plan"); setError("");
    try {
      const started = await request<PlanDraft>("/api/goal-sessions", { method: "POST", body: JSON.stringify({ repositoryId: repository.id, goal: goal.trim(), images: imageReferences(attachments), engine: { provider, model, effort, reviewer }, specOptions, reviewOptions }) });
      receive(started);
      onNotice(`Goal session started in cmux for ${repository.name}.`);
      onClose();
      await onGoalSessionStarted?.(started);
    } catch (cause) { fail(cause, "Could not start the goal session"); }
    finally { setBusy(""); }
  }

  async function approveProposal() {
    if (!draft || !draft.proposalRevision || !draft.goalSessionGeneration) return;
    setBusy("plan"); setError("");
    try { receive(await request<PlanDraft>(`/api/goal-sessions/${encodeURIComponent(draft.planId)}/approve`, { method: "POST", body: JSON.stringify({ generation: draft.goalSessionGeneration, revision: draft.proposalRevision }) })); }
    catch (cause) { fail(cause, "Could not approve this proposal"); }
    finally { setBusy(""); }
  }

  async function requestProposalChanges(text: string) {
    if (!draft || !draft.proposalRevision || !draft.goalSessionGeneration) return;
    setBusy("feedback"); setError("");
    try { receive(await request<PlanDraft>(`/api/goal-sessions/${encodeURIComponent(draft.planId)}/request-changes`, { method: "POST", body: JSON.stringify({ generation: draft.goalSessionGeneration, revision: draft.proposalRevision, feedback: text }) })); }
    catch (cause) { fail(cause, "Could not request proposal changes"); }
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

  // A question about the finished contract. It changes neither the
  // specification nor the task split, so it does not go through receive(): the
  // sheet keeps showing the same contract while the answer is written.
  async function discuss() {
    if (!draft || !question.trim()) return;
    setBusy("discuss"); setError(""); setSteps([]);
    try {
      receiveDiscussStart(await request<PlanDraft>(`/api/worktree-plans/${draft.planId}/discuss`, { method: "POST", body: JSON.stringify({ text: question.trim(), background: true }) }));
      setQuestion("");
    }
    catch (cause) { fail(cause, "Could not ask that question"); }
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

  // Launching is fire and forget, exactly like submitting a goal. The companion
  // answers as soon as it accepts the launch, so this sheet has nothing left to
  // watch: it closes, and a push notification reports the outcome. A refused
  // launch keeps the sheet open, because only this sheet can show the reason.
  async function launch() {
    if (!draft || locked) return;
    setError("");
    try {
      await request(`/api/worktree-plans/${draft.planId}/launch`, { method: "POST", body: JSON.stringify({ background: true }) });
      onNotice("Launching this goal. A notification reports the result.");
      onClose();
    } catch (cause) { fail(cause, "Could not launch this plan"); }
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
      const report = await request<{ tasks: (TaskHealth & { id: string })[] }>(`/api/worktree-plans/${encodeURIComponent(planId)}/health`);
      setTaskHealth(Object.fromEntries((report.tasks || []).map((task) => [task.id, task])));
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
  async function relaunchTask(taskId: string, mode: "continue" | "restart" | "rebranch") {
    if (!draft) return;
    const key = `relaunch:${taskId}`;
    setTaskBusy((current) => ({ ...current, [key]: true })); setError("");
    try {
      // A crashed agent usually leaves its workspace open at a shell prompt, so
      // closing it here saves a trip to cmux. A task the sweep still reports as
      // working is never closed by a button labelled Continue.
      const verdict = taskHealth[taskId]?.health;
      const closeLive = (mode !== "rebranch" || Boolean(taskHealth[taskId]?.session?.id)) && verdict !== undefined && verdict !== "working" && verdict !== "needs_you";
      const result = await request<TaskRelaunchResult>(`/api/worktree-plans/${encodeURIComponent(draft.planId)}/tasks/${encodeURIComponent(taskId)}/relaunch`, { method: "POST", body: JSON.stringify({ mode, closeLive }) });
      setConfirmTask("");
      receive(await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(draft.planId)}`));
      await loadTaskHealth(draft.planId);
      onNotice(mode === "rebranch" ? (result.branch ? `Retried the task on ${result.branch}` : "Retried the task on a fresh branch") : mode === "restart" ? "Restarted the task from its base branch" : "Continued the task in its existing worktree");
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
      receive(await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(draft.planId)}`));
      await loadTaskHealth(draft.planId);
      onNotice("Skipped the task, so the goal can assemble without it");
    } catch (cause) { fail(cause, "Could not skip this task"); }
    finally { setTaskBusy((current) => ({ ...current, [key]: false })); }
  }

  // The local attachments still hold their preview data URLs, so prefer them
  // over the draft's paths for as long as this sheet is open.
  const reviewImages = attachments.length ? attachments : draft?.images || [];
  const reviewGoal = draft?.goal || goal;
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
  const heading = terminal ? terminal === "merged" ? "Merged goal" : "Aborted goal" : discussing ? "Review the plan" : running ? "Planning this goal" : stalled ? "Planning stopped" : launchedPlan ? "Launched goal" : draft?.status === "ready" ? "Review the plan" : draft ? "A few questions" : "Plan a goal";
  // Every action on a plan needs its ccs session, and one round already owns it.
  const locked = running || busy !== "" || terminal !== null;
  const discussion = draft?.discussion || [];
  // A question can be asked only while the contract can still be revised. A
  // launched or terminal goal keeps the thread, and loses the composer.
  const questionable = Boolean(draft) && !launchedPlan && !terminal;
  const atQuestionCap = discussion.length >= MAX_DISCUSSION;
  const providerOptions = PLANNER_ENGINES.providers[provider];
  const reviewerConfig = reviewerEngine(provider, modelRoles);
  const reviewerProvider = reviewerConfig.provider as PlannerProvider;
  const reviewerOptions = PLANNER_ENGINES.providers[reviewerProvider];

  // The handoff into the existing rejection flow. It only fills the box and
  // opens the panel: the re-plan still costs one deliberate press of "Analyse
  // this goal again", so nothing reaches /feedback by accident.
  function useSuggestion(suggestion: string) {
    setFeedback(suggestion);
    setRejecting(true);
    // The panel mounts on this same commit, so the focus waits one tick.
    setTimeout(() => feedbackRef.current?.focus(), 0);
  }

  // A goal takes minutes to write and a round takes minutes to answer, so a
  // mis-tap outside the sheet must not throw both away. The header button is
  // the way out.
  return <><div className="session-menu-backdrop" /><form className="worktree-launcher worktree-planner-sheet" role="dialog" aria-modal="true" aria-label="Plan a goal" onSubmit={(event) => event.preventDefault()}>
    <header><div><strong>{heading}</strong><span>{repository.name}</span></div><button type="button" aria-label="Close goal planner sheet" onClick={onClose}>×</button></header>
    {draft && <div className="planner-goal-reference"><span>Goal reference: <code>{draft.planId}</code></span><button type="button" onClick={async () => { const url = goalPopupUrl({ planId: draft.planId }).href; try { await navigator.clipboard.writeText(url); onNotice("Goal link copied"); } catch { onNotice("Copy the goal URL from the address bar"); } }}>Copy goal link</button></div>}
    {draft && <button type="button" className="planner-new-goal" disabled={busy !== ""} onClick={newGoal}>← New goal</button>}
    {draft && terminal && <TerminalGoalBanner status={terminal} plan={draft} />}
    {!draft && <>
      <section className="planner-spec-options" aria-label="Development setup review">
        <header><strong>Development setup</strong><span>Review instructions, setup and verification for this project, whatever its stack or coding agent.</span></header>
        <button type="button" className="text-button" disabled={goal.trim() !== "" || busy !== ""} onClick={() => setGoal(DEV_SETUP_GOAL)}>Review dev setup</button>
        <p>{goal.trim() ? "The goal below is editable. Clear it to use the review starting point." : "Start with an editable review goal. Planning does not change project files; review the plan before launching work."}</p>
      </section>
      <label className="worktree-task"><span>Goal</span><textarea aria-label="Goal" value={goal} onChange={(event) => setGoal(event.target.value)} onPaste={pasteImages} rows={5} maxLength={4_000} placeholder="Describe the outcome you want across parallel worktrees…" /></label>
      <AttachmentStrip attachments={attachments} onRemove={removeImage} />
      {modelWarning && <p role="status">{modelWarning}</p>}
      <section className="planner-engine-config" aria-label="Planner configuration">
        <header><strong>Planner</strong><span>{providerOptions.label} ({providerOptions.family}) · {model === PLANNER_ENGINES.passthroughModel ? "CCS default model" : modelLabel(provider, model)}</span></header>
        <div className="planner-engine-controls">
          <label><span>Engine</span><select aria-label="Planner engine" value={provider} onChange={(event) => { engineEdited.current = true; const selected = event.target.value as PlannerProvider; setProvider(selected); setModel(modelRoles.planner.models[selected]); }}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
          <ModelSelect label="Planner model" provider={provider} value={model} onChange={(value) => { engineEdited.current = true; setModel(value); }} />
          <label><span>Effort</span><select aria-label="Planner effort" value={effort} onChange={(event) => setEffort(event.target.value)}>{PLANNER_ENGINES.efforts.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        </div>
        <label className="planner-reviewer-toggle"><input type="checkbox" aria-label="Add a reviewer pass" checked={reviewer} onChange={(event) => setReviewer(event.target.checked)} /><span>Add a reviewer pass</span></label>
        {reviewer && <p className="planner-reviewer-identity">Reviewer: {reviewerOptions.label} ({reviewerOptions.family}) · {modelLabel(reviewerProvider, reviewerConfig.model)} · {reviewerConfig.effort} effort</p>}
      </section>
      <section className="planner-engine-config" aria-label="Post-delivery code review">
        <header><strong>{REVIEW_OPTIONS.label}</strong><span>{REVIEW_OPTIONS.hint}</span></header>
        <label className="planner-reviewer-toggle"><input type="checkbox" aria-label="Code review" checked={reviewOptions.codeReview} onChange={(event) => setReviewOptions((current) => ({ ...current, codeReview: event.target.checked }))} /><span>Request a code review</span></label>
        <div className="planner-engine-controls">
          <label><span>Reviewer</span><select aria-label="Code-review reviewer" value={reviewOptions.reviewer} onChange={(event) => {
            reviewEdited.current = true;
            const reviewer = event.target.value as PlanAgent;
            setReviewOptions((current) => ({ ...current, reviewer, reviewerModel: modelRoles.codeReviewer.models[reviewer] }));
          }}>{REVIEW_AGENTS.map((agent) => <option key={agent} value={agent}>{PLANNER_ENGINES.providers[agent as PlanAgent].label}</option>)}</select></label>
          <ModelSelect label="Code-review model" provider={reviewOptions.reviewer} value={reviewOptions.reviewerModel} onChange={(value) => { reviewEdited.current = true; setReviewOptions((current) => ({ ...current, reviewerModel: value })); }} />
        </div>
      </section>
      <section className="planner-spec-options" aria-label="Spec depth">
        <header><strong>Spec depth</strong><span>Each request becomes a written requirement in every planning round and task brief.</span></header>
        <ul>{SPEC_OPTION_CATALOG.map((option) => <li key={option.id}>
          <label>
            <input type="checkbox" aria-label={option.label} checked={specOptions[option.id]} onChange={(event) => setSpecOptions((current) => ({ ...current, [option.id]: event.target.checked }))} />
            <span><b>{option.label}</b><small>{option.hint}</small></span>
          </label>
        </li>)}</ul>
      </section>
      {error && <p className="worktree-action-error">{error}</p>}
      {busy === "plan" && <p className="planner-waiting">Starting the round…</p>}
      <div className="worktree-launch-actions"><ImagePickerButton attachments={attachments} disabled={busy === "plan" || uploading > 0} inputRef={inputRef} label="Choose goal images" onFiles={(files) => { void addImages(files); }} /><button type="button" className="primary-button" disabled={busy === "plan" || modelDefaultsLoading || uploading > 0 || !goal.trim() || !model.trim() || !reviewOptions.reviewerModel.trim()} onClick={() => { void startGoalSession(); }}>{busy === "plan" ? "Starting…" : uploading ? `Uploading ${uploading}…` : "Start goal session"}</button><button type="button" disabled={busy === "plan" || modelDefaultsLoading || uploading > 0 || !goal.trim() || !model.trim() || !reviewOptions.reviewerModel.trim()} onClick={(event) => { void plan(event as unknown as FormEvent); }}>Use task workflow</button></div>
    </>}
    {draft && running && !discussing && <section className="planner-running" aria-label="Planning in progress">
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <ProgressSteps steps={steps} waiting={draft.round === 0 ? "Reading the repository. The first round is the slowest, because it starts a fresh session." : "Thinking about your answers."} />
      <p className="planner-background-note">This round runs on the companion, not in this sheet. Close it and plan another goal. A notification arrives when this one is ready.</p>
      <div className="planner-actions"><button type="button" onClick={onClose}>Close and keep planning</button></div>
    </section>}
    {draft && stalled && <section className="planner-stalled" aria-label="Planning stopped">
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <p className="planner-background-note">This round stopped before it produced anything.{stalledReason ? "" : " A companion restart does this."} The goal is saved, so it can run again.</p>
      {stalledReason && <p className="planner-stalled-reason">{stalledReason}{draft.lastErrorAt ? <span> · {relativeTime(draft.lastErrorAt)} ago</span> : null}</p>}
      {error && <p className="worktree-action-error">{error}</p>}
      <div className="planner-actions"><button type="button" className="primary-button" disabled={busy !== ""} onClick={() => { void rerun(); }}>{busy === "plan" ? "Starting…" : "Plan this goal again"}</button></div>
    </section>}
    {draft && draft.workflow === "goal_session" && <GoalSessionProposal draft={draft} busy={busy !== ""} onApprove={() => { void approveProposal(); }} onRequestChanges={(text) => { void requestProposalChanges(text); }} />}
    {draft && draft.workflow !== "goal_session" && !running && !stalled && draft.status === "questions" && <>
      <p className="planner-round">Round {draft.round}</p>
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <div className="planner-questions">{draft.questions.map((question) => <div className="planner-question" key={question.id}>
        <label><span>{question.text}</span><textarea aria-label={question.text} value={answers[question.id] || ""} readOnly={launchedPlan || terminal !== null} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} rows={2} maxLength={2_000} /></label>
        {question.options.length > 0 && <div className="planner-options">{question.options.map((option) => <button type="button" key={option} aria-label={`Answer ${question.text} with ${option}`} className={answers[question.id] === option ? "selected" : ""} disabled={launchedPlan || terminal !== null} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}>{option}</button>)}</div>}
      </div>)}</div>
      {error && <p className="worktree-action-error">{error}</p>}
      {launchedPlan || terminal ? <p className="planner-launched-note">{terminal ? "This goal is closed. Its questions and answers are read-only." : "This goal was already launched. Its questions and answers are read-only."}</p> : <div className="planner-actions"><button type="button" disabled={locked} onClick={() => answer({ skip: true })}>Skip questions</button><button type="button" className="primary-button" disabled={locked} onClick={() => answer({ answers: draft.questions.map((question) => ({ id: question.id, text: answers[question.id] || "" })).filter((entry) => entry.text.trim()) })}>{busy === "answer" ? "Sending…" : "Answer"}</button></div>}
    </>}
    {draft && draft.workflow !== "goal_session" && (!running || discussing) && !stalled && draft.status === "ready" && <>
      <p className="planner-round">Round {draft.round} · {draft.tasks.length} task{draft.tasks.length === 1 ? "" : "s"}</p>
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <GoalPassport draft={draft} />
      {/* The thread stays readable for the whole life of the goal. Only an
          unlaunched, non-terminal, ready contract can still be questioned or
          revised, so the composer and the handoff hang off `questionable`. */}
      <section className="planner-discussion" aria-label="Question this plan">
        <header><strong>Question this plan</strong><span>Ask about this Delivery Contract before you launch it. The planner answers against the repository and this exact contract. It changes neither the specification nor the task split.</span></header>
        <DiscussionThread entries={discussion} round={draft.round} actionable={questionable} onUseSuggestion={useSuggestion} />
        {discussion.length === 0 && !discussing && <p className="planner-discussion-empty">No question has been asked about this contract yet.</p>}
        {discussing && <ProgressSteps steps={steps} waiting="Answering your question against the repository and this contract. The tasks below do not change." />}
        {questionable && <div className="planner-discussion-composer">
          <label><span>Question about this plan</span><textarea aria-label="Question about this plan" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3} maxLength={2_000} placeholder="Does task 2 already cover the migration, or does that need its own task?" disabled={atQuestionCap} /></label>
          {atQuestionCap && <p className="planner-discussion-cap">{DISCUSSION_CAP_NOTE}</p>}
          <div className="planner-actions"><button type="button" className="primary-button" disabled={locked || atQuestionCap || !question.trim()} onClick={() => { void discuss(); }}>{busy === "discuss" ? "Asking…" : "Ask"}</button></div>
        </div>}
      </section>
      {draft.tasks.length > 1 && <section className="planner-delivery-mode" aria-label="Combined pull request delivery"><strong>One combined PR</strong><p>Task agents commit and push isolated branches. Companion pins their commits and starts a merge agent that resolves conflicts, verifies against a baseline, and opens one pull request.</p></section>}
      <div className="planner-tasks">{draft.tasks.map((task) => <article className="planner-task" key={task.id}>
        <header><strong>{task.title}</strong>{!launchedPlan && !terminal && <button type="button" className="planner-remove-task" aria-label={`Remove ${task.title}`} disabled={locked || draft.tasks.length < 2} onClick={() => editTasks(draft.tasks.filter((item) => item.id !== task.id))}>×</button>}</header>
        <code className="planner-branch">{task.branch}</code>
        <div className="planner-agent" role="group" aria-label={`Agent for ${task.title}`}>{AGENTS.map((option) => <button type="button" key={option} aria-label={`Use ${agentLabel(option)} for ${task.title}`} aria-pressed={task.agent === option} className={task.agent === option ? "selected" : ""} disabled={locked || launchedPlan} onClick={() => editTasks(draft.tasks.map((item) => item.id === task.id ? { ...item, agent: option } : item))}>{agentLabel(option)}</button>)}</div>
        <small className="planner-agent-reason">{task.agentReason}</small>
        <PromptDisclosure label={`Prompt for ${task.title}`} summary="Prompt" text={task.prompt} />
      </article>)}</div>
      {!launchedPlan && !terminal && <section className="planner-reject" aria-label="Reject this plan">
        {rejecting ? <>
          <label><span>What is wrong with this split?</span><textarea ref={feedbackRef} aria-label="What is wrong with this split?" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={3} maxLength={2_000} placeholder="Tasks 2 and 3 touch the same file, so they cannot run in parallel…" /></label>
          <p>This starts a new planner round. It replaces every task above with a fresh split.</p>
          <div className="planner-actions"><button type="button" disabled={locked} onClick={() => { setRejecting(false); setFeedback(""); }}>Cancel</button><button type="button" className="primary-button" disabled={locked || !feedback.trim()} onClick={() => { void reject(); }}>{busy === "feedback" ? "Sending…" : "Analyse this goal again"}</button></div>
        </> : <button type="button" className="planner-reject-open" disabled={locked} onClick={() => setRejecting(true)}>This plan is wrong</button>}
      </section>}
      {error && <p className="worktree-action-error">{error}</p>}
      {terminal ? <section className="planner-delivery-status" aria-label="Recorded delivery status"><strong>{terminal === "merged" ? "Merged" : "Aborted"}</strong><DeliveryTasks tasks={draft.tasks} planId={draft.planId} health={taskHealth} busy={taskBusy} confirming={confirmTask} onRelaunch={(taskId, mode) => { void relaunchTask(taskId, mode); }} onSkip={(taskId) => { void skipTask(taskId); }} onConfirm={setConfirmTask} />{draft.integrationBranch && <code>{draft.integrationBranch}</code>}{draft.deliveryError && <p>{draft.deliveryError}</p>}</section>
        : launchedPlan ? draft.deliveryMode === "combined" ? <section className="planner-delivery-status" aria-label="Combined delivery status"><strong>{draft.finalPrUrl ? "Combined PR ready" : deliveryLabel(draft.deliveryStatus)}</strong><DeliveryTasks tasks={draft.tasks} planId={draft.planId} health={taskHealth} busy={taskBusy} confirming={confirmTask} onRelaunch={(taskId, mode) => { void relaunchTask(taskId, mode); }} onSkip={(taskId) => { void skipTask(taskId); }} onConfirm={setConfirmTask} />{draft.integrationBranch && <code>{draft.integrationBranch}</code>}{draft.deliveryError && <p>{draft.deliveryError}</p>}{draft.finalPrUrl ? <a href={draft.finalPrUrl} target="_blank" rel="noreferrer">Open PR{draft.finalPrNumber ? ` #${draft.finalPrNumber}` : ""}</a> : <button type="button" className="primary-button" disabled={locked} onClick={() => { void assemble(); }}>{busy === "assemble" ? "Checking branches…" : "Check & build combined PR"}</button>}</section> : <p className="planner-launched-note">This goal was already launched. The saved plan is read-only.</p>
        : <button type="button" className="primary-button" disabled={locked} onClick={launch}>{launchLabel(draft)}</button>}
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
