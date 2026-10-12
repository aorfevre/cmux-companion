"use client";
import { useCallback, useEffect, useState } from 'react';
import { request } from '../api-request';
import type { SupervisorChoices } from '../../server/orchestration/types';

export function SupervisorPicker({ selected, onSelect, onReady, disabled }: { selected: string; onSelect: (id: string) => void; onReady: (ready: boolean) => void; disabled: boolean }) {
  const [choices, setChoices] = useState<SupervisorChoices | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0);
  const chooseDefault = useCallback((value: SupervisorChoices | null) => {
    if (!selected && value?.recommendedId) onSelect(value.recommendedId);
  }, [selected, onSelect]);
  useEffect(() => {
    let active = true;
    void request<SupervisorChoices | null>(`/api/orchestration/supervisors${refresh ? '?refresh=1' : ''}`).then(value => {
      if (active) { setChoices(value); if (!value) setError('Supervisor choices are unavailable. Check your goal setup.'); }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not check supervisor readiness.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  useEffect(() => { chooseDefault(choices); }, [chooseDefault, choices]);
  const profile = choices?.profiles.find(entry => entry.id === selected);
  useEffect(() => { onReady(Boolean(profile?.ready && !loading && !error)); }, [profile, loading, error, onReady]);
  return <section aria-label="Supervisor selection">
    <label>Supervisor<select value={selected} onChange={event => onSelect(event.target.value)} disabled={disabled || loading || !choices}>
      <option value="">Choose a CCS supervisor</option>
      {choices?.profiles.map(entry => <option key={entry.id} value={entry.id} disabled={!entry.ready}>{entry.label} · {entry.model}{entry.ready ? '' : ' · unavailable'}</option>)}
    </select></label>
    {loading && <p role="status">Checking configured CCS launchers…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !error && profile && <p>{profile.reason} {profile.capacity.reason}</p>}
    {!loading && choices?.profiles.some(entry => !entry.ready) && <details><summary>Unavailable supervisors</summary><ul>{choices.profiles.filter(entry => !entry.ready).map(entry => <li key={entry.id}>{entry.label}: {entry.reason}</li>)}</ul></details>}
    <button type="button" disabled={disabled || loading} onClick={() => { setLoading(true); setError(''); onReady(false); setRefresh(value => value + 1); }}>Check supervisor readiness</button>
  </section>;
}
