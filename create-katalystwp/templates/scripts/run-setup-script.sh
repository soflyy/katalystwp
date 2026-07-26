#!/usr/bin/env bash
#
# Run the user-provided setup script (sandbox.config.json "setupScript") inside
# the workspace container as the `node` user — the same place `npm run bash`
# drops you, with the WordPress tree at /home/node/wp. Use it to clone a repo
# and run its installer, build a plugin/theme, seed content, etc. Run via
# `npm run setup`, after wp-config defines and before plugin activation, so a
# plugin the script drops into wp-content can then be activated.
#
# The script is piped in over stdin (bash -s) and runs with cwd /home/node, so
# `gh repo clone <repo>` lands a checkout right next to ./wp. Re-runnability is
# up to the script — `npm run setup` may run it again, so guard side effects
# (e.g. skip a clone if the directory already exists).
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

CONFIG="sandbox.config.json"
if [ ! -f "$CONFIG" ]; then
  echo "→ No $CONFIG — skipping setup script."
  exit 0
fi

SCRIPT="$(node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(typeof cfg.setupScript === "string" ? cfg.setupScript : "");
' "$CONFIG")"

if [ -z "$SCRIPT" ]; then
  echo "→ No setupScript in $CONFIG — skipping."
  exit 0
fi
if [ ! -f "$SCRIPT" ]; then
  echo "✖ setupScript \"$SCRIPT\" not found (relative to the project root)." >&2
  exit 1
fi

echo "→ Running setup script ($SCRIPT) in the workspace as node…"

# Forward GitHub credentials from the host env when present, so the script can
# clone private repos (gh / git) without an interactive login in the container.
# (`gh auth login` inside the workspace also works and persists in workspace/.)
exec_args=(-T -w /home/node)
for v in GH_TOKEN GITHUB_TOKEN; do
  if [ -n "${!v:-}" ]; then exec_args+=(-e "$v"); fi
done

# Tell the setup script where this environment lives, so it can build URLs that
# are valid outside the Docker network (dev-app browser URLs, canonical hosts):
#   SANDBOX_PUBLIC_HOST          — PUBLIC_HOST from .env (--public-host)
#   SANDBOX_WP_PORT              — the site's published host port
#   SANDBOX_APP_PORT_<container> — host port for each --app-ports entry
# All are exported by name (-e NAME), so values stay off the command line.
export SANDBOX_PUBLIC_HOST="$(grep -E '^PUBLIC_HOST=' .env | head -1 | cut -d= -f2-)"
export SANDBOX_WP_PORT="$(grep -E '^WP_PORT=' .env | head -1 | cut -d= -f2-)"
exec_args+=(-e SANDBOX_PUBLIC_HOST -e SANDBOX_WP_PORT)
while IFS= read -r pair; do
  [ -n "$pair" ] || continue
  export "SANDBOX_APP_PORT_${pair%%=*}=${pair#*=}"
  exec_args+=(-e "SANDBOX_APP_PORT_${pair%%=*}")
done < <(node -e '
  const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const p of cfg.appPorts || []) console.log(`${p.container}=${p.host}`);
' "$CONFIG")

# Pass through operator-provided setup secrets: any SANDBOX_SETUP_ENV_<NAME> in
# this process's environment reaches the script as plain <NAME> — the same
# pattern as a GitHub Codespaces secret. Multiline values can't survive an
# env file, so store them base64-encoded and decode in the setup script.
while IFS= read -r name; do
  export "${name#SANDBOX_SETUP_ENV_}=${!name}"
  exec_args+=(-e "${name#SANDBOX_SETUP_ENV_}")
done < <(compgen -A variable | grep '^SANDBOX_SETUP_ENV_.' || true)

docker compose exec "${exec_args[@]}" workspace bash -s < "$SCRIPT"

echo "✓ Setup script complete."
