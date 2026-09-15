"use client";
import type { Goal } from './goal-board';
export function WaveBoard({ goal }: { goal: Goal }) {
  if (!goal.tasks.length) return <section className="orch-card"><h3>Waves are being planned</h3><p>The combined planner and designer will propose independent tasks and checks for each wave.</p></section>;
  const waves = goal.waves?.length ? goal.waves : [{ id: 'legacy', title: 'Tasks', taskIds: goal.tasks.map(task => task.id), checkIds: [], number: 1, current: true, checkedHead: null }];
  return <section aria-label="Execution waves" className="mission-waves">{waves.map(wave => <section className="orch-card mission-wave" key={wave.id} aria-label={wave.title}>
    <header><p className="orch-eyebrow">{wave.id === 'legacy' ? 'Tasks · dependency order' : `Wave ${wave.number} of ${waves.length}`} · {wave.current ? goal.hold ? 'On hold' : 'Current' : wave.checkedHead ? 'Verified' : 'Waiting'}</p><h3>{wave.title}</h3></header>
    {wave.checkIds.length > 0 && <p className="project-context">Barrier checks: {wave.checkIds.join(', ')}{wave.current ? ' · Next wave waits for the verified integrated output.' : ''}</p>}
    {wave.checkedHead && <p>Checked integrated head <code>{wave.checkedHead.slice(0, 12)}</code>{wave.current ? ' · Reverification required for the updated head.' : ''}</p>}
    <div className="mission-wave-tasks">{goal.tasks.filter(task => wave.taskIds.includes(task.id)).map(task => <article className="mission-wave-task" key={task.id} data-task={task.id}>
      <strong>{task.id} · {task.title}</strong><span className="orch-state">{task.status.replaceAll('_', ' ')}</span>
      <p>{task.dependsOn.length ? `Depends on ${task.dependsOn.join(', ')}` : 'Independent task'}</p>
      <small>{goal.attempts.filter(attempt => attempt.current && attempt.taskId === task.id).map(attempt => `${attempt.role}: ${attempt.status}`).join(' · ') || 'Agent not assigned yet'}</small>
      {['failed', 'repair_required'].includes(task.status) && <p className="orch-attention">Needs attention · {task.status.replaceAll('_', ' ')}</p>}
      {!wave.current && !wave.checkedHead && <p>Waiting for the prior wave barrier</p>}
    </article>)}</div>
  </section>)}</section>;
}
