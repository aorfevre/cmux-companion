import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSettings } from '../server/local-settings.mjs';
import { createSettingsRuntime } from '../server/settings-runtime.mjs';
import { buildApp } from '../server/app.mjs';
import { RepoCatalog } from '../server/repo-catalog.mjs';
import { createRepositoryFixture } from '../tests/helpers/orchestration/fixture.mjs';
import { FakeAgents } from '../tests/helpers/orchestration/fake-agents.mjs';

// Explicit fake providers only. This fixture never discovers installed tools,
// credentials, production state or configured repository roots.
export async function startSettingsDemo() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'companion-settings-dev-')));
  const repository = await createRepositoryFixture(), settings = new LocalSettings({ path: join(directory, 'settings.sqlite') });
  const token = randomBytes(32).toString('hex'), tokenFile = join(directory, 'pairing-token');
  let runtime;
  try {
    const probeProvider = async () => ({ ready: true });
    runtime = await createSettingsRuntime({ settings, directory, token, probeProvider,
      createAgents: () => Object.assign(new FakeAgents(), { close: async () => {} }),
    });
    const catalog = new RepoCatalog({ roots: [], projects: () => settings.read().settings.projects });
    await runtime.app.register(app => buildApp({ app, token, localSettings: settings, probeProvider, repoCatalog: catalog,
      cmux: { hostStatus: async () => ({}), workspaceList: async () => ({ workspaces: [] }), capabilities: async () => ({}) },
      onSettingsChange: async () => { catalog.invalidate(); await runtime.settingsChanged(); },
    }));
    const address = await runtime.listen({ port: 0 });
    const manifest = { directory, tokenFile, address, repository: repository.repository };
    const manifestFile = join(directory, 'connection.json');
    await writeFile(tokenFile, token, { mode: 0o600 }); await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    return { manifest, manifestFile, async close() { await runtime.close(); settings.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await runtime?.close(); settings.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
