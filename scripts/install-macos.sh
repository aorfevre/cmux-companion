#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
source "${SCRIPT_DIR}/updater-location.sh"
if ! INSTALLER="$(resolve_updater_script install-macos.mjs)"; then
  echo "Install cmux-companion-updater or set CMUX_COMPANION_UPDATER_REPOSITORY to its absolute checkout path." >&2
  echo "Updater source: https://github.com/aorfevre/cmux-companion-updater" >&2
  exit 1
fi
CMUX_COMPANION_REPOSITORY="${PROJECT_DIR}" node "${INSTALLER}"
