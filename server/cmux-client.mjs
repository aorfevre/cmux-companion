import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
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
  "ctrl+c", "ctrl+d", "ctrl+z", "ctrl+l",
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
  } = {}) {
    this.bin = bin;
    this.execute = execute;
    this.socketPassword = socketPassword;
    this.maxConcurrent = Math.max(1, Math.min(4, Number(maxConcurrent) || 2));
    this.activeCommands = 0;
    this.commandQueue = [];
    this.detailedCache = null;
    this.detailedPending = null;
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
    const workspaces = await Promise.all((payload.workspaces || []).map(async (workspace) => {
      const status = await this.workspaceStatus(workspace.id).catch(() => null);
      const local = (localPayload.workspaces || []).find((item) => (
        item.current_directory === workspace.current_directory
        && (!item.title || !workspace.title || item.title.replace(/^[^\w]+\s*/, "") === workspace.title.replace(/^[^\w]+\s*/, ""))
      )) || (localPayload.workspaces || []).find((item) => item.current_directory === workspace.current_directory);
      let listeningPorts = Array.isArray(local?.listening_ports)
        ? local.listening_ports.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65_535)
        : [];
      if (!listeningPorts.length) listeningPorts = await this.workspaceListeningPorts(workspace.id).catch(() => []);
      return { ...workspace, status, listening_ports: listeningPorts };
    }));
    return { ...payload, workspaces };
  }

  workspaceStatus(workspaceId) {
    assertTarget(workspaceId);
    return this.runJSON(["workspace", "status", "--workspace", workspaceId]);
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

  async workspaceCreate({ cwd, title, agent = "shell", prompt = "", script = null }) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new TypeError("Invalid repository path");
    if (!ALLOWED_AGENTS.has(agent)) throw new TypeError("Unsupported agent");
    if (typeof title !== "string" || !title.trim() || title.trim().length > 100) throw new TypeError("Invalid workspace title");
    if (typeof prompt !== "string" || prompt.length > 8_000) throw new TypeError("Prompt is too long");
    if (script !== null && !/^[a-zA-Z0-9:_-]{1,64}$/.test(script)) throw new TypeError("Invalid package script");

    const created = await this.rpc("workspace.create", { cwd, title: title.trim(), focus: false });
    const workspaceId = created.workspace_id || created.workspace_ref;
    assertTarget(workspaceId);
    let command = "";
    if (script) command = `npm run ${script}`;
    else if (agent === "codex") command = prompt.trim() ? `xcodex ${shellQuote(prompt.trim())}` : "xcodex";
    else if (agent === "claude") command = prompt.trim() ? `xclaude ${shellQuote(prompt.trim())}` : "xclaude";
    else if (prompt.trim()) command = `printf '%s\\n' ${shellQuote(prompt.trim())}`;
    if (command) await this.rpc("surface.send_text", { workspace_id: workspaceId, text: `${command}\n` });
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
    if (typeof text !== "string" || text.length === 0 || text.length > 16_000) {
      throw new TypeError("Text must contain between 1 and 16,000 characters");
    }
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
    await this.sendText(surfaceId, text);
    await this.sendKey(surfaceId, "enter");
  }

  async selectWorkspace(workspaceId) {
    assertTarget(workspaceId);
    await this.run(["select-workspace", "--workspace", workspaceId]);
  }
}

export function assertTarget(value) {
  if (!TARGET_PATTERN.test(String(value || ""))) {
    throw new TypeError("Invalid cmux target");
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export { ALLOWED_KEYS, ALLOWED_AGENTS, ALLOWED_TODO_ACTIONS };

function readCredential(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}
