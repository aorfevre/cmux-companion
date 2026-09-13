import { join } from 'node:path';
import { createRuntime } from './orchestration/create-runtime.mjs';
import { acquireRepositoryOwnership } from './orchestration/cutover.mjs';
import { probeGitCapabilities } from './orchestration/adapters/git-capabilities.mjs';
import { GitRemote } from './orchestration/adapters/git-remote.mjs';
import { GitHubCli } from './orchestration/adapters/github-cli.mjs';
import { GitHubPublication } from './orchestration/adapters/github.mjs';
import { transition } from './orchestration/domain/transitions.mjs';
import { requireValue } from './orchestration/domain/contracts.mjs';
import { resolveExecutable } from './local-settings.mjs';

// Every provider instance and publication adapter is bound to a durable goal
// configuration, never to the mutable current Settings form.
export async function createSettingsRuntime({ settings, directory, token, createAgents, probeProvider, probeGit = probeGitCapabilities, own = acquireRepositoryOwnership, publisherFactory }) {
  const storage = { database: join(directory, 'core.sqlite'), artifacts: join(directory, 'artifacts'), resources: join(directory, 'resources') };
  const repositories = new Map(settings.read().settings.projects.map(project => [project.id, project.path]));
  const agents = new Map(), publications = new Map(), owners = new Map();
  let runtime, suspensionReason = null;
  const configured = goalId => {
    const value = settings.goalConfiguration(goalId);
    requireValue(value, 'Goal configuration is unavailable; import the existing installation before resuming', 'NOT_READY');
    return value;
  };
  const find = key => runtime.store.list().find(goal => goal.attempts.some(attempt => attempt.operationId === key || attempt.identity === key));
  async function ownership(project) {
    if (!owners.has(project.id)) {
      const pending = own(new Map([[project.id, project.path]]), storage.database);
      owners.set(project.id, pending);
      try { await pending; } catch (error) { owners.delete(project.id); throw error; }
    }
    (await owners.get(project.id)).assertOwned();
  }
  const environment = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK });
  function publication(goalId) {
    if (!publications.has(goalId)) {
      const config = configured(goalId), project = config.project;
      requireValue(project.remote && project.github, 'Configure a GitHub destination before creating this goal', 'NOT_READY');
      const options = { repositories: runtime.repositories, config, goalId, directory: join(storage.resources, 'publication', goalId) };
      if (publisherFactory) publications.set(goalId, publisherFactory(options));
      else {
        const destinations = new Map([[project.id, { url: project.remote, protocol: project.remote.startsWith('https:') ? 'https' : 'ssh', env: environment() }]]);
        const remote = new GitRemote({ repositories: runtime.repositories, directory: join(storage.resources, 'remote-stage', goalId), destinations });
        const github = new GitHubCli({ repositories: new Map([[project.id, project.github]]), cwd: storage.resources, env: environment() });
        publications.set(goalId, new GitHubPublication({ directory: options.directory, remote, github }));
      }
    }
    return publications.get(goalId);
  }
  const capabilities = [{ role: 'planner', mode: 'interactive' }, ...['implementer', 'reviewer', 'integrator'].map(role => ({ role, mode: 'background' }))];
  let agentContext;
  async function agent(goalId) {
    if (!agents.has(goalId)) {
      const pending = (async () => {
        const config = configured(goalId); await ownership(config.project);
        return createAgents({ config, directory: join(directory, 'native', goalId), context: agentContext });
      })();
      agents.set(goalId, pending);
      try { await pending; } catch (error) { agents.delete(goalId); throw error; }
    }
    return agents.get(goalId);
  }
  const localAgents = {
    capabilities,
    async launch(request) { return (await agent(request.goalId)).launch(request); },
    async resume(request) { return (await agent(request.goalId)).resume(request); },
    async observe(key) { const goal = find(key); return goal ? (await agent(goal.id)).observe(key) : { status: 'unknown', identity: null }; },
    async terminate(key) { const goal = find(key); requireValue(goal, 'Worker identity is unknown', 'OWNERSHIP_UNCERTAIN'); return (await agent(goal.id)).terminate(key); },
    async open(key) { const goal = find(key); requireValue(goal, 'Terminal identity is unknown', 'OWNERSHIP_UNCERTAIN'); return (await agent(goal.id)).open(key); },
    async close() {
      const results = await Promise.allSettled([...agents.values()].map(async pending => (await pending).close()));
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Some native agents could not close');
    },
  };
  try {
    runtime = await createRuntime({ suspension: () => suspensionReason, storage, repositories, token, logLevel: process.env.CMUX_COMPANION_LOG_LEVEL, limits: settings.read().settings.execution,
      createAgents: context => { agentContext = { ...context, describe: request => {
        const description = context.describe(request), checks = configured(request.goalId).project.checks;
        return { ...description, prompt: `${description.prompt}\nOperator-approved verification commands: ${JSON.stringify(checks.map(check => ({ id: check.id, argv: [check.executable, ...check.args] })))}` };
      } }; return localAgents; },
      beforeCommand: async command => {
        if (command.type !== 'create_goal' || runtime.store.get(command.goalId)) return;
        transition(null, command, { kind: 'user' });
        const before = settings.read(), project = before.settings.projects.find(entry => entry.id === command.payload.repositoryId && entry.enabled);
        requireValue(project, 'Choose an enabled project in Settings', 'NOT_READY');
        requireValue(project.github && project.remote && project.checks.length > 0, 'Configure a GitHub destination, remote and verification command for this project in Settings before starting a goal', 'NOT_READY');
        const readiness = await probeProvider(before.settings.provider, before.settings.providers[before.settings.provider], before.settings.tools);
        requireValue(readiness.ready, readiness.reason || 'Configure a supported provider in Settings', 'NOT_READY');
        await probeGit(); await ownership(project);
        requireValue(settings.read().revision === before.revision, 'Settings changed; review the current configuration and retry', 'VERSION_CONFLICT');
        const snapshot = settings.snapshotGoal(command.goalId, project.id);
        requireValue(snapshot.project.id === project.id, 'Goal identity was reused with another project', 'IDEMPOTENCY_CONFLICT');
      },
      projectStatus: id => {
        const project = settings.read().settings.projects.find(entry => entry.id === id);
        return { name: project?.name, enabled: Boolean(project?.enabled), error: project && (!project.github || !project.remote || !project.checks.length) ? 'Add a GitHub destination, remote and verification command in Settings to start a goal.' : null };
      },
      goalLimits: goalId => configured(goalId).execution,
      resolveCheck: (repositoryId, check, goalId) => {
        const config = configured(goalId);
        requireValue(config.project.id === repositoryId, 'Verification repository changed', 'FORBIDDEN');
        const allowed = config.project.checks.find(entry => entry.id === check.id && JSON.stringify([entry.executable, ...entry.args]) === JSON.stringify(check.argv));
        requireValue(allowed, 'Verification command is not approved for this goal', 'UNSUPPORTED_CAPABILITY');
        const bin = resolveExecutable(allowed.executable);
        requireValue(bin, 'Configured verification executable is unavailable', 'UNSUPPORTED_CAPABILITY');
        return { bin, argv: allowed.args, env: environment(), environmentId: `settings-${config.revision}`, policy: config.execution };
      },
      createPublisher: () => ({ publish: (input, options) => publication(input.goalId).publish(input, options), observe: input => publication(input.goalId).observe(input) }),
    });
    const close = runtime.close.bind(runtime);
    runtime.close = async () => { await close(); for (const pending of owners.values()) (await pending).close(); owners.clear(); };
    runtime.settingsChanged = async () => {
      const current = settings.read().settings;
      for (const project of current.projects) { repositories.set(project.id, project.path); runtime.service.repositoryIds.add(project.id); }
      runtime.service.limits = Object.freeze({ global: current.execution.global, perGoal: current.execution.perGoal, planners: current.execution.planners });
    };
    // Reacquire ownership before the scheduler can reconcile any recorded work.
    for (const goal of runtime.store.list()) {
      const config = settings.goalConfiguration(goal.id);
      if (config) {
        repositories.set(config.project.id, config.project.path);
        try { await ownership(config.project); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          suspensionReason = `Restore the saved project directory for ${config.project.name} and restart Companion to resume execution. History and Settings remain available.`;
        }
      }
    }
    return runtime;
  } catch (error) { if (runtime) await runtime.close(); else for (const pending of owners.values()) (await pending).close(); throw error; }
}
