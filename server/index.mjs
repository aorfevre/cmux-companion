import { UpdateControl } from '../updater/src/control.mjs';
import { registerUpdateRoutes } from './update-routes.mjs';
import { installUpdateMaintenance } from './update-maintenance.mjs';
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionRuntime, loadProductionConfig } from "./orchestration/production.mjs";
import { buildApp } from "./app.mjs";
import { ModelSettings, DEFAULT_MODEL_SETTINGS_PATH } from "./model-settings.mjs";
import { SettingsModels } from "./settings-models.mjs";
import { LocalSettings, DEFAULT_DATA_DIRECTORY } from "./local-settings.mjs";
import { createSettingsRuntime } from "./settings-runtime.mjs";
import { createConfiguredAgents, probeProvider } from "./provider-runtime.mjs";
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
  dataDirectory = process.env.CMUX_COMPANION_DATA_DIR || DEFAULT_DATA_DIRECTORY,
  legacyConfigPath = process.env.CMUX_COMPANION_ORCHESTRATION_CONFIG,
  cmuxClient = null,
} = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Companion must bind to loopback");
  const directory = dataDirectory;
  const settingsPath = process.env.CMUX_COMPANION_SETTINGS_DB || join(directory, "settings.sqlite");
  const config = !existsSync(settingsPath) && legacyConfigPath ? loadProductionConfig(legacyConfigPath) : null;
  const localSettings = config ? null : new LocalSettings({ path: settingsPath });
  const preferences = localSettings?.read().settings;
  const tokenPath = process.env.CMUX_COMPANION_TOKEN_FILE || (localSettings ? join(directory, "token") : DEFAULT_TOKEN_PATH);
  const token = ensureToken(tokenPath);
  const cmux = cmuxClient || new CmuxClient({ ...(preferences ? { bin: preferences.tools.cmux, providerSettings: () => localSettings.read().settings.providers } : {}) });
  const pushService = new PushService(localSettings ? { path: join(directory, "push.json") } : {});
  const previewManager = new PreviewManager(preferences ? { path: join(directory, "previews.json"), tailscaleBin: preferences.tools.tailscale, portStart: preferences.previews.portStart, portEnd: preferences.previews.portEnd } : {});
  const promptQueue = new PromptQueue(localSettings ? { path: join(directory, "prompt-queue.json") } : {});
  // Only the running companion opts into the identity cache. buildApp defaults
  // its catalog to a live one, so no test that builds an app ever touches the
  // real database file.
  const repoCatalog = new RepoCatalog({ identityStore: openRepoIdentityStore(localSettings ? { path: join(directory, "repo-identity.db") } : {}), ...(localSettings ? { roots: [], projects: () => localSettings.read().settings.projects } : {}) });
  let runtime;
  let updateControl = null;
  const monitor = async app => { await buildApp({ app, cmux,
    localSettings, probeProvider,
    onSettingsChange: async () => {
      const current = localSettings.read().settings;
      repoCatalog.invalidate(); cmux.bin = current.tools.cmux;
      previewManager.tailscaleBin = current.tools.tailscale;
      previewManager.portStart = current.previews.portStart; previewManager.portEnd = current.previews.portEnd;
      await runtime.settingsChanged();
    },
    modelSettings: localSettings ? new SettingsModels(localSettings) : new ModelSettings({ path: process.env.CMUX_COMPANION_MODEL_SETTINGS_FILE || DEFAULT_MODEL_SETTINGS_PATH }),
    token, repoCatalog, pushService, previewManager, promptQueue, frontendUpstream,
    logger: process.env.NODE_ENV !== "test",
  }); };
  try {
    if (config) runtime = await createProductionRuntime({ config, token,
      sessions: async () => (await cmux.workspaceListDetailed()).workspaces.map(workspace => workspace.id), monitor });
    else {
      runtime = await createSettingsRuntime({ settings: localSettings, directory, token, createAgents: createConfiguredAgents, probeProvider });
      await runtime.app.register(monitor);
    }
  } catch (error) { localSettings?.close(); throw error; }
  try {
    if (process.env.CMUX_COMPANION_UPDATER_CONTROL) {
      updateControl = new UpdateControl(process.env.CMUX_COMPANION_UPDATER_CONTROL);
      const maintenance = installUpdateMaintenance({ runtime, control: updateControl, cmux, promptQueue });
      await runtime.app.register(async app => registerUpdateRoutes(app, { control: updateControl, token, maintenance }));
    }
    await runtime.listen({ port });
  } catch (error) {
    try { await runtime.close(); } finally { updateControl?.close(); localSettings?.close(); }
    throw error;
  }
  const app = { close: async () => { await runtime.close(); updateControl?.close(); localSettings?.close(); } };
  const address = runtime.app.server.address();
  return { app, tokenPath, host, port: address && typeof address !== "string" ? address.port : port };
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
