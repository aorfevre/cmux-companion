#!/bin/zsh
set -euo pipefail

LABEL="com.aorfevre.cmux-companion"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"

/bin/launchctl bootout "gui/${UID}/${LABEL}" >/dev/null 2>&1 || true
if [[ -f "${PLIST_PATH}" ]]; then
  /bin/rm -f "${PLIST_PATH}"
fi

echo "The automatic companion service was removed."
echo "The pairing token and Tailscale Serve configuration were preserved."
