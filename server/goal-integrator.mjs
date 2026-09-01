import { readFile } from "node:fs/promises";
import { join } from "node:path";

const TASK_SETTLE_MS = 1_000;
const COMMAND_TIMEOUT_MS = 15 * 60_000;

class TasksNotReadyError extends TypeError {}

// A multi-task goal owns one delivery branch. Task worktrees are implementation
// details: their pushed, immutable heads are squash-merged here and only this
// generated branch becomes a pull request against the repository default.
export class GoalIntegrator {
  constructor({ store, worktrees, repoCatalog, execute = null, log = null, settleMs = TASK_SETTLE_MS } = {}) {
    if (!store) throw new TypeError("A goal plan store is required");
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!repoCatalog) throw new TypeError("A repository catalog is required");
    this.store = store;
    this.worktrees = worktrees;
    this.repoCatalog = repoCatalog;
    this.execute = execute || ((bin, args, options) => repoCatalog.execute(bin, args, options));
    this.log = log;
    this.settleMs = settleMs;
    this.locks = new Map();
    this.timers = new Map();
  }

  attach({ hub }) {
    if (!hub) return null;
    const onEvent = (event) => {
      if (event?.name !== "agent.hook.Stop") return;
      const workspaceId = event.workspace_id || event.payload?.workspace_id || event.data?.workspace_id;
      if (workspaceId) this.scheduleWorkspace(workspaceId);
    };
    hub.on("event", onEvent);
    hub.addConsumer();
    const startup = setTimeout(() => {
      for (const plan of this.store.activeCombinedPlans()) this.schedulePlan(plan.planId);
    }, this.settleMs);
    startup.unref?.();
    return () => {
      clearTimeout(startup);
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
      hub.off("event", onEvent);
      hub.removeConsumer();
    };
  }

  scheduleWorkspace(workspaceId) {
    const found = this.store.findTaskByWorkspace(workspaceId);
    if (found?.plan) this.schedulePlan(found.plan.planId);
  }

  schedulePlan(planId) {
    clearTimeout(this.timers.get(planId));
    const timer = setTimeout(() => {
      this.timers.delete(planId);
      this.assemble(planId, { automatic: true }).catch((cause) => {
        if (!(cause instanceof TasksNotReadyError)) this.log?.warn?.({ err: cause, planId }, "combined goal assembly failed");
      });
    }, this.settleMs);
    timer.unref?.();
    this.timers.set(planId, timer);
  }

  async assemble(planId, { automatic = false } = {}) {
    const id = String(planId || "");
    if (this.locks.has(id)) return this.locks.get(id);
    const running = this.#assemble(id, { automatic }).finally(() => this.locks.delete(id));
    this.locks.set(id, running);
    return running;
  }

  async #assemble(planId, { automatic }) {
    let plan = this.store.get(planId);
    if (!plan) throw new TypeError("Unknown plan. Start a new goal");
    if (plan.status !== "launched" || plan.deliveryMode !== "combined") {
      throw new TypeError("Only a launched multi-task goal can build a combined pull request");
    }
    if (plan.finalPrUrl) return deliveryResult(plan);

    plan = await this.#refreshTaskHeads(plan);
    const pending = plan.tasks.filter((task) => task.launchStatus === "launched" && task.deliveryStatus !== "ready" && task.deliveryStatus !== "integrated");
    const failed = plan.tasks.filter((task) => task.launchStatus !== "launched");
    if (failed.length) throw new TypeError("Every task must launch successfully before Companion can build the combined pull request");
    if (pending.length) {
      const message = `Waiting for ${pending.length} task branch${pending.length === 1 ? "" : "es"} to be committed and pushed`;
      if (automatic) throw new TasksNotReadyError(message);
      throw new TypeError(message);
    }

    try {
      plan = await this.#integrationWorktree(plan);
      for (const task of plan.tasks) {
        if (task.integratedCommitSha) continue;
        const recovered = await this.#integratedCommit(plan, task);
        if (recovered) {
          plan = this.store.recordTaskIntegrated(plan.planId, task.id, recovered);
          continue;
        }
        await this.#git(plan.integrationWorktreePath, ["merge", "--squash", "--no-commit", task.headSha], { timeout: 120_000 });
        await this.#git(plan.integrationWorktreePath, ["commit", "-m", taskCommitMessage(plan, task)], { timeout: 120_000 });
        const commitSha = (await this.#git(plan.integrationWorktreePath, ["rev-parse", "HEAD"])).trim();
        plan = this.store.recordTaskIntegrated(plan.planId, task.id, commitSha);
      }

      const commands = await qualityCommands(plan.integrationWorktreePath);
      if (!commands.some((command) => command.bin === "npm" && command.args[0] === "run")) {
        throw new TypeError("This repository has no supported declared verification script. Add verify, test, lint, typecheck, or build before combined delivery");
      }
      for (const command of commands) await this.#run(command.bin, command.args, { cwd: plan.integrationWorktreePath, timeout: COMMAND_TIMEOUT_MS });
      const verifiedAt = new Date().toISOString();

      await this.#git(plan.integrationWorktreePath, ["push", "-u", "origin", plan.integrationBranch], { timeout: 120_000 });
      const pullRequest = await this.#pullRequest(plan);
      plan = this.store.recordFinalPr(plan.planId, { ...pullRequest, verifiedAt });
      return deliveryResult(plan);
    } catch (cause) {
      const message = conciseError(cause);
      this.store.recordDeliveryFailure(plan.planId, message);
      throw new TypeError(message);
    }
  }

  async #refreshTaskHeads(plan) {
    let current = plan;
    for (const task of plan.tasks) {
      if (task.launchStatus !== "launched" || task.deliveryStatus === "integrated") continue;
      const headSha = await this.#readyHead(plan, task);
      if (headSha && (task.headSha !== headSha || task.deliveryStatus !== "ready")) {
        current = this.store.recordTaskReady(plan.planId, task.id, headSha);
      } else if (!headSha && task.deliveryStatus === "ready") {
        current = this.store.recordTaskPending(plan.planId, task.id);
      }
    }
    return this.store.get(current.planId);
  }

  async #readyHead(plan, task) {
    const status = await this.#git(task.worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim()) return null;
    const headSha = (await this.#git(task.worktreePath, ["rev-parse", "HEAD"])).trim();
    const base = plan.baseSha || plan.baseRef;
    const ahead = Number((await this.#git(task.worktreePath, ["rev-list", "--count", `${base}..${headSha}`])).trim());
    if (!headSha || !Number.isFinite(ahead) || ahead < 1) return null;
    const commitMessage = await this.#git(task.worktreePath, ["log", "-1", "--format=%B", headSha]);
    if (!commitMessage.includes(`Cmux-Goal-Ready: ${plan.planId}/${task.id}`)) return null;
    const remote = await this.#git(task.worktreePath, ["ls-remote", "origin", `refs/heads/${task.branch}`]).catch(() => "");
    return remote.trim().split(/\s+/)[0] === headSha ? headSha : null;
  }

  async #integrationWorktree(plan) {
    if (plan.integrationWorktreePath && plan.integrationBranch) return plan;
    const baseBranch = String(plan.baseRef || "origin/main").replace(/^origin\//, "") || "main";
    await this.#git(plan.cwd, ["fetch", "origin", baseBranch], { timeout: 120_000 });
    const branch = integrationBranch(plan);
    const dashboard = await this.worktrees.snapshot?.({ refresh: true });
    const recovered = dashboard?.repositories?.find((repository) => repository.id === plan.repositoryId)?.worktrees?.find((worktree) => worktree.branch === branch);
    if (recovered?.path) return this.store.recordIntegrationStarted(plan.planId, { branch, path: recovered.path });
    const created = await this.worktrees.create(plan.repositoryId, { branch, base: `origin/${baseBranch}` });
    if (created.branchCreated === false) throw new TypeError(`The integration branch ${branch} already exists`);
    return this.store.recordIntegrationStarted(plan.planId, { branch, path: created.worktree.path });
  }

  async #integratedCommit(plan, task) {
    const token = `Cmux-Goal-Task: ${plan.planId}/${task.id}/${task.headSha}`;
    const output = await this.#git(plan.integrationWorktreePath, ["log", "-100", "--format=%H%x00%B%x00"]);
    const parts = output.split("\0");
    for (let index = 0; index + 1 < parts.length; index += 2) {
      const sha = parts[index].trim().split("\n").at(-1) || "";
      if (/^[0-9a-f]{40}$/i.test(sha) && parts[index + 1].includes(token)) return sha;
    }
    return null;
  }

  async #pullRequest(plan) {
    const existing = await this.#run("gh", ["pr", "view", plan.integrationBranch, "--json", "number,url"], {
      cwd: plan.integrationWorktreePath, timeout: 20_000,
    }).then(({ stdout }) => parsePullRequest(stdout), () => null);
    if (existing) return existing;
    const baseBranch = String(plan.baseRef || "origin/main").replace(/^origin\//, "") || "main";
    const body = pullRequestBody(plan);
    await this.#run("gh", [
      "pr", "create", "--base", baseBranch, "--head", plan.integrationBranch,
      "--title", oneLine(plan.goal, 120), "--body", body,
    ], { cwd: plan.integrationWorktreePath, timeout: 60_000 });
    const { stdout } = await this.#run("gh", ["pr", "view", plan.integrationBranch, "--json", "number,url"], {
      cwd: plan.integrationWorktreePath, timeout: 20_000,
    });
    const created = parsePullRequest(stdout);
    if (!created) throw new TypeError("GitHub created the combined pull request but did not return its URL");
    return created;
  }

  #git(cwd, args, options = {}) {
    return this.repoCatalog.git(cwd, args, options);
  }

  async #run(bin, args, { cwd, timeout }) {
    return this.execute(bin, args, {
      cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, env: process.env,
    });
  }
}

export async function qualityCommands(cwd) {
  let pkg;
  try { pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")); } catch { return []; }
  const scripts = pkg?.scripts || {};
  const commands = [];
  try {
    await readFile(join(cwd, "package-lock.json"));
    commands.push({ bin: "npm", args: ["ci"] });
  } catch { /* a repository without an npm lockfile skips installation */ }
  if (scripts.verify) commands.push({ bin: "npm", args: ["run", "verify"] });
  else for (const name of ["test", "lint", "typecheck", "build"]) if (scripts[name]) commands.push({ bin: "npm", args: ["run", name] });
  return commands;
}

function integrationBranch(plan) {
  const slug = oneLine(plan.goal, 48).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "goal";
  const suffix = String(plan.planId).replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "combined";
  return `goal/${slug}-${suffix}`;
}

function taskCommitMessage(plan, task) {
  const subject = oneLine(`Task ${String(task.id).replace(/^t/i, "")}: ${task.title}`, 100);
  return `${subject}\n\nCmux-Goal-Task: ${plan.planId}/${task.id}/${task.headSha}`;
}

function pullRequestBody(plan) {
  const tasks = plan.tasks.map((task) => `- [x] ${task.title} (\`${task.branch}\` at \`${task.headSha.slice(0, 8)}\`)`).join("\n");
  const closingReferences = [...new Set(plan.issueNumbers || [])].map((number) => `Closes #${number}`).join("\n");
  return [
    "## Goal", plan.goal, "", "## Integrated tasks", tasks, "",
    "## Verification", "- Combined repository verification passed in the generated goal worktree.", "",
    ...(closingReferences ? ["## Linked issues", closingReferences, ""] : []),
    "_Assembled automatically by cmux companion._",
  ].join("\n");
}

function parsePullRequest(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (!parsed?.url) return null;
    return { number: Number.isInteger(parsed.number) ? parsed.number : null, url: String(parsed.url) };
  } catch { return null; }
}

function deliveryResult(plan) {
  return {
    planId: plan.planId,
    deliveryMode: plan.deliveryMode,
    deliveryStatus: plan.deliveryStatus,
    integrationBranch: plan.integrationBranch,
    integrationWorktreePath: plan.integrationWorktreePath,
    finalPrNumber: plan.finalPrNumber,
    finalPrUrl: plan.finalPrUrl,
    verifiedAt: plan.verifiedAt,
    tasks: plan.tasks.map((task) => ({
      id: task.id, title: task.title, branch: task.branch, headSha: task.headSha,
      deliveryStatus: task.deliveryStatus, integratedCommitSha: task.integratedCommitSha,
    })),
  };
}

function conciseError(cause) {
  const stderr = String(cause?.stderr || "").trim().split("\n").filter(Boolean).slice(-8).join("\n");
  const message = stderr || cause?.message || "Combined delivery failed";
  return String(message).slice(0, 2_000);
}

function oneLine(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
