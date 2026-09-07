// A managed goal conversation runs inside the visible cmux workspace. It is
// intentionally a small line-oriented program instead of a native CLI wrapper:
// Companion can prove the read-only tool surface before approval and can resume
// the same compatible CCS conversation after a revision-bound decision.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { WorktreePlanStore } from "./worktree-plan-store.mjs";
import { finalEnvelope, parsePlannerReply, progressEvent, streamExecFile } from "./worktree-planner.mjs";
import { specOptionsPromptLines } from "./spec-options.mjs";

// `--tools` is the enforced provider tool surface. `--allowed-tools` only
// answers permission prompts for this narrow subset; it is deliberately never
// used as the access-control mechanism by itself. The installed Claude CLI
// supports these flags, including `--restricted`, without any bypass mode.
const READ_ONLY = [
  "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--restricted",
  "--tools", "Read,Grep,Glob", "--permission-mode", "plan", "--permission-prompts", "none",
  "--allowed-tools", "Read,Grep,Glob",
  "--disallowed-tools", "Bash,Write,Edit,MultiEdit,NotebookEdit,Task,WebFetch,WebSearch",
];
const WRITABLE_TOOL_ALLOWLIST = [
  "Read", "Grep", "Glob", "Edit", "Write",
  "Bash(git status *)", "Bash(git diff *)", "Bash(git add *)", "Bash(git commit *)", "Bash(git push *)",
  "Bash(git rev-parse *)", "Bash(git log *)", "Bash(git show *)", "Bash(git branch --show-current)", "Bash(git fetch *)",
  "Bash(npm ci)", "Bash(npm test)", "Bash(npm run *)", "Bash(npx cypress run *)", "Bash(node --test *)",
  "Bash(pnpm install)", "Bash(pnpm test)", "Bash(pnpm run *)", "Bash(yarn install)", "Bash(yarn test)", "Bash(yarn run *)",
  "Bash(bun test *)", "Bash(bun run *)", "Bash(cargo test *)", "Bash(go test *)", "Bash(pytest *)", "Bash(python -m pytest *)",
  "Bash(gh auth status)", "Bash(gh pr create *)", "Bash(gh pr view *)", "Bash(gh pr list *)",
].join(",");
const WRITABLE = [
  "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--restricted",
  "--tools", "Read,Grep,Glob,Edit,Write,Bash", "--permission-mode", "manual", "--permission-prompts", "none",
  "--allowed-tools", WRITABLE_TOOL_ALLOWLIST,
  "--disallowed-tools", "MultiEdit,NotebookEdit,Task,WebFetch,WebSearch",
];
const TURN_TIMEOUT_MS = 30 * 60_000;
const TURN_IDLE_TIMEOUT_MS = 5 * 60_000;
const TURN_MAX_BUFFER = 1024 * 1024;

export async function runGoalSession({ planId, databasePath, generation: generationArg = null, dispatchId: dispatchArg = null, execute = runCcs, out = console.log, input = process.stdin, intervalMs = 1_000 } = {}) {
  const store = new WorktreePlanStore({ path: databasePath });
  let plan = store.get(planId);
  if (!plan || plan.workflow !== "goal_session" || !plan.goalSessionWorktreePath) throw new Error("This goal session is unavailable");
  const generation = Number.isInteger(generationArg) ? generationArg : plan.goalSessionGeneration;
  if (generation !== plan.goalSessionGeneration) throw new Error("This goal session was replaced; reopen its current workspace");
  // Direct invocations retain a safe local path for diagnostics and tests.
  // The cmux boundary always supplies its preclaimed dispatch id.
  const dispatchId = typeof dispatchArg === "string" && /^[0-9a-f-]{36}$/i.test(dispatchArg) ? dispatchArg : randomUUID();
  if (!dispatchArg) store.claimGoalSessionRunnerDispatch(planId, { generation, dispatchId });
  store.claimGoalSessionRunner(planId, { generation, pid: process.pid, dispatchId });
  out("Goal session started. I can investigate and refine the proposal here. Companion will require an approval card before implementation tools are enabled.");
  const lines = createInterface({ input, crlfDelay: Infinity });
  let turn = Promise.resolve();

  const planningTurn = async (message, pendingFeedback = null) => {
    plan = store.get(planId);
    if (plan?.goalSessionGeneration !== generation || plan?.boardStatus) throw new Error("This goal session was replaced or closed");
    const output = await execute(command(plan, message, false), { cwd: plan.goalSessionWorktreePath, out });
    validateGoalSessionPlanning(output, plan.goalSessionProviderSessionId);
    const reply = parsePlannerReply(output, plan.specOptions);
    if (!reply.sessionId) throw new Error("The provider did not return a resumable conversation id");
    plan = store.recordGoalSessionProviderSession(planId, { generation, providerSessionId: reply.sessionId });
    // Feedback can arrive while a read-only provider turn is running. It is
    // durable and wins over this stale reply, so no proposal becomes visible
    // until the queued request has been applied in the same conversation.
    if (!pendingFeedback && store.get(planId)?.goalSessionPendingInput) {
      out("New feedback was queued while I was planning. Revising before publishing a proposal.");
      return;
    }
    if (reply.status === "questions") {
      store.publishGoalSessionQuestions(planId, { generation, providerSessionId: reply.sessionId, questions: reply.questions });
      out(reply.questions.map((question) => `Question: ${question.text}${question.options.length ? ` (${question.options.join(" / ")})` : ""}`).join("\n"));
      if (pendingFeedback) store.acknowledgeGoalSessionInput(planId, { generation, feedback: pendingFeedback });
      return;
    }
    const proposal = {
      intendedBehavior: reply.spec?.outcome || plan.goal,
      scope: reply.spec?.inScope || reply.tasks.map((task) => task.title),
      exclusions: reply.spec?.nonGoals || [],
      assumptions: reply.spec?.assumptions || [],
      acceptanceCriteria: (reply.spec?.acceptanceCriteria || []).map((criterion) => ({ text: criterion.text, verification: criterion.verification })),
      verification: reply.tasks.flatMap((task) => task.verification || []),
    };
    store.publishProposal(planId, { generation: plan.goalSessionGeneration, providerSessionId: reply.sessionId, proposal });
    if (pendingFeedback) store.acknowledgeGoalSessionInput(planId, { generation, feedback: pendingFeedback });
    out(`Proposal revision ${store.get(planId).proposalRevision} is ready in Companion. Approve it there to enable implementation, or type feedback here to revise it.`);
  };

  if (!plan.goalSessionProviderSessionId && !plan.goalSessionError) {
    void (turn = turn.then(() => planningTurn(openingMessage(plan))).catch((cause) => { store.recordGoalSessionPlanningFailure(planId, { generation, error: cause?.message || cause }); out(`Planning failed: ${cause.message}`); }));
  } else if (plan.goalSessionState === "planning" && !plan.goalSessionPendingInput && !plan.goalSessionError) {
    void (turn = turn.then(() => planningTurn("Resume the saved goal conversation. Reconstruct the next proposal from the goal and saved decisions. Do not implement anything.")).catch((cause) => { store.recordGoalSessionPlanningFailure(planId, { generation, error: cause?.message || cause }); out(`Planning failed: ${cause.message}`); }));
  } else if (plan.goalSessionState === "awaiting_approval") {
    out(`Proposal revision ${plan.proposalRevision} is still awaiting a decision in Companion.`);
  }
  let implementationStarted = false;
  let inputQueued = false;
  const timer = setInterval(() => {
    if (implementationStarted) return;
    const current = store.get(planId);
    if (!inputQueued && current?.goalSessionGeneration === generation && current?.goalSessionState === "planning" && current.goalSessionPendingInput) {
      inputQueued = true;
      turn = turn.then(async () => {
        const feedback = store.consumeGoalSessionInput(planId, { generation });
        if (feedback) await planningTurn(`The user requested these changes: ${feedback}\nRevise the proposal. Do not implement anything.`, feedback);
      }).catch((cause) => {
        store.recordGoalSessionInputFailure(planId, { generation, error: cause?.message || cause });
        out(`Planning failed: ${cause?.message || cause}`);
      }).finally(() => { inputQueued = false; });
      return;
    }
    if (current?.goalSessionGeneration !== generation || current?.transitionStatus !== "pending" || !current.approvalRevision) return;
    implementationStarted = true;
    turn = turn.then(async () => {
      const latest = store.get(planId);
      if (latest?.goalSessionGeneration !== generation || latest?.transitionStatus !== "pending" || !latest.approvalRevision) { implementationStarted = false; return; }
      const claimed = store.claimGoalSessionTransition(planId, { generation, revision: latest.approvalRevision });
      if (!claimed) { implementationStarted = false; return; }
      try {
        out("Approval recorded. Resuming this provider conversation with implementation tools enabled.");
        const completed = validateGoalSessionExecution(await execute(command(claimed, implementationMessage(claimed), true), { cwd: claimed.goalSessionWorktreePath, out }), claimed.goalSessionProviderSessionId);
        store.recordGoalSessionTransition(planId, { generation, revision: claimed.approvalRevision });
        const report = completionText(completed);
        if (report) out(report);
        out("Implementation turn completed. Review the workspace and request an in-scope correction here if needed.");
      } catch (cause) {
        store.recordGoalSessionTransition(planId, { generation, revision: claimed.approvalRevision, error: String(cause?.message || cause) });
        out("The implementation transition is uncertain and was not retried automatically. Open the goal in Companion to recover it safely.");
      }
    }).catch((cause) => out(`Goal session failed: ${cause?.message || cause}`));
  }, intervalMs);
  timer.unref?.();
  lines.on("line", (line) => {
    const feedback = String(line || "").trim();
    if (!feedback) return;
    if (implementationStarted && store.get(planId)?.transitionStatus !== "delivered") { out("Implementation is still running. Wait for its recorded result before sending another request."); return; }
    const current = store.get(planId);
    if (current?.goalSessionGeneration !== generation) { out("This goal session was replaced; reopen its current workspace."); return; }
    if (current?.transitionStatus === "delivered") {
      let claimed;
      try { claimed = store.claimGoalSessionCorrection(planId, { generation, feedback }); }
      catch (cause) { out(String(cause?.message || cause)); return; }
      turn = turn.then(() => {
        const latest = store.get(planId);
        if (latest?.goalSessionGeneration !== generation || latest?.boardStatus || latest?.goalSessionCorrectionStatus !== "dispatching") throw new Error("This goal session was closed before the correction could run");
        return execute(command(latest, `The user requested this in-scope correction: ${claimed.goalSessionCorrectionInput}\nThe approved proposal is: ${JSON.stringify(latest.proposal)}\nImplement only this approved scope and report verification.`, true), { cwd: latest.goalSessionWorktreePath, out }).then((output) => {
          const completed = validateGoalSessionExecution(output, latest.goalSessionProviderSessionId);
          store.recordGoalSessionCorrection(planId, { generation });
          const report = completionText(completed);
          if (report) out(report);
        }).catch((cause) => {
          store.recordGoalSessionCorrection(planId, { generation, error: cause?.message || cause });
          throw cause;
        });
      }).catch((cause) => out(`Correction was not run: ${cause?.message || cause}`));
      return;
    }
    if (current?.goalSessionState === "awaiting_approval") {
      try { store.requestProposalChanges(planId, { generation, revision: current.proposalRevision, feedback }); }
      catch (cause) { out(String(cause?.message || cause)); return; }
      return;
    }
    if (current?.goalSessionState === "awaiting_input") {
      try { store.submitGoalSessionAnswer(planId, { generation, feedback }); }
      catch (cause) { out(String(cause?.message || cause)); }
      return;
    }
    if (current?.goalSessionState === "planning") {
      try { store.queueGoalSessionSteering(planId, { generation, feedback }); out("Feedback queued. The next proposal will include it."); }
      catch (cause) { out(String(cause?.message || cause)); }
      return;
    }
    out("This goal is not waiting for an answer. Use the approval card or wait for the current proposal turn.");
  });
  return () => { clearInterval(timer); lines.close(); store.releaseGoalSessionRunner(planId, { generation, pid: process.pid }); store.close(); };
}

function command(plan, message, writable) {
  const args = [plan.engine.provider, "--target", "claude", "--print", "--output-format", "stream-json", "--verbose", ...(writable ? WRITABLE : READ_ONLY)];
  if (plan.engine.model && plan.engine.model !== "default") args.push("--model", plan.engine.model);
  if (plan.engine.effort && plan.engine.effort !== "default") args.push("--effort", plan.engine.effort);
  const attachmentDirectories = [...new Set((plan.images || []).map((image) => typeof image?.path === "string" ? dirname(image.path) : "").filter(Boolean))];
  for (const directory of attachmentDirectories) args.push("--add-dir", directory);
  const session = plan.goalSessionProviderSessionId;
  if (session) args.push("--resume", session);
  args.push("--", message);
  return args;
}

function openingMessage(plan) {
  const images = Array.isArray(plan.images) && plan.images.length
    ? `\nAttached image${plan.images.length > 1 ? "s" : ""}:\n${plan.images.map((image) => `- ${image.path}`).join("\n")}\nRead each attachment with the Read tool; it provides user context for the proposal.\n`
    : "";
  const options = specOptionsPromptLines(plan.specOptions);
  return `You are planning one small increment for this goal: ${plan.goal}${images}Investigate read-only. Reply with exactly one JSON object and no other prose. Return either {"questions":[{"text":"...","options":["..."]}]} or {"spec":{"outcome":"...","inScope":["..."],"nonGoals":["..."],"constraints":["..."],"assumptions":["..."],"acceptanceCriteria":[{"id":"AC-1","text":"observable result","verification":"specific check"}],"risks":[{"text":"...","mitigation":"...","level":"low|medium|high"}],"optionEvidence":{}},"tasks":[{"id":"T1","title":"...","branch":"feature/...","prompt":"self-contained outcome, scope and verification","type":"feature|bugfix|ui|backend|docs|test|migration|investigation|refactor","criterionIds":["AC-1"],"dependsOn":[],"ownedAreas":["path/or/glob/**"],"verification":["specific command or manual check"]}]}. Never return both questions and tasks.${options.length ? `\n${options.join("\n")}` : ""} Do not implement, run shell commands, edit files, delegate, or ask for tool permissions.`;
}

function implementationMessage(plan) {
  const base = plan.baseRef || plan.baseSha || "the recorded repository base";
  const issues = (plan.issueNumbers || []).filter((number) => Number.isInteger(number) && number > 0);
  const issueDelivery = issues.length ? ` Linked GitHub issues: ${issues.map((number) => `#${number}`).join(", ")}. Reference these issues in the pull request. Add a Closes #N line only for issues fully resolved by the approved scope; otherwise explain the remaining work. Do not close issues directly or expand scope to close them.` : "";
  return `The user approved proposal revision ${plan.approvalRevision}. The immutable approved proposal is:\n${JSON.stringify(plan.proposal)}\nImplement only that displayed scope in this worktree. Do not expand it without another proposal. When finished, commit the change, push branch ${plan.goalSessionBranch}, open one pull request against ${base}, and report concrete manual verification and changed files.${issueDelivery}`;
}

function runCcs(args, { cwd, out = null } = {}) {
  return streamExecFile("ccs", args, {
    cwd,
    env: process.env,
    timeout: TURN_TIMEOUT_MS,
    idleTimeout: TURN_IDLE_TIMEOUT_MS,
    maxBuffer: TURN_MAX_BUFFER,
    onLine: (row) => {
      const prose = assistantProse(row);
      if (prose) out?.(prose);
      else { const progress = progressEvent(row); if (progress?.t) out?.(progress.t); }
    },
  }).then(({ stdout }) => finalEnvelope(stdout));
}

// A zero exit code only says that the CLI process exited. Provider failures and
// permission denials are emitted as stream-json result envelopes with that same
// exit code, so a writable transition must validate the provider result before
// it becomes delivered.
export function validateGoalSessionExecution(output, expectedSessionId = null) {
  return validateGoalSessionEnvelope(output, expectedSessionId, "writable");
}

// Planning remains read-only, but it is still a continuation of one recorded
// provider conversation. A success-shaped error or a changed session id must
// never replace the durable resume id before an approval is evaluated.
export function validateGoalSessionPlanning(output, expectedSessionId = null) {
  return validateGoalSessionEnvelope(output, expectedSessionId, "planning");
}

function validateGoalSessionEnvelope(output, expectedSessionId, turn) {
  const raw = finalEnvelope(String(output || "")).trim();
  let envelope;
  try { envelope = JSON.parse(raw); } catch { throw new TypeError("The provider did not return a completion envelope"); }
  const denied = [envelope?.permission_denials, envelope?.permission_denied, envelope?.denied_tools]
    .some((value) => Array.isArray(value) ? value.length > 0 : Boolean(value));
  const sessionId = typeof envelope?.session_id === "string" ? envelope.session_id.trim() : "";
  const wrongSession = expectedSessionId && sessionId !== expectedSessionId;
  if (envelope?.type !== "result" || envelope?.subtype !== "success" || envelope?.is_error === true || denied || !sessionId || wrongSession) {
    const detail = wrongSession
      ? "the provider returned a different conversation id"
      : String(envelope?.result || envelope?.error || "provider execution was not successful").replace(/\s+/g, " ").trim().slice(0, 500);
    throw new TypeError(`The provider did not complete the ${turn} turn: ${detail}`);
  }
  return envelope;
}

function assistantProse(row) {
  try {
    const value = JSON.parse(row);
    if (value?.type !== "assistant") return "";
    return (value.message?.content || []).filter((block) => block?.type === "text")
      .map((block) => String(block.text || "").trim()).filter(Boolean).join("\n").slice(0, 8_000);
  } catch { return ""; }
}

function completionText(envelope) {
  const text = String(envelope?.result || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 8_000) : "";
}

if (process.argv[1]?.endsWith("goal-session-runner.mjs")) {
  const [planId, databasePath, generation, dispatchId] = process.argv.slice(2);
  runGoalSession({ planId, databasePath, generation: Number(generation), dispatchId }).catch((cause) => { console.error(cause?.message || cause); process.exitCode = 1; });
}
