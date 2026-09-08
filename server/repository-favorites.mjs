import { RepositorySet } from "./repository-set.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

export class RepositoryFavorites extends RepositorySet {
  constructor({ path = join(homedir(), ".config", "cmux-companion", "favorite-repositories.json") } = {}) { super({ path }); }
}
