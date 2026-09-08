// Commit timestamps are immutable for a known SHA; failed/unborn reads are not cached.
export async function readCommitTime(catalog, path, sha) {
  const store = catalog.identityStore;
  const stored = sha ? store?.commitTime(sha) : null;
  if (stored) return stored;
  const output = await catalog.git(path, ["log", "-1", "--format=%ct"]).catch(() => "0");
  const commitTime = Number(String(output).trim()) || 0;
  if (sha && commitTime > 0) store?.rememberCommitTimes([{ sha, commitTime }]);
  return commitTime;
}
