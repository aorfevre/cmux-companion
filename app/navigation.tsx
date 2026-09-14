'use client';
export function AppNavigation({ active }: { active: 'sessions' | 'goals' | 'inbox' | 'settings'; onNavigate?: (view: 'sessions' | 'inbox') => void }) {
  return <nav className="app-navigation" aria-label="Main navigation">{([
    ['goals', '/orchestration', 'Goals', '▤'], ['settings', '/settings', 'Settings', '⚙'],
  ] as const).map(([id, href, label, icon]) => <a key={id} href={href} aria-current={(active === 'sessions' ? 'goals' : active) === id ? 'page' : undefined}><span aria-hidden="true">{icon}</span>{label}</a>)}</nav>;
}
