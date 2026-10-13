'use client';
export function AppNavigation({ active }: { active: 'usage' | 'sessions' | 'goals' | 'settings' }) {
  return <nav className="app-navigation" aria-label="Main navigation">{([
    ['usage', '/', 'Account usage', '◴'], ['goals', '/orchestration', 'Goals', '▤'],
    ['sessions', '/?view=sessions', 'Sessions', '▣'], ['settings', '/settings', 'Setup', '⚙'],
  ] as const).map(([id, href, label, icon]) => <a key={id} href={href} aria-current={active === id ? 'page' : undefined}><span aria-hidden="true">{icon}</span>{label}</a>)}</nav>;
}
