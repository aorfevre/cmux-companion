// These defaults preserve the installed Mac's aliases. Configuration belongs
// to the server environment, never to a launch request from the browser.
export const DEFAULT_LAUNCHERS = [
  { id: "codex", label: "Codex", command: "xcodex" },
  { id: "claude", label: "Claude", command: "xclaude" },
  { id: "kimi", label: "Kimi", command: "kimi" },
];

export function providerLaunchers(env = process.env) {
  return DEFAULT_LAUNCHERS.map((provider) => {
    const command = env[`CMUX_COMPANION_${provider.id.toUpperCase()}_COMMAND`] ?? provider.command;
    if (typeof command !== "string" || command.length > 512 ||
        !(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(command) || /^\/[a-zA-Z0-9_./ -]+$/.test(command))) {
      throw new TypeError(`Invalid ${provider.id} launcher: use a command name or absolute executable path, without arguments`);
    }
    return { ...provider, command };
  });
}

export function launcherCommand(provider, command, modelFlag, prompt, quote) {
  // Leave simple names unquoted so interactive zsh aliases still expand.
  const executable = command.startsWith("/") ? quote(command) : command;
  const task = prompt.trim();
  return `${executable}${modelFlag}${task ? `${provider === "kimi" ? " --prompt" : ""} ${quote(task)}` : ""}`;
}
