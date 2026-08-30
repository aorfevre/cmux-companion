#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

const home = homedir();
const configPath = join(home, ".config", "cmux", "cmux.json");
const credentialPath = join(home, ".config", "cmux-companion", "cmux-socket-password");
const cmuxBin = process.env.CMUX_BIN || "/Applications/cmux.app/Contents/Resources/bin/cmux";

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
if (current !== source) {
  if (current !== null) {
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const backup = `${configPath}.${timestamp}.bak`;
    copyFileSync(configPath, backup);
    chmodSync(backup, statSync(configPath).mode & 0o777);
    console.log(`Backed up cmux configuration to ${backup}`);
  }
  writeFileSync(configPath, source, { encoding: "utf8", mode: 0o600 });
}

try {
  try {
    execFileSync(cmuxBin, ["reload-config"], { env: process.env, stdio: "pipe" });
  } catch {
    execFileSync(cmuxBin, ["reload-config"], {
      env: { ...process.env, CMUX_SOCKET_PASSWORD: socketPassword },
      stdio: "pipe",
    });
  }
  console.log("Enabled password-protected cmux automation and reloaded cmux.");
} catch {
  console.log("Enabled password-protected cmux automation. It will apply the next time cmux opens.");
}
