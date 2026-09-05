import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GitHubReviewToken } from "../server/github-review-token.mjs";

const TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

function store({ execute = okExecute("octo-bot") } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "review-token-")), "github-review-token.json");
  return { path, token: new GitHubReviewToken({ path, execute }) };
}

function okExecute(login) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    return { stdout: `${login}\n` };
  };
  run.calls = calls;
  return run;
}

test("an unconfigured companion reports no token and never throws", () => {
  const { token } = store();
  assert.deepEqual(token.status(), { configured: false, login: null, verifiedAt: null });
});

test("saving validates through the GitHub CLI and records the account", async () => {
  const execute = okExecute("octo-bot");
  const { path, token } = store({ execute });
  const status = await token.save(`  ${TOKEN}  `);

  assert.equal(status.configured, true);
  assert.equal(status.login, "octo-bot");
  assert.ok(status.verifiedAt);
  // The status is the whole browser-visible shape. The token is absent by
  // construction, so no caller can leak it by spreading this object.
  assert.equal(Object.hasOwn(status, "token"), false);

  // The token reaches gh only through the environment, never through argv,
  // because a command line is visible to every process on the machine.
  assert.deepEqual(execute.calls[0].args, ["api", "user", "--jq", ".login"]);
  assert.equal(execute.calls[0].env.GH_TOKEN, TOKEN);
  assert.equal(execute.calls[0].args.join(" ").includes(TOKEN), false);

  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.token, TOKEN);
  assert.equal(stored.login, "octo-bot");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a saved token survives a companion restart", async () => {
  const { path, token } = store();
  await token.save(TOKEN);
  const reopened = new GitHubReviewToken({ path, execute: okExecute("octo-bot") });
  assert.deepEqual(reopened.status(), { configured: true, login: "octo-bot", verifiedAt: token.status().verifiedAt });
});

test("an unusable token is refused before it is stored", async () => {
  const { path, token } = store({
    execute: async () => { throw new Error("gh: Bad credentials (HTTP 401)"); },
  });
  await assert.rejects(() => token.save(TOKEN), /GitHub refused that token/);
  assert.equal(token.status().configured, false);
  assert.throws(() => readFileSync(path, "utf8"), /ENOENT/);
});

test("malformed input is refused without reaching the network", async () => {
  const execute = okExecute("octo-bot");
  const { token } = store({ execute });
  await assert.rejects(() => token.save(""), /Paste a GitHub token/);
  await assert.rejects(() => token.save("   "), /Paste a GitHub token/);
  await assert.rejects(() => token.save(null), /Paste a GitHub token/);
  await assert.rejects(() => token.save("ghp_short"), /too short/);
  await assert.rejects(() => token.save(`${TOKEN} ${TOKEN}`), /contains no spaces/);
  await assert.rejects(() => token.save("x".repeat(400)), /too long/);
  assert.equal(execute.calls.length, 0);
});

test("a token GitHub accepts but cannot name is refused", async () => {
  const { token } = store({ execute: async () => ({ stdout: "  \n" }) });
  await assert.rejects(() => token.save(TOKEN), /named no account/);
  assert.equal(token.status().configured, false);
});

test("clearing removes the file and the identity", async () => {
  const { path, token } = store();
  await token.save(TOKEN);
  assert.deepEqual(token.clear(), { configured: false, login: null, verifiedAt: null });
  assert.throws(() => readFileSync(path, "utf8"), /ENOENT/);
  // Clearing twice is not an error: the user may click Remove on a file a
  // second companion already deleted.
  assert.equal(token.clear().configured, false);
});

test("a corrupted file disables the feature instead of stopping the companion", () => {
  const path = join(mkdtempSync(join(tmpdir(), "review-token-")), "github-review-token.json");
  writeFileSync(path, "{ not json", "utf8");
  assert.equal(new GitHubReviewToken({ path }).status().configured, false);

  writeFileSync(path, JSON.stringify({ login: "octo-bot" }), "utf8");
  assert.equal(new GitHubReviewToken({ path }).status().configured, false);
});

test("the brief is given the path, never the secret", async () => {
  const { path, token } = store();
  await token.save(TOKEN);
  // The agent reads the file itself. The companion never types the token into
  // a shell, because cmux exports are visible in the session and the companion
  // replays sessions over HTTP.
  assert.equal(token.location(), path);
});

test("a companion with no GitHub CLI says so rather than storing an unchecked token", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "review-token-")), "github-review-token.json");
  const token = new GitHubReviewToken({ path });
  await assert.rejects(() => token.save(TOKEN), /cannot reach the GitHub CLI/);
  assert.equal(token.status().configured, false);
});
