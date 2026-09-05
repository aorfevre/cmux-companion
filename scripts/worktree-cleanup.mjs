#!/usr/bin/env node
// This operator command is intentionally dry-run only. Deletion requires the
// authenticated UI's reviewed preview or explicitly enabled scheduling.
import { writeFile } from "node:fs/promises";
import { RepoCatalog } from "../server/repo-catalog.mjs";
import { CmuxClient } from "../server/cmux-client.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { WorktreeInventory, processActivity } from "../server/worktree-inventory.mjs";
import { WorktreeCleanup } from "../server/worktree-cleanup.mjs";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex === -1 ? null : process.argv[outputIndex + 1];
const store = new WorktreePlanStore();
try {
  const catalog = new RepoCatalog();
  const cmux = new CmuxClient();
  const inventory = new WorktreeInventory({ roots: catalog.roots, activity: () => processActivity(cmux), goalPlans: () => store.sessionCleanupPlanIds().map((id) => store.get(id)) });
  const cleanup = new WorktreeCleanup({ inventory });
  const report = await cleanup.preview();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, json, { mode: 0o600 });
  else process.stdout.write(json);
  if (output) console.log(JSON.stringify({ output, repositories: report.repositoryCount, ...report.summary, errors: report.errors.length, activityAvailable: report.activityAvailable, automaticDeletion: report.policy.enabled, pruning: report.policy.pruneEnabled }));
} finally { store.close(); }
