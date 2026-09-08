import { finalEnvelope, streamExecFile } from "./planner-process.mjs";
import { describeRunFailure, describeTimeout } from "./worktree-planner.mjs";
import { normalizeProposal } from "./burst-contract.mjs";
import { PLANNER_ENGINES } from "./worktree-planner-options.mjs";
import { ModelSettings } from "./model-settings.mjs";

// Read-only by construction: the same tool lists the retired headless planner
// used, so the scan can read a repository and never touch it.
const ALLOWED_TOOLS = "Read,Grep,Glob";
const DENIED_TOOLS = "Bash,Write,Edit,MultiEdit,NotebookEdit,Task,WebFetch,WebSearch";
const ISOLATION = ["--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands"];
const IDLE_TIMEOUT_MS = Number(process.env.CMUX_BURST_IDLE_TIMEOUT_MS) || 240_000;
const CEILING_MS = Number(process.env.CMUX_BURST_CEILING_MS) || 900_000;
const UNUSABLE = "The scan returned an unusable answer";

export class BurstScanner {
  constructor({ execute = streamExecFile, modelSettings = new ModelSettings(), idleTimeoutMs = IDLE_TIMEOUT_MS, ceilingMs = CEILING_MS } = {}) {
    this.execute = execute;
    this.modelSettings = modelSettings;
    this.idleTimeoutMs = idleTimeoutMs;
    this.ceilingMs = ceilingMs;
  }

  async scan({ repository, provider }) {
    if (provider !== "claude" && provider !== "codex") throw new TypeError("Unknown scan provider");
    const engine = this.modelSettings.engine("planner", provider);
    const args = [provider, "--print", "--output-format", "stream-json", "--verbose", ...ISOLATION, "--allowed-tools", ALLOWED_TOOLS, "--disallowed-tools", DENIED_TOOLS];
    if (engine.model && engine.model !== PLANNER_ENGINES.passthroughModel) args.push("--model", engine.model);
    if (engine.effort && engine.effort !== PLANNER_ENGINES.defaultEffort) args.push("--effort", engine.effort);
    // `--` is required: --disallowed-tools is variadic and would swallow the prompt.
    args.push("--", scanPrompt(repository));
    let stdout = "";
    try {
      ({ stdout = "" } = await this.execute("ccs", args, {
        cwd: repository.path, encoding: "utf8", timeout: this.ceilingMs, idleTimeout: this.idleTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env,
      }));
    } catch (cause) {
      if (cause?.code === "ENOENT") throw new Error("The scan needs the ccs CLI. Install it, then try again");
      if (cause?.killed || cause?.signal === "SIGTERM") throw new Error(describeTimeout(cause?.reason, this.idleTimeoutMs, this.ceilingMs));
      throw new Error(describeRunFailure(cause?.stderr));
    }
    return parseScanReply(finalEnvelope(stdout));
  }
}

export function scanPrompt(repository) {
  return [
    `You are scanning the repository "${repository.name}" to propose one goal for a coding agent.`,
    "1. Read AGENTS.md or CLAUDE.md if present, then the README.",
    "2. Find the largest tractable increment worth one goal: a missing test area, a stale module, a documented TODO, an unfinished feature. Prefer work with observable verification.",
    "3. Do not write files. Do not run commands. Read only.",
    'Answer with exactly one JSON object and nothing else: {"goal":"one sentence a developer can act on","rationale":"why this, in two to four sentences","evidence":["path/or/command", "..."],"sizeEstimate":"small|medium|large"}',
  ].join("\n");
}

export function parseScanReply(stdout) {
  const envelope = extractJson(String(stdout));
  if (!envelope) throw new TypeError(UNUSABLE);
  const payload = extractJson(String(envelope.result ?? ""));
  if (!payload) throw new TypeError(UNUSABLE);
  return normalizeProposal(payload);
}

// The result line holds JSON, or prose around JSON. Take the outermost object.
function extractJson(text) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
