import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL_ROLES, patchModelRoles, roleEngine } from "./model-options.mjs";

export const DEFAULT_MODEL_SETTINGS_PATH = join(homedir(), ".config", "cmux-companion", "model-settings.json");

export class ModelSettings {
  // Only the running server supplies a path; tests and isolated services use
  // in-memory defaults and never read or overwrite the user's settings.
  constructor({ path = null } = {}) {
    this.path = path;
    this.roles = structuredClone(DEFAULT_MODEL_ROLES);
    this.warning = null;
    if (path) try {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      if (saved.version !== 1) throw new Error("Unknown settings version");
      this.roles = patchModelRoles(this.roles, saved.roles);
    } catch (cause) {
      if (cause.code !== "ENOENT") this.warning = "Saved model settings could not be read. Built-in defaults are active.";
    }
  }

  status() {
    return { roles: structuredClone(this.roles), defaults: structuredClone(DEFAULT_MODEL_ROLES), warning: this.warning };
  }

  engine(role, provider) { return roleEngine(this.roles, role, provider); }

  workspace(role, agent) {
    if (agent === "shell") return { agent };
    const engine = this.engine(role, agent);
    return { agent: engine.provider, model: engine.model };
  }

  configure(body) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "roles")) {
      throw new TypeError("Expected model roles");
    }
    const next = patchModelRoles(this.roles, body.roles);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ version: 1, roles: next }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.path);
      } finally { rmSync(temporary, { force: true }); }
    }
    this.roles = next;
    this.warning = null;
    return this.status();
  }
}
