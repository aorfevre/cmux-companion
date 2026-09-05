import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_PATH = join(homedir(), ".config", "cmux-companion", "github-review-token.json");
// A GitHub token is opaque. The bound is a sanity check on user input, not a
// format claim: classic PATs, fine-grained PATs and OAuth tokens all differ.
const MAX_TOKEN = 200;
const MIN_TOKEN = 20;

// The credential the code-review agent posts under.
//
// It exists because a review is worth more than a comment. GitHub refuses
// APPROVE and REQUEST_CHANGES on your own pull request with a 422, and the
// goal pull request is opened with the machine's own gh credential. A second
// identity is the only way a review can carry a real verdict.
//
// The token never leaves this process. `status()` is what the browser sees,
// and it reports only whether one is configured and which login it belongs to.
// Storage matches server/github-issue-store.mjs: a 0o700 directory, an atomic
// temp-file write, and a 0o600 file.
export class GitHubReviewToken {
  constructor({ path = DEFAULT_PATH, execute = null, log = null } = {}) {
    this.path = path;
    this.execute = execute;
    this.log = log;
    this.state = { token: "", login: "", verifiedAt: null };
    this.load();
  }

  load() {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      this.state = {
        token: text(value?.token, MAX_TOKEN),
        login: text(value?.login, 100),
        verifiedAt: text(value?.verifiedAt, 40) || null,
      };
    } catch {
      // A missing or corrupted file means no review identity. That disables
      // the feature; it must never stop the companion from starting.
      this.state = { token: "", login: "", verifiedAt: null };
    }
    if (!this.state.token) this.state = { token: "", login: "", verifiedAt: null };
    return this.status();
  }

  // The only shape the browser is ever given. The token itself is absent by
  // construction rather than by redaction, so no future caller can leak it by
  // spreading this object.
  status() {
    return {
      configured: this.state.token !== "",
      login: this.state.login || null,
      verifiedAt: this.state.verifiedAt,
    };
  }

  // The agent reads the token out of this file itself. The companion never
  // types it into a shell, because cmux exports are visible in the session and
  // the companion replays sessions over HTTP (GET /api/terminals/:id/replay).
  // The brief therefore needs the path, not the secret.
  location() {
    return this.path;
  }

  // Saving validates. An unusable token that silently sits in the file would
  // surface much later as a failed review on a finished goal, which is the
  // worst moment to discover it.
  async save(value) {
    const token = text(value, MAX_TOKEN + 1);
    if (!token) throw new TypeError("Paste a GitHub token");
    if (token.length > MAX_TOKEN) throw new TypeError("That token is too long to be a GitHub token");
    if (token.length < MIN_TOKEN) throw new TypeError("That token is too short to be a GitHub token");
    if (/\s/.test(token)) throw new TypeError("A GitHub token contains no spaces");

    const login = await this.#login(token);
    this.state = { token, login, verifiedAt: new Date().toISOString() };
    this.#write();
    return this.status();
  }

  clear() {
    this.state = { token: "", login: "", verifiedAt: null };
    try {
      rmSync(this.path, { force: true });
    } catch (cause) {
      this.log?.warn?.({ err: cause }, "review token file could not be removed");
    }
    return this.status();
  }

  // `gh api user` under this token answers two questions at once: the token
  // works, and which account will own the review.
  async #login(token) {
    if (!this.execute) throw new TypeError("This companion cannot reach the GitHub CLI to check the token");
    let stdout = "";
    try {
      const result = await this.execute("gh", ["api", "user", "--jq", ".login"], {
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 1_000_000,
        env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      });
      stdout = String(result?.stdout ?? result ?? "");
    } catch {
      throw new TypeError("GitHub refused that token. Check that it is current and has repository access");
    }
    const login = text(stdout, 100);
    if (!login) throw new TypeError("GitHub accepted that token but named no account");
    return login;
  }

  #write() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function text(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}
