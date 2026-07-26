#!/usr/bin/env bash
#
# Install the sandbox's agent skills into the workspace, and expose the
# WordPress MCP helper (baked into the image at /usr/local/bin) at the documented
# /home/node/bin path. Re-run safe (overwrites / idempotent). Run via `npm run setup`.
#
# Skills: copied from the project's skills/ dir into BOTH agents' personal skills
# dirs — ~/.claude/skills (Claude) and ~/.cursor/skills (Cursor). We copy rather
# than bind-mount because a bind mount nested inside the ./workspace mount is
# unreliable on Docker Desktop. ./workspace is the workspace container's
# /home/node, so writing here lands where the agents load personal skills.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

if [ -d skills ] && [ -n "$(ls -A skills 2>/dev/null)" ]; then
  for dest in workspace/.claude/skills workspace/.cursor/skills; do
    mkdir -p "$dest"
    cp -R skills/. "$dest"/
  done
  # The host-side copy above is owned by whoever ran `npm run setup` — which is
  # root when this runs under the devbox control server. The agents run as the
  # node user (uid 1000) and need to add/symlink their OWN skills at runtime, so
  # hand the skill dirs to node. Done inside the container as root so it works
  # regardless of the host user's uid. Non-fatal (container may be down on a
  # standalone re-run).
  docker compose exec -T -u root workspace \
    chown -R node:node /home/node/.claude/skills /home/node/.cursor/skills >/dev/null 2>&1 || true
  echo "✓ Skills installed into the workspace (~/.claude/skills and ~/.cursor/skills)."
else
  echo "→ No skills/ to install — skipping."
fi

# Expose the image-baked WordPress MCP helper at /home/node/bin/cursor-wp-mcp-helper
# (the path its skill documents) and add /home/node/bin to interactive shells'
# PATH. The helper is already on PATH via /usr/local/bin for non-interactive use
# (npm run cursor, agent shell tools) — this is for parity with the skill's paths
# and human shells. Done in-container so the symlink resolves; non-fatal so a
# non-writable /home/node can't abort setup.
echo "→ Exposing cursor-wp-mcp-helper at /home/node/bin…"
if docker compose exec -T workspace sh <<'EOF'
set -e
mkdir -p /home/node/bin
ln -sf /usr/local/bin/cursor-wp-mcp-helper /home/node/bin/cursor-wp-mcp-helper
if ! grep -qs '/home/node/bin' /home/node/.bashrc 2>/dev/null; then
  printf '%s\n' \
    'case ":$PATH:" in' \
    '  *:/home/node/bin:*) ;;' \
    '  *) export PATH="/home/node/bin:$PATH" ;;' \
    'esac' >> /home/node/.bashrc
fi
if [ ! -f /home/node/.bash_profile ]; then
  printf '%s\n' \
    'if [ -f "$HOME/.bashrc" ]; then' \
    '  . "$HOME/.bashrc"' \
    'fi' > /home/node/.bash_profile
fi
EOF
then
  echo "✓ cursor-wp-mcp-helper available at /home/node/bin (and on PATH as 'cursor-wp-mcp-helper')."
else
  echo "⚠ Could not set up /home/node/bin (is /home/node writable by the node user?)." >&2
  echo "  The helper is still usable on PATH as 'cursor-wp-mcp-helper' (baked into the image)." >&2
fi
