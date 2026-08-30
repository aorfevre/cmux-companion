#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
LABEL="com.aorfevre.cmux-companion"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs"
NODE_BIN="${CMUX_COMPANION_NODE:-$(command -v node)}"
TAILSCALE_PORT="${CMUX_COMPANION_TAILSCALE_PORT:-8443}"

cd "${PROJECT_DIR}"
npm install
node scripts/configure-cmux-automation.mjs
npm run build

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"
/usr/bin/plutil -create xml1 "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :Label string ${LABEL}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments array" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string ${NODE_BIN}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:1 string ${PROJECT_DIR}/server/supervisor.mjs" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :WorkingDirectory string ${PROJECT_DIR}" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :RunAtLoad bool true" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :KeepAlive dict" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :KeepAlive:SuccessfulExit bool false" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ProcessType string Interactive" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :ThrottleInterval integer 5" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardOutPath string ${LOG_DIR}/cmux-companion.log" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :StandardErrorPath string ${LOG_DIR}/cmux-companion.error.log" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:NODE_ENV string production" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:CMUX_COMPANION_HOST string 127.0.0.1" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:CMUX_COMPANION_PORT string 3210" "${PLIST_PATH}"
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:PATH string ${NODE_BIN:h}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "${PLIST_PATH}"
/bin/chmod 600 "${PLIST_PATH}"

/bin/launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
for attempt in {1..40}; do
  if ! /bin/launchctl print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
for attempt in {1..20}; do
  if /bin/launchctl bootstrap "gui/${UID}" "${PLIST_PATH}" >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 20 )); then
    echo "Could not install the automatic companion service." >&2
    exit 1
  fi
  sleep 0.25
done
/bin/launchctl enable "gui/${UID}/${LABEL}"
/bin/launchctl kickstart -k "gui/${UID}/${LABEL}"

for attempt in {1..80}; do
  if /usr/bin/curl -fsS http://127.0.0.1:3210/api/health >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 80 )); then
    echo "The companion did not start. Check ${LOG_DIR}/cmux-companion.error.log." >&2
    exit 1
  fi
  sleep 0.25
done

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  tailscale serve --bg --yes --https="${TAILSCALE_PORT}" http://127.0.0.1:3210 >/dev/null
  DNS_NAME="$(tailscale status --json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  echo "cmux companion is ready at https://${DNS_NAME}:${TAILSCALE_PORT}"
else
  echo "cmux companion is ready locally at http://127.0.0.1:3210"
  echo "Tailscale is not connected, so private phone access was not configured."
fi

echo "It starts automatically at login and waits for cmux when cmux is closed."
echo "Run 'npm run status -- --show-token' to display the phone pairing code."
