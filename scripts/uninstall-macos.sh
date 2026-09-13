#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
source "${SCRIPT_DIR}/updater-location.sh"
if ! OPERATOR="$(resolve_updater_script uninstall-macos.mjs)"; then
  echo "Updater uninstaller not found. Set CMUX_COMPANION_UPDATER_REPOSITORY to its absolute checkout path." >&2
  exit 1
fi
node "${OPERATOR}"
