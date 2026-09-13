import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runSupervisedProcess, observeSupervisedProcess } from '../../server/orchestration/adapters/supervised-process.mjs';
import { resolveExecutable } from '../../server/local-settings.mjs';

// Deterministic receipts prevent a restarted updater from launching a second npm
// tree while the first build's independent watchdog still owns its processes.
export function supervisedBuildRunner(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = realpathSync(directory);
  return async (file, argv, { cwd = root, env = {}, timeoutMs = 600000, log } = {}) => {
    const bin = resolveExecutable(file); if (!bin) throw new Error('Build executable unavailable');
    const identity = createHash('sha256').update(JSON.stringify({ bin, argv, cwd, env })).digest('hex');
    const evidence = join(root, identity);
    let outcome;
    if (existsSync(evidence)) {
      const deadline = Date.now() + timeoutMs + 20000;
      do {
        outcome = await observeSupervisedProcess(evidence);
        if (outcome) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
    } else {
      outcome = await runSupervisedProcess({ bin, argv, cwd, env: { ...process.env, ...env } }, {
        directory: evidence, policy: { ceilingMs: timeoutMs, idleMs: Math.min(timeoutMs, 120000), maxOutputBytes: 2097152, killGraceMs: 5000 }, onIdentity: () => {},
      });
    }
    if (!outcome || outcome.workerState !== 'stopped') throw Object.assign(new Error('Build process ownership is uncertain'), { code: 'OWNERSHIP_UNCERTAIN' });
    log?.(outcome.stdout); log?.(outcome.stderr);
    if (outcome.status !== 'succeeded') throw new Error('Release verification failed');
    return { code: 0, stdout: outcome.stdout, stderr: outcome.stderr };
  };
}
