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
  } = {}) {
    this.bin = bin;
    this.execute = execute;
    this.socketPassword = socketPassword;
  }

  async run(args, { timeout = 10_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
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
    }
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

  workspaceList() {
    return this.runJSON(["rpc", "mobile.workspace.list", "{}"]);
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

export { ALLOWED_KEYS };

function readCredential(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}
