import { createDevRepoTracking } from './dev-repo-tracking.mjs';
import { browseFolders } from './folder-browser.mjs';
import { inspectDevRepo } from './dev-repositories.mjs';
import { inspectProject, providerCommand, resolveExecutable } from './local-settings.mjs';

// Registered inside the monitoring scope, after its pairing/origin hooks.
export function registerSettingsRoutes(app, { settings, onChange = async () => {}, browse = browseFolders, inspect = inspectProject, probeProvider = async () => ({ ready: false, reason: 'Native capability validation is required before starting goals' }) }) {
  const tracking = createDevRepoTracking({ settings, inspect, onChange });
  const finishSave = async (result, previous) => {
    await onChange(result);
    const added = result.settings.devRepos.filter(root => !previous.settings.devRepos.some(entry => entry.id === root.id));
    return added.length ? tracking.all(added.map(root => root.id)) : result;
  };
  const status = () => settings.read();
  app.get('/api/settings/favorites', async () => settings.favorites());
  app.patch('/api/settings/projects/:id/favorite', { bodyLimit: 1024 }, async request => {
    const body = request.body;
    if (!body || Object.keys(body).some(key => !['expectedRevision', 'favorite'].includes(key))) throw new TypeError('Expected favorite and revision');
    return settings.setFavorite(body.expectedRevision, request.params.id, body.favorite);
  });
  app.get('/api/settings/local', async () => status());
  app.put('/api/settings/local', { bodyLimit: 256 * 1024 }, async request => {
    const body = request.body;
    if (!body || Object.keys(body).some(key => !['expectedRevision', 'settings'].includes(key))) throw new TypeError('Expected settings and revision');
    if (body.settings?.onboarding?.completed && !settings.read().settings.onboarding.completed) {
      if (!body.settings.projects?.some(project => project.enabled && project.github && project.remote && project.checks?.length)) throw new TypeError('Add an enabled project with a GitHub destination, remote and verification command before completing setup');
      const provider = body.settings.provider;
      providerCommand(body.settings.providers?.[provider], provider);
      const readiness = await probeProvider(provider, body.settings.providers[provider], body.settings.tools);
      if (!readiness.ready) throw new TypeError(readiness.reason || 'Configure a supported provider before completing setup');
    }
    const previous = settings.read();
    const result = await settings.update(body.expectedRevision, body.settings, { inspect });
    return finishSave(result, previous);
  });
  app.patch('/api/settings/local', { bodyLimit: 256 * 1024 }, async request => {
    const body = request.body;
    if (!body || Object.keys(body).some(key => !['expectedRevision', 'changes'].includes(key)) || !body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes)) throw new TypeError('Expected edited fields and revision');
    const before = settings.read();
    settings.assertRevision(body.expectedRevision, before.revision);
    if (Object.keys(body.changes).some(key => !['devRepos', 'projects', 'providers', 'provider', 'tools', 'execution', 'previews'].includes(key))) throw new TypeError('Unknown editable settings field');
    const result = await settings.update(body.expectedRevision, { ...before.settings, ...body.changes }, { inspect });
    return finishSave(result, before);
  });
  app.post('/api/settings/folders', { bodyLimit: 8192 }, async request => browse(request.body, { roots: settings.read().settings.devRepos }));
  app.post('/api/settings/dev-repos/inspect', async request => {
    if (!request.body || Object.keys(request.body).some(key => key !== 'path')) throw new TypeError('Expected a Dev repo directory');
    return inspectDevRepo(request.body.path);
  });
  app.post('/api/settings/dev-repos/reconcile', async () => tracking.all());
  app.post('/api/settings/dev-repos/:id/scan', async request => {
    const root = settings.read().settings.devRepos.find(entry => entry.id === request.params.id);
    if (!root) throw new TypeError('Choose a saved Dev repo');
    const result = await tracking.one(root.id);
    return { ...result, snapshot: settings.read() };
  });
  app.post('/api/settings/projects/inspect', async request => {
    if (!request.body || Object.keys(request.body).some(key => key !== 'path')) throw new TypeError('Expected a project directory');
    return inspect(request.body.path);
  });
  app.post('/api/settings/providers/validate', async request => {
    const body = request.body;
    if (!body || !['claude', 'codex'].includes(body.provider) || Object.keys(body).some(key => !['provider', 'command'].includes(key))) throw new TypeError('Choose Claude or Codex');
    const command = providerCommand(body.command, body.provider);
    const executable = resolveExecutable(command.executable);
    if (!executable) return { ready: false, reason: 'Executable not found on this Mac. Install the tool or enter its absolute path.' };
    return probeProvider(body.provider, command, settings.read().settings.tools);
  });
}
