'use client';
import { useState } from 'react';
import { request } from '../api-request';
import { ProviderCommand } from './provider-command';
import type { Settings, LaunchProfile, Provider } from './settings-panel';
const roles = { planner: 'Planner & designer', implementer: 'Implementation', reviewer: 'Independent review', integrator: 'Integration repair' } as const;
export function LaunchProfiles({ draft, change, busy }: { draft: Settings; change(value: Settings): void; busy: boolean }) {
  const [validation, setValidation] = useState<Record<string, string>>({});
  const profiles = draft.launchProfiles ?? [];
  const choices = [...(['claude', 'codex'] as const).map(provider => ({ id: provider, label: provider === 'claude' ? 'Claude' : 'Codex', enabled: true, roles: Object.keys(roles) })), ...profiles];
  const update = (id: string, value: Partial<LaunchProfile>) => {
    const updated = profiles.map(profile => profile.id === id ? { ...profile, ...value } : profile);
    const profile = updated.find(entry => entry.id === id)!;
    const teamDefaults = Object.fromEntries(Object.entries(draft.teamDefaults ?? {}).filter(([role, selected]) => selected !== id || (profile.enabled && profile.roles.includes(role as keyof typeof roles))));
    change({ ...draft, launchProfiles: updated, teamDefaults });
    setValidation(current => ({ ...current, [id]: '' }));
  };
  return <section><h3>Team defaults</h3><p>Preferences break ties between eligible profiles. Fresh provider capacity may suggest another profile; review or override the proposed team with the plan.</p><fieldset disabled={busy}>
    {(Object.keys(roles) as (keyof typeof roles)[]).map(role => <label key={role}>Preferred {roles[role]}<select value={draft.teamDefaults?.[role] ?? draft.provider} onChange={event => change({ ...draft, teamDefaults: { ...draft.teamDefaults, [role]: event.target.value } })}>{choices.filter(profile => profile.enabled && profile.roles.includes(role)).map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>)}
  </fieldset><h3>Additional launch profiles</h3><p>Use a named CCS profile, supported terminal command or direct CLI with its own model and eligible roles. Saved goals retain their original commands.</p>
    {profiles.map(profile => <fieldset key={profile.id} disabled={busy} aria-label={`Launch profile ${profile.label}`}><legend>{profile.label}</legend>
      <label>Profile name<input value={profile.label} maxLength={160} onChange={event => update(profile.id, { label: event.target.value })} /></label>
      <label>Provider family<select value={profile.provider} onChange={event => { const provider = event.target.value as Provider; update(profile.id, { provider, command: structuredClone(draft.providers[provider]) }); }}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
      <label><input type="checkbox" checked={profile.enabled} onChange={event => update(profile.id, { enabled: event.target.checked })} />Enabled for new goals</label>
      <div role="group" aria-label="Eligible roles">{(Object.keys(roles) as (keyof typeof roles)[]).map(role => <label key={role}><input type="checkbox" checked={profile.roles.includes(role)} onChange={event => update(profile.id, { roles: event.target.checked ? [...profile.roles, role] : profile.roles.filter(entry => entry !== role) })} />{roles[role]}</label>)}</div>
      <ProviderCommand key={`${profile.id}:${profile.provider}`} provider={profile.provider} command={profile.command} change={command => update(profile.id, { command: { ...profile.command, ...command } })} validation={validation[profile.id]} validate={() => {
        setValidation(current => ({ ...current, [profile.id]: 'Checking the saved command…' }));
        void request<{ ready: boolean; reason?: string }>('/api/settings/providers/validate', { method: 'POST', body: JSON.stringify({ provider: profile.provider, command: profile.command }) }).then(result => setValidation(current => ({ ...current, [profile.id]: result.ready ? 'Provider command is ready. Model availability is checked when it launches.' : result.reason || 'Provider is unavailable.' }))).catch(cause => setValidation(current => ({ ...current, [profile.id]: cause instanceof Error ? cause.message : 'Validation failed' })));
      }} />
      <button type="button" onClick={() => change({ ...draft, launchProfiles: profiles.filter(entry => entry.id !== profile.id), teamDefaults: Object.fromEntries(Object.entries(draft.teamDefaults ?? {}).filter(([, id]) => id !== profile.id)) })}>Remove {profile.label}</button>
    </fieldset>)}
    <button type="button" disabled={busy || profiles.length >= 48} onClick={() => change({ ...draft, launchProfiles: [...profiles, { id: crypto.randomUUID(), label: 'New profile', provider: draft.provider, command: structuredClone(draft.providers[draft.provider]), roles: ['implementer'], enabled: true }] })}>Add launch profile</button>
  </section>;
}
