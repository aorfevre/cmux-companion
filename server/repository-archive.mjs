import { readPrivateJson } from "./private-json-state.mjs";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "archived-repositories.json");

export class RepositoryArchive {
  constructor({ path = DEFAULT_PATH } = {}) {
    this.path = path;
    this.ids = new Set();
    this.load();
  }

  load() {
    const value = readPrivateJson(this.path, { repositories: [] }, value => value !== null && typeof value === "object" && Array.isArray(value.repositories));
    const ids = Array.isArray(value?.repositories) ? value.repositories : [];
    this.ids = new Set(ids.filter((id) => typeof id === "string" && /^[A-Za-z0-9_-]{18}$/.test(id)));
  }

  has(id) {
    return this.ids.has(id);
  }

  set(id, archived) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid repository");
    if (archived) this.ids.add(id);
    else this.ids.delete(id);
    this.save();
    return this.has(id);
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ repositories: [...this.ids].sort() }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}
