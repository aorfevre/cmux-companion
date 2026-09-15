import type { ReactNode } from 'react';
import { AppNavigation } from './navigation';
export function MissionShell({ active, children, className = '' }: { active: 'goals' | 'needs' | 'sessions' | 'settings'; children: ReactNode; className?: string }) {
  return <main className={`mission-control ${className}`}><aside className="mission-sidebar"><a className="mission-brand" href="/orchestration">⌘ cmux<span>Companion</span></a><AppNavigation active={active} /><p className="mission-sidebar-note">Your Mac · private workspace</p></aside><div className="mission-content">{children}</div></main>;
}
