import { randomUUID } from 'node:crypto';
import { scanDevRepo } from './dev-repositories.mjs';

// One owner per root; simultaneous page opens share discovery and persistence.
export function createDevRepoTracking({ settings, inspect, onChange, scan = scanDevRepo }) {
  const pending = new Map();
  async function reconcile(root) {
    const result = await scan(root, inspect);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = settings.read();
      if (!before.settings.devRepos.some(entry => entry.id === root.id && entry.path === root.path)) throw new Error('Dev repo changed. Refresh to retry.');
      const paths = new Set(before.settings.projects.map(project => project.path));
      const projects = [...before.settings.projects];
      for (const entry of result.repositories) {
        if (entry.error || paths.has(entry.path)) continue;
        if (projects.length >= 500) { result.partial = true; result.reason = 'Repository limit reached (500). Some repositories could not be tracked.'; break; }
        projects.push({ id: randomUUID(), name: entry.name, path: entry.path, github: entry.github, remote: entry.remote, enabled: true, checks: [], devRepoId: root.id });
        paths.add(entry.path);
      }
      if (projects.length === before.settings.projects.length) return result;
      try {
        const saved = await settings.update(before.revision, { ...before.settings, projects }, { inspect });
        await onChange(saved);
        return result;
      } catch (error) {
        if (error.statusCode !== 409 || attempt === 2) throw error;
      }
    }
  }
  function one(id) {
    if (pending.has(id)) return pending.get(id);
    const root = settings.read().settings.devRepos.find(entry => entry.id === id);
    if (!root) throw new TypeError('Choose a saved Dev repo');
    const task = reconcile(root).finally(() => pending.delete(id));
    pending.set(id, task);
    return task;
  }
  async function all(ids = settings.read().settings.devRepos.map(root => root.id)) {
    const scans = {};
    // Keep Git inspection concurrency bounded across roots as well as within one.
    for (const id of ids) {
      try { scans[id] = await one(id); }
      catch { scans[id] = { repositories: [], partial: true, reason: 'Directory could not be refreshed. Check its location and access, then retry.' }; }
    }
    return { ...settings.read(), scans };
  }
  return { one, all };
}
