import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.mjs";
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
  const app = await buildApp({
    cmux,
    token,
    repoCatalog,
    pushService,
    previewManager,
    promptQueue,
    frontendUpstream,
    logger: process.env.NODE_ENV !== "test",
  });
  await app.listen({ host, port });
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
