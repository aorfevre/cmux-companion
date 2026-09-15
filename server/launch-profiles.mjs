import { providerCommand } from './local-settings.mjs';
import { TEAM_ROLES, parseTeamConfiguration } from './orchestration/domain/teams.mjs';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export function launchProfiles(settings) {
  const custom = settings.launchProfiles ?? [];
  if (!Array.isArray(custom) || custom.length > 48) throw new TypeError('Use at most 48 additional launch profiles');
  const profiles = ['claude', 'codex'].map(provider => ({ id: provider, label: provider === 'claude' ? 'Claude' : 'Codex', provider, command: settings.providers[provider], roles: [...TEAM_ROLES], enabled: true }));
  for (const profile of custom) {
    if (!profile || Object.keys(profile).some(key => !['id', 'label', 'provider', 'command', 'roles', 'enabled'].includes(key)) || !idPattern.test(profile.id) || profiles.some(entry => entry.id === profile.id)) throw new TypeError('Launch profile identities must be unique');
    if (typeof profile.label !== 'string' || !profile.label.trim() || profile.label.length > 160 || /[\r\n]/.test(profile.label)) throw new TypeError('Give the launch profile a short name');
    if (!['claude', 'codex'].includes(profile.provider) || typeof profile.enabled !== 'boolean' || !Array.isArray(profile.roles) || !profile.roles.length || new Set(profile.roles).size !== profile.roles.length || !profile.roles.every(role => TEAM_ROLES.includes(role))) throw new TypeError('Choose supported roles and a provider for the launch profile');
    providerCommand(profile.command, profile.provider); profiles.push(structuredClone(profile));
  }
  return profiles;
}
export function teamDefaults(settings, profiles = launchProfiles(settings)) {
  const defaults = settings.teamDefaults ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || Object.keys(defaults).some(role => !TEAM_ROLES.includes(role))) throw new TypeError('Invalid team default roles');
  return Object.fromEntries(TEAM_ROLES.map(role => {
    const id = defaults[role] ?? settings.provider;
    if (!profiles.some(profile => profile.id === id && profile.enabled && profile.roles.includes(role))) throw new TypeError(`Choose an enabled eligible default for ${role}`);
    return [role, id];
  }));
}
const FRESH_MS = 15 * 60 * 1000;
/** Quotas are a provider-pool signal, never a promise about the account selected by a saved command. */
export function profileCapacity(profile, usage, now = Date.now()) {
  const unknown = reason => ({ remainingPercent: null, source: 'CCS', checkedAt: typeof usage?.generatedAt === 'string' && Number.isFinite(Date.parse(usage.generatedAt)) ? usage.generatedAt : null, reason });
  const fresh = value => { const time = Date.parse(value); return Number.isFinite(time) && time <= now && now - time <= FRESH_MS; };
  if (!usage?.available || !fresh(usage.generatedAt)) return unknown('Capacity unknown: the CCS snapshot is unavailable or stale.');
  const accounts = usage.providers?.find(provider => provider.id === profile.provider)?.accounts?.filter(account => !account.paused) ?? [];
  const observed = accounts.map(account => {
    const windows = account.windows?.filter(window => window.category === 'usage') ?? [];
    return fresh(account.updatedAt) && ['ready', 'low', 'exhausted'].includes(account.status) && windows.length && windows.every(window => Number.isFinite(window.remainingPercent) && window.remainingPercent >= 0 && window.remainingPercent <= 100) ? Math.min(...windows.map(window => window.remainingPercent)) : null;
  });
  const known = observed.filter(value => value !== null);
  if (!known.length || Math.max(...known) === 0 && observed.some(value => value === null)) return unknown('Capacity unknown: no complete, fresh provider allowance is available.');
  const remainingPercent = Math.max(...known);
  return { remainingPercent, source: 'CCS provider pool', checkedAt: usage.generatedAt, reason: `CCS reports up to ${remainingPercent}% remaining among available ${profile.provider} accounts. This is a provider signal; the saved launch command controls account selection.` };
}
export function teamConfiguration(profiles, defaults, usage, readiness, now = Date.now()) {
  return parseTeamConfiguration({ capturedAt: new Date(now).toISOString(), defaults, profiles: profiles.filter(profile => profile.enabled).map(profile => ({
    id: profile.id, label: profile.label, provider: profile.provider, model: profile.command.model, roles: profile.roles,
    ready: Boolean(readiness[profile.id]?.ready), reason: readiness[profile.id]?.reason || (readiness[profile.id]?.ready ? 'Validated provider command' : 'Provider readiness is unknown'),
    capacity: profileCapacity(profile, usage, now),
  })) });
}

/** Quota availability must not hold goal creation indefinitely. */
export async function boundedUsageSnapshot(load, timeoutMs = 5000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(load).catch(() => ({ available: false })), new Promise(resolve => { timer = setTimeout(() => resolve({ available: false }), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
