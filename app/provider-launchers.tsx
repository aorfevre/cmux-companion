"use client";

import { useEffect, useState } from "react";
import { DEFAULT_LAUNCHERS } from "../server/provider-launchers.mjs";
import { request } from "./api-request";

type Launcher = { id: string; label: string; command: string };
export function useLaunchers() {
  const [warning, setWarning] = useState("");
  const [providers, setProviders] = useState<Launcher[]>(DEFAULT_LAUNCHERS);
  useEffect(() => {
    let active = true;
    void request<{ providers: Launcher[] }>("/api/settings/launchers")
      .then((value) => {
        if (!Array.isArray(value.providers) || !DEFAULT_LAUNCHERS.every(({ id }) => value.providers.some((provider) => provider.id === id && typeof provider.command === "string"))) throw new Error("Invalid launcher settings");
        if (active) setProviders(value.providers);
      })
      .catch(() => { if (active) setWarning("Command settings unavailable; showing default command names."); });
    return () => { active = false; };
  }, []);
  return { providers, warning };
}

export function LauncherChoices({ agent, onChange, prefix = "", shell = false }: { agent: string; onChange: (agent: string) => void; prefix?: string; shell?: boolean }) {
  const { providers, warning } = useLaunchers();
  return <>{providers.map((provider) => <button type="button" key={provider.id} aria-label={`${prefix}${provider.label} (${provider.command})`} className={agent === provider.id ? "selected" : ""} onClick={() => onChange(provider.id)}>{provider.label}<small>{provider.command}</small></button>)}{shell && <button type="button" className={agent === "shell" ? "selected" : ""} onClick={() => onChange("shell")}>Shell</button>}{warning && <small className="launcher-warning">{warning}</small>}</>;
}

export function LauncherReference() {
  const { providers, warning } = useLaunchers();
  return <details className="launcher-reference"><summary>Provider launcher commands</summary>{warning && <p role="status">{warning}</p>}<p>Commands run on your Mac. Configure each command in the companion environment and restart the companion.</p><dl>{providers.map((provider) => <div key={provider.id}><dt>{provider.label}</dt><dd><code>{provider.command}</code><small>CMUX_COMPANION_{provider.id.toUpperCase()}_COMMAND</small></dd></div>)}</dl><p>Use a command name or absolute executable path. For arguments, use a local wrapper script. Kimi sessions require Kimi CLI; automated goals use Claude or Codex.</p></details>;
}
