import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { contract } from './domain-fixture.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../../fixtures/orchestration-repo/', import.meta.url));
// Git receives no inherited Git overrides, credential helpers, signing or hooks.
const environment = () => ({ PATH: process.env.PATH, TMPDIR: tmpdir(), LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
export async function fixtureGit(cwd, argv) {
  const result = await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Orchestration Fixture', '-c', 'user.email=fixture@example.invalid', ...argv], { cwd, env: environment(), timeout: 10000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}

export async function createRepositoryFixture({ conflict = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orchestration-repo-'));
  const repository = join(directory, 'repository'), remote = join(directory, 'remote.git'), worktrees = join(directory, 'worktrees');
  try {
    await cp(source, repository, { recursive: true }); await mkdir(worktrees);
    await fixtureGit(repository, ['init', '--initial-branch=main']);
    await fixtureGit(repository, ['add', '.']); await fixtureGit(repository, ['commit', '-m', 'Seed independent module tasks']);
    await fixtureGit(directory, ['init', '--bare', '--initial-branch=main', remote]);
    await fixtureGit(repository, ['remote', 'add', 'origin', remote]);
    await fixtureGit(repository, ['push', '-u', 'origin', 'main']);
    const baseSha = await fixtureGit(repository, ['rev-parse', 'HEAD']);
    const approvedContract = contract();
    approvedContract.verification = [{ id: 'unit', argv: ['node', '--test', 'test/acceptance.test.mjs'] }];
    if (conflict) for (const task of approvedContract.tasks.filter((task) => task.id !== 'C')) {
      task.ownedAreas.push('src/composition.mjs'); task.integrationPolicy = 'serialize';
    }
    return {
      directory, repository, remote, worktrees, baseSha, contract: approvedContract,
      async checkout(name, base = baseSha) {
        if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name) || !/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid fixture checkout identity');
        const worktree = join(worktrees, name), branch = `fixture/${name}`;
        await fixtureGit(repository, ['worktree', 'add', '-b', branch, worktree, base]);
        return { worktree, branch, baseSha: base };
      },
      async implement(worktree, taskId, { failing = false } = {}) {
        // Scripted candidates change source only; verification is immutable.
        if (taskId === 'A' || taskId === 'B') {
          const name = taskId.toLowerCase(), value = taskId === 'A' ? 2 : 3;
          await writeFile(join(worktree, 'src', `${name}.mjs`), `export function ${name}() { return ${value}; }\n`);
          if (conflict) await writeFile(join(worktree, 'src/composition.mjs'), `export function composition() { return '${taskId} awaiting composition'; }\n`);
        } else if (taskId === 'C') {
          await writeFile(join(worktree, 'src/composition.mjs'), `import { a } from './a.mjs';\nimport { b } from './b.mjs';\nexport function composition() { return a() ${failing ? '-' : '+'} b(); }\n`);
        } else throw new Error('Unknown fixture task');
        await fixtureGit(worktree, ['add', 'src']); await fixtureGit(worktree, ['commit', '-m', `Implement ${taskId}${failing ? ' with intentional defect' : ''}`]);
        return fixtureGit(worktree, ['rev-parse', 'HEAD']);
      },
      async verify(worktree) {
        try {
          const result = await execute(process.execPath, ['--test', 'test/acceptance.test.mjs'], { cwd: worktree, env: environment(), timeout: 10000, maxBuffer: 1024 * 1024 });
          return { passed: true, stdout: result.stdout, stderr: result.stderr };
        } catch (error) {
          if (typeof error.code !== 'number' || error.killed) throw error;
          return { passed: false, stdout: error.stdout, stderr: error.stderr };
        }
      },
      async close() { await rm(directory, { recursive: true, force: true }); },
    };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
