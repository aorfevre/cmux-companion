"use client";

import { useEffect, useState } from "react";
import { DEFAULT_MODEL_ROLES, MODEL_PROVIDERS, MODEL_ROLES, MODEL_SUGGESTIONS } from "../server/model-options.mjs";
import { request } from "./image-attachments";

export type ModelProvider = "claude" | "codex";
export type ModelRoles = Record<string, { provider?: ModelProvider; models: Record<ModelProvider, string> }>;
export type ModelSettingsStatus = { roles: ModelRoles; defaults: ModelRoles; warning: string | null };
export const BUILTIN_MODEL_ROLES = DEFAULT_MODEL_ROLES as ModelRoles;

export function ModelSettingsPanel() {
  const [settings, setSettings] = useState<ModelSettingsStatus | null>(null);
  const [roles, setRoles] = useState<ModelRoles | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setError("");
    try {
      const value = await request<ModelSettingsStatus>("/api/settings/models");
      setSettings(value);
      setRoles(value.roles);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load model settings"); }
  }
  useEffect(() => { void load(); }, []);

  function update(id: string, provider: ModelProvider, model: string) {
    setNotice("");
    setRoles((current) => current && ({ ...current, [id]: { ...current[id], models: { ...current[id].models, [provider]: model } } }));
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await request<ModelSettingsStatus>("/api/settings/models", { method: "PATCH", body: JSON.stringify({ roles }) });
      setSettings(value); setRoles(value.roles); setNotice("Model defaults saved");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save model settings"); }
    finally { setBusy(false); }
  }
  const dirty = settings && JSON.stringify(roles) !== JSON.stringify(settings.roles);
  return <section className="model-settings" aria-label="Model defaults">
    <h2>Model defaults</h2>
    <p>Choose the model for each role and provider. Use a suggested ID or enter a model supported by your provider. “default” uses the provider’s own default.</p>
    <p>Saved on this Mac for all paired devices. Changes apply to new agent runs; active sessions and existing planner choices keep their model.</p>
    {error && <p role="alert">{error}</p>}
    {!roles && <button type="button" onClick={() => void load()}>Retry loading model defaults</button>}
    {settings?.warning && <p role="status">{settings.warning}</p>}
    {roles && <form onSubmit={save}>
      <fieldset disabled={busy}>
        <legend className="sr-only">Defaults by agent role</legend>
        {MODEL_ROLES.map((role) => <div className="model-settings-role" key={role.id}>
          <div><h3>{role.label}</h3><p>{role.description}</p></div>
          <div className="model-settings-controls">
            {role.provider && <label><span>Provider</span><select aria-label={`${role.label} default provider`} value={roles[role.id].provider} onChange={(event) => { setNotice(""); setRoles({ ...roles, [role.id]: { ...roles[role.id], provider: event.target.value as ModelProvider } }); }}>
              <option value="claude">Claude</option><option value="codex">Codex</option>
            </select></label>}
            {(MODEL_PROVIDERS as ModelProvider[]).map((provider) => <label key={provider}>
              <span>{provider === "claude" ? "Claude" : "Codex"} model</span>
              <input aria-label={`${role.label} ${provider === "claude" ? "Claude" : "Codex"} model`} list={`models-${provider}`} value={roles[role.id].models[provider]} onChange={(event) => update(role.id, provider, event.target.value)} required maxLength={160} pattern="[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </label>)}
          </div>
          <button className="text-button" type="button" onClick={() => { setNotice(""); setRoles({ ...roles, [role.id]: structuredClone(settings!.defaults[role.id]) }); }}>Reset {role.label.toLowerCase()}</button>
        </div>)}
        <div className="model-settings-actions"><button className="primary-button" type="submit" disabled={!dirty}>{busy ? "Saving…" : "Save model defaults"}</button><button type="button" disabled={!dirty} onClick={() => { setRoles(structuredClone(settings!.roles)); setNotice(""); setError(""); }}>Discard changes</button></div>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
      {(MODEL_PROVIDERS as ModelProvider[]).map((provider) => <datalist id={`models-${provider}`} key={provider}>{MODEL_SUGGESTIONS[provider].map((model) => <option key={model} value={model} />)}</datalist>)}
    </form>}
  </section>;
}
