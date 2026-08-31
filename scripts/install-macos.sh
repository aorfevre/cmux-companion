#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
UPDATER_DIR="${CMUX_COMPANION_UPDATER_REPOSITORY:-${PROJECT_DIR:h}/cmux-companion-updater}"

if [[ ! -f "${UPDATER_DIR}/scripts/install-macos.mjs" ]]; then
  echo "cmux-companion-updater is required at ${UPDATER_DIR}." >&2
  echo "Clone https://github.com/aorfevre/cmux-companion-updater next to this checkout, then retry." >&2
  exit 1
fi

CMUX_COMPANION_REPOSITORY="${PROJECT_DIR}" node "${UPDATER_DIR}/scripts/install-macos.mjs"

