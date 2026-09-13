function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function launchAgentPlist({ label, program, keepAlive = false, persistent = false, throttleSeconds = null, out, error, env = {} }) {
  const args = program.map((item) => `<string>${xml(item)}</string>`).join("");
  const environment = Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
  const keepAliveXml = persistent
    ? "<key>KeepAlive</key><true/>"
    : keepAlive
      ? "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>"
      : "";
  const throttleXml = throttleSeconds === null ? "" : `<key>ThrottleInterval</key><integer>${throttleSeconds}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/>${keepAliveXml}${throttleXml}<key>StandardOutPath</key><string>${xml(out)}</string><key>StandardErrorPath</key><string>${xml(error)}</string><key>EnvironmentVariables</key><dict>${environment}</dict></dict></plist>\n`;
}
