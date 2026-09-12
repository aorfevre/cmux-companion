import { DEFAULT_MODEL_ROLES } from './model-options.mjs';

// Compatibility projection for session launchers. The editable source of truth
// is the versioned local-settings API; no second JSON preference store is opened.
export class SettingsModels {
  constructor(settings) { this.settings = settings; }
  status() {
    const configured = this.settings.read().settings;
    const roles = structuredClone(DEFAULT_MODEL_ROLES);
    for (const role of Object.values(roles)) for (const provider of ['claude', 'codex']) role.models[provider] = configured.providers[provider].model;
    return { roles, defaults: structuredClone(DEFAULT_MODEL_ROLES), warning: null };
  }
  workspace(_role, provider) {
    if (provider === 'shell') return { agent: 'shell' };
    const command = this.settings.read().settings.providers[provider];
    if (!command) throw new TypeError('Choose Claude or Codex');
    return { agent: provider, model: command.model };
  }
  configure() { throw new TypeError('Edit models in Projects and agent setup; reload the settings page before saving.'); }
}
