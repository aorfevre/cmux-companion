"use client";
import type { Action, Goal } from './goal-board';
const roleName: Record<string, string> = { planner: 'Planner & designer', implementer: 'Implementation', reviewer: 'Independent review', integrator: 'Integration repair' };
export function GoalTeam({ goal, disabled, act }: { goal: Goal; disabled: boolean; act(goal: Goal, action: Action): Promise<boolean> }) {
  if (!goal.team || !goal.teamConfiguration) return <section className="orch-card"><h3>Team configuration unavailable</h3><p>This saved goal uses its original configured agent.</p></section>;
  const config = goal.teamConfiguration;
  return <section className="orch-card"><h3>{goal.team.approved ? 'Approved team' : 'Proposed team'}</h3><p>Approved together with the design and plan. Overrides apply to future attempts; active sessions keep their saved assignment.</p><p className="project-context">Configuration and allocation snapshot: {new Date(config.capturedAt).toLocaleString()}.</p>
    <div className="mission-team">{config.profiles.map(profile => <article className="mission-wave-task" key={profile.id}><strong>{profile.label} · {profile.model}</strong><small>{profile.ready ? 'Provider command ready' : profile.reason}</small>
      <p className="project-context">{profile.capacity.source} · Provider capacity signal: {profile.capacity.fresh && profile.capacity.remainingPercent !== null ? `${profile.capacity.remainingPercent}% remaining` : 'Unknown'}{!profile.capacity.fresh ? ' (snapshot unavailable or stale)' : ''}.</p>
      <details><summary>Capacity evidence</summary><p>{profile.capacity.reason}</p>{profile.capacity.checkedAt && <p>Checked {new Date(profile.capacity.checkedAt).toLocaleString()}</p>}</details>
    </article>)}</div>
    <div className="mission-team-assignments" aria-label="Team assignments">{goal.team.assignments.map(assignment => {
      const options = goal.teamOptions.find(entry => entry.key === assignment.key)?.choices ?? [], editable = options.some(option => !option.blocked);
      const name = `${roleName[assignment.role]}${assignment.taskId ? ` ${assignment.taskId}` : ''}`;
      return <article className="mission-team-row" key={assignment.key} aria-label={name}><strong>{roleName[assignment.role]}{assignment.taskId ? ` · ${assignment.taskId}` : ''}</strong>
        <label><span className="sr-only">Profile for {name}</span><select value={assignment.profileId ?? ''} disabled={disabled || !editable} onChange={event => { void act(goal, { type: 'override_assignment', label: 'Apply profile override', payload: { key: assignment.key, profileId: event.target.value } }); }}>
          {!assignment.profileId && <option value="">Choose an eligible profile</option>}{options.map(option => { const candidate = config.profiles.find(entry => entry.id === option.profileId)!; return <option key={option.profileId} value={option.profileId} disabled={Boolean(option.blocked)}>{candidate.label} · {candidate.model}{option.blocked ? ' · unavailable' : ''}</option>; })}
        </select></label><div><details><summary>{assignment.manual ? 'Manual override' : 'Suggested'} · Why</summary><p>{assignment.reason}</p></details>{!editable && <small>{options[0]?.blocked || 'No eligible profile is available.'}</small>}</div>
      </article>;
    })}</div>
    {goal.team.changes.length > 0 && <details><summary>Assignment changes ({goal.team.changes.length})</summary><ul>{goal.team.changes.map(change => <li key={change.commandId}>{change.key}: {change.from ?? 'Unassigned'} → {change.to}</li>)}</ul></details>}
  </section>;
}
