import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { WorktreePlanStore } from "../server/worktree-plan-store.mjs";

const directory = mkdtempSync(join(tmpdir(), "companion-store-benchmark-"));
const path = join(directory, "plans.db");
const store = new WorktreePlanStore({ path });
function sample(work, iterations = 100) {
  const times = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now(); work(index); times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: +times[Math.floor(times.length / 2)].toFixed(2), p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2), maxMs: +times.at(-1).toFixed(2) };
}
try {
  for (let plan = 0; plan < 200; plan++) {
    const planId = `benchmark-${plan}`;
    store.createPlan({ planId, repositoryId: "benchmark-repo", goal: `Isolated goal ${plan}` });
    for (let round = 1; round <= 4; round++) store.recordRound(planId, { round, stage: "ready", tasks: Array.from({ length: 8 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, branch: `feature/task-${index}`, prompt: "Benchmark fixture ".repeat(220), agent: "codex" })) });
  }
  const result = {
    node: process.version, platform: `${process.platform}/${process.arch}`, plans: 200, tasksPerPlan: 8, roundsPerPlan: 4,
    list: sample(() => store.list({ limit: 200 })),
    detail: sample(index => store.get(`benchmark-${index}`)),
    write: sample(index => store.recordRoundFailure(`benchmark-${index}`, "Benchmark-only failure state")),
    databaseBytes: statSync(path).size,
  };
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
