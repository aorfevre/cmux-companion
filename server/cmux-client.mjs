import { providerCommand } from "./local-settings.mjs";
import { normalizeModelId } from "./model-options.mjs";
import { withWorkspaceLaunch } from "./worktree-operations.mjs";
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BIN = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const DEFAULT_PASSWORD_FILE = join(homedir(), ".config", "cmux-companion", "cmux-socket-password");
const TARGET_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set([
  "enter", "escape", "tab", "up", "down", "left", "right",
  "backspace", "delete", "home", "end", "pageup", "pagedown",
  "ctrl+c", "ctrl+d", "ctrl+z", "ctrl+l", "ctrl+j",
]);
const ALLOWED_TODO_ACTIONS = new Set(["check", "uncheck", "start"]);
const ALLOWED_AGENTS = new Set(["shell", "codex", "claude"]);
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9:_-]{8,128}$/;

export class CmuxCommandError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = "CmuxCommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

export class CmuxClient {
  constructor({
    bin = process.env.CMUX_BIN || DEFAULT_BIN,
    execute = execFileAsync,
    socketPassword = readCredential(process.env.CMUX_SOCKET_PASSWORD_FILE || DEFAULT_PASSWORD_FILE),
    maxConcurrent = 2,
    providerSettings = null,
  } = {}) {
    this.providerSettings = providerSettings;
    this.bin = bin;
    this.execute = execute;
    this.socketPassword = socketPassword;
    this.maxConcurrent = Math.max(1, Math.min(4, Number(maxConcurrent) || 2));
    this.activeCommands = 0;
    this.commandQueue = [];
    this.detailedCache = null;
    this.detailedPending = null;
    this.statusCache = new Map();
  }

  async run(args, { timeout = 10_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
    await this.acquireCommandSlot();
    try {
      const { stdout = "", stderr = "" } = await this.execute(this.bin, args, {
        timeout,
        maxBuffer,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(this.socketPassword ? { CMUX_SOCKET_PASSWORD: this.socketPassword } : {}),
        },
      });
      return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
    } catch (error) {
      const stderr = String(error.stderr || "").trim();
      const message = stderr || error.message || "cmux command failed";
      throw new CmuxCommandError(message, { code: error.code, stderr });
    } finally {
      this.releaseCommandSlot();
    }
  }

  acquireCommandSlot() {
    if (this.activeCommands < this.maxConcurrent) {
      this.activeCommands += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.commandQueue.push(resolve));
  }

  releaseCommandSlot() {
    const next = this.commandQueue.shift();
    if (next) next();
    else this.activeCommands -= 1;
  }

  async runJSON(args, options) {
    const { stdout } = await this.run(["--json", ...args], options);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new CmuxCommandError("cmux returned invalid JSON");
    }
  }

  ping() {
    return this.run(["ping"], { timeout: 2_500 }).then(() => true);
  }

  capabilities() {
    return this.runJSON(["capabilities"]);
  }

  hostStatus() {
    return this.runJSON(["rpc", "mobile.host.status", "{}"]);
  }

  rpc(method, params = {}, options) {
    if (!/^[a-z][a-z0-9_.]{1,80}$/.test(String(method || ""))) {
      throw new TypeError("Invalid cmux method");
    }
    return this.runJSON(["rpc", method, JSON.stringify(params)], options);
  }

  workspaceList() {
    return this.runJSON(["rpc", "mobile.workspace.list", "{}"]);
  }

  async workspaceListDetailed() {
    if (this.detailedCache && Date.now() - this.detailedCache.at < 5_000) return this.detailedCache.value;
    if (this.detailedPending) return this.detailedPending;
    this.detailedPending = this.loadWorkspaceListDetailed();
    try {
      const value = await this.detailedPending;
      this.detailedCache = { at: Date.now(), value };
      return value;
    } finally {
      this.detailedPending = null;
    }
  }

  async loadWorkspaceListDetailed() {
    const [payload, localPayload] = await Promise.all([
      this.workspaceList(),
      this.runJSON(["list-workspaces"]).catch(() => ({ workspaces: [] })),
    ]);
    const mobileWorkspaces = payload.workspaces || [];
    const localWorkspaces = localPayload.workspaces || [];
    const needsListenerScan = mobileWorkspaces.some((workspace) => {
      const local = matchLocalWorkspace(workspace, localWorkspaces);
      return !Array.isArray(local?.listening_ports) || local.listening_ports.length === 0;
    });
    const [discoveredPorts, statuses] = await Promise.all([
      needsListenerScan
        ? this.workspaceListeningPortsAll(mobileWorkspaces, localWorkspaces).catch(() => new Map())
        : new Map(),
      this.recentWorkspaceStatuses(mobileWorkspaces),
    ]);
    const workspaces = mobileWorkspaces.map((workspace) => {
      const local = matchLocalWorkspace(workspace, localWorkspaces);
      let listeningPorts = Array.isArray(local?.listening_ports)
        ? local.listening_ports.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535)
        : [];
      if (!listeningPorts.length) listeningPorts = discoveredPorts.get(workspace.id) || [];
      const status = statuses.get(workspace.id)
        || normalizeWorkspaceStatus(workspace.status || local?.status || workspace.agent_status || local?.agent_status);
      return { ...workspace, status, listening_ports: listeningPorts };
    });
    return { ...payload, workspaces };
  }

  workspaceStatus(workspaceId) {
    assertTarget(workspaceId);
    return this.runJSON(["workspace", "status", "--workspace", workspaceId]);
  }

  async recentWorkspaceStatuses(workspaces, limit = 6) {
    const now = Date.now();
    const activeIds = new Set(workspaces.map((workspace) => workspace.id));
    for (const id of this.statusCache.keys()) if (!activeIds.has(id)) this.statusCache.delete(id);
    const prioritized = [...workspaces].sort((left, right) => (
      workspacePriority(right) - workspacePriority(left)
    )).slice(0, limit);
    const entries = await Promise.all(prioritized.map(async (workspace) => {
      const cached = this.statusCache.get(workspace.id);
      if (cached && now - cached.at < 15_000) return [workspace.id, cached.value];
      const value = await this.workspaceStatus(workspace.id).catch(() => cached?.value || null);
      if (value) this.statusCache.set(workspace.id, { at: Date.now(), value });
      return [workspace.id, value];
    }));
    return new Map(entries.filter((entry) => entry[1]));
  }

  todoList(workspaceId) {
    assertTarget(workspaceId);
    return this.runJSON(["todo", "list", "--workspace", workspaceId]);
  }

  async todoAction(workspaceId, todoId, action) {
    assertTarget(workspaceId);
    assertTarget(todoId);
    if (!ALLOWED_TODO_ACTIONS.has(action)) throw new TypeError("Unsupported todo action");
    return this.runJSON(["todo", action, todoId, "--workspace", workspaceId]);
  }

  pendingFeed() {
    return this.rpc("feed.list", { pending_only: true });
  }

  notifications() {
    return this.rpc("notification.list", {});
  }

  async markNotificationRead(id) {
    assertTarget(id);
    return this.rpc("notification.mark_read", { id });
  }

  // A notification is a courtesy, so its text is clamped and defaulted rather
  // than rejected: a blank title is a caller bug, and failing here would abort
  // the delivery this call only meant to report on.
  //
  // notification.create is the only method that takes a workspace alone.
  // notification.create_for_target rejects that shape with "Missing or invalid
  // surface_id" - it wants BOTH a surface_id and a workspace_id - and because
  // every caller sits inside a publish catch, switching back would silently
  // swallow every notification instead of failing loudly.
  async notify(workspaceId, { title, body = "" }) {
    assertTarget(workspaceId);
    const heading = String(title || "").trim().slice(0, 100) || "cmux companion";
    return this.rpc("notification.create", {
      workspace_id: workspaceId,
      title: heading,
      body: String(body || "").trim().slice(0, 500),
    });
  }

  feedReply(requestId, kind, body = {}) {
    assertTarget(requestId);
    if (kind === "permissionRequest") {
      const mode = String(body.mode || "");
      if (!["once", "always", "all", "bypass", "deny"].includes(mode)) throw new TypeError("Invalid permission response");
      return this.rpc("feed.permission.reply", { request_id: requestId, mode });
    }
    if (kind === "question") {
      const selections = Array.isArray(body.selections) ? body.selections : [];
      if (!selections.length || selections.length > 20 || selections.some((item) => typeof item !== "string" || !item.trim() || item.length > 500)) {
        throw new TypeError("Select at least one valid answer");
      }
      return this.rpc("feed.question.reply", { request_id: requestId, selections });
    }
    if (kind === "exitPlan") {
      const mode = String(body.mode || "");
      if (!["ultraplan", "bypassPermissions", "autoAccept", "manual", "deny"].includes(mode)) throw new TypeError("Invalid plan response");
      const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
      if (feedback.length > 4_000) throw new TypeError("Feedback is too long");
      return this.rpc("feed.exit_plan.reply", { request_id: requestId, mode, ...(feedback ? { feedback } : {}) });
    }
    throw new TypeError("Unsupported inbox item");
  }

  async workspaceCreate(options) {
    if (typeof options?.cwd !== "string" || !options.cwd.startsWith("/")) throw new TypeError("Invalid repository path");
    if (!statSync(options.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new TypeError(`This directory does not exist: ${options.cwd}`);
    return withWorkspaceLaunch(options.cwd, () => this.createWorkspaceLocked(options));
  }

  async createWorkspaceLocked({ cwd, title, agent = "shell", model = "default", prompt = "", script = null, env = null }) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new TypeError("Invalid repository path");
    // cmux accepts a cwd that does not exist and creates the workspace anyway.
    // Its shell then cannot enter the directory and silently keeps the one cmux
    // started from, so the agent runs against the wrong repository and its work
    // is lost. A refusal the caller can read beats that every time.
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new TypeError(`This directory does not exist: ${cwd}`);
    if (!ALLOWED_AGENTS.has(agent)) throw new TypeError("Unsupported agent");
    if (typeof title !== "string" || !title.trim() || title.trim().length > 100) throw new TypeError("Invalid workspace title");
    if (typeof prompt !== "string" || prompt.length > 8_000) throw new TypeError("Prompt is too long");
    if (script !== null && !/^[a-zA-Z0-9:_-]{1,64}$/.test(script)) throw new TypeError("Invalid package script");

    // A title is what a person reads, and a person can rename it. These stamps
    // are the identity that survives that, so a later sweep can still say which
    // goal and task a session belongs to. They are exported in the session's
    // own shell rather than passed to `workspace.create`, because the RPC's
    // env parameter is not part of the surface this client has verified.
    const modelId = normalizeModelId(model);
    const modelFlag = modelId === "default" ? "" : ` --model ${shellQuote(modelId)}`;
    const configured = agent === "codex" || agent === "claude"
      ? providerCommand(this.providerSettings?.()[agent] ?? { executable: "ccs", args: [agent], model: "default" }, agent) : null;
    const exports = envExports(env);
    const created = await this.rpc("workspace.create", { cwd, title: title.trim(), focus: false });
    const workspaceId = created.workspace_id || created.workspace_ref;
    assertTarget(workspaceId);
    let command = "";
    if (script) command = `npm run ${script}`;
    else if (agent === "codex" || agent === "claude") {
      command = `${[configured.executable, ...configured.args].map(shellQuote).join(" ")}${modelFlag}${prompt.trim() ? ` ${shellQuote(prompt.trim())}` : ""}`;
    }
    else if (prompt.trim()) command = `printf '%s\\n' ${shellQuote(prompt.trim())}`;
    const text = `${exports}${command}`;
    if (text) await this.rpc("surface.send_text", { workspace_id: workspaceId, text: `${text}\n` });
    return { ...created, workspace_id: workspaceId };
  }

  async workspaceRename(workspaceId, title) {
    assertTarget(workspaceId);
    if (typeof title !== "string" || !title.trim() || title.trim().length > 100) throw new TypeError("Invalid workspace title");
    await this.run(["workspace", "rename", workspaceId, "--title", title.trim()]);
    return { ok: true };
  }

  async workspaceClose(workspaceId) {
    assertTarget(workspaceId);
    await this.run(["workspace", "close", workspaceId]);
    return { ok: true };
  }

  async workspaceRespawn(workspaceId, surfaceId) {
    assertTarget(workspaceId);
    assertTarget(surfaceId);
    return this.rpc("surface.respawn", {
      workspace_id: workspaceId,
      surface_id: surfaceId,
      command: "/bin/zsh -l",
      tmux_start_command: "exec ${SHELL:-/bin/zsh} -l",
    });
  }

  async workspaceOverview(workspaceId) {
    assertTarget(workspaceId);
    const [status, todos, top, surfaceHealth] = await Promise.all([
      this.workspaceStatus(workspaceId),
      this.todoList(workspaceId),
      this.workspaceMetrics(workspaceId).catch(() => null),
      this.rpc("surface.health", { workspace_id: workspaceId }).catch(() => null),
    ]);
    return { status, todos, metrics: top, surfaceHealth };
  }

  async workspaceMetrics(workspaceId) {
    assertTarget(workspaceId);
    const { stdout } = await this.run(["top", "--workspace", workspaceId, "--processes", "--flat", "--format", "tsv"], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseWorkspaceMetrics(stdout);
  }

  async workspaceListeningPorts(workspaceId) {
    assertTarget(workspaceId);
    const { stdout } = await this.run(["top", "--workspace", workspaceId, "--processes", "--flat", "--format", "tsv"], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const pids = [...new Set(stdout.split("\n").map((line) => {
      const columns = line.split("\t");
      return columns[3] === "process" && /^\d+$/.test(columns[4] || "") ? columns[4] : null;
    }).filter(Boolean))].slice(0, 200);
    if (!pids.length) return [];
    const result = await this.execute("/usr/sbin/lsof", [
      "-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fpn",
    ], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", env: process.env });
    const ports = [];
    for (const line of String(result.stdout || "").split("\n")) {
      if (!line.startsWith("n")) continue;
      const match = line.match(/:(\d{1,5})(?:\s|$)/);
      const port = Number(match?.[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535 && !ports.includes(port)) ports.push(port);
    }
    return ports.sort((left, right) => left - right);
  }

  async workspaceListeningPortsAll(mobileWorkspaces, localWorkspaces = []) {
    const { stdout } = await this.run(["top", "--all", "--processes", "--flat", "--format", "tsv"], {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const nodes = new Map();
    const processes = [];
    for (const line of stdout.split("\n")) {
      const columns = line.split("\t");
      const kind = columns[3];
      const ref = columns[4];
      const parent = columns[5];
      const title = columns.slice(6).join("\t");
      if (!kind || !ref) continue;
      nodes.set(ref, { kind, ref, parent, title });
      if (kind === "process" && /^\d+$/.test(ref)) processes.push({ pid: ref, parent });
    }
    const workspaceByTopRef = new Map();
    for (const node of nodes.values()) {
      if (node.kind !== "workspace") continue;
      const local = localWorkspaces.find((item) => item.ref === node.ref || item.workspace_ref === node.ref)
        || localWorkspaces.find((item) => cleanTitle(item.title) === cleanTitle(node.title));
      const mobile = local ? matchMobileWorkspace(local, mobileWorkspaces) : mobileWorkspaces.find((item) => cleanTitle(item.title) === cleanTitle(node.title));
      if (mobile?.id) workspaceByTopRef.set(node.ref, mobile.id);
    }
    const pidToWorkspace = new Map();
    for (const process of processes) {
      let ref = process.parent;
      const visited = new Set();
      while (ref && !visited.has(ref)) {
        visited.add(ref);
        if (workspaceByTopRef.has(ref)) {
          pidToWorkspace.set(process.pid, workspaceByTopRef.get(ref));
          break;
        }
        ref = nodes.get(ref)?.parent;
      }
    }
    const pids = [...pidToWorkspace.keys()].slice(0, 1_000);
    if (!pids.length) return new Map();
    const result = await this.execute("/usr/sbin/lsof", [
      "-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fpn",
    ], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", env: process.env });
    const portsByWorkspace = new Map();
    let currentWorkspace = null;
    for (const line of String(result.stdout || "").split("\n")) {
      if (line.startsWith("p")) {
        currentWorkspace = pidToWorkspace.get(line.slice(1)) || null;
        continue;
      }
      if (!currentWorkspace || !line.startsWith("n")) continue;
      const port = Number(line.match(/:(\d{1,5})(?:\s|$)/)?.[1]);
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
      const ports = portsByWorkspace.get(currentWorkspace) || [];
      if (!ports.includes(port)) ports.push(port);
      portsByWorkspace.set(currentWorkspace, ports);
    }
    for (const ports of portsByWorkspace.values()) ports.sort((left, right) => left - right);
    return portsByWorkspace;
  }

  async readScreen(surfaceId, lines = 240) {
    assertTarget(surfaceId);
    const safeLines = Math.max(20, Math.min(Number(lines) || 240, 2_000));
    const { stdout } = await this.run([
      "read-screen",
      "--surface", surfaceId,
      "--scrollback",
      "--lines", String(safeLines),
    ]);
    return { text: stdout, lines: safeLines };
  }

  terminalReplay(surfaceId, maxScrollbackRows = 600) {
    assertTarget(surfaceId);
    const safeRows = Math.max(0, Math.min(Number(maxScrollbackRows) || 600, 2_000));
    return this.rpc("mobile.terminal.replay", {
      surface_id: surfaceId,
      anchor: "screen",
      max_scrollback_rows: safeRows,
    }, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  }

  terminalViewport(surfaceId, { clientId, generation, columns, rows, clear = false } = {}) {
    assertTarget(surfaceId);
    if (!CLIENT_ID_PATTERN.test(String(clientId || ""))) throw new TypeError("Invalid mobile client ID");
    const safeGeneration = Number(generation);
    if (!Number.isSafeInteger(safeGeneration) || safeGeneration < 0) throw new TypeError("Invalid viewport generation");
    const params = {
      surface_id: surfaceId,
      client_id: clientId,
      viewport_generation: safeGeneration,
    };
    if (clear) return this.rpc("mobile.terminal.viewport", { ...params, clear: true });
    const safeColumns = Number(columns);
    const safeRows = Number(rows);
    if (!Number.isInteger(safeColumns) || safeColumns < 20 || safeColumns > 300) throw new TypeError("Viewport columns must be between 20 and 300");
    if (!Number.isInteger(safeRows) || safeRows < 5 || safeRows > 120) throw new TypeError("Viewport rows must be between 5 and 120");
    return this.rpc("mobile.terminal.viewport", {
      ...params,
      viewport_columns: safeColumns,
      viewport_rows: safeRows,
    });
  }

  async sendText(surfaceId, text) {
    assertTarget(surfaceId);
    assertInputText(text);
    await this.run(["send", "--surface", surfaceId, "--", text]);
  }

  async sendKey(surfaceId, key) {
    assertTarget(surfaceId);
    const normalized = String(key || "").toLowerCase();
    if (!ALLOWED_KEYS.has(normalized)) {
      throw new TypeError("Unsupported key");
    }
    await this.run(["send-key", "--surface", surfaceId, "--", normalized]);
  }

  async sendPrompt(surfaceId, text) {
    assertTarget(surfaceId);
    assertInputText(text);
    await this.#sendPrompt("--surface", surfaceId, text);
  }

  // Recovery commands target the agent workspace recorded by a goal. Text
  // insertion alone leaves a composed prompt sitting in Claude's input box;
  // send the same explicit Enter sequence used by the mobile terminal.
  async sendWorkspacePrompt(workspaceId, text) {
    assertTarget(workspaceId);
    assertInputText(text);
    await this.#sendPrompt("--workspace", workspaceId, text);
  }

  async #sendPrompt(targetFlag, targetId, text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]) await this.run(["send", targetFlag, targetId, "--", lines[index]]);
      if (index < lines.length - 1) await this.run(["send-key", targetFlag, targetId, "--", "ctrl+j"]);
    }
    await this.run(["send-key", targetFlag, targetId, "--", "enter"]);
  }

  async selectWorkspace(workspaceId) {
    assertTarget(workspaceId);
    // Use explicit RPC targets so the server's inherited terminal context cannot
    // route this user action to a different workspace or surface.
    const selected = await this.rpc("workspace.select", { workspace_id: workspaceId });
    assertTarget(selected.window_id);
    await this.rpc("window.focus", { window_id: selected.window_id });
    // The visual cue is optional; older cmux builds may not support it.
    await this.rpc("surface.trigger_flash", {
      workspace_id: workspaceId,
      window_id: selected.window_id,
    }).catch(() => {});
  }
}

function assertTarget(value) {
  if (!TARGET_PATTERN.test(String(value || ""))) {
    throw new TypeError("Invalid cmux target");
  }
}

function assertInputText(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 16_000) {
    throw new TypeError("Text must contain between 1 and 16,000 characters");
  }
}

export function parseWorkspaceMetrics(output) {
  for (const line of String(output).split("\n")) {
    const [cpu, memory, processes, kind, ref, parent, ...title] = line.split("\t");
    if (kind === "workspace") {
      return {
        cpuPercent: Number(cpu) || 0,
        memoryBytes: Number(memory) || 0,
        processCount: Number(processes) || 0,
        ref,
        parent,
        title: title.join("\t"),
      };
    }
  }
  return null;
}

function cleanTitle(value) {
  return String(value || "").replace(/^[^\w]+\s*/, "").trim();
}

function matchLocalWorkspace(workspace, localWorkspaces) {
  return localWorkspaces.find((item) => (
    item.current_directory === workspace.current_directory
    && (!item.title || !workspace.title || cleanTitle(item.title) === cleanTitle(workspace.title))
  )) || localWorkspaces.find((item) => item.current_directory === workspace.current_directory)
    || localWorkspaces.find((item) => cleanTitle(item.title) === cleanTitle(workspace.title));
}

function matchMobileWorkspace(workspace, mobileWorkspaces) {
  return mobileWorkspaces.find((item) => (
    item.current_directory === workspace.current_directory
    && (!item.title || !workspace.title || cleanTitle(item.title) === cleanTitle(workspace.title))
  )) || mobileWorkspaces.find((item) => cleanTitle(item.title) === cleanTitle(workspace.title));
}

function normalizeWorkspaceStatus(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string" && value.trim()) return { effective: value.trim() };
  return null;
}

function workspacePriority(workspace) {
  const activity = Number(workspace.last_activity_at) || 0;
  return activity + (workspace.has_unread ? 2e15 : 0) + (workspace.is_selected ? 1e15 : 0);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// Builds the `export K=V; ` prefix that stamps a session's identity into its own
// shell. The name pattern is strict rather than escaped: a variable name is
// never user text, so anything that is not a plain identifier is a bug in the
// caller and is dropped instead of being quoted into the command line. The
// value is quoted like every other argument this client sends.
function envExports(env) {
  if (!env || typeof env !== "object") return "";
  const pairs = Object.entries(env)
    .filter(([name, value]) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && typeof value === "string" && value.trim())
    .slice(0, 12)
    .map(([name, value]) => `export ${name}=${shellQuote(value.trim().slice(0, 200))}`);
  return pairs.length ? `${pairs.join("; ")}; ` : "";
}



function readCredential(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}
