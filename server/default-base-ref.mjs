// One resolution of the default remote branch for every caller that must branch
// from the tip of it: goal task launches and manual worktree creation. `git` is
// the caller's own runner, `(cwd, args, options) => stdout`, so each caller
// keeps its concurrency limits and its process policy.
export async function resolveDefaultBaseRef(git, repositoryPath) {
  let branch = "main";
  try {
    const output = await git(repositoryPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    branch = String(output).trim().replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "") || "main";
  } catch {
    // No local origin/HEAD ref. Ask the remote rather than guessing "main",
    // which aborts the whole launch on a healthy master-default repository.
    const head = await git(repositoryPath, ["ls-remote", "--symref", "origin", "HEAD"]).catch(() => "");
    branch = String(head).match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] || "main";
  }
  try {
    await git(repositoryPath, ["fetch", "origin", branch], { timeout: 120_000 });
  } catch (cause) {
    const lines = String(cause?.stderr || cause?.message || "").trim().split("\n").map((line) => line.trim()).filter(Boolean);
    // Git prints the diagnosis first and boilerplate advice last, so prefer
    // the first fatal or error line over the tail.
    const detail = (lines.find((line) => /^(fatal|error):/.test(line)) || lines.at(-1) || "").slice(0, 160);
    throw new TypeError(detail ? `Git could not fetch origin/${branch}: ${detail}` : `Git could not fetch origin/${branch}`);
  }
  return `origin/${branch}`;
}
