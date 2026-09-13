import { homedir } from "node:os";
import { join } from "node:path";
import { SERVICE_LABEL, UPDATER_LABEL } from "../../server/service-identity.mjs";

export const LABELS = {
  companion: SERVICE_LABEL,
  updater: UPDATER_LABEL,
};

export function defaultPaths(home = homedir()) {
  const configRoot = join(home, ".config", "cmux-companion");
  return {
    home,
    configRoot,
    config: join(configRoot, "updater.json"),
    stateRoot: join(configRoot, "updater"),
    state: join(configRoot, "updater", "state.json"),
    control: join(configRoot, "updater", "control.sqlite"),
    transaction: join(configRoot, "updater", "transaction.json"),
    lock: join(configRoot, "updater", "lock"),
    libexec: join(home, ".local", "libexec"),
    bootstrap: join(home, ".local", "libexec", "cmux-companion-updater"),
    launcher: join(home, ".local", "libexec", "cmux-companion-launch"),
    updaterStore: join(home, ".local", "share", "cmux-companion-updater"),
    companionStore: join(home, ".local", "share", "cmux-companion"),
    launchAgents: join(home, "Library", "LaunchAgents"),
    logs: join(home, "Library", "Logs"),
  };
}

export const INITIAL_STATE = Object.freeze({
  schemaVersion: 1,
  deployedSha: null,
  previousSha: null,
  observedRemoteSha: null,
  pendingSha: null,
  quarantinedSha: null,
  updaterDeployedSha: null,
  updaterObservedRemoteSha: null,
  updaterQuarantinedSha: null,
  phase: "idle",
  lastCheckAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
  nextEligibleCheckAt: null,
  engineVersion: null,
  bootstrapVersion: null,
  restartExpected: false,
});
