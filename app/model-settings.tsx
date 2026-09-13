"use client";

import { useEffect, useState } from "react";
import { MODEL_CATALOG, MODEL_PROVIDERS, ACTIVE_MODEL_ROLES } from "../server/model-options.mjs";
import { request } from "./image-attachments";

export type ModelProvider = "claude" | "codex";
export type ModelRoles = Record<string, { provider?: ModelProvider; models: Record<ModelProvider, string> }>;
export type ModelSettingsStatus = { roles: ModelRoles; defaults: ModelRoles; warning: string | null };

export function ModelSettingsPanel() {
  const [settings, setSettings] = useState<ModelSettingsStatus | null>(null);
  const [roles, setRoles] = useState<ModelRoles | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function load() {
    return request<ModelSettingsStatus>("/api/settings/models").then((value) => {
      setError(""); setSettings(value); setRoles(value.roles);
    }).catch((cause) => { setError(cause instanceof Error ? cause.message : "Could not load model settings"); });
  }
  useEffect(() => {
    let active = true;
    request<ModelSettingsStatus>("/api/settings/models").then((value) => {
      if (active) { setSettings(value); setRoles(value.roles); }
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Could not load model settings"); });
    return () => { active = false; };
  }, []);

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
    <p>Choose the model for each role and provider. Open a dropdown to see all suggested models, or choose “Custom model…” to enter another model ID. “Provider default” lets your provider choose the model.</p>
    <p>Saved on this Mac for all paired devices. Changes apply to newly launched manual coding sessions. Orchestration models are configured by the operator.</p>
    {error && <p role="alert">{error}</p>}
    {!roles && (error ? <button type="button" onClick={() => void load()}>Retry loading model defaults</button> : <p role="status">Loading model defaults…</p>)}
    {settings?.warning && <p role="status">{settings.warning}</p>}
    {roles && <form onSubmit={save}>
      <fieldset disabled={busy}>
        <legend className="sr-only">Defaults by agent role</legend>
        {ACTIVE_MODEL_ROLES.map((role) => <div className="model-settings-role" key={role.id}>
          <div><h3>{role.label}</h3><p>{role.description}</p></div>
          <div className="model-settings-controls">
            {role.provider && <label><span>Provider</span><select aria-label={`${role.label} default provider`} value={roles[role.id].provider} onChange={(event) => { setNotice(""); setRoles({ ...roles, [role.id]: { ...roles[role.id], provider: event.target.value as ModelProvider } }); }}>
              <option value="claude">Claude</option><option value="codex">Codex</option>
            </select></label>}
            {(MODEL_PROVIDERS as ModelProvider[]).map((provider) => <ModelSelect key={provider}
              label={`${role.label} ${provider === "claude" ? "Claude" : "Codex"} model`}
              caption={`${provider === "claude" ? "Claude" : "Codex"} model`}
              provider={provider} value={roles[role.id].models[provider]} onChange={(model) => update(role.id, provider, model)} />)}
          </div>
          <button className="text-button" type="button" onClick={() => { setNotice(""); setRoles({ ...roles, [role.id]: structuredClone(settings!.defaults[role.id]) }); }}>Reset {role.label.toLowerCase()}</button>
        </div>)}
        <div className="model-settings-actions"><button className="primary-button" type="submit" disabled={!dirty && !settings?.warning}>{busy ? "Saving…" : "Save model defaults"}</button><button type="button" disabled={!dirty} onClick={() => { setRoles(structuredClone(settings!.roles)); setNotice(""); setError(""); }}>Discard changes</button></div>
      </fieldset>
      {notice && <p role="status">{notice}</p>}
    </form>}
  </section>;
}

// Preserve the convenient suggestions while allowing newly released or
// provider-specific model IDs without changing the app's catalog.
export function ModelSelect({ label, caption = "Model", provider, value, onChange }: { label: string; caption?: string; provider: ModelProvider; value: string; onChange: (model: string) => void }) {
  const suggestions = MODEL_CATALOG[provider];
  const custom = !suggestions.some((model) => model.id === value);
  return <label><span>{caption}</span><select aria-label={label} value={custom ? "__custom__" : value} onChange={(event) => onChange(event.target.value === "__custom__" ? "" : event.target.value)}>
    {suggestions.map((model) => <option key={model.id} value={model.id}>{model.id === "default" ? "Provider default" : model.label}</option>)}
    <option value="__custom__">Custom model…</option>
  </select>{custom && <input aria-label={`${label} ID`} value={value} onChange={(event) => onChange(event.target.value)} placeholder="Provider model ID" maxLength={160} required autoCapitalize="none" autoCorrect="off" spellCheck={false} />}</label>;
}
