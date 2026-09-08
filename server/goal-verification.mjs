import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The delivery contract names how the work is checked, as text. Approval means
// the words look right; nothing ran them. This runs one of those words: when a
// goal session's pull request opens, the contract's verification lines are
// matched to the repository's own declared package scripts, and the matched
// script runs once per head commit inside the goal's worktree. The result is
// recorded on the plan as evidence beside the pull request. It never moves the
// goal, never edits the branch and never runs a command the repository did not
// declare.
const COMMAND_TIMEOUT_MS = Number(process.env.CMUX_GOAL_VERIFY_TIMEOUT_MS) || 20 * 60 * 1_000;
const MAX_OUTPUT = 4_000;
// Preferred when the contract names several declared scripts: the widest first.
const PREFERENCE = ["verify", "check", "ci", "test", "lint", "typecheck"];

const executeFile = promisify(execFile);

export class GoalVerification {
  constructor({ store, repoCatalog, execute = executeFile, gitHead = null, log = null }) {
    if (!store) throw new TypeError("A goal plan store is required");
    this.store = store;
    this.repoCatalog = repoCatalog;
    this.execute = execute;
    this.gitHead = gitHead || ((cwd) => this.#git(cwd, ["rev-parse", "HEAD"]));
    this.log = log;
    this.running = new Map();
  }

  // One run per goal at a time; a second caller shares the first run.
  verify(planId) {
    const id = String(planId || "");
    if (this.running.has(id)) return this.running.get(id);
    const run = this.#verify(id).finally(() => { if (this.running.get(id) === run) this.running.delete(id); });
    this.running.set(id, run);
    return run;
  }

  async #verify(planId) {
    const plan = this.store.get(planId);
    if (!plan || plan.workflow !== "goal_session" || plan.boardStatus || !plan.goalSessionWorktreePath || !plan.approvalAt) return { planId, status: "skipped" };
    let headSha;
    try { headSha = String(await this.gitHead(plan.goalSessionWorktreePath)).trim(); }
    catch (cause) { return this.#record(plan, { status: "unavailable", reason: `The goal worktree commit could not be read: ${cause?.message || cause}` }); }
    const current = plan.verification;
    if (current && current.headSha === headSha && ["passed", "failed"].includes(current.status)) return { planId, status: current.status, script: current.script, headSha };
    let scripts = [];
    try { scripts = (await this.repoCatalog?.get?.(plan.repositoryId))?.scripts || []; } catch { scripts = []; }
    const chosen = chooseVerificationCommand(plan.proposal?.verification || [], scripts);
    if (!chosen) return this.#record(plan, { status: "unavailable", headSha, reason: "The contract names no declared package script to run" });
    const startedAt = new Date().toISOString();
    try {
      const { stdout = "", stderr = "" } = await this.execute("npm", ["run", "--silent", chosen.script], { cwd: plan.goalSessionWorktreePath, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: "1" } });
      return this.#record(plan, { status: "passed", headSha, script: chosen.script, source: chosen.source, startedAt, output: tail(`${stdout}${stderr}`) });
    } catch (cause) {
      return this.#record(plan, { status: "failed", headSha, script: chosen.script, source: chosen.source, startedAt, output: tail(`${cause?.stdout || ""}${cause?.stderr || ""}${cause?.stderr || cause?.stdout ? "" : cause?.message || ""}`) });
    }
  }

  #record(plan, verification) {
    const entry = { ...verification, finishedAt: new Date().toISOString() };
    try { this.store.recordGoalVerification(plan.planId, entry); }
    catch (cause) { this.log?.warn?.({ err: cause, planId: plan.planId }, "goal verification could not be recorded"); }
    return { planId: plan.planId, status: entry.status, script: entry.script, headSha: entry.headSha };
  }

  async #git(cwd, args) {
    const { stdout = "" } = await this.execute("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000 });
    return stdout;
  }
}

// Reads the contract's verification lines for `npm test`, `npm run <script>`,
// `yarn <script>` or `pnpm <script>`, keeps only names the repository declares,
// and returns the widest one. Prose such as "Try a sandbox payment" matches
// nothing, and nothing runs.
export function chooseVerificationCommand(verification, scripts) {
  const declared = new Set(Array.isArray(scripts) ? scripts : []);
  const found = [];
  for (const line of Array.isArray(verification) ? verification : []) {
    const text = String(line || "");
    for (const match of text.matchAll(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([a-zA-Z0-9:_-]{1,64})\b/g)) {
      const script = match[1];
      if (script === "run" || script === "exec" || script === "install") continue;
      if (declared.has(script)) found.push({ script, source: text.trim() });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => rank(a.script) - rank(b.script));
  return found[0];
}

function rank(script) {
  const index = PREFERENCE.indexOf(script);
  return index === -1 ? PREFERENCE.length : index;
}

function tail(text) {
  const value = String(text || "");
  return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value;
}
