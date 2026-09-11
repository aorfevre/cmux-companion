import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { GitRepository } from '../../../server/orchestration/adapters/git.mjs';
import { GitRemote } from '../../../server/orchestration/adapters/git-remote.mjs';
import { GitHubPublication } from '../../../server/orchestration/adapters/github.mjs';
import { ArtifactStore } from '../../../server/orchestration/storage/artifacts.mjs';
import { FakeGitHub } from './fake-github.mjs';
const [directory, crashAt] = process.argv.slice(2);
const { repository, remote: remotePath, input } = JSON.parse(readFileSync(join(directory, 'publication-input.json'), 'utf8'));
function crash(point) { if (point === crashAt) { writeFileSync(join(directory, 'checkpoint'), point); process.kill(process.pid, 'SIGKILL'); } }
const repositories = new GitRepository({ repositories: new Map([['repo', repository]]), directory: join(directory, 'resources'), artifacts: new ArtifactStore({ directory: join(directory, 'artifacts') }) });
const remote = new GitRemote({ repositories, directory: join(directory, 'remote-stage'), destinations: new Map([['repo', { url: realpathSync(remotePath), protocol: 'file', env: { PATH: process.env.PATH } }]]) });
const inventory = join(directory, 'github-external.json');
const github = new FakeGitHub({ remote });
if (existsSync(inventory)) Object.assign(github, JSON.parse(readFileSync(inventory, 'utf8')));
const create = github.create.bind(github);
github.create = async request => {
  await create(request);
  writeFileSync(inventory, JSON.stringify({ pulls: github.pulls, creates: github.creates }));
  crash('pr_success');
};
const push = remote.push.bind(remote);
remote.push = async request => { await push(request); crash('push_success'); };
const publisher = new GitHubPublication({ directory: join(directory, 'publications'), remote, github, failpoint: crash });
const result = await publisher.publish(input);
process.stdout.write(JSON.stringify({ result, creates: github.creates.length, head: await remote.head('repo', input.branch) }));
