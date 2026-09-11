import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    baseUrl: process.env.CMUX_COMPANION_CYPRESS_BASE_URL || "http://localhost:3221",
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    video: false,
    screenshotOnRunFailure: true,
    setupNodeEvents(on, config) {
      if (process.env.CI || process.env.CMUX_COMPANION_LOCAL_E2E !== "1") {
        throw new Error("Cypress is local-only. Run npm run test:e2e:local outside CI.");
      }
      const manifestPath = process.env.CMUX_ORCHESTRATION_CYPRESS_MANIFEST;
      config.expose = { ...config.expose, orchestration: Boolean(manifestPath), orchestrationReadOnly: process.env.CMUX_ORCHESTRATION_CYPRESS_READ_ONLY === '1' };
      if (manifestPath) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!manifest.browserHarness) throw new Error('Expected a disposable browser fixture');
        on('task', {
          orchestrationPairing() { return readFileSync(manifest.tokenFile, 'utf8'); },
          orchestrationRelease(stage: string) {
            if (!['siblings', 'final', 'reset'].includes(stage)) throw new Error('Unknown fixture barrier');
            for (const name of stage === 'reset' ? ['siblings', 'final'] : [stage]) {
              const path = join(manifest.directory, `release-${name}`);
              if (stage === 'reset') { if (existsSync(path)) unlinkSync(path); }
              else writeFileSync(path, 'released', { mode: 0o600 });
            }
            return null;
          },
          async orchestrationEvidence(expected: { title?: string; status?: string; overlap?: boolean } | null) {
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
              const evidence = JSON.parse(readFileSync(join(manifest.directory, 'browser-evidence.json'), 'utf8'));
              const goal = evidence.goals.find((entry: { title: string }) => entry.title === expected?.title);
              if (!expected || (goal && (!expected.status || goal.status === expected.status) && (!expected.overlap || evidence.overlaps.includes(goal.id)))) return evidence;
              await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error('Timed out waiting for fixture evidence');
          },
          orchestrationGit(input: { branch: string; file: string }) {
            if (!/^companion(?:-goals)?\/[a-zA-Z0-9_/-]+$/.test(input.branch) || !['src/a.mjs', 'src/b.mjs', 'src/composition.mjs'].includes(input.file)) throw new Error('Invalid fixture evidence query');
            return execFileSync('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', 'show', `${input.branch}:${input.file}`], { cwd: input.branch.startsWith('companion-goals/') ? manifest.remote : manifest.repository, env: { NODE_ENV: 'test', PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', timeout: 10000 });
          },
        });
      }
      return config;
    },
  },
});
