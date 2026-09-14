/** Repository setup is independent of provider readiness. This pure description
 * is shared by Settings and the Goals API; it never inspects or executes Git.
 * @param {{enabled:boolean,github:string|null,remote:string|null,checks:unknown[]}|undefined} project */
export function repositoryReadiness(project) {
  if (!project?.enabled) return { label: 'Disabled', reason: 'This repository is disabled. Enable it in Settings to start new work.' };
  if (!project.github || !project.remote) return { label: 'Check GitHub remote', reason: 'The GitHub repository could not be determined. Check this repository’s Git remote in Settings.' };
  return { label: 'Repository ready', reason: null };
}
