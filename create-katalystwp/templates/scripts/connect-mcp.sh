#!/usr/bin/env bash
#
# Connect the workspace's agents (Claude Code, Codex, and Cursor) to the MCP
# servers in this sandbox, so all can use them out of the box. Idempotent — re-run safe.
# Run via `npm run setup`.
#
#   - wordpress: the site's MCP server (Agent Connector for WP, which bundles
#     mcp-adapter), reached through Automattic's mcp-wordpress-remote stdio proxy
#     run locally via npx — the broadly-supported way to reach a WordPress MCP
#     server. It authenticates with a WordPress application password (no direct
#     HTTP transport). Needs pretty permalinks (enabled by install-wp.sh).
#   - playwright: the prebaked Playwright MCP service, over HTTP, for driving a
#     headless browser against the site at http://wordpress.
#
# Claude reads user-scope registrations (`claude mcp add`); Cursor reads
# ~/.cursor/mcp.json. Both persist in workspace/ across rebuilds. Everything runs
# inside a single `docker compose exec` so the minted app password never leaves
# the container (it's not captured into a host-side variable).
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# The admin user the MCP application password is minted for — must match the
# account install-wp.sh created (overridable via .env; defaults to admin).
if [ -f .env ]; then set -a; . ./.env; set +a; fi
WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"

# Is the WordPress MCP server available? (Agent Connector active.)
HAS_WP=0
if docker compose exec -T workspace wp plugin is-active agent-connector-for-wp >/dev/null 2>&1; then
  HAS_WP=1
else
  echo "→ agent-connector-for-wp plugin not active — skipping the WordPress MCP server (both agents)."
fi

# All registration happens in-container. HAS_WP is $1, the admin user is $2 (to
# sh -s); the app password is minted and used here, never surfacing on the host.
docker compose exec -T workspace sh -s "$HAS_WP" "$WP_ADMIN_USER" <<'EOF'
set -e
HAS_WP="$1"
ADMIN_USER="$2"
WP_MCP_URL="http://wordpress/wp-json/mcp/mcp-adapter-default-server"
PLAYWRIGHT_URL="http://playwright:8931/mcp"
APPPASS=""

if [ "$HAS_WP" = "1" ]; then
  # Reset the admin user's app passwords (the sandbox only uses them for this)
  # and mint a fresh one — the plaintext is only available at creation time.
  wp user application-password delete "$ADMIN_USER" --all >/dev/null 2>&1 || true
  APPPASS=$(wp user application-password create "$ADMIN_USER" "agent-sandbox" --porcelain)

  echo "→ Connecting Claude to the WordPress MCP server (mcp-wordpress-remote proxy)…"
  claude mcp remove wordpress --scope user >/dev/null 2>&1 || true
  claude mcp add wordpress --scope user \
    --env WP_API_URL="$WP_MCP_URL" \
    --env WP_API_USERNAME="$ADMIN_USER" \
    --env WP_API_PASSWORD="$APPPASS" \
    --env OAUTH_ENABLED=false \
    -- npx -y @automattic/mcp-wordpress-remote
fi

echo "→ Connecting Claude to the Playwright MCP server…"
claude mcp remove playwright --scope user >/dev/null 2>&1 || true
claude mcp add playwright --scope user --transport http "$PLAYWRIGHT_URL"

# Cursor reads ~/.cursor/mcp.json (same servers, its own format). Merge into any
# existing file so a manual login or other servers aren't clobbered. The proxy
# command + the playwright HTTP url mirror the Claude registrations above.
# Non-fatal: if the home dir isn't writable (e.g. a root-owned /home/node from
# scaffolding as a non-1000 host user), warn and continue rather than aborting
# setup — Claude registration above is independent.
echo "→ Connecting Cursor to the MCP servers (~/.cursor/mcp.json)…"
if HAS_WP="$HAS_WP" APPPASS="$APPPASS" WP_API_USERNAME="$ADMIN_USER" WP_MCP_URL="$WP_MCP_URL" PLAYWRIGHT_URL="$PLAYWRIGHT_URL" node -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = path.join(os.homedir(), ".cursor");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "mcp.json");
  let c = {};
  try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  c.mcpServers = c.mcpServers || {};
  if (process.env.HAS_WP === "1") {
    c.mcpServers.wordpress = {
      command: "npx",
      args: ["-y", "@automattic/mcp-wordpress-remote"],
      env: {
        WP_API_URL: process.env.WP_MCP_URL,
        WP_API_USERNAME: process.env.WP_API_USERNAME,
        WP_API_PASSWORD: process.env.APPPASS,
        OAUTH_ENABLED: "false",
      },
    };
  } else {
    delete c.mcpServers.wordpress;
  }
  c.mcpServers.playwright = { url: process.env.PLAYWRIGHT_URL };
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
'; then
  echo "✓ MCP servers registered for Claude ('claude mcp list') and Cursor (~/.cursor/mcp.json)."
else
  echo "⚠ Could not write ~/.cursor/mcp.json (is /home/node writable by the node user?)." >&2
  echo "  Skipping Cursor's MCP setup — Claude is registered and unaffected. Fix the" >&2
  echo "  workspace/ ownership (it must be uid 1000) and re-run: bash scripts/connect-mcp.sh" >&2
fi

# Codex (~/.codex/config.toml, via `codex mcp add`). Same servers as above. Skipped
# when codex isn't installed (older env images); each add is non-fatal so a Codex
# hiccup never breaks the Claude/Cursor setup. stdio for wordpress (--env), HTTP
# (--url) for playwright.
if command -v codex >/dev/null 2>&1; then
  echo "→ Connecting Codex to the MCP servers (~/.codex/config.toml)…"
  if [ "$HAS_WP" = "1" ]; then
    codex mcp remove wordpress >/dev/null 2>&1 || true
    if codex mcp add wordpress \
      --env WP_API_URL="$WP_MCP_URL" \
      --env WP_API_USERNAME="$ADMIN_USER" \
      --env WP_API_PASSWORD="$APPPASS" \
      --env OAUTH_ENABLED=false \
      -- npx -y @automattic/mcp-wordpress-remote >/dev/null 2>&1; then
      echo "  ✓ codex: wordpress"
    else
      echo "  ⚠ codex: 'mcp add wordpress' failed (continuing)" >&2
    fi
  fi
  codex mcp remove playwright >/dev/null 2>&1 || true
  if codex mcp add playwright --url "$PLAYWRIGHT_URL" >/dev/null 2>&1; then
    echo "  ✓ codex: playwright"
  else
    echo "  ⚠ codex: 'mcp add playwright' failed (continuing)" >&2
  fi
else
  echo "→ codex not installed in this env — skipping Codex MCP setup."
fi

# OpenCode (~/.config/opencode/opencode.json). Merge the mcp section (preserving
# other config). wordpress = local (stdio) with env; playwright = remote (http).
# Skipped when opencode isn't installed; non-fatal.
if command -v opencode >/dev/null 2>&1; then
  echo "→ Connecting OpenCode to the MCP servers (~/.config/opencode/opencode.json)…"
  if HAS_WP="$HAS_WP" APPPASS="$APPPASS" WP_API_USERNAME="$ADMIN_USER" WP_MCP_URL="$WP_MCP_URL" PLAYWRIGHT_URL="$PLAYWRIGHT_URL" node -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = path.join(os.homedir(), ".config", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "opencode.json");
    let c = {};
    try { c = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    c["$schema"] = "https://opencode.ai/config.json";
    c.mcp = c.mcp || {};
    if (process.env.HAS_WP === "1") {
      c.mcp.wordpress = {
        type: "local",
        command: ["npx", "-y", "@automattic/mcp-wordpress-remote"],
        environment: {
          WP_API_URL: process.env.WP_MCP_URL,
          WP_API_USERNAME: process.env.WP_API_USERNAME,
          WP_API_PASSWORD: process.env.APPPASS,
          OAUTH_ENABLED: "false",
        },
        enabled: true,
      };
    } else {
      delete c.mcp.wordpress;
    }
    c.mcp.playwright = { type: "remote", url: process.env.PLAYWRIGHT_URL, enabled: true };
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  '; then
    echo "  ✓ opencode: wordpress + playwright"
  else
    echo "  ⚠ opencode: MCP config write failed (continuing)" >&2
  fi
else
  echo "→ opencode not installed in this env — skipping OpenCode MCP setup."
fi
EOF

echo "✓ Run 'npm run claude' or 'npm run cursor' and use the MCP servers right away."
