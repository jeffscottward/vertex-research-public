#!/usr/bin/env bash

load_env_defaults() {
  local env_file="${1:-.env}"
  [[ -f "$env_file" ]] || return 0

  local key
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if [[ -z "${!key+x}" ]]; then
      local value
      value="$(
        ENV_FILE="$env_file" ENV_KEY="$key" bash -c '
          set -a
          source "$ENV_FILE"
          set +a
          printf "%s" "${!ENV_KEY-}"
        '
      )"
      export "$key=$value"
    fi
  done < <(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$env_file")
}
