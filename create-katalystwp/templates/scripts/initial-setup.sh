#!/usr/bin/env bash
#
# One-time setup: build & start the stack, wait for it to be ready, then run the
# provisioning steps. Re-runnable — every step is idempotent.
#
# Day to day you just use `npm run start`; this is only for the first bring-up
# (or after `npm run reset`).
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

echo "→ Building and starting containers…"
docker compose up -d --build

echo "→ Waiting for WordPress files and the database…"
tries=0
until docker compose exec -T workspace bash -c '[ -f /home/node/wp/wp-config.php ] && wp db query "SELECT 1;"' >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    echo "✖ Timed out waiting for the stack to come up." >&2
    exit 1
  fi
  sleep 2
done

# Provisioning steps — each is an idempotent host-side script that runs WP-CLI
# in the workspace container. Add more steps here as setup grows.
bash scripts/install-wp.sh
bash scripts/apply-defines.sh
bash scripts/run-setup-script.sh
bash scripts/install-plugins.sh
bash scripts/install-agent-connector.sh
bash scripts/connect-mcp.sh
bash scripts/install-skills.sh

echo ""
echo "✓ Initial setup complete."
