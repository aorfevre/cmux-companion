#!/usr/bin/env node
import { CmuxClient } from "../server/cmux-client.mjs";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";
import { inspectTaskAssociation, applyTaskAssociation } from "../server/task-association.mjs";

const [planId, taskId, workspaceId, action] = process.argv.slice(2);
if (!planId || !taskId || !workspaceId || (action && action !== "--apply")) {
  throw new Error("Usage: node scripts/recover-task-association.mjs PLAN_ID TASK_ID WORKSPACE_UUID [--apply]");
}
const store = new WorktreePlanStore();
try {
  const options = { store, cmux: new CmuxClient(), planId, taskId, workspaceId };
  const candidate = await inspectTaskAssociation(options);
  if (action === "--apply") await applyTaskAssociation(options, candidate);
  console.log(JSON.stringify({ applied: action === "--apply", ...candidate }, null, 2));
} finally { store.close(); }
