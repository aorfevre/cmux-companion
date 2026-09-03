import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineConfig } from "cypress";
import { CmuxClient } from "./server/cmux-client.mjs";

export default defineConfig({
  e2e: {
    baseUrl: process.env.CMUX_COMPANION_E2E_URL || "http://127.0.0.1:3210",
    specPattern: "cypress/live/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    video: false,
    defaultCommandTimeout: 20_000,
    requestTimeout: 30_000,
    // A two-task launch fetches the base, creates two Git worktrees and opens
    // two real cmux sessions before the route answers. Slow local disks or a
    // cold cmux automation socket can legitimately exceed Cypress's default.
    responseTimeout: 240_000,
    pageLoadTimeout: 240_000,
    taskTimeout: 120_000,
    setupNodeEvents(on, config) {
      if (process.env.CI || process.env.CMUX_COMPANION_LIVE_E2E !== "I_UNDERSTAND") {
        throw new Error("Real-agent Cypress tests are local-only and require CMUX_COMPANION_LIVE_E2E=I_UNDERSTAND.");
      }
      const fixtureRoot = resolve(process.env.CMUX_COMPANION_E2E_FIXTURE_ROOT || join(homedir(), "Developers", "karven", "cmux-e2e-cypress"));
      const run = promisify(execFile);
      config.env.fixtureRoot = fixtureRoot;

      async function pairingToken() {
        const path = process.env.CMUX_COMPANION_TOKEN_FILE || join(homedir(), ".config", "cmux-companion", "token");
        return (process.env.CMUX_COMPANION_E2E_TOKEN || await readFile(path, "utf8")).trim();
      }

      async function cleanupFixtureWorkspaces(runId: string) {
        if (!/^cypress-[a-z0-9]+$/.test(runId)) throw new Error("Invalid fixture run id for cmux cleanup.");
        const cmux = new CmuxClient();
        const payload = await cmux.workspaceListDetailed();
        const fixturePrefix = `${fixtureRoot}-`;
        const owned = (payload.workspaces || []).filter((workspace: { id?: string; current_directory?: string }) => {
          const directory = resolve(String(workspace.current_directory || "/"));
          return directory.startsWith(fixturePrefix)
            && directory.includes(runId);
        });
        const closed: string[] = [];
        const errors: string[] = [];
        for (const workspace of owned) {
          if (!workspace.id) continue;
          try { await cmux.workspaceClose(workspace.id); closed.push(workspace.id); }
          catch (cause) { errors.push(`${workspace.id}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
        return { closed, errors };
      }

      async function cleanupFixtureGitArtifacts(runId: string) {
        const removedWorktrees: string[] = [];
        const removedBranches: string[] = [];
        const errors: string[] = [];
        const fixturePrefix = `${fixtureRoot}-`;
        const inventory = await run("git", ["-C", fixtureRoot, "worktree", "list", "--porcelain", "-z"], { timeout: 30_000 });
        const paths = inventory.stdout.split("\0\0")
          .map((record) => record.split("\0").find((line) => line.startsWith("worktree "))?.slice(9) || "")
          .map((path) => resolve(path || "/"))
          .filter((path) => path.startsWith(fixturePrefix) && path.includes(runId));
        for (const path of paths) {
          try { await run("git", ["-C", fixtureRoot, "worktree", "remove", "--force", path], { timeout: 30_000 }); removedWorktrees.push(path); }
          catch (cause) { errors.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
        const remoteRefs = await run("git", ["-C", fixtureRoot, "ls-remote", "--heads", "origin"], { timeout: 30_000 });
        const remoteBranches = remoteRefs.stdout.split("\n")
          .map((value) => value.trim().split(/\s+/)[1] || "")
          .filter((value) => value.startsWith("refs/heads/") && value.includes(runId))
          .map((value) => value.slice("refs/heads/".length));
        for (const branch of remoteBranches) {
          try { await run("git", ["-C", fixtureRoot, "push", "origin", "--delete", branch], { timeout: 60_000 }); removedBranches.push(`origin/${branch}`); }
          catch (cause) { errors.push(`origin/${branch}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
        const localRefs = await run("git", ["-C", fixtureRoot, "for-each-ref", "--format=%(refname:short)", "refs/heads"], { timeout: 30_000 });
        const localBranches = localRefs.stdout.split("\n").map((value) => value.trim()).filter((value) => value.includes(runId));
        for (const branch of localBranches) {
          try { await run("git", ["-C", fixtureRoot, "branch", "-D", branch], { timeout: 30_000 }); removedBranches.push(branch); }
          catch (cause) { errors.push(`${branch}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
        return { removedWorktrees, removedBranches, errors };
      }

      on("task", {
        async pairingToken() {
          return pairingToken();
        },
        async cmuxWorkspaces() {
          const payload = await new CmuxClient().workspaceListDetailed();
          return payload.workspaces || [];
        },
        async cleanupFixtureWorkspaces(runId: string) {
          return cleanupFixtureWorkspaces(runId);
        },
        async cleanupLiveRun(input: { planId?: string | null; runId: string; reachedMerged?: boolean }) {
          let abortStatus: number | null = null;
          let abortError: string | null = null;
          let workspaces: { closed: string[]; errors: string[] } = { closed: [], errors: [] };
          try {
            if (input.planId && !input.reachedMerged) {
              const token = await pairingToken();
              const response = await fetch(new URL(`/api/worktree-plans/${encodeURIComponent(input.planId)}/abort`, config.baseUrl || "http://127.0.0.1:3210"), {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: "{}",
                signal: AbortSignal.timeout(30_000),
              });
              abortStatus = response.status;
            }
          } catch (cause) {
            abortError = cause instanceof Error ? cause.message : String(cause);
          } finally {
            workspaces = await cleanupFixtureWorkspaces(input.runId);
          }
          const gitArtifacts = input.reachedMerged
            ? await cleanupFixtureGitArtifacts(input.runId)
            : { removedWorktrees: [], removedBranches: [], errors: [] };
          return { abortStatus, abortError, ...workspaces, gitArtifacts };
        },
        async mergeFixturePullRequest(input: { url: string; runId: string }) {
          const { url, runId } = input;
          if (!/^https:\/\/github\.com\/aorfevre\/cmux-e2e-cypress\/pull\/\d+$/.test(url)) {
            throw new Error("Refusing to merge a pull request outside the disposable fixture repository.");
          }
          if (!/^cypress-[a-z0-9]+$/.test(runId)) throw new Error("Invalid fixture run id for pull request merge.");
          const { stdout } = await run("gh", ["pr", "view", url, "--json", "headRefName,state"], { timeout: 30_000 });
          const pullRequest = JSON.parse(stdout);
          if (pullRequest.state !== "OPEN" || !String(pullRequest.headRefName || "").includes(runId)) {
            throw new Error("Refusing to merge a pull request not owned by this Cypress run.");
          }
          await run("gh", ["pr", "merge", url, "--squash", "--delete-branch"], { timeout: 120_000 });
          return true;
        },
      });
      return config;
    },
  },
});
