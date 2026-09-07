#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

export function configureCmuxAutomation({ directory = homedir(), cmuxBin = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux", execute = execFileSync } = {}) {
  const configPath = join(directory, ".config", "cmux", "cmux.json");
  const credentialPath = join(directory, ".config", "cmux-companion", "cmux-socket-password");

  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });

  let source = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : '{\n  "$schema": "https://raw.githubusercontent.com/manaflow-ai/cmux/main/web/data/cmux.schema.json",\n  "schemaVersion": 1\n}\n';
  const errors = [];
  const document = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const details = errors.map((error) => printParseErrorCode(error.error)).join(", ");
    throw new Error(`Cannot configure invalid cmux.json (${details}). Run cmux config doctor first.`);
  }

  let socketPassword;
  if (
    document?.automation?.socketControlMode === "password"
    && typeof document?.automation?.socketPassword === "string"
    && document.automation.socketPassword.length >= 32
  ) {
    socketPassword = document.automation.socketPassword;
  } else if (existsSync(credentialPath)) {
    socketPassword = readFileSync(credentialPath, "utf8").trim();
  }
  if (!socketPassword || socketPassword.length < 32) {
    socketPassword = randomBytes(32).toString("base64url");
  }

  writeFileSync(credentialPath, socketPassword + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(credentialPath, 0o600);

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  source = applyEdits(source, modify(source, ["automation", "socketControlMode"], "password", { formattingOptions }));
  source = applyEdits(source, modify(source, ["automation", "socketPassword"], socketPassword, { formattingOptions }));

  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  const configurationChanged = current !== source;
  if (configurationChanged) {
    if (current !== null) {
      const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const backup = `${configPath}.${timestamp}.bak`;
      writeFileSync(backup, current, { encoding: "utf8", mode: 0o600, flag: "wx" });
      console.log(`Backed up cmux configuration to ${backup}`);
    }
    // Tighten an existing file before writing a password into it.
    if (current !== null) chmodSync(configPath, 0o600);
    writeFileSync(configPath, source, { encoding: "utf8", mode: 0o600 });
  }

  // Also repair permissions when the contents already match.
  chmodSync(configPath, 0o600);

  if (!configurationChanged) {
    console.log("Password-protected cmux automation is already configured.");
  } else try {
    try {
      execute(cmuxBin, ["reload-config"], { env: process.env, stdio: "pipe", timeout: 5_000 });
    } catch {
      execute(cmuxBin, ["reload-config"], {
        env: { ...process.env, CMUX_SOCKET_PASSWORD: socketPassword },
        stdio: "pipe",
        timeout: 5_000,
      });
    }
    console.log("Enabled password-protected cmux automation and reloaded cmux.");
  } catch {
    console.log("Enabled password-protected cmux automation. It will apply the next time cmux opens.");
  }
  return { configPath, credentialPath, configurationChanged };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) configureCmuxAutomation();
