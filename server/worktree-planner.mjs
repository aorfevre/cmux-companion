import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// promisify(execFile) buffers to completion, so nothing can be reported while
// the model is still thinking. spawn resolves the same shape and rejects with
// the same fields, plus it calls onLine for each stdout line, so every injected
// `execute` fake stays valid.
export function streamExecFile(bin, args, { cwd, timeout = 0, maxBuffer = 4 * 1024 * 1024, env, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = timeout ? setTimeout(() => { killed = true; child.kill("SIGTERM"); }, timeout) : null;
    timer?.unref?.();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      // Only the final result line is needed later, so an over-long run drops
      // old lines instead of failing the round the way execFile does.
      if (stdout.length + line.length + 1 <= maxBuffer) stdout += `${line}\n`;
      // A progress consumer must never fail a planner round.
      try { onLine?.(line); } catch { /* the round outlives its audience */ }
    });
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once("error", (cause) => { clearTimeout(timer); lines.close(); reject(cause); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      lines.close();
      if (killed || signal) return reject(Object.assign(new Error("Command failed"), { killed, signal: signal || "SIGTERM", stderr, code }));
      if (code !== 0) return reject(Object.assign(new Error("Command failed"), { code, stderr, killed: false }));
      return resolve({ stdout, stderr });
    });
  });
}

// The non-streaming envelope and the stream-json result line hold the same two
// fields, so parsePlannerReply is reused as it is and only the line choice is
// new. Falling back to raw stdout keeps every plain-envelope fixture working.
export function finalEnvelope(stdout) {
  const lines = String(stdout).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.includes('"result"')) continue;
    try { if (JSON.parse(line)?.type === "result") return line; } catch { /* a partial or unrelated line */ }
  }
  return stdout;
}

const TOOL_DETAIL = {
  Read: (input) => shortPath(input?.file_path),
  Grep: (input) => quoted(input?.pattern),
  Glob: (input) => quoted(input?.pattern),
};

// Only the model's own turn is legible progress. The system, hook and user lines
// are transport noise. The input is never spread: one whitelisted key per tool
// is read and truncated, so no path list or file body can leak into the UI.
export function progressEvent(line) {
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (value?.type !== "assistant") return null;
  for (const block of value.message?.content || []) {
    if (block?.type === "tool_use") {
      const detail = TOOL_DETAIL[block.name]?.(block.input) || "";
      return { k: "tool", t: `${String(block.name || "Tool").slice(0, 20)}${detail ? ` ${detail}` : ""}` };
    }
    // Prose between tool calls is reasoning. It runs long and it quotes the
    // repository, so only its presence is reported, never its content.
    if (block?.type === "text" && String(block.text || "").trim()) return { k: "text", t: "Thinking…" };
  }
  return null;
}

function shortPath(value) {
  const path = String(value || "");
  return path ? path.split("/").slice(-2).join("/").slice(0, 60) : "";
}

function quoted(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return text ? `"${text}"` : "";
}

// A subprocess failure, not an unusable reply. It is still a TypeError, so the
// Fastify error handler answers 400 with its message, but #round never retries
// it: a second launch cannot fix a missing binary or a timeout.
class PlannerRunError extends TypeError {}

const UNUSABLE = "The planner returned an unusable answer. Try again";

export function parsePlannerReply(stdout) {
  const envelope = extractJson(String(stdout));
  if (!envelope) throw new TypeError(UNUSABLE);
  const sessionId = typeof envelope.session_id === "string" ? envelope.session_id : null;
  const payload = extractJson(String(envelope.result || ""));
  if (!payload) throw new TypeError(UNUSABLE);

  const hasQuestions = Array.isArray(payload.questions) && payload.questions.length > 0;
  const hasTasks = Array.isArray(payload.tasks) && payload.tasks.length > 0;
  if (hasQuestions === hasTasks) throw new TypeError(UNUSABLE);

  if (hasQuestions) {
    const questions = payload.questions
      .map((item, index) => ({
        id: `q${index + 1}`,
        text: cleanText(item?.text || item?.question),
        options: Array.isArray(item?.options) ? item.options.map(cleanText).filter(Boolean).slice(0, 6) : [],
      }))
      .filter((item) => item.text);
    if (!questions.length) throw new TypeError(UNUSABLE);
    return { sessionId, status: "questions", questions, tasks: [] };
  }

  const tasks = payload.tasks
    .map((item, index) => ({
      id: `t${index + 1}`,
      title: cleanText(item?.title),
      branch: cleanText(item?.branch),
      prompt: cleanText(item?.prompt),
    }))
    .filter((item) => item.title && item.branch && item.prompt);
  if (!tasks.length) throw new TypeError(UNUSABLE);
  return { sessionId, status: "ready", questions: [], tasks };
}

const MAX_SCAN_BYTES = 256 * 1024;
const MAX_CANDIDATES = 20;

// Model text may hold prose, several fenced blocks, and stray braces. Try each
// fenced block first, then the raw text, and take the first candidate that
// parses into the shape we need.
function jsonCandidates(text) {
  const source = text.length > MAX_SCAN_BYTES ? text.slice(0, MAX_SCAN_BYTES) : text;
  const fences = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
  return [...fences.reverse(), source];
}

function extractJson(text) {
  for (const candidate of jsonCandidates(String(text))) {
    const value = firstBalancedObject(candidate);
    if (value) return value;
  }
  return null;
}

// Walks forward from each `{`, tracks depth, and respects strings and escapes,
// so one pass finds the end of each object instead of guessing at every `}`.
function firstBalancedObject(text) {
  let attempts = 0;
  for (let start = text.indexOf("{"); start !== -1 && attempts < MAX_CANDIDATES; start = text.indexOf("{", start + 1)) {
    attempts += 1;
    const end = balancedEnd(text, start);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // This brace opened prose, not an object. Try the next one.
    }
  }
  return null;
}

function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && inString) { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim().slice(0, 4_000) : "";
}

const USABLE_STATUS = new Set(["ready", "low"]);
const MIN_HEADROOM = 5;
const CLOSE_ENOUGH = 10;
const LABELS = { claude: "Claude", codex: "Codex" };

export function assignAgents(tasks, usage) {
  const claude = providerHeadroom(usage, "claude");
  const codex = providerHeadroom(usage, "codex");
  const list = Array.isArray(tasks) ? tasks : [];

  if (claude === null && codex === null) {
    return list.map((task) => ({ ...task, agent: "claude", agentReason: "Account usage is unavailable" }));
  }
  if (claude === null) return list.map((task) => ({ ...task, ...describe("codex", codex) }));
  if (codex === null) return list.map((task) => ({ ...task, ...describe("claude", claude) }));

  const roomier = codex > claude ? "codex" : "claude";
  const other = roomier === "codex" ? "claude" : "codex";
  const headroom = { claude, codex };
  if (Math.abs(codex - claude) > CLOSE_ENOUGH) {
    return list.map((task) => ({ ...task, ...describe(roomier, headroom[roomier]) }));
  }
  return list.map((task, index) => {
    const agent = index % 2 === 0 ? roomier : other;
    return { ...task, ...describe(agent, headroom[agent]) };
  });
}

// The percentage is the provider's best usable account, not a promise about the
// account that runs the task: assignAgents chooses a provider, never an account.
function describe(agent, percent) {
  return { agent, agentReason: `${LABELS[agent]} · best account ${Math.round(percent)}% left` };
}

// Returns the best headroom across a provider's usable accounts, or null when
// the provider cannot take work right now.
function providerHeadroom(usage, id) {
  const provider = (usage?.providers || []).find((item) => item?.id === id);
  if (!provider) return null;
  const scores = (provider.accounts || [])
    .filter((account) => USABLE_STATUS.has(account?.status))
    .map(accountHeadroom)
    .filter((value) => value !== null);
  if (!scores.length) return null;
  const best = Math.max(...scores);
  return best > MIN_HEADROOM ? best : null;
}

function accountHeadroom(account) {
  const percents = (account?.windows || [])
    .filter((window) => window?.category === "usage" && (window.cadence === "5h" || window.cadence === "weekly"))
    .map((window) => window.remainingPercent)
    .filter((value) => Number.isFinite(value));
  return percents.length ? Math.min(...percents) : null;
}

const DRAFT_TTL_MS = 30 * 60_000;
const ROUND_TIMEOUT_MS = 180_000;
// --allowed-tools only AUTO-APPROVES; it does not restrict. Verified against the
// real CLI: with Bash absent from the allow list it still ran. Only
// --disallowed-tools enforces, and the planner runs unsandboxed in the user's
// own repository, so every writing and executing tool must be denied by name.
const ALLOWED_TOOLS = "Read,Grep,Glob";
const DENIED_TOOLS = "Bash,Write,Edit,MultiEdit,NotebookEdit,Task,Skill,WebFetch,WebSearch";
const MAX_TASKS = 8;
const MAX_IMAGES = 4;
const MAX_DRAFTS = 50;

// ccs draws its errors as a box: ANSI colour, border glyphs, a blank padded
// line between every sentence, and a bare docs URL last. Taking the last stderr
// line therefore reported only the URL. Strip the frame, then keep the words.
const BOX_GLYPHS = /[\u2500-\u257f]/gu;
// eslint-disable-next-line no-control-regex -- stripping ANSI needs the escape byte.
const ANSI = /\u001b\[[0-9;]*m/gu;

export function describeRunFailure(stderr) {
  const lines = String(stderr || "")
    .replace(ANSI, "")
    .replace(BOX_GLYPHS, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.join(" ");
  // E301 is the one failure an operator can fix without reading the docs, and
  // the launchd PATH omits ~/.local/bin, where the installer puts claude.
  if (/E301|Claude CLI not found/i.test(text)) {
    return "The planner could not run: ccs cannot find the claude CLI on PATH. Add its directory to the companion PATH, or set CCS_CLAUDE_PATH to the binary";
  }
  const detail = lines.filter((line) => !/^https?:\/\//.test(line) && line !== "ERROR").at(-1);
  return detail ? `The planner could not run: ${detail.slice(0, 160)}` : "The planner could not run. Try again";
}

export class WorktreePlanner {
  constructor({ worktrees, cmux, accountUsage, log = null, execute = streamExecFile, git = null, maxRounds = 6, timeoutMs = ROUND_TIMEOUT_MS, ttlMs = DRAFT_TTL_MS } = {}) {
    if (!worktrees) throw new TypeError("A worktree dashboard is required");
    if (!cmux) throw new TypeError("A cmux client is required");
    this.worktrees = worktrees;
    // The dashboard owns the repo catalog, which owns the injected git runner.
    this.git = git || ((cwd, args, options) => worktrees.repoCatalog.git(cwd, args, options));
    this.cmux = cmux;
    this.accountUsage = accountUsage;
    this.log = log;
    this.execute = execute;
    this.maxRounds = maxRounds;
    this.timeoutMs = timeoutMs;
    this.ttlMs = ttlMs;
    this.drafts = new Map();
  }

  async start({ repositoryId, goal, images, onEvent = null }) {
    const text = String(goal || "").trim();
    if (!text) throw new TypeError("Describe the goal for this repository");
    if (text.length > 4_000) throw new TypeError("That goal is too long");
    const attachments = normalizeImages(images);
    const repository = await this.#repository(repositoryId);
    const draft = {
      planId: randomUUID(),
      repositoryId: repository.id,
      repositoryName: repository.name,
      cwd: repository.primaryPath,
      goal: text,
      images: attachments,
      sessionId: null,
      round: 0,
      at: Date.now(),
      status: "questions",
      questions: [],
      tasks: [],
    };
    this.#sweep();
    if (this.drafts.size >= MAX_DRAFTS) {
      const oldest = [...this.drafts.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest) this.drafts.delete(oldest[0]);
    }
    this.drafts.set(draft.planId, draft);
    return this.#round(draft, openingPrompt(draft), onEvent);
  }

  async answer(planId, { answers = [], skip = false, onEvent = null } = {}) {
    const draft = this.#draft(planId);
    if (draft.round >= this.maxRounds) {
      throw new TypeError("The planner could not produce a plan. Start again with a narrower goal");
    }
    return this.#round(draft, skip ? SKIP_PROMPT : answerPrompt(draft, answers), onEvent);
  }

  async update(planId, { tasks } = {}) {
    const draft = this.#draft(planId);
    if (!Array.isArray(tasks) || !tasks.length) throw new TypeError("Keep at least one task");
    if (tasks.length > MAX_TASKS) throw new TypeError(`A plan can hold at most ${MAX_TASKS} tasks`);
    const next = tasks.map((task, index) => {
      const branch = String(task?.branch || "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(branch) || branch.includes("..")) {
        throw new TypeError(`Task ${index + 1} needs a valid Git branch name`);
      }
      const title = String(task?.title || "").trim();
      const prompt = String(task?.prompt || "").trim();
      if (!title || !prompt) throw new TypeError(`Task ${index + 1} needs a title and a prompt`);
      const agent = task?.agent === "codex" ? "codex" : "claude";
      return { id: task?.id || `t${index + 1}`, title, branch, prompt, agent, agentReason: String(task?.agentReason || "") };
    });
    const branches = new Set(next.map((task) => task.branch));
    if (branches.size !== next.length) throw new TypeError("Two tasks share a branch name");
    draft.tasks = next;
    draft.at = Date.now();
    return publicDraft(draft);
  }

  async launch(planId) {
    const draft = this.#draft(planId);
    if (draft.status !== "ready" || !draft.tasks.length) throw new TypeError("This plan is not ready to launch yet");
    const base = await this.#baseRef(draft);
    const results = [];
    for (const task of draft.tasks) {
      results.push(await this.#launchTask(draft, task, base));
    }
    const launched = results.filter((item) => item.status === "launched").length;
    // Deleting stops a plan running twice. That risk does not exist when nothing
    // was created, and keeping the draft saves the user a fresh planner round
    // after a transient failure such as cmux being down.
    if (launched > 0) this.drafts.delete(draft.planId);
    return { planId: draft.planId, base, launched, results };
  }

  // One task never rolls back another: a half-made plan the user can see and
  // finish by hand beats a silent undo of work that already started.
  async #launchTask(draft, task, base) {
    const summary = { id: task.id, title: task.title, branch: task.branch, agent: task.agent };
    let path = null;
    try {
      const created = await this.worktrees.create(draft.repositoryId, { branch: task.branch, base });
      path = created.worktree.path;
      // create() checks out an existing branch and ignores `base`, so the task
      // would start on old work instead of the fetched commit. Refuse it: an
      // agent committing on top of someone's in-progress branch is worse than
      // a failed row the user can act on.
      if (created.branchCreated === false) {
        throw new TypeError(`Branch ${task.branch} already exists, so this task would not start from ${base}. Rename it in the plan, or delete the branch first`);
      }
      const workspace = await this.cmux.workspaceCreate({
        cwd: path,
        title: task.title,
        agent: task.agent,
        // Each worktree agent is isolated, so every task prompt carries the
        // image paths and the closing pull request step itself.
        prompt: taskPrompt(task.prompt, draft.images, base),
      });
      return { ...summary, status: "launched", path, workspace };
    } catch (cause) {
      this.log?.warn?.({ err: cause, branch: task.branch }, "planner task launch failed");
      return { ...summary, status: "failed", path, error: cause?.message || "Could not launch this task" };
    }
  }

  // Branch every task from the up-to-date default remote branch, so no task
  // inherits another task's work or a stale local commit.
  async #baseRef(draft) {
    const repositoryPath = await this.#repositoryPath(draft);
    let branch = "main";
    try {
      const output = await this.git(repositoryPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      branch = String(output).trim().replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "") || "main";
    } catch {
      // No local origin/HEAD ref. Ask the remote rather than guessing "main",
      // which aborts the whole launch on a healthy master-default repository.
      const head = await this.git(repositoryPath, ["ls-remote", "--symref", "origin", "HEAD"]).catch(() => "");
      branch = String(head).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] || "main";
    }
    try {
      await this.git(repositoryPath, ["fetch", "origin", branch], { timeout: 120_000 });
    } catch (cause) {
      const lines = String(cause?.stderr || cause?.message || "").trim().split("\n").map((line) => line.trim()).filter(Boolean);
      // Git prints the diagnosis first and boilerplate advice last, so prefer
      // the first fatal or error line over the tail.
      const detail = (lines.find((line) => /^(fatal|error):/.test(line)) || lines.at(-1) || "").slice(0, 160);
      throw new TypeError(detail ? `Git could not fetch origin/${branch}: ${detail}` : `Git could not fetch origin/${branch}`);
    }
    return `origin/${branch}`;
  }

  async #repositoryPath(draft) {
    const dashboard = await this.worktrees.snapshot({ refresh: false });
    const repository = dashboard.repositories.find((item) => item.id === draft.repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    return repository.path;
  }

  async #round(draft, prompt, onEvent = null) {
    let reply;
    try {
      reply = parsePlannerReply(await this.#spawn(draft, prompt, onEvent));
    } catch (cause) {
      // Retry an unusable reply once: a second sample often parses. Never retry
      // a subprocess failure, because a second launch cannot fix it.
      if (cause instanceof PlannerRunError || !(cause instanceof TypeError)) throw cause;
      // The retry repeats the same tool calls, so say why the list restarts.
      emit(onEvent, { k: "text", t: "Retrying…" });
      reply = parsePlannerReply(await this.#spawn(draft, prompt, onEvent));
    }
    draft.round += 1;
    draft.at = Date.now();
    if (reply.sessionId) draft.sessionId = reply.sessionId;
    else if (draft.sessionId) {
      draft.sessionId = null;
      throw new TypeError("The planner lost its session. Start again with this goal");
    }
    draft.status = reply.status;
    draft.questions = reply.questions;
    draft.tasks = reply.status === "ready" ? assignAgents(reply.tasks, await this.#usage()) : [];
    return publicDraft(draft);
  }

  async #spawn(draft, prompt, onEvent = null) {
    const args = [
      // stream-json is what makes live progress possible, and the CLI refuses
      // it under --print without --verbose.
      "claude", "--print", "--output-format", "stream-json", "--verbose",
      "--allowed-tools", ALLOWED_TOOLS,
      "--disallowed-tools", DENIED_TOOLS,
    ];
    if (draft.sessionId) args.push("--resume", draft.sessionId);
    // `--` is required, not cosmetic: --allowed-tools is variadic, so without a
    // terminator the CLI swallows the prompt as another tool name.
    args.push("--", prompt);
    try {
      const { stdout = "" } = await this.execute("ccs", args, {
        cwd: draft.cwd,
        encoding: "utf8",
        // Round 1 starts a fresh session and reads the repository, so it is the
        // slowest. Later rounds resume and only pay for the new turn.
        timeout: draft.sessionId ? this.timeoutMs : this.timeoutMs * 2,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
        onLine: onEvent ? (line) => { const event = progressEvent(line); if (event) emit(onEvent, event); } : undefined,
      });
      return finalEnvelope(stdout);
    } catch (cause) {
      if (cause?.code === "ENOENT") throw new PlannerRunError("The planner needs the ccs CLI. Install it, then try again");
      if (cause?.killed || cause?.signal === "SIGTERM") throw new PlannerRunError("The planner did not answer in time. Try again");
      throw new PlannerRunError(describeRunFailure(cause?.stderr));
    }
  }

  async #usage() {
    try {
      return await this.accountUsage?.snapshot();
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "planner usage snapshot failed");
      return null;
    }
  }

  async #repository(repositoryId) {
    if (typeof repositoryId !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(repositoryId)) throw new TypeError("Invalid repository");
    const dashboard = await this.worktrees.snapshot({ refresh: true });
    const repository = dashboard.repositories.find((item) => item.id === repositoryId);
    if (!repository) throw new TypeError("Unknown repository");
    const primary = repository.worktrees.find((item) => item.isPrimary) || repository.worktrees[0];
    return { id: repository.id, name: repository.name, primaryPath: primary?.path || repository.path };
  }

  #draft(planId) {
    this.#sweep();
    const draft = this.drafts.get(String(planId || ""));
    if (!draft) throw new TypeError("Unknown plan. Start a new goal");
    return draft;
  }

  #sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, draft] of this.drafts) if (draft.at < cutoff) this.drafts.delete(id);
  }
}

// A listener that throws must not fail the round it is only watching.
function emit(onEvent, event) {
  try { onEvent?.(event); } catch { /* the round outlives its audience */ }
}

function publicDraft(draft) {
  return {
    planId: draft.planId,
    repositoryId: draft.repositoryId,
    goal: draft.goal,
    round: draft.round,
    status: draft.status,
    questions: draft.questions,
    tasks: draft.tasks,
  };
}

const SKIP_PROMPT = "Stop asking questions. Decide the remaining details yourself and reply now with the tasks JSON object.";

const CONTRACT = [
  "Reply with exactly one JSON object and no other prose.",
  'It holds either {"questions": [{"text": "...", "options": ["..."]}]} or {"tasks": [{"title": "...", "branch": "feature/...", "prompt": "..."}]}.',
  "It never holds both keys.",
  "Ask questions only while a real ambiguity would change the split. Otherwise return the tasks.",
  "Each task must be independent of every other task, because the agents run in separate worktrees and never see each other.",
  "Each task branch starts with feature/ and uses only letters, digits, dots, dashes and slashes.",
  "Each task prompt is self-contained: it states the outcome, the files or areas to touch, and how to verify the work.",
  "Return one task when the goal is a single unit of work. That is a valid answer.",
  "Do not include an agent field. The server assigns the agent.",
  "Do not tell a task to commit, to push, or to open a pull request. The server appends that step to every prompt.",
].join("\n");

const OVERRIDES = [
  "Overrides for this run, which take priority over any skill instruction:",
  "Write no file. Create no design document. Create no plan document. Ask for no approval gate.",
  "Your only output is the JSON object described above.",
].join("\n");

// The planner runs with Read allowed, so it can open each file itself.
function imageBlock(images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return "";
  return [`Attached image${list.length > 1 ? "s" : ""}:`, ...list.map((image) => `- ${image.path}`)].join("\n");
}

function withImages(prompt, images) {
  const block = imageBlock(images);
  return block ? `${prompt}\n\n${block}` : prompt;
}

// The plan ends at a pull request, not at a finished worktree. The agent opens
// it, because the branch has no commit at launch time and gh would refuse an
// empty one. Each agent is isolated, so every task prompt carries this itself.
function pullRequestStep(base) {
  const branch = String(base || "").replace(/^origin\//, "") || "main";
  return [
    "Finish with a pull request:",
    "1. Commit your work.",
    "2. Push the branch to origin.",
    `3. Open a pull request against ${branch} with \`gh pr create\`. Do not mark it a draft.`,
    "Open the pull request even when your own checks fail. State what failed at the top of its body, so the work stays visible instead of stopping on this machine.",
  ].join("\n");
}

function taskPrompt(prompt, images, base) {
  return [withImages(prompt, images), pullRequestStep(base)].join("\n\n");
}

function normalizeImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new TypeError("Attached images must be a list");
  if (images.length > MAX_IMAGES) throw new TypeError(`Attach at most ${MAX_IMAGES} images`);
  return images.map((image) => {
    const path = image?.path;
    if (typeof path !== "string" || !path.trim()) throw new TypeError("Each attached image needs a file path");
    const name = typeof image?.name === "string" && image.name.trim() ? image.name.trim().slice(0, 200) : "attached image";
    return { path: path.trim().slice(0, 1_000), name };
  });
}

function openingPrompt(draft) {
  const images = imageBlock(draft.images);
  return [
    `Repository: ${draft.repositoryName} at ${draft.cwd}`,
    `Goal: ${draft.goal}`,
    ...(images ? ["", images, "Read each image with the Read tool. It shows what the user means.", "Do not repeat these paths in the task prompts. The server adds them to every task."] : []),
    "",
    "Read the repository to understand the goal. Ask a question only when a real ambiguity would change how the work splits. Split the goal into tasks that share no files and depend on no other task's output.",
    "",
    OVERRIDES,
    "",
    CONTRACT,
  ].join("\n");
}

function answerPrompt(draft, answers) {
  const list = Array.isArray(answers) ? answers : [];
  const lines = list.map((answer) => {
    const text = String(answer?.text || "").trim().slice(0, 2_000);
    if (!text) return "";
    const question = draft.questions.find((item) => item.id === answer?.id);
    if (!question) throw new TypeError("That answer no longer matches the question. Reload the plan");
    return `Q: ${question.text}\nA: ${text}`;
  }).filter(Boolean);
  return [lines.length ? lines.join("\n\n") : "No answers were given.", "", CONTRACT].join("\n");
}
