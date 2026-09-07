import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxClient } from "../../server/cmux-client.mjs";
import { buildApp } from "../../server/app.mjs";
import { WorktreePlanStore } from "../../server/worktree-plan-store.mjs";
import { GitHubIssueStore } from "../../server/github-issue-store.mjs";
import { GitHubReviewToken } from "../../server/github-review-token.mjs";
import { AgentBriefs } from "../../server/agent-brief.mjs";
import { ImageAttachments } from "../../server/image-attachments.mjs";
import { kimiUsage } from "../../server/kimi-usage.mjs";
import { AccountUsage } from "../../server/account-usage.mjs";
import { RepoCatalog } from "../../server/repo-catalog.mjs";
import { WorktreeDashboard } from "../../server/worktree-dashboard.mjs";
import { WorktreeInventory } from "../../server/worktree-inventory.mjs";
import { WorktreeCleanup } from "../../server/worktree-cleanup.mjs";
import { RepositoryArchive } from "../../server/repository-archive.mjs";
import { RepositoryFavorites } from "../../server/repository-favorites.mjs";

// Each invocation owns its storage, including failures before app construction.
// No process-wide HOME override or shared mutable test database is required.
export async function buildTestApp(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cmux-api-fixture-"));
  let app;
  let ownedStore;
  t.after(async () => {
    try { await app?.close(); }
    finally {
      ownedStore?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const repoCatalog = options.repoCatalog || new RepoCatalog({ roots: [] });
  const worktreePlanStore = options.worktreePlanStore || (options.worktreePlanner ? null : (ownedStore = new WorktreePlanStore({ path: join(directory, "plans.db") })));
  app = await buildApp({
    ...options,
    cmux: options.cmux || new CmuxClient({ bin: "/fake/cmux", socketPassword: "" }),
    repoCatalog,
    worktreePlanStore,
    worktreeDashboard: options.worktreeDashboard || new WorktreeDashboard({
      repoCatalog, managedReleaseRoots: [],
      repositoryArchive: new RepositoryArchive({ path: join(directory, "archive.json") }),
      repositoryFavorites: new RepositoryFavorites({ path: join(directory, "favorites.json") }),
    }),
    worktreeCleanup: options.worktreeCleanup || new WorktreeCleanup({
      directory: join(directory, "cleanup"),
      inventory: new WorktreeInventory({ roots: [], activity: async () => ({ available: true, processes: [] }) }),
      onRemoved: (path) => worktreePlanStore?.recordWorktreeRemoved(path),
    }),
    githubIssueStore: options.githubIssueStore || new GitHubIssueStore({ path: join(directory, "issues.json") }),
    githubReviewToken: options.githubReviewToken || new GitHubReviewToken({ path: join(directory, "review-token.json") }),
    agentBriefs: options.agentBriefs || new AgentBriefs({ directory: join(directory, "briefs") }),
    imageAttachments: options.imageAttachments || new ImageAttachments({ directory: join(directory, "attachments") }),
    accountUsage: options.accountUsage || new AccountUsage({ kimiLoader: () => kimiUsage({ key: "" }), sourceLoader: async () => { throw new Error("No account source in API fixture"); } }),
  });
  app.decorate("fixtureDirectory", directory);
  return app;
}
