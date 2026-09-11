# Disposable orchestration development

Use Node from `.nvmrc` and the checked-in npm lockfile. This development entry
runs the replacement API with real SQLite, Git worktrees, integration and Node
verification. Scripted agents and a stateful fake GitHub are the only external
workflow boundaries. It does not construct the legacy application or discover
production accounts, credentials, cmux, Tailscale or installed data.

```sh
npm run orchestration:dev -- --port 3211
```

Omit `--port` to allocate a free loopback port. An occupied port fails without
stopping its owner. `--read-only` keeps queries and pairing available and rejects
user workflow mutations. The script ignores inherited Companion configuration;
its agents, local remote and fake GitHub cannot switch to live adapters via env.

The first stdout line is JSON containing `address`, `manifestFile` and `tokenFile`
paths. The pairing token is never printed. The temporary directory is private
(mode 0700); the token and connection manifest are mode 0600. The manifest also
contains the disposable repository ID, base SHA, repository path and bare remote.
Keep the token private. Ctrl-C or SIGTERM joins owned work, closes storage and
removes the fixture. A failed shutdown preserves resources for inspection. A
SIGKILL cannot run cleanup; its printed manifest identifies the orphaned fixture.

## Drive the API

The frontend for this replacement is still under implementation. The API can
already exercise the complete workflow. This example reads credentials from the
private file instead of putting them in process arguments or console output:

```sh
node --input-type=module - /path/from/stdout/connection.json <<'JS'
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const connection = JSON.parse(await readFile(process.argv[2], 'utf8'));
const token = await readFile(connection.tokenFile, 'utf8');
const response = await fetch(`${connection.address}/api/orchestration/commands`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, origin: connection.address,
    'content-type': 'application/json' },
  body: JSON.stringify({ id: randomUUID(), goalId: randomUUID(), expectedVersion: 0,
    type: 'create_goal', payload: { repositoryId: connection.repositoryId,
      baseSha: connection.baseSha, title: 'Compose the disposable modules' } }),
});
console.log(response.status, await response.json());
JS
```

Authenticated `GET /api/orchestration/snapshot` returns the public goals, cursor,
journal identity and read-only status. `GET /api/orchestration/goals/:id` returns
one goal. After the independent contract review accepts the proposal, approve it
with a new command ID, the goal's current `expectedVersion`, `type: "approve"`
and `payload: { "revision": <current revision> }`. A version conflict requires
refreshing the goal; retries of the same request retain the original command ID.
The fixture does not approve its own plan.

A and B wait until both have started before writing separate modules. C starts
from their integrated head, intentionally fails its first task review, then gets
repaired. A separate final check fails on injectable dependencies. A bounded final
repair changes the integration commit; fresh review and checks gate one fake PR
at the resulting SHA. The fake PR URL uses `github.invalid` and is not a live PR.

Authenticated `GET /api/orchestration/stream` sends SSE snapshots and public
invalidation events. Reconnect with `Last-Event-ID: <journalId>:<cursor>`; expired
or foreign cursors return a `resync` snapshot. Invalid or future cursors fail before
streaming headers. Each connection buffers at most one bounded frame, pauses on
backpressure and closes if draining takes more than 15 seconds. Browser streams
do not prevent event retention. Fetch current goal projections after invalidations.

## Local checks

```sh
node --test tests/orchestration-composition.test.mjs tests/orchestration-events.test.mjs tests/orchestration-dev.test.mjs
```

These tests cover real HTTP auth/read-only protection, snapshot streaming above
the socket high-water mark, reconnect/retention, duplicate-safe durable consumer
delivery, lifecycle races, the complete temporary Git journey and CLI cleanup.
They do not establish native provider permission enforcement or live GitHub/cmux
behavior. The browser journey below uses the same real service and disposable repository.


## Mobile browser journey

Open `/orchestration` on the development frontend configured with the demo's API
address and pair using its disposable token. The board exposes the service's
available actions; it refreshes on events, reconnects and polls when streaming is
unavailable. An uncertain command retries its original ID and expected version.

```sh
npm run test:e2e:local -- --orchestration --spec cypress/e2e/orchestration-core.cy.ts
npm run test:e2e:local -- --orchestration --read-only --spec cypress/e2e/orchestration-core.cy.ts
```

The runner starts and stops its own frontend and real replacement backend with
fixed fake agents and local bare Git publication. It never starts installed or
live adapters. Set `CMUX_COMPANION_CYPRESS_PORT` if the default port is occupied;
set `CMUX_COMPANION_CYPRESS_BROWSER=chrome` to select Chrome. The writable journey
checks overlapping implementers, dependency integration, review and final-check
repair, reload, abort/reconciliation, one PR and its exact Git content. The separate
read-only run checks both disabled controls and the real HTTP mutation guard.
Sanitized fixture state and bounded source diffs are retained in `cypress/results/`
before disposable resources are removed; screenshots remain under `cypress/screenshots/`.
These fake PRs and scripted agents do not prove live model quality or permissions.
