import { launchProfiles, teamDefaults, teamConfiguration, boundedUsageSnapshot } from './launch-profiles.mjs';
import { suggestAssignment } from './orchestration/domain/teams.mjs';
import { AgentPreparationError } from './orchestration/agent-preparation-error.mjs';
import { projectCode } from './orchestration/domain/goal-presentation.mjs';
import { repositoryReadiness } from './repository-readiness.mjs';
import { assertDevChild } from './dev-repositories.mjs';
import { join } from 'node:path';
import { createRuntime } from './orchestration/create-runtime.mjs';
import { acquireRepositoryOwnership } from './orchestration/cutover.mjs';
import { probeGitCapabilities } from './orchestration/adapters/git-capabilities.mjs';
import { GitRemote } from './orchestration/adapters/git-remote.mjs';
import { GitHubCli } from './orchestration/adapters/github-cli.mjs';
import { GitHubPublication } from './orchestration/adapters/github.mjs';
import { transition } from './orchestration/domain/transitions.mjs';
import { requireValue } from './orchestration/domain/contracts.mjs';
import { resolveGoalCheck } from './goal-verification.mjs';
import { resolvePrepare as resolvePrepareCommand } from './prepare-command.mjs';

// Every provider instance and publication adapter is bound to a durable goal
// configuration, never to the mutable current Settings form.
export async function createSettingsRuntime({ settings, directory, token, createAgents, probeProvider, probeGit = probeGitCapabilities, own = acquireRepositoryOwnership, publisherFactory, prepareGoal, resolveProviderCommand, resolvePrepare = resolvePrepareCommand, usageSnapshot = async () => ({ available: false }) }) {
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
  // Prepare is infrastructure approved in Setup, so the live project setting
  // applies; this is what lets an already-held goal recover after a Setup fix.
  const prepareFor = (repositoryId, goalId) => {
    const config = configured(goalId);
    requireValue(config.project.id === repositoryId, 'Verification repository changed', 'FORBIDDEN');
    const current = settings.read();
    const live = current.settings.projects.find(entry => entry.id === repositoryId) ?? config.project;
    return resolvePrepare(live, { env: environment(), environmentId: `settings-${current.revision}`, policy: config.execution });
  };
  const capabilities = [{ role: 'planner', mode: 'interactive' }, ...['implementer', 'reviewer', 'integrator'].map(role => ({ role, mode: 'background' }))];
  let agentContext;
  async function agent(goalId, attempt) {
    const profileId = attempt?.assignment?.profileId ?? 'legacy', key = `${goalId}:${profileId}`;
    if (!agents.has(key)) {
      const pending = (async () => {
        const saved = configured(goalId), profile = saved.profiles?.find(entry => entry.id === profileId);
        requireValue(profileId === 'legacy' || profile, 'Saved attempt profile is unavailable', 'NOT_READY');
        const config = profile ? { ...saved, provider: profile.provider, command: profile.command, providerResolution: profile.providerResolution } : saved;
        await ownership(config.project);
        return createAgents({ config, directory: profile ? join(directory, 'native', goalId, 'profiles', profileId) : join(directory, 'native', goalId), context: agentContext });
      })();
      agents.set(key, pending);
      try { await pending; } catch (error) { agents.delete(key); throw error; }
    }
    return agents.get(key);
  }
  const savedAttempt = (goal, key) => goal.attempts.find(attempt => attempt.operationId === key || attempt.identity === key);
  const localAgents = {
    capabilities,
    async prepareHandoff(request) { const owner = await agent(request.goalId, request.attempt); requireValue(owner.prepareHandoff, 'Existing planning agent needs update-compatible recovery', 'HANDOFF_UNSUPPORTED'); return owner.prepareHandoff(request); },
    async launch(request) {
      let owner;
      try { owner = await agent(request.goalId, request.attempt); }
      catch { throw new AgentPreparationError(); }
      // Once delegated, every failure requires native worker observation.
      return owner.launch(request);
    },
    async resume(request) { return (await agent(request.goalId, request.attempt)).resume(request); },
    async observe(key) { const goal = find(key); return goal ? (await agent(goal.id, savedAttempt(goal, key))).observe(key) : { status: 'unknown', identity: null }; },
    async terminate(key) { const goal = find(key); requireValue(goal, 'Worker identity is unknown', 'OWNERSHIP_UNCERTAIN'); return (await agent(goal.id, savedAttempt(goal, key))).terminate(key); },
    async open(key) { const goal = find(key); requireValue(goal, 'Terminal identity is unknown', 'OWNERSHIP_UNCERTAIN'); return (await agent(goal.id, savedAttempt(goal, key))).open(key); },
    async close({ preserve = [] } = {}) {
      const results = await Promise.allSettled([...agents.entries()].map(async ([key, pending]) => (await pending).close({ preserve: preserve.filter(request => `${request.goalId}:${request.attempt.assignment?.profileId ?? 'legacy'}` === key) })));
      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Some native agents could not close');
    },
  };
  try {
    runtime = await createRuntime({ planReviewEnabled: () => settings.read().settings.automation.planReviews, suspension: () => suspensionReason, storage, repositories, token, logLevel: process.env.CMUX_COMPANION_LOG_LEVEL, limits: settings.read().settings.execution,
      createAgents: context => { agentContext = { ...context, describe: request => {
        const description = context.describe(request), checks = configured(request.goalId).project.checks;
        return { ...description, prompt: `${description.prompt}\nOptional repository verification defaults (discover and adapt checks for this goal): ${JSON.stringify(checks.map(check => ({ id: check.id, argv: [check.executable, ...check.args] })))}` };
      } }; return localAgents; },
      prepareGoal: async goal => {
        const saved = configured(goal.id), profile = saved.profiles?.find(entry => entry.id === goal.team?.assignments.find(assignment => assignment.role === 'planner').profileId);
        const config = profile ? { ...saved, provider: profile.provider, command: profile.command, providerResolution: profile.providerResolution } : saved, project = config.project;
        if (prepareGoal) return prepareGoal({ goal, config, repositories: runtime.repositories });
        requireValue(!config.providerResolution?.error, config.providerResolution?.error || 'Saved provider command could not be resolved', 'NOT_READY');
        const readiness = await probeProvider(config.provider, config.command, config.tools, config.providerResolution);
        requireValue(readiness.ready, `${readiness.reason || 'The saved planning provider is unavailable'}. Restore this goal's saved provider and retry; create a new goal to use changed provider settings.`, 'NOT_READY');
        await probeGit(); await ownership(project);
        requireValue(project.remote, 'Configure the GitHub destination and retry startup', 'NOT_READY');
        const remote = new GitRemote({ repositories: runtime.repositories, directory: join(storage.resources, 'goal-base', goal.id), destinations: new Map([[project.id, { url: project.remote, protocol: project.remote.startsWith('https:') ? 'https' : 'ssh', env: environment() }]]) });
        return remote.fetchBase(project.id, goal.baseBranch);
      },
      beforeCommand: async command => {
        if (command.type !== 'create_goal') return;
        if (runtime.store.get(command.goalId)) { const saved = configured(command.goalId); if (saved.teamConfiguration) command.payload.teamConfiguration = saved.teamConfiguration; if (command.payload.description !== undefined) command.payload.projectCode = projectCode(configured(command.goalId).project.name); return; }
        const before = settings.read(), project = before.settings.projects.find(entry => entry.id === command.payload.repositoryId && entry.enabled);
        requireValue(project, 'Choose an enabled project in Settings', 'NOT_READY');
        const readinessIssue = repositoryReadiness(project).reason;
        requireValue(!readinessIssue, readinessIssue || 'Repository setup is incomplete', 'NOT_READY');
        const root = before.settings.devRepos?.find(entry => entry.id === project.devRepoId);
        if (root) await assertDevChild(root.path, project.path);
        if (command.payload.baseSha !== undefined) {
          await probeGit(); await ownership(project);
        }
        if (command.payload.description !== undefined) command.payload.projectCode = projectCode(project.name);
        transition(null, command, { kind: 'user' });
        requireValue(settings.read().revision === before.revision, 'Settings changed; review the current configuration and retry', 'VERSION_CONFLICT');
        const profiles = launchProfiles(before.settings), readiness = {};
        const [usage] = await Promise.all([
          boundedUsageSnapshot(usageSnapshot),
          Promise.all(profiles.filter(profile => profile.enabled).map(async profile => {
            try {
              const result = await probeProvider(profile.provider, profile.command, before.settings.tools);
              if (result.resolution) profile.providerResolution = result.resolution;
              else if (result.ready && resolveProviderCommand) profile.providerResolution = await resolveProviderCommand(profile.provider, profile.command);
              readiness[profile.id] = result;
            } catch { readiness[profile.id] = { ready: false, reason: 'Saved command could not be resolved. Correct Setup for a new goal.' }; }
          })),
        ]);
        requireValue(settings.read().revision === before.revision, 'Settings changed; review the current configuration and retry', 'VERSION_CONFLICT');
        const configuration = teamConfiguration(profiles, teamDefaults(before.settings, profiles), usage, readiness);
        command.payload.teamConfiguration = configuration;
        const planner = profiles.find(profile => profile.id === suggestAssignment(configuration, 'planner', null).profileId);
        const snapshot = settings.snapshotGoal(command.goalId, project.id, undefined, { profiles, configuration, planner });
        command.payload.teamConfiguration = snapshot.teamConfiguration ?? configuration;
        requireValue(snapshot.project.id === project.id, 'Goal identity was reused with another project', 'IDEMPOTENCY_CONFLICT');
      },
      projectStatus: id => {
        const project = settings.read().settings.projects.find(entry => entry.id === id);
        const root = settings.read().settings.devRepos?.find(entry => entry.id === project?.devRepoId);
        const readiness = repositoryReadiness(project);
        return { name: project?.name, devRepoName: root?.name, github: project?.github, enabled: Boolean(project?.enabled), setupLabel: readiness.label, error: readiness.reason };
      },
      goalLimits: goalId => configured(goalId).execution,
      resolveCheck: (repositoryId, check, goalId) => {
        const config = configured(goalId);
        requireValue(config.project.id === repositoryId, 'Verification repository changed', 'FORBIDDEN');
        return resolveGoalCheck({ goal: runtime.store.get(goalId), repositoryId, check,
          env: environment(), environmentId: `settings-${config.revision}`, policy: config.execution });
      },
      resolvePrepare: prepareFor,
      // Every method the publication port defines is forwarded to the adapter
      // bound to that goal. A silently dropped method reads downstream as a
      // failed remote call, so an absent one names itself instead.
      createPublisher: () => Object.fromEntries(['observeMerge', 'publish', 'observe', 'reviewThreads', 'pushFix', 'replyAndResolve']
        .map(name => [name, (input, second) => {
          const adapter = publication(input.goalId);
          requireValue(typeof adapter[name] === 'function', `Publication capability ${name} is unavailable in this configuration`, 'UNSUPPORTED_CAPABILITY');
          return adapter[name](input, second);
        }])),
    });
    const close = runtime.close.bind(runtime);
    runtime.close = async () => { await close(); for (const pending of owners.values()) (await pending).close(); owners.clear(); };
    runtime.resolvePrepareForTest = prepareFor;
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
