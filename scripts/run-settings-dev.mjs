import { browseFolders } from '../server/folder-browser.mjs';
import { UpdateControl } from '../updater/src/control.mjs';
import { updateCycle } from '../updater/src/transaction.mjs';
import { registerUpdateRoutes } from '../server/update-routes.mjs';
import { installUpdateMaintenance } from '../server/update-maintenance.mjs';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm, mkdir, cp } from 'node:fs/promises';
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
  let runtime, updateControl, updateTimer, updatePending = Promise.resolve();
  try {
    await mkdir(join(directory, 'karven')); await mkdir(join(directory, 'rekord'));
    await cp(repository.repository, join(directory, 'karven', 'example'), { recursive: true });
    await cp(repository.repository, join(directory, 'rekord', 'example'), { recursive: true });
    const probeProvider = async () => ({ ready: true });
    runtime = await createSettingsRuntime({ settings, directory, token, probeProvider,
      createAgents: () => Object.assign(new FakeAgents(), { close: async () => {} }),
    });
    const catalog = new RepoCatalog({ roots: [], projects: () => { const current = settings.read().settings; return current.projects.map(project => ({ ...project, devRepoName: current.devRepos?.find(root => root.id === project.devRepoId)?.name, devRepoPath: current.devRepos?.find(root => root.id === project.devRepoId)?.path })); } });
    await runtime.app.register(app => buildApp({ app, token, localSettings: settings, probeProvider, browseSettingsFolders: (input, options) => browseFolders(input, { ...options, home: directory, name: 'Disposable Mac' }), repoCatalog: catalog,
      cmux: { hostStatus: async () => ({}), workspaceList: async () => ({ workspaces: [] }), capabilities: async () => ({}) },
      onSettingsChange: async () => { catalog.invalidate(); await runtime.settingsChanged(); },
    }));
    updateControl = new UpdateControl(join(directory, 'updates.sqlite'));
    const cmux = { workspaceList: async () => ({ workspaces: [] }) };
    const maintenance = installUpdateMaintenance({ runtime, control: updateControl, cmux });
    await runtime.app.register(async app => registerUpdateRoutes(app, { control: updateControl, token, maintenance }));
    const sha = 'a'.repeat(40), base = 'b'.repeat(40), evidence = { activations: [], checks: 0 };
    const adapter = {
      prepare: async () => {}, verifyFence: async () => {}, backup: async () => ({ previousSha: base, files: [] }),
      activate: async sha => { evidence.activations.push(sha); }, restart: async () => {}, health: async () => {}, accept: async () => {}, stop: async () => {}, restore: async () => {},
    };
    const cycle = async () => {
      await updateCycle({ control: updateControl, deployedSha: updateControl.status().deployedSha || base,
        discover: async deployedSha => { evidence.checks++; return { candidate: deployedSha === sha ? null : { sha, changesUrl: `https://github.com/example/disposable/compare/${base}...${sha}` }, deployedSha, observedSha: sha }; },
        revalidate: async () => {}, maintenance: async id => existsSync(join(directory, 'updates-busy')) ? { ready: false } : maintenance.acquire(id), adapter });
      await writeFile(join(directory, 'updates-evidence.json'), JSON.stringify(evidence), { mode: 0o600 });
    };
    await cycle();
    updateTimer = setInterval(() => { updatePending = updatePending.then(cycle); }, 100);
    const address = await runtime.listen({ port: 0 });
    const manifest = { directory, tokenFile, address, repository: repository.repository, devRepos: { karven: join(directory, 'karven'), rekord: join(directory, 'rekord') } };
    const manifestFile = join(directory, 'connection.json');
    await writeFile(tokenFile, token, { mode: 0o600 }); await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    return { manifest, manifestFile, async close() { clearInterval(updateTimer); await updatePending; await runtime.close(); updateControl.close(); settings.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { clearInterval(updateTimer); await updatePending; await runtime?.close(); updateControl?.close(); settings.close(); await repository.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
