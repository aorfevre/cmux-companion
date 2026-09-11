import { readFileSync } from 'node:fs';
import { git } from '../../../server/orchestration/adapters/git.mjs';
import { withGitProcessScope } from '../../../server/orchestration/adapters/git-process-scope.mjs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
await withGitProcessScope(config.scope, () => git(config.repository, ['update-ref', 'refs/heads/delayed', config.headSha]));
