import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionRuntime, loadProductionConfig } from "./orchestration/production.mjs";
import { buildApp } from "./app.mjs";
import { ModelSettings, DEFAULT_MODEL_SETTINGS_PATH } from "./model-settings.mjs";
import { CmuxClient } from "./cmux-client.mjs";
import { PushService } from "./push-service.mjs";
import { PreviewManager } from "./preview-manager.mjs";
import { PromptQueue } from "./prompt-queue.mjs";
import { RepoCatalog } from "./repo-catalog.mjs";
import { openRepoIdentityStore } from "./repo-identity-store.mjs";
import { ensureToken } from "./security.mjs";

const DEFAULT_TOKEN_PATH = join(homedir(), ".config", "cmux-companion", "token");

export async function startServer({
  host = process.env.CMUX_COMPANION_HOST || "127.0.0.1",
  port = Number(process.env.CMUX_COMPANION_PORT || 3210),
  frontendUpstream = process.env.CMUX_COMPANION_FRONTEND_UPSTREAM || null,
} = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Companion must bind to loopback");
  const config = loadProductionConfig(process.env.CMUX_COMPANION_ORCHESTRATION_CONFIG);
  const tokenPath = process.env.CMUX_COMPANION_TOKEN_FILE || DEFAULT_TOKEN_PATH;
  const token = ensureToken(tokenPath);
  const cmux = new CmuxClient();
  const pushService = new PushService();
  const previewManager = new PreviewManager();
  const promptQueue = new PromptQueue();
  // Only the running companion opts into the identity cache. buildApp defaults
  // its catalog to a live one, so no test that builds an app ever touches the
  // real database file.
  const repoCatalog = new RepoCatalog({ identityStore: openRepoIdentityStore() });
  const runtime = await createProductionRuntime({ config, token,
    sessions: async () => (await cmux.workspaceListDetailed()).workspaces.map(workspace => workspace.id),
    monitor: async app => { await buildApp({ app, cmux,
      modelSettings: new ModelSettings({ path: process.env.CMUX_COMPANION_MODEL_SETTINGS_FILE || DEFAULT_MODEL_SETTINGS_PATH }),
      token, repoCatalog, pushService, previewManager, promptQueue, frontendUpstream,
      logger: process.env.NODE_ENV !== "test",
    }); },
  });
  await runtime.listen({ port });
  const app = { close: () => runtime.close() };
  return { app, tokenPath, host, port };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = await startServer();
  const stop = async () => {
    await server.app.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
