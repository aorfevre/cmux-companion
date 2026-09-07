import { readPrivateJson } from "./private-json-state.mjs";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "previews.json");
const MACOS_TAILSCALE_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const BLOCKED_TARGET_PORTS = new Set([3210, 3211]);

export class PreviewManager extends EventEmitter {
  constructor({
    path = process.env.CMUX_COMPANION_PREVIEWS_FILE || DEFAULT_PATH,
    execute = execFileAsync,
    checkPort = portIsOpen,
    tailscaleBin = process.env.CMUX_COMPANION_TAILSCALE_BIN || (existsSync(MACOS_TAILSCALE_BIN) ? MACOS_TAILSCALE_BIN : "tailscale"),
    environment = process.env,
    portStart = Number(process.env.CMUX_COMPANION_PREVIEW_PORT_START || 8500),
    portEnd = Number(process.env.CMUX_COMPANION_PREVIEW_PORT_END || 8599),
  } = {}) {
    super();
    this.path = path;
    this.execute = execute;
    this.checkPort = checkPort;
    this.tailscaleBin = tailscaleBin;
    this.environment = { ...environment, TERM: environment.TERM || "dumb" };
    this.portStart = portStart;
    this.portEnd = portEnd;
    this.state = this.load();
  }

  list() {
    return {
      previews: [...this.state.previews]
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))),
      tailnetOnly: true,
      portRange: { start: this.portStart, end: this.portEnd },
    };
  }

  discover({ workspaceId, repoId = null, name = "Local app", targetPort, sourceUrl = null } = {}) {
    assertWorkspaceId(workspaceId);
    const port = normalizeTargetPort(targetPort);
    const id = previewId(workspaceId, port);
    const now = new Date().toISOString();
    const existing = this.state.previews.find((item) => item.id === id);
    if (existing) {
      existing.name = safeName(name, existing.name);
      existing.repoId = safeRepoId(repoId) || existing.repoId || null;
      existing.sourceUrl = normalizeLocalUrl(sourceUrl, port);
      if (existing.status === "stopped") existing.status = "detected";
      existing.updatedAt = now;
      existing.misses = 0;
      this.save();
      return { preview: { ...existing }, created: false };
    }
    const record = {
      id,
      workspaceId,
      repoId: safeRepoId(repoId),
      name: safeName(name, "Local app"),
      targetPort: port,
      publicPort: null,
      sourceUrl: normalizeLocalUrl(sourceUrl, port),
      url: null,
      status: "detected",
      detectedAt: now,
      updatedAt: now,
      misses: 0,
    };
    this.state.previews.push(record);
    this.save();
    this.emit("detected", { ...record });
    return { preview: { ...record }, created: true };
  }

  async syncWorkspaces(workspaces = [], repos = []) {
    const present = new Set();
    for (const workspace of workspaces) {
      const repo = repos.find((item) => {
        const directory = workspace.current_directory || workspace.terminals?.[0]?.current_directory;
        return directory && (directory === item.path || directory.startsWith(`${item.path}/`));
      });
      for (const value of workspace.listening_ports || []) {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1024 || port > 49_151 || BLOCKED_TARGET_PORTS.has(port)) continue;
        const result = this.discover({
          workspaceId: workspace.id,
          repoId: repo?.id || null,
          name: repo?.name || workspace.title || `Local app on ${port}`,
          targetPort: port,
        });
        present.add(result.preview.id);
      }
    }
    for (const preview of this.state.previews) {
      if (present.has(preview.id)) continue;
      preview.misses = Number(preview.misses || 0) + 1;
      if (preview.misses >= 2 && preview.status === "active") await this.stop(preview.id, { preserve: true });
      else if (preview.misses >= 2 && preview.status !== "active") preview.status = "stopped";
    }
    this.save();
    return this.list();
  }

  async enable(id) {
    const preview = this.require(id);
    if (!await this.checkPort(preview.targetPort)) throw new TypeError("That localhost app is not accepting connections");
    const publicPort = preview.publicPort || await this.nextPublicPort();
    try {
      await this.execute(this.tailscaleBin, [
        "serve", "--bg", "--yes", `--https=${publicPort}`, `http://127.0.0.1:${preview.targetPort}`,
      ], { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, env: this.environment });
    } catch {
      throw new TypeError("Tailscale could not create that private preview link");
    }
    const hostname = await this.tailnetHostname();
    preview.publicPort = publicPort;
    preview.url = `https://${hostname}:${publicPort}`;
    preview.status = "active";
    preview.updatedAt = new Date().toISOString();
    preview.misses = 0;
    this.save();
    this.emit("ready", { ...preview });
    return { preview: { ...preview } };
  }

  async stop(id, { preserve = true } = {}) {
    const preview = this.require(id);
    if (preview.publicPort) {
      await this.execute(this.tailscaleBin, ["serve", `--https=${preview.publicPort}`, "off"], {
        encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, env: this.environment,
      });
    }
    preview.status = "stopped";
    preview.url = null;
    preview.updatedAt = new Date().toISOString();
    if (!preserve) this.state.previews = this.state.previews.filter((item) => item.id !== preview.id);
    this.save();
    this.emit("stopped", { ...preview });
    return preserve ? { preview: { ...preview } } : { removed: true };
  }

  async restart(id) {
    const preview = this.require(id);
    await this.stop(id);
    preview.publicPort = preview.publicPort || null;
    return this.enable(id);
  }

  remove(id) {
    const preview = this.require(id);
    if (preview.status === "active") throw new TypeError("Stop the preview before removing it");
    this.state.previews = this.state.previews.filter((item) => item.id !== id);
    this.save();
    return { removed: true };
  }

  require(id) {
    const preview = this.state.previews.find((item) => item.id === id);
    if (!preview) throw new TypeError("Unknown preview");
    return preview;
  }

  async nextPublicPort() {
    const used = new Set(this.state.previews.map((item) => item.publicPort).filter(Boolean));
    try {
      const { stdout = "" } = await this.execute(this.tailscaleBin, ["serve", "status", "--json"], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, env: this.environment,
      });
      const status = JSON.parse(stdout);
      for (const port of Object.keys(status.TCP || {})) used.add(Number(port));
    } catch {
      // The enable command will provide the actionable Tailscale error.
    }
    for (let port = this.portStart; port <= this.portEnd; port += 1) if (!used.has(port)) return port;
    throw new TypeError("No private preview ports are available");
  }

  async tailnetHostname() {
    const { stdout = "" } = await this.execute(this.tailscaleBin, ["status", "--json"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024, env: this.environment,
    });
    let hostname;
    try {
      hostname = JSON.parse(stdout)?.Self?.DNSName?.replace(/\.$/, "");
    } catch {
      throw new TypeError("Tailscale DNS name is unavailable");
    }
    if (!hostname || !/^[a-zA-Z0-9.-]+$/.test(hostname)) throw new TypeError("Tailscale DNS name is unavailable");
    return hostname;
  }

  load() {
    const value = readPrivateJson(this.path, { previews: [] }, value => value !== null && typeof value === "object" && Array.isArray(value.previews));
    return { previews: Array.isArray(value.previews) ? value.previews.map(normalizeStoredPreview).filter(Boolean) : [] };
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

export function extractLocalUrls(text) {
  const matches = String(text || "").matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(?:\/[^\s<>'"`)]*)?/gi);
  const urls = [];
  for (const match of matches) {
    const port = Number(match[1] || (match[0].startsWith("https:") ? 443 : 80));
    if (port > 0 && port <= 65_535 && !BLOCKED_TARGET_PORTS.has(port)) urls.push({ url: match[0], port });
  }
  return [...new Map(urls.map((item) => [`${item.port}:${item.url}`, item])).values()].slice(0, 12);
}

function previewId(workspaceId, port) {
  return createHash("sha256").update(`${workspaceId}:${port}`).digest("base64url").slice(0, 18);
}

function assertWorkspaceId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{3,128}$/.test(value)) throw new TypeError("Invalid workspace");
}

function normalizeTargetPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || BLOCKED_TARGET_PORTS.has(port)) throw new TypeError("Invalid localhost port");
  return port;
}

function safeName(value, fallback) {
  const name = typeof value === "string" ? value.trim().slice(0, 100) : "";
  return name || fallback;
}

function safeRepoId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,64}$/.test(value) ? value : null;
}

function normalizeLocalUrl(value, port) {
  if (typeof value === "string") {
    const found = extractLocalUrls(value).find((item) => item.port === port);
    if (found) return found.url;
  }
  return `http://localhost:${port}`;
}

function normalizeStoredPreview(item) {
  try {
    assertWorkspaceId(item.workspaceId);
    const targetPort = normalizeTargetPort(item.targetPort);
    return {
      id: previewId(item.workspaceId, targetPort), workspaceId: item.workspaceId,
      repoId: safeRepoId(item.repoId), name: safeName(item.name, "Local app"), targetPort,
      publicPort: Number.isInteger(item.publicPort) ? item.publicPort : null,
      sourceUrl: normalizeLocalUrl(item.sourceUrl, targetPort),
      url: typeof item.url === "string" && item.url.startsWith("https://") ? item.url : null,
      status: item.status === "active" && item.url ? "active" : item.status === "detected" ? "detected" : "stopped",
      detectedAt: item.detectedAt || new Date().toISOString(), updatedAt: item.updatedAt || new Date().toISOString(),
      misses: Number(item.misses || 0),
    };
  } catch {
    return null;
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
