import assert from 'node:assert/strict';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
if (process.env.CI) throw new Error('The Cypress suite is intentionally local-only and refuses to run in CI.');
const settings = process.argv.includes('--settings');
const open = process.argv.includes('--open'), orchestration = process.argv.includes('--orchestration'), spa = process.argv.includes('--spa-experiment');
const index = process.argv.indexOf('--spec'), spec = index < 0 ? null : process.argv[index + 1];
if (index >= 0 && !spec) throw new Error('--spec needs a spec path.');
const host = 'localhost', port = Number(process.env.CMUX_COMPANION_CYPRESS_PORT) || 3221, baseUrl = `http://${host}:${port}`;
await new Promise((resolve, reject) => {
  const probe = createServer(); probe.once('error', () => reject(new Error(`Local Cypress port ${port} is already in use.`)));
  probe.listen(port, host, () => probe.close(resolve));
});
let demo, frontend, cypress, stopping = false;
const signal = () => { stopping = true; for (const child of [cypress, frontend]) if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); };
process.once('SIGINT', signal); process.once('SIGTERM', signal);
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 10000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
try {
  if (settings) { const { startSettingsDemo } = await import('./run-settings-dev.mjs'); demo = await startSettingsDemo(); }
  if (orchestration) {
    const { startOrchestrationDemo } = await import('./run-orchestration-dev.mjs');
    demo = await startOrchestrationDemo({ browserHarness: true, readOnly: process.argv.includes('--read-only') });
  }
  const environment = { ...process.env, CMUX_COMPANION_LOCAL_E2E: '1', CMUX_COMPANION_CYPRESS_BASE_URL: baseUrl,
    ...(demo ? { CMUX_COMPANION_API: demo.manifest.address, ...(settings ? { CMUX_SETTINGS_CYPRESS_MANIFEST: demo.manifestFile } : { CMUX_ORCHESTRATION_CYPRESS_MANIFEST: demo.manifestFile }), CMUX_ORCHESTRATION_CYPRESS_READ_ONLY: process.argv.includes('--read-only') ? '1' : '0' } : {}) };
  frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...(spa ? ['preview', '--config', 'experiments/local-spa/vite.config.ts'] : []), '--host', host, '--port', String(port), '--strictPort'], { env: environment, stdio: 'inherit' });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
    if (frontend.exitCode !== null || frontend.signalCode !== null) throw new Error('The local frontend stopped before Cypress could connect.');
    try { if ((await fetch(orchestration ? `${baseUrl}/orchestration` : baseUrl, { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch { /* Listener is starting. */ }
    await delay(500);
  }
  if (stopping) throw new Error('Local Cypress run cancelled.');
  if (!ready) throw new Error('The local frontend did not become ready.');
  const args = ['node_modules/cypress/bin/cypress', open ? 'open' : 'run', '--config-file', 'cypress.config.ts'];
  if (process.env.CMUX_COMPANION_CYPRESS_BROWSER) args.push('--browser', process.env.CMUX_COMPANION_CYPRESS_BROWSER);
  if (spec || orchestration || settings) args.push('--spec', spec || (settings ? 'cypress/e2e/settings-onboarding.cy.ts' : 'cypress/e2e/orchestration-core.cy.ts'));
  cypress = spawn(process.execPath, args, { env: environment, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { cypress.once('error', reject); cypress.once('exit', code => resolve(code ?? 1)); });
} finally {
  try {
    await stop(cypress); await stop(frontend);
    if (demo && !settings) {
      await mkdir('cypress/results', { recursive: true });
      await copyFile(join(demo.manifest.directory, 'browser-evidence.json'), 'cypress/results/orchestration-evidence.json');
      const { fixtureGit } = await import('../tests/helpers/orchestration/fixture.mjs');
      const evidence = JSON.parse(await readFile('cypress/results/orchestration-evidence.json', 'utf8'));
      const diffs = [];
      for (const goal of evidence.goals) {
        assert.match(goal.baseSha, /^[a-f0-9]{40}$/); assert.match(goal.integrationHead, /^[a-f0-9]{40}$/);
        diffs.push({ goalId: goal.id, status: goal.status, diff: await fixtureGit(demo.manifest.repository, ['diff', '--no-ext-diff', '--no-textconv', goal.baseSha, goal.integrationHead, '--', 'src/a.mjs', 'src/b.mjs', 'src/composition.mjs']) });
      }
      await writeFile('cypress/results/orchestration-diffs.json', JSON.stringify(diffs, null, 2), { mode: 0o600 });
    }
  } finally { await demo?.close(); }
  process.off('SIGINT', signal); process.off('SIGTERM', signal);
}
