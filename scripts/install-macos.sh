#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
node "${PROJECT_DIR}/updater/scripts/install-macos.mjs" "$@"
