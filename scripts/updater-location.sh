# Shared by the operator-facing zsh entry points. Sourcing this file performs no
# installation or process operation.
resolve_updater_script() {
  local script_name="$1"
  local checkout_root="${0:A:h:h}"
  local candidate_dir
  if [[ -n "${CMUX_COMPANION_UPDATER_REPOSITORY:-}" ]]; then
    [[ "${CMUX_COMPANION_UPDATER_REPOSITORY}" == /* ]] || return 1
    [[ -f "${CMUX_COMPANION_UPDATER_REPOSITORY}/scripts/${script_name}" ]] || return 1
    print -r -- "${CMUX_COMPANION_UPDATER_REPOSITORY}/scripts/${script_name}"
    return
  fi
  for candidate_dir in "${HOME}/.local/share/cmux-companion/current/updater" "${checkout_root}/updater"; do
    if [[ -f "${candidate_dir}/scripts/${script_name}" ]]; then
      print -r -- "${candidate_dir}/scripts/${script_name}"
      return
    fi
  done
  return 1
}
