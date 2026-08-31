#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
UPDATER_DIR="${CMUX_COMPANION_UPDATER_REPOSITORY:-${PROJECT_DIR:h}/cmux-companion-updater}"
OPERATOR="${UPDATER_DIR}/scripts/uninstall-macos.mjs"
[[ -f "${OPERATOR}" ]] || OPERATOR="${HOME}/.local/share/cmux-companion-updater/current/scripts/uninstall-macos.mjs"

if [[ ! -f "${OPERATOR}" ]]; then
  echo "The CMUX Companion updater uninstaller could not be found." >&2
  exit 1
fi
node "${OPERATOR}"

