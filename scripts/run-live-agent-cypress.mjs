import { spawn } from "node:child_process";

if (process.env.CI) throw new Error("The real-agent Cypress suite is intentionally local-only.");
if (process.env.CMUX_COMPANION_LIVE_E2E !== "I_UNDERSTAND") {
  throw new Error("Set CMUX_COMPANION_LIVE_E2E=I_UNDERSTAND to create real cmux sessions, branches, and a pull request in the fixture repository.");
}

const countArgument = process.argv.find((value) => /^--tasks=[12]$/.test(value));
const taskCount = countArgument ? countArgument.slice("--tasks=".length) : "1";
const args = [
  "cypress", "run", "--config-file", "cypress.live.config.ts",
  "--spec", "cypress/live/real-goal.cy.ts", "--env", `taskCount=${taskCount}`,
];
const child = spawn("npx", args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (value) => resolve(value ?? 1));
});
process.exitCode = Number(code);
