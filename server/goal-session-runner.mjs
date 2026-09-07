// A managed goal conversation runs inside the visible cmux workspace. It is
// intentionally a small line-oriented program instead of a native CLI wrapper:
// Companion can prove the read-only tool surface before approval and can resume
// the same compatible CCS conversation after a revision-bound decision.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { WorktreePlanStore } from "./worktree-plan-store.mjs";
import { finalEnvelope, parsePlannerReply, progressEvent } from "./worktree-planner.mjs";

const READ_ONLY = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--allowed-tools", "Read,Grep,Glob", "--disallowed-tools", "Bash,Write,Edit,MultiEdit,NotebookEdit,Task,WebFetch,WebSearch"];
const WRITABLE = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];

export async function runGoalSession({ planId, databasePath, generation: generationArg = null, execute = runCcs, out = console.log, input = process.stdin, intervalMs = 1_000 } = {}) {
  const store = new WorktreePlanStore({ path: databasePath });
  let plan = store.get(planId);
  if (!plan || plan.workflow !== "goal_session" || !plan.goalSessionWorktreePath) throw new Error("This goal session is unavailable");
  const generation = Number.isInteger(generationArg) ? generationArg : plan.goalSessionGeneration;
  if (generation !== plan.goalSessionGeneration) throw new Error("This goal session was replaced; reopen its current workspace");
  out("Goal session started. I can investigate and refine the proposal here. Companion will require an approval card before implementation tools are enabled.");
  const lines = createInterface({ input, crlfDelay: Infinity });
  let turn = Promise.resolve();

  const planningTurn = async (message) => {
    plan = store.get(planId);
    if (plan.goalSessionGeneration !== generation) throw new Error("This goal session was replaced");
    const reply = parsePlannerReply(await execute(command(plan, message, false), { cwd: plan.goalSessionWorktreePath, out }), plan.specOptions);
    if (!reply.sessionId) throw new Error("The provider did not return a resumable conversation id");
    plan = store.recordGoalSessionProviderSession(planId, { generation, providerSessionId: reply.sessionId });
    if (reply.status === "questions") {
      out(reply.questions.map((question) => `Question: ${question.text}${question.options.length ? ` (${question.options.join(" / ")})` : ""}`).join("\n"));
      return;
    }
    const proposal = { intendedBehavior: reply.spec?.outcome || plan.goal, scope: reply.tasks.map((task) => task.title), assumptions: reply.spec?.assumptions || [], verification: reply.tasks.flatMap((task) => task.verification || []) };
    store.publishProposal(planId, { generation: plan.goalSessionGeneration, providerSessionId: reply.sessionId, proposal });
    out(`Proposal revision ${store.get(planId).proposalRevision} is ready in Companion. Approve it there to enable implementation, or type feedback here to revise it.`);
  };

  if (!plan.goalSessionProviderSessionId) {
    void (turn = turn.then(() => planningTurn(openingMessage(plan))).catch((cause) => out(`Planning failed: ${cause.message}`)));
  } else if (plan.goalSessionState === "planning" && !plan.goalSessionPendingInput) {
    void (turn = turn.then(() => planningTurn("Resume the saved goal conversation. Reconstruct the next proposal from the goal and saved decisions. Do not implement anything.")).catch((cause) => out(`Planning failed: ${cause.message}`)));
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
        if (feedback) await planningTurn(`The user requested these changes: ${feedback}\nRevise the proposal. Do not implement anything.`);
      }).catch((cause) => out(`Planning failed: ${cause?.message || cause}`)).finally(() => { inputQueued = false; });
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
        await execute(command(claimed, implementationMessage(claimed), true), { cwd: claimed.goalSessionWorktreePath, out });
        store.recordGoalSessionTransition(planId, { generation, revision: claimed.approvalRevision });
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
    if (!feedback || implementationStarted && store.get(planId)?.transitionStatus !== "delivered") return;
    const current = store.get(planId);
    if (current?.goalSessionGeneration !== generation) { out("This goal session was replaced; reopen its current workspace."); return; }
    if (current?.transitionStatus === "delivered") {
      turn = turn.then(() => execute(command(current, `The user requested this in-scope correction: ${feedback}\nThe approved proposal is: ${JSON.stringify(current.proposal)}\nImplement only this approved scope and report verification.`, true), { cwd: current.goalSessionWorktreePath, out }));
      return;
    }
    if (current?.goalSessionState === "awaiting_approval") {
      try { store.requestProposalChanges(planId, { generation, revision: current.proposalRevision, feedback }); }
      catch (cause) { out(String(cause?.message || cause)); return; }
    }
    turn = turn.then(() => planningTurn(`The user responded: ${feedback}\nRevise the proposal. Do not implement anything.`)).catch((cause) => out(`Planning failed: ${cause.message}`));
  });
  return () => { clearInterval(timer); lines.close(); store.close(); };
}

function command(plan, message, writable) {
  const args = [plan.engine.provider, "--target", "claude", "--print", "--output-format", "stream-json", "--verbose", ...(writable ? WRITABLE : READ_ONLY)];
  if (plan.engine.model && plan.engine.model !== "default") args.push("--model", plan.engine.model);
  if (plan.engine.effort && plan.engine.effort !== "default") args.push("--effort", plan.engine.effort);
  const session = plan.goalSessionProviderSessionId;
  if (session) args.push("--resume", session);
  args.push("--", message);
  return args;
}

function openingMessage(plan) {
  return `You are planning one small increment for this goal: ${plan.goal}\nInvestigate read-only. Return either focused questions or a structured delivery contract with spec and tasks. Do not implement, run shell commands, edit files, delegate, or ask for tool permissions.`;
}

function implementationMessage(plan) {
  return `The user approved proposal revision ${plan.approvalRevision}. The immutable approved proposal is:\n${JSON.stringify(plan.proposal)}\nImplement only that displayed scope in this worktree. Do not expand it without another proposal. When finished, commit the change, push the branch, open one pull request against the recorded base, and report concrete manual verification and changed files.`;
}

function runCcs(args, { cwd, out = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn("ccs", args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    let partial = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk; partial += chunk;
      const rows = partial.split("\n"); partial = rows.pop() || "";
      for (const row of rows) {
        const prose = assistantProse(row);
        if (prose) out?.(prose);
        else { const progress = progressEvent(row); if (progress?.t) out?.(progress.t); }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(finalEnvelope(stdout)) : reject(new Error(stderr.trim() || "CCS exited without completing the goal turn")));
  });
}

function assistantProse(row) {
  try {
    const value = JSON.parse(row);
    if (value?.type !== "assistant") return "";
    return (value.message?.content || []).filter((block) => block?.type === "text")
      .map((block) => String(block.text || "").trim()).filter(Boolean).join("\n").slice(0, 8_000);
  } catch { return ""; }
}

if (process.argv[1]?.endsWith("goal-session-runner.mjs")) {
  const [planId, databasePath, generation] = process.argv.slice(2);
  runGoalSession({ planId, databasePath, generation: Number(generation) }).catch((cause) => { console.error(cause?.message || cause); process.exitCode = 1; });
}
