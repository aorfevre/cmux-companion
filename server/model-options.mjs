// Shared by Settings, the planner form, and the process boundary. Suggestions
// are conveniences; safe custom model IDs do not require a code release.
export const MODEL_PROVIDERS = ["claude", "codex"];
export const MODEL_CATALOG = {
  claude: [
    { id: "default", label: "Default" },
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
  ],
  codex: [
    { id: "default", label: "Default" },
    { id: "gpt-6-astra", label: "Codex Astra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
};
export const MODEL_ROLES = [
  { id: "planner", label: "Planner", description: "The interactive conversation for discovery, review and approved implementation.", provider: true },
  { id: "specReviewer", label: "Spec reviewer", description: "The optional second pass uses the other provider.", provider: false },
  { id: "coder", label: "Coder", description: "Task launches, retries, dependency waves, and manually launched agents. Task provider choices still apply.", provider: false },
  { id: "codeReviewer", label: "Code reviewer", description: "Post-delivery review requests and follow-ups that include a code review, using the selected provider.", provider: false },
  { id: "merger", label: "Merge agent", description: "Combines completed tasks into the delivery branch.", provider: true },
  { id: "followup", label: "Follow-up agent", description: "Additional tests, questions, and custom work after delivery.", provider: false },
  { id: "issueAnalyzer", label: "Issue analyzer", description: "Groups GitHub issues into topics before planning.", provider: true },
];
// Retain old keys for saved configuration compatibility, without exposing retired workflows.
export const ACTIVE_MODEL_ROLES = MODEL_ROLES.filter((role) => !["issueAnalyzer"].includes(role.id));
export const DEFAULT_MODEL_ROLES = Object.fromEntries(MODEL_ROLES.map((role) => [role.id, {
  ...(role.provider ? { provider: role.id === "planner" ? "codex" : "claude" } : {}),
  models: ["specReviewer", "codeReviewer"].includes(role.id)
    ? { claude: "claude-fable-5-1", codex: "gpt-5.6-sol" }
    : { claude: "default", codex: role.id === "planner" ? "gpt-6-astra" : "default" },
}]));

// `gpt-6` was published as the Codex Astra id before the provider settled on
// `gpt-6-astra`. The provider now rejects the old id with an "unknown provider
// for model" error, so a saved setting that still holds it would break every
// planning turn. Retired ids are rewritten at load time instead.
export const RETIRED_MODEL_IDS = Object.freeze({ "gpt-6": "gpt-6-astra" });

export function currentModelId(value) {
  return typeof value === "string" && Object.hasOwn(RETIRED_MODEL_IDS, value) ? RETIRED_MODEL_IDS[value] : value;
}

export function normalizeModelId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(value)) {
    throw new TypeError("Model must be an ID of 1–160 letters, numbers, dots, underscores, colons, slashes, plus signs or hyphens");
  }
  return value;
}

export function roleEngine(roles, roleId, provider) {
  const role = roles[roleId];
  if (!role) throw new TypeError("Unknown model role");
  const selected = provider ?? role.provider;
  if (!MODEL_PROVIDERS.includes(selected)) throw new TypeError("Choose Claude or Codex");
  return { provider: selected, model: normalizeModelId(role.models[selected]) };
}

export function patchModelRoles(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Model roles must be an object");
  const next = structuredClone(current);
  for (const [id, value] of Object.entries(patch)) {
    const role = MODEL_ROLES.find((entry) => entry.id === id);
    if (!role) throw new TypeError(`Unknown model role ${id}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Invalid settings for ${role.label}`);
    for (const [key, entry] of Object.entries(value)) {
      if (key === "provider" && role.provider) {
        if (!MODEL_PROVIDERS.includes(entry)) throw new TypeError("Choose Claude or Codex");
        next[id].provider = entry;
      } else if (key === "models") {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Models must be an object");
        for (const [provider, model] of Object.entries(entry)) {
          if (!MODEL_PROVIDERS.includes(provider)) throw new TypeError("Choose Claude or Codex");
          next[id].models[provider] = normalizeModelId(currentModelId(model));
        }
      } else throw new TypeError(`Unknown ${role.label} setting ${key}`);
    }
  }
  return next;
}
