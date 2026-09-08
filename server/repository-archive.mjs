import { RepositorySet } from "./repository-set.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

export class RepositoryArchive extends RepositorySet {
  constructor({ path = join(homedir(), ".config", "cmux-companion", "archived-repositories.json") } = {}) { super({ path }); }
}
