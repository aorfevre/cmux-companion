import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from './create-runtime.mjs';

/** Disposable composition lifecycle shared by the CLI and browser fixture runner.
 * The configure callback supplies fake adapters explicitly; no production config
 * or credentials are discovered here. Cleanup waits for owned work to stop.
 * @param {{ port?: number; configure: (directory: string) => Promise<{
 * options: Omit<Parameters<typeof createRuntime>[0], 'storage' | 'token'>;
 * dispose: () => Promise<void>; metadata?: Record<string, unknown>;
 * }> }} options
 */
export async function createDevelopmentServer({ port = 0, configure }) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-orchestration-dev-'));
  let configured;
  /** @type {Awaited<ReturnType<typeof createRuntime>> | undefined} */ let runtime;
  try {
    configured = await configure(directory);
    const token = randomBytes(32).toString('hex'), tokenFile = join(directory, 'pairing-token');
    await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
    runtime = await createRuntime({ ...configured.options, token, storage: { database: join(directory, 'state.sqlite'), artifacts: join(directory, 'artifacts'), resources: join(directory, 'resources') } });
    const address = await runtime.listen({ port });
    const manifest = { ...configured.metadata, address, tokenFile, directory };
    const manifestFile = join(directory, 'connection.json');
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    const ownedRuntime = runtime, dispose = configured.dispose;
    let closed = false;
    /** @type {Promise<void> | null} */ let closing = null;
    return { runtime, manifest, manifestFile,
      close() {
        if (closed) return Promise.resolve();
        if (!closing) closing = (async () => {
          await ownedRuntime.close(); await dispose(); await rm(directory, { recursive: true, force: true }); closed = true;
        })().finally(() => { closing = null; });
        return closing;
      },
    };
  } catch (error) {
    // Preserve evidence/resources if adapter shutdown cannot establish safety.
    await runtime?.close(); await configured?.dispose(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
