import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CmuxClient } from "../../server/cmux-client.mjs";
import { buildApp } from "../../server/app.mjs";
import { ImageAttachments } from "../../server/image-attachments.mjs";
import { AccountUsage } from "../../server/account-usage.mjs";
import { RepoCatalog } from "../../server/repo-catalog.mjs";

// Monitoring fixtures own their temporary data and never construct orchestration.
export async function buildTestApp(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cmux-api-fixture-"));
  let app;
  t.after(async () => { try { await app?.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  app = await buildApp({ ...options,
    cmux: options.cmux || new CmuxClient({ bin: "/fake/cmux", socketPassword: "" }),
    repoCatalog: options.repoCatalog || new RepoCatalog({ roots: [] }),
    imageAttachments: options.imageAttachments || new ImageAttachments({ directory: join(directory, "attachments") }),
    accountUsage: options.accountUsage || new AccountUsage({ sourceLoader: async () => { throw new Error("No account source in API fixture"); } }),
  });
  app.decorate("fixtureDirectory", directory);
  return app;
}
