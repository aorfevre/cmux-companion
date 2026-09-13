import { inspectProject, providerCommand, resolveExecutable } from './local-settings.mjs';

// Registered inside the monitoring scope, after its pairing/origin hooks.
export function registerSettingsRoutes(app, { settings, onChange = async () => {}, inspect = inspectProject, probeProvider = async () => ({ ready: false, reason: 'Native capability validation is required before starting goals' }) }) {
  const status = () => settings.read();
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
    const result = await settings.update(body.expectedRevision, body.settings, { inspect });
    await onChange(result);
    return result;
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
