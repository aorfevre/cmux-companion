import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.mjs";
import { CmuxClient } from "./cmux-client.mjs";
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
  const app = await buildApp({
    cmux,
    token,
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
