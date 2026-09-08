import { readPrivateJson, writePrivateJson } from "./private-json-state.mjs";

export class RepositorySet {
  constructor({ path } = {}) {
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

  set(id, enabled) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{18}$/.test(id)) throw new TypeError("Invalid repository");
    if (enabled) this.ids.add(id);
    else this.ids.delete(id);
    this.save();
    return this.has(id);
  }

  save() { writePrivateJson(this.path, { repositories: [...this.ids].sort() }); }
}
