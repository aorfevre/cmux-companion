// cmux launches this fixed entry point. The native CLI owns its terminal;
// Companion owns only durable identity, proposal publication and approval.
import { fileURLToPath } from "node:url";
import { runInteractiveGoalSession } from "./goal-session-interactive.mjs";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [planId, databasePath, generation, dispatchId] = process.argv.slice(2);
  runInteractiveGoalSession({ planId, databasePath, generation: Number(generation), dispatchId })
    .catch((cause) => { console.error(cause?.message || cause); process.exitCode = 1; });
}
