#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
LABELS="$(node --input-type=module -e 'const {SERVICE_LABEL,LEGACY_SERVICE_LABEL}=await import(process.argv[1]); console.log(SERVICE_LABEL+"\n"+LEGACY_SERVICE_LABEL)' "${SCRIPT_DIR:h}/server/service-identity.mjs")"
TOKEN_PATH="${CMUX_COMPANION_TOKEN_FILE:-${CMUX_COMPANION_DATA_DIR:-${HOME}/.config/cmux-companion}/token}"
TAILSCALE_PORT="${CMUX_COMPANION_TAILSCALE_PORT:-8443}"

if HEALTH_JSON="$(/usr/bin/curl -fsS "http://127.0.0.1:${CMUX_COMPANION_PORT:-3210}/api/health" 2>/dev/null)"; then
  RUNNING_SHA="$(printf '%s' "${HEALTH_JSON}" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",{}).get("gitSha","unknown"))')"
  echo "Service: running (${RUNNING_SHA})"
else
  echo "Service: not reachable"
fi

source "${SCRIPT_DIR}/updater-location.sh"
if UPDATER_OPERATOR="$(resolve_updater_script operator.mjs)"; then
  "$(command -v node)" "${UPDATER_OPERATOR}" status
fi

AUTOSTART_FOUND=false
for LABEL in ${(f)LABELS}; do
  if /bin/launchctl print "gui/${UID}/${LABEL}" >/dev/null 2>&1; then AUTOSTART_FOUND=true; break; fi
done
if [[ "${AUTOSTART_FOUND}" == true ]]; then
  echo "Automatic startup: installed"
else
  echo "Automatic startup: not installed"
fi

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  DNS_NAME="$(tailscale status --json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  echo "Phone URL: https://${DNS_NAME}:${TAILSCALE_PORT}"
fi

if [[ "${1:-}" == "--show-token" ]]; then
  if [[ -f "${TOKEN_PATH}" ]]; then
    echo "Pairing code: $(<"${TOKEN_PATH}")"
  else
    echo "Pairing code: not generated yet"
  fi
fi
