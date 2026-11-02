#!/usr/bin/env bash
set -euo pipefail

source scripts/load-env-defaults.sh
load_env_defaults .env

NAME="${PM2_NAME:-vertex-ibkr-account-heartbeat}"

if pm2 describe "$NAME" >/dev/null 2>&1; then
  pm2 restart "$NAME" --update-env
else
  pm2 start "scripts/ibkr-account-heartbeat.sh" --name "$NAME" --time
fi

pm2 show "$NAME"
