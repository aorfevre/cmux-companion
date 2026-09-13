'use client';
export function AppNavigation({ active, onNavigate }: { active: 'sessions' | 'goals' | 'inbox' | 'settings'; onNavigate?: (view: 'sessions' | 'inbox') => void }) {
  return <nav className="app-navigation" aria-label="Main navigation">{([
    ['sessions', '/', 'Sessions', '⌂'], ['goals', '/orchestration', 'Goals', '▤'], ['inbox', '/?view=inbox', 'Inbox', '▣'], ['settings', '/settings', 'Settings', '⚙'],
  ] as const).map(([id, href, label, icon]) => <a key={id} href={href} aria-current={active === id ? 'page' : undefined} onClick={event => { if (onNavigate && (id === 'sessions' || id === 'inbox') && !event.metaKey && !event.ctrlKey) { event.preventDefault(); onNavigate(id); } }}><span aria-hidden="true">{icon}</span>{label}</a>)}</nav>;
}
