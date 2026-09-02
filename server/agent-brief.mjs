import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_BRIEF_DIRECTORY = join(homedir(), ".config", "cmux-companion", "briefs");

const MAX_POINTER_CHARACTERS = 1_900;

function identifier(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const raw = value.trim();
  if (!raw) throw new TypeError(`${label} must not be empty`);
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) throw new TypeError(`${label} must not contain a path`);
  const safe = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  if (!safe) throw new TypeError(`${label} must contain a letter or a digit`);
  return safe.slice(0, 120);
}

function summary(value, limit) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export class AgentBriefs {
  constructor({ directory = DEFAULT_BRIEF_DIRECTORY } = {}) {
    this.directory = directory;
  }

  async write({ planId, taskId, markdown }) {
    const plan = identifier(planId, "planId");
    const task = identifier(taskId, "taskId");
    if (typeof markdown !== "string" || !markdown.trim()) throw new TypeError("markdown must not be empty");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.cleanup();
    const path = resolve(this.directory, `${plan}-${task}.md`);
    await writeFile(path, markdown, { mode: 0o600 });
    return { path };
  }

  pointerPrompt({ title, outcome, path }) {
    if (typeof path !== "string" || !path.trim()) throw new TypeError("path must not be empty");
    const lines = [
      `Read the file ${path.trim()} in full before you do anything else.`,
      "That file is your complete brief. It holds the delivery contract, the verification steps, and the finish steps.",
      `Task: ${summary(title, 200) || "see the brief"}`,
      `Goal outcome: ${summary(outcome, 400) || "see the brief"}`,
      "Follow the brief file exactly. Do not start work before you read it.",
    ];
    return lines.join("\n").slice(0, MAX_POINTER_CHARACTERS);
  }

  async cleanup(maxAgeMs = 7 * 24 * 60 * 60 * 1_000) {
    const entries = await readdir(this.directory).catch(() => []);
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(entries.map(async (name) => {
      const path = join(this.directory, name);
      const details = await stat(path).catch(() => null);
      if (details?.isFile() && details.mtimeMs < cutoff) await unlink(path).catch(() => {});
    }));
  }
}
