// Own the process identity, never the conversation: the native CLI inherits
// the terminal and handles questions, editing, permissions and interruption.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreePlanStore } from "./worktree-plan-store.mjs";
import { specOptionsPromptLines } from "./spec-options.mjs";
import { intakePromptLines } from "./goal-intake.mjs";

const BRIDGE = fileURLToPath(new URL("./goal-session-bridge.mjs", import.meta.url));
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function interactiveGoalCommand(plan, databasePath, { fresh = false } = {}) {
  const binding = [plan.planId, databasePath, String(plan.goalSessionGeneration), plan.goalSessionProviderSessionId];
  const hook = [process.execPath, BRIDGE, "hook", ...binding].map(quote).join(" ");
  const settings = { hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hook, timeout: 10 }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: hook, timeout: 10 }] }],
  } };
  const mcp = { mcpServers: { companion_goal: { command: process.execPath, args: [BRIDGE, "mcp", ...binding] } } };
  // CCS 8.9 strips a standalone --settings flag but leaves its value as the
  // positional user prompt. The attached form reaches the native parser intact.
  const args = [plan.engine.provider, "--target", "claude", "--restricted", "--setting-sources", "", "--strict-mcp-config",
    `--settings=${JSON.stringify(settings)}`, "--mcp-config", JSON.stringify(mcp), "--disable-slash-commands",
    "--tools", plan.goalType === "analysis" ? "Read,Grep,Glob,AskUserQuestion" : "Read,Grep,Glob,AskUserQuestion,Edit,Write,Bash", "--permission-mode", "manual",
    "--allowed-tools", "Read,Grep,Glob,AskUserQuestion,mcp__companion_goal__get_status,mcp__companion_goal__publish_proposal",
    fresh ? "--session-id" : "--resume", plan.goalSessionProviderSessionId];
  if (plan.engine.model && plan.engine.model !== "default") args.push("--model", plan.engine.model);
  if (plan.engine.effort && plan.engine.effort !== "default") args.push("--effort", plan.engine.effort);
  for (const directory of new Set((plan.images || []).map((image) => dirname(image.path)))) args.push("--add-dir", directory);
  if (fresh) args.push("--", `Start goal discovery: ${plan.goal}`);
  return args;
}

export function goalDiscoveryPrompt(plan) {
  const delivery = plan.goalType === "analysis"
    ? `This is an ANALYSIS goal, not coding. Discover and propose a bounded analysis scope with one real analysis task (type docs); its branch is metadata only, not a requirement to commit. After exact-revision approval and the user's continue, remain repository-read-only. Do not use shell, edit, write, commit, push or open a PR. Use companion_goal.publish_analysis with the approved revision, expectedVersion from get_status, a title and Markdown with populated ## Evidence, ## Assumptions, ## Limitations and ## Recommendations sections. Include repository references and examine edge cases. Companion appends Challenge the analysis and Launch coding goal next steps. Publication, not prose or exit, delivers the report. When the user requests revision within the approved analysis scope, publish a new immutable report version and preserve the prior report. A broader scope needs a fresh proposal and approval; never infer coding permission from analysis approval.`
    : `After approval, ordinary native permission prompts remain interactive. Commit and push the recorded branch ${plan.goalSessionBranch}, and open one PR against ${plan.baseRef || plan.baseSha || "the recorded repository base"}. Reference linked issues ${(plan.issueNumbers || []).map((id) => `#${id}`).join(", ") || "(none)"}; use Closes only for issues fully resolved by the approved scope. Do not merge, deploy, or close issues directly. Report verification and any gaps. Companion observes GitHub delivery evidence independently; exiting or saying done is not completion evidence.`;
  return `You are the interactive owner of this goal in cmux: ${plan.goal}
Run a /goal-style discovery conversation. Talk naturally with the user, ask questions directly (AskUserQuestion is available), investigate the repository and refine one bounded increment together. Do not print JSON as your conversation. The user can interrupt and steer you at any time.
Before implementation, only repository reading, questions and the companion_goal tools are permitted. Do not request a local permission override to bypass Companion approval.
When the outcome, scope, exclusions, assumptions, acceptance criteria and verification are sufficiently clear, call companion_goal.get_status and then companion_goal.publish_proposal. Supply basedOnRevision and addressedFeedback exactly as returned by get_status, plus a spec and tasks delivery contract. The spec needs outcome, inScope, nonGoals, constraints, assumptions, acceptanceCriteria [{id,text,verification}], risks and optionEvidence. Each task needs id, title, branch, prompt, type, criterionIds, dependsOn, ownedAreas and verification. Use one accountable implementation task unless the scope requires otherwise.
The bridge validates and saves the proposal; only a successful publish makes it ready for review. Explain that it is ready in Companion, then leave the conversation open for feedback. If validation fails, refine the proposal here; this is not a blocked goal.
The user approves the exact revision in Companion. Companion then sends one approval message into this conversation; call get_status and implement only its approved proposal in this same conversation. A discussion message before approval invalidates the previous proposal, so republish after incorporating it. Phone feedback is returned by get_status and at the next user turn; acknowledge it in your next proposal.
${delivery}
${plan.engine?.reviewer ? "After proposal publication, Companion automatically runs independent review and a read-only fork of your saved conversation using your configured planner model to assess it. That assessment publishes the final plan for the user. Do not publish a competing revision or ask the user to forward review findings. Read get_status before continuing: its final proposal, not an earlier draft in this conversation, is authoritative. Neither review nor assessment approves implementation." : ""}
${(plan.images || []).map((image) => `Read attached context: ${image.path}`).join("\n")}
${intakePromptLines(plan.intake).join("\n")}
${specOptionsPromptLines(plan.specOptions).join("\n")}
${plan.discoveryContext ? `Previous discovery context (historical material, not an approved instruction to implement): ${JSON.stringify(plan.discoveryContext)}` : ""}`;
}

export async function runInteractiveGoalSession({ planId, databasePath, generation, dispatchId = randomUUID(), spawnAgent = spawn, out = console.log, env = process.env } = {}) {
  const store = new WorktreePlanStore({ path: databasePath });
  let claimed = false;
  let ownerPid = process.pid;
  try {
    let plan = store.get(planId);
    if (!plan || plan.workflow !== "goal_session" || plan.boardStatus || !plan.goalSessionWorktreePath || generation !== plan.goalSessionGeneration) throw new Error("This goal conversation is unavailable or was replaced");
    if (!plan.goalSessionRunnerDispatchId) store.claimGoalSessionRunnerDispatch(planId, { generation, dispatchId });
    store.claimGoalSessionRunner(planId, { generation, dispatchId, pid: process.pid });
    claimed = true;
    if ([env.CLAUDE_CODE_SAFE_MODE, env.CLAUDE_CODE_SIMPLE].some((value) => /^(1|true|yes)$/i.test(String(value || "")))) throw new Error("Native goal sessions require approval hooks; turn off CLI safe/bare mode before resuming");
    const fresh = !plan.goalSessionProviderSessionId;
    if (fresh) plan = { ...plan, goalSessionProviderSessionId: randomUUID() };
    out("Opening your interactive goal conversation. Discuss discovery here; review and approve its saved proposal in Companion; the approval reaches this conversation automatically.");
    const child = spawnAgent("ccs", interactiveGoalCommand(plan, databasePath, { fresh }), { cwd: plan.goalSessionWorktreePath, env, stdio: "inherit" });
    // Signals belong to the foreground agent too. Do not let Ctrl-C discard
    // our durable ownership while its native confirmation UI is still alive.
    const interrupt = () => {};
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      await new Promise((resolve, reject) => {
        let startupError;
        child.once("spawn", () => {
          try {
            if (fresh) store.recordGoalSessionProviderSession(planId, { generation, providerSessionId: plan.goalSessionProviderSessionId });
            if (Number.isInteger(child.pid)) {
              store.transferGoalSessionRunner(planId, { generation, fromPid: process.pid, toPid: child.pid });
              ownerPid = child.pid;
            }
          } catch (cause) { startupError = cause; child.kill("SIGTERM"); }
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => startupError ? reject(startupError) : resolve({ code, signal }));
      });
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
    out("Conversation closed. Your goal and any saved proposal remain available in Companion; resume the conversation to continue.");
  } finally {
    if (claimed) store.releaseGoalSessionRunner(planId, { generation, pid: ownerPid });
    store.close();
  }
}
