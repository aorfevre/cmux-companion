"use client";
import { ProposalReview } from "./proposal-review";
import { relativeTime as relativeTimestamp } from "./relative-time";

import { goalPopupUrl } from "./goal-popup-url";
import { BUILTIN_MODEL_ROLES, ModelRoles, ModelSelect, ModelSettingsStatus } from "./model-settings";
import { NEW_GOAL_SPEC_OPTIONS, NEW_GOAL_REVIEW_OPTIONS, NEW_GOAL_REVIEWER, ANALYSIS_INAPPLICABLE, applicableSpecOptions, plannerReviewReady, approvalDeliveryMessage } from "../server/goal-options.mjs";
import { GoalOutcomes, type AnalysisReport, type GoalReview } from "./goal-outcomes";
import { BURST_OPTION } from "../server/burst-options.mjs";
import { DEV_SETUP_GOAL } from "./dev-setup-goal";
import { ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { isFreshBranchSafeReason } from "../server/worktree-errors.mjs";
import { PLANNER_ENGINES, SPEC_OPTIONS } from "../server/worktree-planner-options.mjs";
import { AttachmentReview, AttachmentStrip, imageReferences, ImagePickerButton, request, useImageAttachments } from "./image-attachments";
// One shared predicate: two copies had already drifted, so the sheet read
// "1 of 2 ready" while the group read 1/1.
import { readyCount } from "../server/delivery-contract.mjs";
import { PromptDisclosure } from "./prompt-markdown";
import { DesignArtifacts, DesignArtifact } from "./spec-artifacts";

export type ReviewOptions = { codeReview: boolean; reviewer: "claude" | "codex"; reviewerModel: string };
type PlanAgent = "claude" | "codex";
type PlanQuestion = { id: string; text: string; options: string[] };
type CompletionReport = { criteria: string[]; verification: { check: string; status: "passed" | "failed" | "not_run" }[]; limitations: string[] };
type PlanCriterion = { id: string; text: string; verification: string };
// The six specification-rigor requests. The keys and their order come from
// SPEC_OPTIONS, so the sheet cannot offer a request the server refuses.
type SpecOptionId = "unitTests" | "e2eTests" | "edgeCases" | "refactorPass" | "screenMocks" | "flowcharts";
export type SpecOptions = Record<SpecOptionId, boolean>;
type SpecOptionCatalogEntry = { id: SpecOptionId; label: string; hint: string };
type PlanOptionEvidence = { status: "planned" | "not_applicable"; rationale: string; taskIds: string[]; criterionIds: string[] };
// The server derives this. The sheet only displays it, so a status here is
// never re-computed from readiness warning prose.
type PlanOptionCoverage = { id: SpecOptionId; requested: boolean; status: "not_requested" | "covered" | "not_applicable" | "missing"; message: string };
type ApprovalSummary = { overview: string; userFlow: string[]; decisions: { choice: string; consequence: string }[]; successCriteria: string[] };
type PlanSpec = { version?: number; outcome: string; inScope: string[]; nonGoals: string[]; constraints: string[]; assumptions: string[]; acceptanceCriteria: PlanCriterion[]; risks: { text: string; mitigation: string; level: string }[]; approvalSummary?: ApprovalSummary; optionEvidence?: Partial<Record<SpecOptionId, PlanOptionEvidence>>; designArtifacts?: DesignArtifact[] };
type PlanReadiness = { ready: boolean; errors: string[]; warnings: string[]; waves: string[][]; coverage: { criterionId: string; taskIds: string[] }[]; optionCoverage?: PlanOptionCoverage[] };
export type PlanTask = { id: string; title: string; branch: string; prompt: string; agent: PlanAgent; agentReason: string; type?: string; criterionIds?: string[]; dependsOn?: string[]; ownedAreas?: string[]; verification?: string[]; wave?: number; launchStatus?: string; launchReason?: string | null; launchError?: string | null; deliveryStatus?: string; completionReport?: CompletionReport | null; evidenceStatus?: string | null; evidenceError?: string | null; changedFiles?: string[]; scopeWarnings?: string[]; workspaceId?: string | null; worktreePath?: string | null };
// One question and its answer, attached to the contract round it examined. The
// round is what keeps a suggestion from an older split out of the current one.
type PlanDiscussion = { question: string; answer: string; contractImpact: "none" | "revision_suggested"; suggestion: string; round: number; createdAt: string };
type PlanImage = { path: string; name: string };
export type PlannerProvider = "claude" | "codex";
type PlannerEngine = { provider: PlannerProvider; model: string; effort: string; reviewer: boolean };
// The eight lifecycle ids come from server/goal-board.mjs. The board and the
// planner sheet read the same ids, so a card and its sheet never disagree.
export type GoalBoardStateId = "discovering" | "needs_you" | "building" | "analysis_in_progress" | "analysis_ready" | "in_review" | "stopped" | "shipped" | "aborted";
// Every verdict server/goal-health.mjs can return, worst first. The sweep and
// the plan list both send one of these words and nothing else.
export type GoalHealth = "failed" | "dead" | "idle" | "needs_you" | "working" | "ready" | "integrated" | "queued" | "unknown";
export type GoalBoardStatus = "merged" | "aborted";
type GoalBoardPrState = "OPEN" | "CLOSED" | "MERGED";
// Every plan payload carries these. `boardState` is the server's derivation,
// and the other fields are the structured evidence behind it.
type GoalBoardFields = { boardState?: GoalBoardStateId | null; boardStatus?: GoalBoardStatus | null; boardChangedAt?: string | null; boardPrNumber?: number | null; boardPrUrl?: string | null; boardPrState?: GoalBoardPrState | null; boardPrObservedAt?: string | null; runStage?: string | null; verification?: GoalVerification | null };
export type GoalVerification = { status: "passed" | "failed" | "unavailable"; script: string | null; source: string | null; headSha: string | null; reason: string | null; output: string | null; startedAt: string | null; finishedAt: string | null };
export type ApprovalDelivery = { status: string; dispatchId?: string; reason?: string | null; error?: string | null; sentAt?: string | null };
export type PlanSummary = { burst?: boolean; goalType?: "coding" | "analysis"; plannerReviewStatus?: string | null; transitionStatus?: string | null; approvalDelivery?: ApprovalDelivery | null; workflow?: "planned" | "goal_session"; goalSessionState?: string | null; planId: string; repositoryId: string; repositoryName: string; goal: string; status: "draft" | "launched"; stage: "questions" | "ready"; running?: boolean; launching?: boolean; runPhase?: string | null; runStep?: string; runError?: string; lastError?: string | null; lastErrorAt?: string | null; issueNumbers?: number[]; issuesReturnedAt?: string | null; followupCount?: number; deliveryMode?: "single" | "combined"; deliveryStatus?: string; deliveryError?: string | null; mergeStatus?: string | null; mergeWorkspaceId?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; round: number; taskCount: number; launchedCount: number; readyCount?: number; failedCount?: number; skippedCount?: number; queuedCount?: number; agentSplit?: { claude: number; codex: number }; workspaceIds?: string[]; health?: GoalHealth | null; healthReason?: string | null; stuckCount?: number | null; createdAt: string; updatedAt: string; launchedAt: string | null } & GoalBoardFields;
type GoalProposal = { intendedBehavior?: string; scope?: string[]; exclusions?: string[]; assumptions?: string[]; acceptanceCriteria?: { text: string; verification: string }[]; verification?: string[] };
export type PlanDraft = { burst?: boolean; goalType?: "coding" | "analysis"; sourceAnalysis?: { planId: string; version: number } | null; analysisReports?: AnalysisReport[]; reviews?: GoalReview[]; reviewOptions?: ReviewOptions; planId: string; repositoryId: string; repositoryName?: string; goal: string; running?: boolean; launching?: boolean; runPhase?: string | null; runStep?: string; runError?: string; lastError?: string | null; lastErrorAt?: string | null; images?: PlanImage[]; issueNumbers?: number[]; issuesReturnedAt?: string | null; issueUrls?: string[]; deliveryPolicy?: "auto" | "combined"; engine?: PlannerEngine; specOptions?: SpecOptions; round: number; status: "questions" | "ready"; stage?: "questions" | "ready"; planStatus?: "draft" | "launched"; contractVersion?: number; spec?: PlanSpec | null; readiness?: PlanReadiness | null; deliveryMode?: "single" | "combined"; deliveryStatus?: string; deliveryError?: string | null; integrationBranch?: string | null; integrationWorktreePath?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null; questions: PlanQuestion[]; tasks: PlanTask[]; discussion?: PlanDiscussion[]; createdAt?: string; updatedAt?: string; launchedAt?: string | null; base?: string; history?: unknown[]; workflow?: "planned" | "goal_session"; goalSessionState?: string | null; goalSessionWorkspaceId?: string | null; goalSessionGeneration?: number; goalSessionQuestionRevision?: number; proposalRevision?: number; proposal?: GoalProposal | null; approvalRevision?: number | null; transitionStatus?: string | null; approvalDelivery?: ApprovalDelivery | null; goalSessionError?: string | null; goalSessionRunnerPid?: number | null; goalSessionRunnerDispatchId?: string | null } & GoalBoardFields;
export type TaskRelaunchResult = { branch?: string; launchReason?: string | null };
type DeliveryResult = { planId: string; deliveryMode: "combined"; deliveryStatus: string; integrationBranch?: string | null; finalPrNumber?: number | null; finalPrUrl?: string | null; verifiedAt?: string | null };
type PlannerRepository = { id: string; name: string };

const LOST_SESSION = "The planner lost its session";
// One typed view of the shared catalog. The module is plain JavaScript, so the
// cast happens once here rather than at every use.
const SPEC_OPTION_CATALOG = SPEC_OPTIONS.options as readonly SpecOptionCatalogEntry[];
// Creation policy is shared with API and issue quick-start; saved goals keep their choices.
const FORM_REVIEWER_DEFAULT = NEW_GOAL_REVIEWER;
const FORM_REVIEW_DEFAULTS: ReviewOptions = { ...NEW_GOAL_REVIEW_OPTIONS };
const FORM_SPEC_DEFAULTS: SpecOptions = { ...NEW_GOAL_SPEC_OPTIONS };
const SPEC_OPTION_LABELS: Record<SpecOptionId, string> = SPEC_OPTION_CATALOG.reduce((labels, option) => ({ ...labels, [option.id]: option.label }), {} as Record<SpecOptionId, string>);
const COVERAGE_LABELS: Record<string, string> = { covered: "Covered", not_applicable: "Not applicable", missing: "Missing" };
function modelLabel(provider: PlannerProvider, model: string) { return PLANNER_ENGINES.providers[provider].models.find((option) => option.id === model)?.label || model; }

// After the plan appears, the goal and its images leave the screen. This brings
// them back on demand, so a user can check eight tasks against what they asked.
function ContextReview({ goal, images }: { goal: string; images: { path: string; name: string; preview?: string }[] }) {
  if (!goal.trim() && !images.length) return null;
  return <div className="planner-context"><PromptDisclosure label="Your goal and attachments" summary={<>Your goal{images.length ? ` · ${images.length} image${images.length === 1 ? "" : "s"}` : ""}</>} text={goal}>
    <AttachmentReview attachments={images} />
  </PromptDisclosure></div>;
}

function GoalSessionProposal({ draft, busy, onApprove, onRequestChanges, onAnswer, onRecover, onResendApproval, onOpenConversation }: { draft: PlanDraft; busy: boolean; onApprove: () => void; onRequestChanges: (text: string) => void; onAnswer: (text: string) => void; onRecover: () => void; onResendApproval: () => void; onOpenConversation: () => void }) {
  const [changes, setChanges] = useState("");
  const [answer, setAnswer] = useState("");
  const proposal = draft.proposal;
  const reviewReady = plannerReviewReady(draft);
  const disconnected = draft.goalSessionRunnerPid === null && draft.goalSessionRunnerDispatchId === null && !draft.goalSessionError && draft.transitionStatus !== "uncertain";
  const resume = disconnected ? <><p>Conversation closed. Discovery and saved proposals are preserved.</p><button type="button" disabled={busy} onClick={onRecover}>Resume conversation</button></> : null;
  const open = draft.goalSessionWorkspaceId ? <button type="button" onClick={onOpenConversation}>Open conversation</button> : null;
  if (draft.goalSessionState === "awaiting_input") return <section className="planner-delivery-status" aria-label="Managed goal questions"><strong>Goal needs your answer</strong>{draft.questions.map((question) => <p key={question.id}>Question: {question.text}{question.options.length ? ` (${question.options.join(" / ")})` : ""}</p>)}<label><span>Answer</span><textarea aria-label="Answer managed goal questions" value={answer} disabled={busy} maxLength={4_000} rows={2} onChange={(event) => setAnswer(event.target.value)} /></label><div className="planner-actions">{open}<button type="button" className="primary-button" disabled={busy || !answer.trim()} onClick={() => onAnswer(answer.trim())}>Send answer</button></div></section>;
  if (!proposal || draft.goalSessionState !== "awaiting_approval") {
    const delivery = approvalDeliveryMessage(draft);
    const message = draft.goalSessionError || delivery || (draft.transitionStatus === "uncertain"
      ? "The implementation handoff is uncertain. Companion will not send it again automatically."
      : draft.goalSessionState === "analysis_ready" ? "The analysis report is saved below. Return to the analyst conversation to request a revision."
        : draft.goalSessionState === "analyzing" ? "Analysis is continuing read-only in the same conversation; its report will appear here."
        : draft.goalSessionState === "implementing" ? "Implementation is continuing in the same managed goal session."
        : "Discovery is open in the interactive cmux conversation. Ask questions and steer the agent there.");
    return <section className="planner-delivery-status" aria-label="Goal session status"><strong>Goal session</strong><p>{message}</p>{resume}<div className="planner-actions">{open}{draft.goalSessionError && <button type="button" className="primary-button" disabled={busy} onClick={onRecover}>Recover failed turn</button>}{draft.transitionStatus === "pending" && draft.approvalDelivery?.reason && <button type="button" className="primary-button" disabled={busy} onClick={onResendApproval}>Send approval again</button>}</div></section>;
  }
  if (!reviewReady) return <section className="planner-delivery-status" aria-label="Plan review progress"><strong>Preparing your reviewed plan</strong><p>The reviewer and planner are assessing this proposal. Your final plan will appear here when assessment finishes.</p><details><summary>Draft plan</summary><ProposalReview proposal={proposal} goal={draft.goal} /></details><div className="planner-actions">{open}</div></section>;
  return <section className="planner-delivery-status proposal-review" aria-label="Proposal awaiting approval"><h2>Proposal revision {draft.proposalRevision}</h2>{resume}
    <div className="proposal-layout"><ProposalReview proposal={proposal} goal={draft.goal} /><div className="proposal-decision">
    <p>Ready for your decision. Approve this exact final revision and the agent starts implementing it in its conversation. You can keep discussing to revise it.</p>
    <label><span>Request changes</span><textarea aria-label="Request proposal changes" value={changes} maxLength={4_000} rows={3} onChange={(event) => setChanges(event.target.value)} /></label>
    <div className="planner-actions">{open}<button type="button" disabled={busy || !changes.trim()} onClick={() => onRequestChanges(changes.trim())}>Request changes</button><button type="button" className="primary-button" disabled={busy} onClick={onApprove}>{busy ? "Approving…" : draft.goalType === "analysis" ? "Approve analysis" : "Approve and implement"}</button></div>
    </div></div>
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
    const rebranchable = task.launchStatus === "failed" && isFreshBranchSafeReason(verdict?.launchReason ?? task.launchReason);
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

function DeliveryPlan({ tasks, waves, criteria, deliveryMode }: { tasks: PlanTask[]; waves: string[][]; criteria: PlanCriterion[]; deliveryMode?: "single" | "combined" }) {
  const orderedIds = waves.flat();
  const deliveryLabel = deliveryMode === "combined" ? "One combined pull request" : deliveryMode === "single" ? `${tasks.length} task pull request${tasks.length === 1 ? "" : "s"}` : "Delivery mode set at launch";
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const taskNumber = (id: string) => orderedIds.indexOf(id) + 1;
  return <section className="delivery-plan" aria-label="Delivery plan">
    <header><strong>Delivery plan</strong><span>{tasks.length} tasks · {waves.length} stages</span></header>
    <ol className="delivery-stages">
      {waves.map((wave, index) => <li className="delivery-stage" key={`${index}-${wave.join("-")}`}>
        <div className="delivery-stage-heading"><span className="delivery-stage-number" aria-hidden="true">{index + 1}</span><strong>Stage {index + 1}</strong>{wave.length > 1 && <span className="delivery-parallel">{wave.length} tasks can run in parallel</span>}</div>
        <ol className="delivery-stage-tasks">{wave.map((id) => {
          const task = taskById.get(id);
          const dependencies = task?.dependsOn || [];
          return <li className="delivery-plan-task" key={id}>
            <div className="delivery-task-title"><span className="delivery-task-number">{taskNumber(id)}</span><strong>{task?.title || id}</strong></div>
            {dependencies.length ? <details className="delivery-dependencies"><summary>After {dependencies.map((dependency) => taskNumber(dependency) ? `task ${taskNumber(dependency)}` : dependency).join(", ")}</summary><ul>{dependencies.map((dependency) => <li key={dependency}>{taskById.get(dependency)?.title || dependency}</li>)}</ul></details> : <p className="delivery-start">No prerequisites</p>}
            <details className="delivery-dependencies"><summary>Scope and checks</summary><div>
              <p>Scope: {task?.criterionIds?.map((criterionId) => criteria.find((criterion) => criterion.id === criterionId)?.text).filter(Boolean).join(" · ") || "Not declared"}</p>
              <p>Files: {task?.ownedAreas?.join(", ") || "Not declared"}</p>
              <p>Checks: {task?.verification?.join(" · ") || "Not declared"}</p>
            </div></details>
          </li>;
        })}</ol>
      </li>)}
    </ol>
    {tasks.length > 0 && <footer><span aria-hidden="true">↓</span> {deliveryLabel}</footer>}
  </section>;
}

type ReviewTab = "Overview" | "Design" | "Impacts" | "Tasks" | "Checks";
const REVIEW_TABS: ReviewTab[] = ["Overview", "Design", "Impacts", "Tasks", "Checks"];

function GoalPassport({ draft, children }: { draft: PlanDraft; children?: ReactNode }) {
  const [tab, setTab] = useState<ReviewTab>("Overview");
  const uid = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const spec = draft.spec;
  if (!spec) return <>{children}</>;
  const readiness = draft.readiness;
  const waves = readiness?.waves?.length ? readiness.waves : [...new Set(draft.tasks.map((task) => task.wave || 0))].sort((a, b) => a - b).map((wave) => draft.tasks.filter((task) => (task.wave || 0) === wave).map((task) => task.id));
  const requestedCoverage = (readiness?.optionCoverage || []).filter((entry) => entry?.requested === true);
  const artifacts = spec.designArtifacts || [];
  const needsReview = Boolean(readiness?.warnings?.length || spec.assumptions?.length || spec.risks?.length);
  const reviewStatus = readiness?.ready === false ? "Needs work" : readiness?.ready !== true ? "Plan checks unavailable" : needsReview ? "Review before launch" : "Plan checks passed";
  const summary = spec.approvalSummary;
  const displayedOutcome = summary?.overview || spec.outcome;
  const longOutcome = displayedOutcome.length > 320;
  // An excerpt stays explicitly labelled; no client-generated claims or impact scores.
  const outcomePreview = longOutcome ? `${displayedOutcome.slice(0, 280).trimEnd()}…` : displayedOutcome;
  const success = summary?.successCriteria?.length ? summary.successCriteria : spec.acceptanceCriteria.map((criterion) => criterion.text);
  const areas = [...new Set(draft.tasks.flatMap((task) => task.ownedAreas || []))];
  function navigate(next: ReviewTab) {
    setTab(next);
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-review-tab="${next}"]`)?.focus();
  }
  return <section className="goal-passport goal-review" aria-label="Goal passport">
    <header><div><small>YOUR PLAN</small><strong>A clear view before you start</strong></div><em className={readiness?.ready === false ? "blocked" : needsReview || readiness?.ready !== true ? "review" : "ready"}>{reviewStatus}</em></header>
    {Boolean(readiness?.errors?.length) && <div className="goal-passport-readiness" role="alert">{readiness?.errors.map((item) => <p className="error" key={item}>{item}</p>)}</div>}
    <div className="plan-review-tabs" role="tablist" aria-label="Plan review sections" ref={tabsRef}>
      {REVIEW_TABS.map((name, index) => <button type="button" role="tab" key={name} data-review-tab={name} id={`${uid}-tab-${name}`} aria-controls={`${uid}-panel-${name}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)} onKeyDown={(event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % REVIEW_TABS.length : event.key === "ArrowLeft" ? (index + REVIEW_TABS.length - 1) % REVIEW_TABS.length : event.key === "Home" ? 0 : event.key === "End" ? REVIEW_TABS.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); navigate(REVIEW_TABS[next]);
      }}>{name}{name === "Impacts" && needsReview && <span className="review-attention-dot" aria-label="Needs review" />}</button>)}
    </div>
    <div className="plan-review-panel" role="tabpanel" id={`${uid}-panel-${tab}`} aria-labelledby={`${uid}-tab-${tab}`} tabIndex={0}>
    {tab === "Overview" && <>
      <div className="review-overview-heading"><small>{longOutcome ? "Expected outcome (excerpt)" : "Expected outcome"}</small><p className="goal-review-outcome">{outcomePreview}</p></div>
      {(longOutcome || Boolean(summary?.overview && summary.overview !== spec.outcome)) && <PromptDisclosure label="Full expected outcome" summary="Read the full expected outcome" text={spec.outcome} />}
      {longOutcome && summary?.overview && <PromptDisclosure label="Full overview" summary="Read the full overview" text={summary.overview} />}
      <div className="review-at-a-glance">
        <button type="button" onClick={() => navigate("Tasks")}><b>{draft.tasks.length}</b><span>Tasks <span aria-hidden="true">↗</span></span><small>{waves.length} delivery stages</small></button>
        <button type="button" onClick={() => navigate("Design")}><b>{artifacts.length}</b><span>Design sketches <span aria-hidden="true">↗</span></span><small>{artifacts.length ? "Explore screens & flows" : "No sketches supplied"}</small></button>
        <button type="button" onClick={() => navigate("Impacts")}><b>{spec.risks.length}</b><span>Declared risks <span aria-hidden="true">↗</span></span><small>{spec.assumptions.length} assumptions to review</small></button>
      </div>
      {needsReview && <button type="button" className="review-attention" onClick={() => navigate("Impacts")}>Before you decide: review {spec.assumptions.length} assumptions, {spec.risks.length} risks and {readiness?.warnings?.length || 0} warnings <span aria-hidden="true">→</span></button>}
      <div className="review-success"><strong>What success looks like</strong><ul>{success.slice(0, 3).map((criterion, index) => <li key={index}><span aria-hidden="true">✓</span>{criterion}</li>)}</ul><button type="button" onClick={() => navigate("Checks")}>See all {spec.acceptanceCriteria.length} acceptance checks →</button></div>
      <p className="goal-review-note">Plan checks cover structure. Implementation results appear in Checks.</p>
    </>}
    {tab === "Design" && <>
      <h3>How it will work</h3>
      {summary?.userFlow?.length ? <ol className="review-user-flow" aria-label="User journey">{summary.userFlow.map((step, index) => <li key={index}><span>{index + 1}</span><p>{step}</p></li>)}</ol> : <p className="goal-review-note">No user journey was supplied in this plan.</p>}
      {artifacts.length > 0 ? <div className="goal-passport-block"><strong>Design artifacts</strong><p className="goal-review-note">Proposed screens and flows for review.</p><DesignArtifacts artifacts={artifacts} /></div> : <div className="review-empty"><strong>No design sketches yet</strong><p>Ask for screen mockups or flowcharts in “Question this plan”, then request a revised plan to include them.</p></div>}
    </>}
    {tab === "Impacts" && <>
      <h3>What changes, and what to watch</h3>
      {summary?.decisions?.length ? <div className="goal-passport-block"><strong>Decisions and consequences</strong><ul className="goal-passport-decisions">{summary.decisions.map((decision, index) => <li key={index}><b>{decision.choice}</b><small>{decision.consequence}</small></li>)}</ul></div> : <p className="goal-review-note">No decision consequences were supplied. Review the declared scope below.</p>}
      {Boolean(readiness?.warnings?.length) && <div className="goal-passport-readiness"><strong>Review notes</strong>{readiness?.warnings.map((item) => <p className="warning" key={item}>{item}</p>)}</div>}
      <details className="goal-review-details"><summary>Affected code · {areas.length} declared areas</summary><ul className="review-code-areas">{areas.map((area) => <li key={area}><code>{area}</code></li>)}</ul><p className="goal-review-note">Planned ownership, not a measured diff.{draft.tasks.some((task) => !task.ownedAreas?.length) ? " Some tasks have no declared areas." : ""}</p></details>
    <div className="goal-passport-scope">
      <PassportList title="In scope" items={spec.inScope} empty="Defined by the outcome" />
      <PassportList title="Non-goals" items={spec.nonGoals} empty="None declared" />
      <PassportList title="Constraints" items={spec.constraints} empty="None declared" />
      <PassportList title="Assumptions to review" items={spec.assumptions} empty="None" />
    </div>
    {spec.risks?.length > 0 && <div className="goal-passport-block"><strong>Risks and mitigations</strong><ul className="goal-passport-risks">{spec.risks.map((risk, index) => <li key={`${index}-${risk.text}-${risk.mitigation}`}><em>{risk.level}</em><div><span>{risk.text}</span><small>{risk.mitigation || "No mitigation recorded"}</small></div></li>)}</ul></div>}

      {spec.risks.length === 0 && <p className="goal-review-note">No risks were declared by the planner.</p>}
    </>}
    {tab === "Tasks" && <>
      <DeliveryPlan tasks={draft.tasks} waves={waves} criteria={spec.acceptanceCriteria} deliveryMode={draft.deliveryMode || (draft.deliveryPolicy === "combined" ? "combined" : undefined)} />
      <details className="goal-review-details"><summary>Task ownership and checks</summary><div className="goal-passport-block"><ul className="goal-passport-task-plan">{draft.tasks.map((task) => <li key={task.id}><span>{task.title}</span><small>Owns: {task.ownedAreas?.join(", ") || "Not declared"}</small><small>Depends on: {task.dependsOn?.join(", ") || "None"}</small><small>Verify: {task.verification?.join(" · ") || "Not declared"}</small></li>)}</ul></div></details>
      <details className="goal-review-details"><summary>Agents and task prompts</summary>{children}</details>
    </>}
    {tab === "Checks" && <>
      {summary?.successCriteria?.length ? <div className="goal-passport-block"><strong>Success criteria</strong><ul className="goal-passport-summary-list">{summary.successCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></div> : null}
    <div className="goal-passport-block"><strong>Success criteria and verification</strong><ul className="goal-passport-criteria">{spec.acceptanceCriteria.map((criterion) => {
      const tasks = draft.tasks.filter((task) => task.criterionIds?.includes(criterion.id));
      const state = criterionState(tasks);
      return <li key={criterion.id}><code>{criterion.id}</code><div><span>{criterion.text}</span><small>Check: {criterion.verification || "Not specified"}</small><small>{tasks.map((task) => task.title).join(" · ") || "No task assigned"}</small></div><em className={state}>{state}</em></li>;
    })}</ul></div>
    {requestedCoverage.length > 0 && <div className="goal-passport-block"><strong>Specification coverage</strong><ul className="goal-passport-options">{requestedCoverage.map((entry) => <li key={entry.id} className={`coverage-${entry.status}`}>
      <span>{SPEC_OPTION_LABELS[entry.id] || entry.id}</span>
      <small>{entry.message || "No detail recorded"}</small>
      <em className={`coverage-${entry.status}`}>{COVERAGE_LABELS[entry.status] || entry.status}</em>
    </li>)}</ul></div>}
    {draft.tasks.some((task) => task.completionReport || task.evidenceError || task.scopeWarnings?.length) && <div className="goal-passport-block"><strong>Task evidence</strong><ul className="goal-passport-evidence">{draft.tasks.filter((task) => task.completionReport || task.evidenceError || task.scopeWarnings?.length).map((task) => <li key={task.id}><span>{task.title}</span>{task.completionReport?.verification.map((item) => <small key={`${item.check}-${item.status}`}>{item.check}: <b className={item.status}>{item.status}</b></small>)}{task.completionReport?.limitations.map((item) => <small className="limitation" key={item}>Limitation: {item}</small>)}{task.scopeWarnings?.map((item) => <small className="warning" key={item}>Outside ownership: {item}</small>)}{task.evidenceError && <small className="error">{task.evidenceError}</small>}</li>)}</ul></div>}
    </>}
    </div>
  </section>;
}

// Historical discussion is read-only and rendered as text.
function DiscussionThread({ entries, round }: { entries: PlanDiscussion[]; round: number }) {
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
        <small>{historical ? "This suggestion examined an earlier contract round, so it cannot be applied." : "This goal is closed to further planning rounds."}</small>
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

function relativeTime(timestamp?: string) { return relativeTimestamp(timestamp ? Date.parse(timestamp) / 1000 : undefined); }

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
  const [goalType, setGoalType] = useState<"coding" | "analysis">("coding");
  const [modelRoles, setModelRoles] = useState<ModelRoles>(BUILTIN_MODEL_ROLES);
  const [modelWarning, setModelWarning] = useState("");
  const [modelDefaultsLoading, setModelDefaultsLoading] = useState(true);
  const engineEdited = useRef(false);
  const reviewEdited = useRef(false);
  const [provider, setProvider] = useState<PlannerProvider>(PLANNER_ENGINES.defaultProvider as PlannerProvider);
  const [model, setModel] = useState<string>(PLANNER_ENGINES.defaultModel);
  const [effort, setEffort] = useState<string>(PLANNER_ENGINES.defaultEffort);
  const [reviewer, setReviewer] = useState(FORM_REVIEWER_DEFAULT);
  const [reviewOptions, setReviewOptions] = useState<ReviewOptions>({ ...FORM_REVIEW_DEFAULTS });
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
  const [specOptions, setSpecOptions] = useState<SpecOptions>(() => ({ ...FORM_SPEC_DEFAULTS }));
  const [burst, setBurst] = useState(false);
  const [exclusions, setExclusions] = useState("");
  const [verification, setVerification] = useState("");
  const [draft, setDraft] = useState<PlanDraft | null>(() => initialDraft ? normalizedDraft(initialDraft) : null);
  const [busy, setBusy] = useState<"" | "plan" | "answer" | "edit" | "assemble" | "feedback" | "discuss" | "recover" | "resend">("");
  // Keyed per task, not one shared string: one task relaunching must not
  // disable the recovery buttons of every other task on the sheet.
  const [taskBusy, setTaskBusy] = useState<Record<string, boolean>>({});
  const [taskHealth, setTaskHealth] = useState<Record<string, TaskHealth>>({});
  const [confirmTask, setConfirmTask] = useState("");
  const [error, setError] = useState("");
  const goalSessionRequestId = useRef("");
  const { attachments, uploading, inputRef, addImages, pasteImages, removeImage } = useImageAttachments(onNotice);

  const receive = useCallback((next: PlanDraft) => { setDraft(normalizedDraft(next)); setError(""); onPlanResolved?.(next); }, [onPlanResolved]);

  const reload = useCallback(async (planId: string) => {
    try { receive(await request<PlanDraft>(`/api/worktree-plans/${encodeURIComponent(planId)}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read the finished round"); }
  }, [receive]);

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
    if (message.startsWith(LOST_SESSION)) { setDraft(null); }
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
    setBurst(false); setGoal(""); setExclusions(""); setVerification(""); setGoalType("coding"); goalSessionRequestId.current = ""; setDraft(null); setError(""); setSpecOptions({ ...FORM_SPEC_DEFAULTS }); setReviewOptions({ ...FORM_REVIEW_DEFAULTS }); setReviewer(FORM_REVIEWER_DEFAULT);
  }

  async function startGoalSession() {
    if (draft || busy || modelDefaultsLoading || uploading > 0 || !goal.trim() || !model.trim() || !reviewOptions.reviewerModel.trim()) return;
    setBusy("plan"); setError("");
    try {
      if (!goalSessionRequestId.current) goalSessionRequestId.current = crypto.randomUUID();
      const started = await request<PlanDraft>("/api/goal-sessions", { method: "POST", body: JSON.stringify({ repositoryId: repository.id, goalType, goal: goal.trim(), images: imageReferences(attachments), engine: { provider, model, effort, reviewer }, specOptions: applicableSpecOptions(goalType, specOptions), reviewOptions: { ...reviewOptions, codeReview: goalType === "coding" && reviewOptions.codeReview }, burst, idempotencyKey: goalSessionRequestId.current, ...(exclusions.trim() || verification.trim() ? { intake: { exclusions: exclusions.trim(), verification: verification.trim() } } : {}) }) });
      receive(started);
      goalSessionRequestId.current = "";
      onNotice(`Goal session started in cmux for ${repository.name}.`);
      onClose();
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

  async function answerGoalSession(text: string) {
    if (!draft?.goalSessionGeneration) return;
    setBusy("answer"); setError("");
    try { receive(await request<PlanDraft>(`/api/goal-sessions/${encodeURIComponent(draft.planId)}/answer`, { method: "POST", body: JSON.stringify({ generation: draft.goalSessionGeneration, questionRevision: draft.goalSessionQuestionRevision, feedback: text }) })); }
    catch (cause) { fail(cause, "Could not send this answer"); }
    finally { setBusy(""); }
  }

  async function restartDiscovery() {
    if (!draft || busy) return;
    setBusy("recover"); setError("");
    try {
      const restarted = await request<PlanDraft>(`/api/goal-sessions/${encodeURIComponent(draft.planId)}/continue`, { method: "POST", body: "{}" });
      receive(restarted);
      onNotice("Opened interactive discovery. Previous context remains saved.");
      onClose();
    } catch (cause) { fail(cause, "Could not restart discovery"); }
    finally { setBusy(""); }
  }

  async function resendApproval() {
    if (!draft) return;
    setBusy("resend"); setError("");
    try { receive(await request<PlanDraft>(`/api/goal-sessions/${encodeURIComponent(draft.planId)}/resend-approval`, { method: "POST", body: "{}" })); }
    catch (cause) { fail(cause, "Could not send the approval again"); }
    finally { setBusy(""); }
  }

  async function recoverGoalSession() {
    if (!draft) return;
    setBusy("recover"); setError("");
    try {
      const recovered = await request<PlanDraft>(`/api/goal-sessions/${encodeURIComponent(draft.planId)}/recover`, { method: "POST", body: "{}" });
      receive(recovered);
      onNotice("Goal conversation recovery requested.");
    } catch (cause) { fail(cause, "Could not recover this goal session"); }
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
  const stalled = Boolean(draft && !draft.running && !launchedPlan && !terminal && draft.round === 0 && !draft.questions.length && !draft.tasks.length);
  // Why it stopped. runError is this process's memory of a round that just
  // failed and expires within a minute; lastError is the copy the plan row
  // keeps. Without either, a restart really is the likeliest cause.
  const stalledReason = draft?.runError || draft?.lastError || "";
  const heading = terminal ? terminal === "merged" ? "Merged goal" : "Aborted goal" : draft?.workflow === "goal_session" ? "Goal conversation" : draft ? "Saved discovery" : "Plan a goal";
  // Every action on a plan needs its ccs session, and one round already owns it.
  // A question can be asked only while the contract can still be revised. A
  // launched or terminal goal keeps the thread, and loses the composer.
  const providerOptions = PLANNER_ENGINES.providers[provider];


  // A goal takes minutes to write and a round takes minutes to answer, so a
  // mis-tap outside the sheet must not throw both away. The header button is
  // the way out.
  return <><div className="session-menu-backdrop" /><form className="worktree-launcher worktree-planner-sheet" role="dialog" aria-modal="true" aria-label="Plan a goal" onSubmit={(event) => { event.preventDefault(); void startGoalSession(); }}>
    <header><div><strong>{heading}</strong><span>{repository.name}</span></div><button type="button" aria-label="Close goal planner sheet" onClick={onClose}>×</button></header>
    {draft && <div className="planner-goal-reference"><span>Goal reference: <code>{draft.planId}</code></span><button type="button" onClick={async () => { const url = goalPopupUrl({ planId: draft.planId }).href; try { await navigator.clipboard.writeText(url); onNotice("Goal link copied"); } catch { onNotice("Copy the goal URL from the address bar"); } }}>Copy goal link</button></div>}
    {draft && <button type="button" className="planner-new-goal" disabled={busy !== ""} onClick={newGoal}>← New goal</button>}
    {draft && terminal && <TerminalGoalBanner status={terminal} plan={draft} />}
    {draft && (draft.workflow !== "goal_session" || terminal === "aborted") && !launchedPlan && !draft.tasks.some((task) => task.workspaceId || task.worktreePath) && terminal !== "merged" && <section className="planner-spec-options" aria-label="Continue discovery">
      <strong>Continue discovery</strong><p>Continue this saved goal in the interactive cmux conversation. Companion stops its previous discovery and carries over its specification, questions, answers, images and GitHub links. Review and implementation happen in that same conversation.</p>
      <button type="button" className="primary-button" disabled={busy !== ""} onClick={() => { void restartDiscovery(); }}>{busy === "recover" ? "Opening discovery…" : "Continue discovery"}</button>
    </section>}
    {!draft && <>
      <section className="planner-spec-options" aria-label="Development setup review">
        <header><strong>Development setup</strong><span>Review instructions, setup and verification for this project, whatever its stack or coding agent.</span></header>
        <button type="button" className="text-button" disabled={goal.trim() !== "" || busy !== ""} onClick={() => setGoal(DEV_SETUP_GOAL)}>Review dev setup</button>
        <p>{goal.trim() ? "The goal below is editable. Clear it to use the review starting point." : "Start with an editable review goal. Planning does not change project files; review the plan before launching work."}</p>
      </section>
      <label className="worktree-task"><span>Goal</span><textarea aria-label="Goal" value={goal} onChange={(event) => setGoal(event.target.value)} onPaste={pasteImages} rows={5} maxLength={4_000} placeholder="Describe the outcome you want across parallel worktrees…" /></label>
      {/* The two optional answers are the contract's exclusions and verification,
          asked up front so the agent confirms them instead of inventing them. */}
      <div className="planner-intake">
        <label className="worktree-task"><span>What must not change</span><textarea aria-label="What must not change" value={exclusions} onChange={(event) => setExclusions(event.target.value)} rows={2} maxLength={4_000} placeholder="One per line. Files, behaviour or data the agent must leave alone…" /></label>
        <label className="worktree-task"><span>How you will know it worked</span><textarea aria-label="How you will know it worked" value={verification} onChange={(event) => setVerification(event.target.value)} rows={2} maxLength={4_000} placeholder="One per line. A check you can run, or a thing you can see…" /></label>
      </div>
      <AttachmentStrip attachments={attachments} onRemove={removeImage} />
      {modelWarning && <p role="status">{modelWarning}</p>}
      <label><span>Goal type</span><select aria-label="Goal type" value={goalType} onChange={(event) => setGoalType(event.target.value as "coding" | "analysis")}><option value="coding">Coding</option><option value="analysis">Analysis</option></select></label>
      <p>{goalType === "coding" ? "Outcome: code delivered through a pull request." : "Outcome: a versioned Markdown report in Companion. Repository files stay read-only; no PR is required."}</p>
      <section className="planner-engine-config" aria-label="Planner configuration">
        <header><strong>Planner</strong><span>{providerOptions.label} ({providerOptions.family}) · {model === PLANNER_ENGINES.passthroughModel ? "CCS default model" : modelLabel(provider, model)}</span></header>
        <div className="planner-engine-controls">
          <label><span>Engine</span><select aria-label="Planner engine" value={provider} onChange={(event) => { engineEdited.current = true; const selected = event.target.value as PlannerProvider; setProvider(selected); setModel(modelRoles.planner.models[selected]); }}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
          <ModelSelect label="Planner model" provider={provider} value={model} onChange={(value) => { engineEdited.current = true; setModel(value); }} />
          <label><span>Effort</span><select aria-label="Planner effort" value={effort} onChange={(event) => setEffort(event.target.value)}>{PLANNER_ENGINES.efforts.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        </div>
        <label><input type="checkbox" aria-label="Add reviewer pass" checked={reviewer} onChange={(event) => setReviewer(event.target.checked)} /> Add reviewer pass</label>
        <p>An independent read-only reviewer uses the other provider before your approval. Adds provider usage and waiting time; findings are advisory.</p>
      </section>
      <section className="planner-spec-options" aria-label="Spec depth">
        <header><strong>Spec depth</strong><span>Each request becomes a written requirement in every planning round and task brief.</span></header>
        <ul>{SPEC_OPTION_CATALOG.map((option) => <li key={option.id}>
          <label>
            <input type="checkbox" aria-label={option.label} checked={goalType === "analysis" && ANALYSIS_INAPPLICABLE.includes(option.id) ? false : specOptions[option.id]} disabled={goalType === "analysis" && ANALYSIS_INAPPLICABLE.includes(option.id)} onChange={(event) => setSpecOptions((current) => ({ ...current, [option.id]: event.target.checked }))} />
            <span><b>{option.label}</b><small>{goalType === "analysis" && ANALYSIS_INAPPLICABLE.includes(option.id) ? "Not applicable to read-only analysis" : option.hint}</small></span>
          </label>
        </li>)}</ul>
      </section>
      <section className="planner-engine-config" aria-label="Code review configuration">
        <strong>Code review</strong>
        <label><input type="checkbox" aria-label="Code review" checked={goalType === "coding" && reviewOptions.codeReview} disabled={goalType === "analysis"} onChange={(event) => { reviewEdited.current = true; setReviewOptions((current) => ({ ...current, codeReview: event.target.checked })); }} /> Add reviewer pass after PR creation</label>
        <p>{goalType === "analysis" ? "Not applicable to analysis. Challenge the saved report instead." : "A separate read-only agent reviews the observed PR commit and posts advisory findings to GitHub. Adds provider usage and waiting time; never fixes or merges automatically."}</p>
        <label><span>Reviewer</span><select aria-label="Code reviewer" disabled={goalType === "analysis"} value={reviewOptions.reviewer} onChange={(event) => { reviewEdited.current = true; const selected = event.target.value as PlannerProvider; setReviewOptions((current) => ({ ...current, reviewer: selected, reviewerModel: modelRoles.codeReviewer.models[selected] })); }}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
        <ModelSelect label={goalType === "analysis" ? "Analysis critique model" : "Code reviewer model"} provider={reviewOptions.reviewer} value={reviewOptions.reviewerModel} onChange={(value) => { reviewEdited.current = true; setReviewOptions((current) => ({ ...current, reviewerModel: value })); }} />
      </section>
      <section className="planner-spec-options planner-burst" aria-label="Execution intensity">
        <header><strong>{BURST_OPTION.label}</strong><span>{BURST_OPTION.hint}</span></header>
        <ul><li>
          <label>
            <input type="checkbox" aria-label={BURST_OPTION.label} checked={burst} onChange={(event) => setBurst(event.target.checked)} />
            <span><b>{BURST_OPTION.label}</b><small>{BURST_OPTION.description}</small></span>
          </label>
        </li></ul>
      </section>
      {error && <p className="worktree-action-error">{error}</p>}
      {busy === "plan" && <p className="planner-waiting">Starting the round…</p>}
      <div className="worktree-launch-actions"><ImagePickerButton attachments={attachments} disabled={busy === "plan" || uploading > 0} inputRef={inputRef} label="Choose goal images" onFiles={(files) => { void addImages(files); }} /><button type="button" className="primary-button" disabled={busy === "plan" || modelDefaultsLoading || uploading > 0 || !goal.trim() || !model.trim() || !reviewOptions.reviewerModel.trim()} onClick={() => { void startGoalSession(); }}>{busy === "plan" ? "Starting…" : uploading ? `Uploading ${uploading}…` : "Start goal session"}</button></div>
    </>}
    {draft && draft.workflow !== "goal_session" && stalled && <section className="planner-stalled" aria-label="Planning stopped">
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <p className="planner-background-note">This round stopped before it produced anything.{stalledReason ? "" : " A companion restart does this."} The goal is saved, so it can run again.</p>
      {stalledReason && <p className="planner-stalled-reason">{stalledReason}{draft.lastErrorAt ? <span> · {relativeTime(draft.lastErrorAt)} ago</span> : null}</p>}

    </section>}
    {draft && draft.workflow === "goal_session" && <GoalSessionProposal draft={draft} busy={busy !== ""} onApprove={() => { void approveProposal(); }} onRequestChanges={(text) => { void requestProposalChanges(text); }} onAnswer={(text) => { void answerGoalSession(text); }} onRecover={() => { void recoverGoalSession(); }} onResendApproval={() => { void resendApproval(); }} onOpenConversation={() => { if (draft.goalSessionWorkspaceId) void onGoalSessionStarted?.(draft); }} />}
    {draft?.workflow === "goal_session" && <GoalOutcomes draft={draft} onReceive={receive} onLinked={async (linked) => { receive(linked); await onGoalSessionStarted?.(linked); }} />}
    {draft && draft.workflow !== "goal_session" && !stalled && <>
      <ContextReview goal={reviewGoal} images={reviewImages} />
      <p className="planner-round">Round {draft.round} · {draft.tasks.length} task{draft.tasks.length === 1 ? "" : "s"}</p>
      {launchedPlan && <p>This goal was already launched. The saved plan is read-only.</p>}
      <p>Saved discovery record. Continue the conversation to revise the specification.</p>
      {draft.questions.length > 0 && <p>{terminal ? "This goal is closed. Its questions and answers are read-only." : "Saved questions are read-only; continue discovery to answer in the conversation."}</p>}
      {draft.questions.map((question) => <section key={question.id}><label><strong>{question.text}</strong><textarea aria-label={question.text} value="" readOnly /></label>{question.options.map((option) => <button type="button" key={option} disabled aria-label={`Answer ${question.text} with ${option}`}>{option}</button>)}</section>)}
      {draft.tasks.length > 0 && <GoalPassport key={`${draft.planId}-${draft.round}`} draft={draft}><div className="planner-tasks">{draft.tasks.map((task) => <article className="planner-task" key={task.id}><h3>{task.title}</h3><code>{task.branch}</code><PromptDisclosure label={`Prompt for ${task.title}`} summary="Prompt" text={task.prompt} /></article>)}</div></GoalPassport>}
      <section className="planner-discussion" aria-label="Saved discussion"><DiscussionThread entries={draft.discussion || []} round={draft.round} /></section>
      {launchedPlan && <section className="planner-delivery-status" aria-label="Combined delivery status"><strong>{draft.finalPrUrl ? "Combined PR ready" : deliveryLabel(draft.deliveryStatus)}</strong><DeliveryTasks tasks={draft.tasks} planId={draft.planId} health={taskHealth} busy={taskBusy} confirming={confirmTask} onRelaunch={(taskId, mode) => { void relaunchTask(taskId, mode); }} onSkip={(taskId) => { void skipTask(taskId); }} onConfirm={setConfirmTask} />{draft.integrationBranch && <code>{draft.integrationBranch}</code>}{draft.deliveryError && <p>{draft.deliveryError}</p>}{draft.finalPrUrl ? !terminal && <a href={draft.finalPrUrl} target="_blank" rel="noreferrer">Open PR{draft.finalPrNumber ? ` #${draft.finalPrNumber}` : ""}</a> : !terminal && draft.deliveryMode === "combined" && <button type="button" className="primary-button" disabled={busy !== ""} onClick={() => { void assemble(); }}>{busy === "assemble" ? "Checking branches…" : "Check & build combined PR"}</button>}</section>}
    </>}
    {draft && error && <p role="alert">{error}</p>}
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
