import { lstat, realpath, statfs } from "node:fs/promises";
import { join } from "node:path";
import { normalizeRemote, validateSha } from "./config.mjs";
import { run } from "./process.mjs";

export async function verifyRepository(target) {
  await lstat(join(target.repositoryPath, ".git"));
  await run("/usr/bin/git", ["-C", target.repositoryPath, "rev-parse", "--git-common-dir"], { timeoutMs: 10_000 });
  const actual = (await run("/usr/bin/git", ["-C", target.repositoryPath, "remote", "get-url", target.remote], { timeoutMs: 10_000 })).stdout.trim();
  if (normalizeRemote(actual) !== normalizeRemote(target.expectedRemote)) {
    throw new Error(`Configured remote does not match the expected ${target.name} repository`);
  }
}

export async function discover(target) {
  const ref = `refs/heads/${target.branch}`;
  const output = await run("/usr/bin/git", ["-C", target.repositoryPath, "ls-remote", "--exit-code", target.remote, ref], { timeoutMs: 10_000 });
  const [sha, returnedRef, ...extra] = output.stdout.trim().split(/\s+/);
  if (extra.length || returnedRef !== ref) throw new Error(`Unexpected remote response for ${target.name}`);
  return validateSha(sha);
}

export async function fetchExact(target, expectedSha) {
  await run("/usr/bin/git", ["-C", target.repositoryPath, "fetch", "--no-tags", target.remote, `refs/heads/${target.branch}`], { timeoutMs: 120_000 });
  const sha = validateSha((await run("/usr/bin/git", ["-C", target.repositoryPath, "rev-parse", "FETCH_HEAD^{commit}"])).stdout.trim());
  if (sha !== expectedSha) throw new Error(`The ${target.name} branch changed while it was being fetched; deferring the newer commit`);
  return sha;
}

export async function assertFastForward(target, deployedSha, candidateSha) {
  if (!deployedSha || deployedSha === candidateSha) return;
  const result = await run("/usr/bin/git", ["-C", target.repositoryPath, "merge-base", "--is-ancestor", deployedSha, candidateSha], { allowFailure: true });
  if (result.code === 0) return;

  // GitHub squash merges replace the feature commit, so the installed SHA is
  // no longer an ancestor even though the squash commit contains the exact
  // same tree. Accept only when that tree is already in candidate history.
  const deployedTree = await run("/usr/bin/git", ["-C", target.repositoryPath, "rev-parse", `${deployedSha}^{tree}`], { allowFailure: true });
  if (deployedTree.code === 0) {
    const historyTrees = await run("/usr/bin/git", ["-C", target.repositoryPath, "log", "--format=%T", candidateSha], { allowFailure: true });
    if (historyTrees.code === 0 && historyTrees.stdout.split(/\s+/).includes(deployedTree.stdout.trim())) return;
  }

  throw new Error(`Unsafe non-fast-forward history for ${target.name}: ${candidateSha}`);
}

export async function primaryWorktree(repositoryPath) {
  const result = await run("/usr/bin/git", ["-C", repositoryPath, "worktree", "list", "--porcelain", "-z"], { timeoutMs: 10_000 });
  const field = result.stdout.split("\0").find((value) => value.startsWith("worktree "));
  if (!field) throw new Error(`Could not determine the primary worktree for ${repositoryPath}`);
  return await realpath(field.slice("worktree ".length));
}

export async function ensureDiskSpace(releaseRoot, minimumBytes = 512 * 1024 * 1024) {
  const info = await statfs(releaseRoot);
  const free = Number(info.bavail) * Number(info.bsize);
  if (free < minimumBytes) throw new Error(`Insufficient disk space: ${free} bytes available`);
}

export async function addWorktree(target, releasePath, sha) {
  await run("/usr/bin/git", ["-C", target.repositoryPath, "worktree", "add", "--detach", releasePath, sha], { timeoutMs: 120_000 });
  const actual = validateSha((await run("/usr/bin/git", ["-C", releasePath, "rev-parse", "HEAD"])).stdout.trim());
  if (actual !== sha) throw new Error("Staged worktree SHA mismatch");
  await lockWorktree(target, releasePath);
}

export async function lockWorktree(target, releasePath) {
  const result = await run("/usr/bin/git", ["-C", target.repositoryPath, "worktree", "lock", "--reason", "cmux-companion managed deployment", releasePath], { allowFailure: true, timeoutMs: 10_000 });
  if (result.code !== 0 && !/already locked/i.test(result.stderr)) {
    const detail = result.stderr.trim().split("\n").at(-1);
    throw new Error(detail ? `Could not protect managed release: ${detail}` : "Could not protect managed release");
  }
}

export async function removeWorktree(target, releasePath, { force = false } = {}) {
  await run("/usr/bin/git", ["-C", target.repositoryPath, "worktree", "remove", ...(force ? ["--force"] : []), releasePath], { timeoutMs: 120_000 });
}
