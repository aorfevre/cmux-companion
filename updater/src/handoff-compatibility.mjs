import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateManifest } from './manifest.mjs';

// This marker lives in a launcher already digest-bound by pre-handoff builders.
// Separate capability files would not be authenticated in the first rollout's
// old-builder manifest. Both the candidate and rollback source must support it.
export async function assertHandoffCompatibility(target, previous, previousSha, candidate, candidateSha) {
  for (const [root, sha] of [[previous, previousSha], [candidate, candidateSha]]) {
    await validateManifest(target, root, sha);
    const source = await readFile(join(root, 'updater/scripts/launch-companion.mjs'), 'utf8');
    if (!/^\/\/ companion-native-handoff: 1$/m.test(source)) throw Object.assign(new Error('Release does not support the active planning agent handoff'), { code: 'HANDOFF_UNSUPPORTED' });
  }
}
