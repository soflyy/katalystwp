#!/usr/bin/env bash
#
# Install & activate the plugins declared in sandbox.config.json (run via
# `npm run setup`). Idempotent: WP-CLI skips plugins that are already installed.
# Assumes the stack is up and WordPress is installed.
#
# sandbox.config.json format:
#   { "plugins": [
#       "ai",                                  // shorthand: wordpress.org slug
#       { "source": "akismet", "activate": false, "version": "5.3" },
#       { "source": "https://example.com/plugin.zip", "activate": true }
#   ],
#     "activate": ["oxygen-elements", "breakdance-main"]  // see below
#   }
# "source" is a wordpress.org slug or a URL/path to a plugin zip. "activate"
# (the per-plugin flag) defaults to true; "version" is optional (slugs only).
#
# The top-level "activate" array activates already-present plugins — ones a
# setup script dropped into wp-content (so there's nothing to install) — in the
# exact order listed. It runs after the install loop, and after the setup
# script, so the plugins exist by then.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

CONFIG="sandbox.config.json"
if [ ! -f "$CONFIG" ]; then
  echo "→ No $CONFIG — skipping plugins."
  exit 0
fi

# Flatten the plugins array to tab-separated rows: source<TAB>activate<TAB>version.
rows="$(node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const p of cfg.plugins ?? []) {
    const e = typeof p === "string" ? { source: p } : (p || {});
    if (!e.source) continue;
    const activate = e.activate === false ? "0" : "1";
    process.stdout.write([e.source, activate, e.version ?? ""].join("\t") + "\n");
  }
' "$CONFIG")"

if [ -z "$rows" ]; then
  echo "→ No plugins to install from $CONFIG."
else
  printf '%s\n' "$rows" | while IFS=$'\t' read -r source activate version; do
    [ -n "$source" ] || continue
    args=(plugin install "$source")
    label="$source${version:+ @$version}"
    # wordpress.org slugs are idempotent (already-installed exits 0), but a zip URL
    # errors on reinstall ("destination folder already exists") — --force fixes it.
    case "$source" in
      *://*) args+=(--force) ;;
    esac
    if [ -n "$version" ]; then args+=(--version="$version"); fi
    if [ "$activate" = "1" ]; then args+=(--activate); label="$label (activate)"; fi
    echo "→ Plugin: $label"
    # </dev/null so `docker compose exec` doesn't swallow the loop's remaining rows.
    docker compose exec -T workspace wp "${args[@]}" </dev/null
  done
fi

# Activate already-present plugins (e.g. dropped into wp-content by the setup
# script) in the exact order listed under "activate". `wp plugin activate` is
# idempotent — an already-active plugin just reports so and exits 0.
activate_rows="$(node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const slug of cfg.activate ?? []) {
    if (typeof slug === "string" && slug) process.stdout.write(slug + "\n");
  }
' "$CONFIG")"

if [ -n "$activate_rows" ]; then
  printf '%s\n' "$activate_rows" | while IFS= read -r slug; do
    [ -n "$slug" ] || continue
    echo "→ Activate: $slug"
    # </dev/null so `docker compose exec` doesn't swallow the loop's remaining rows.
    docker compose exec -T workspace wp plugin activate "$slug" </dev/null
  done
fi

echo "✓ Plugins processed."
