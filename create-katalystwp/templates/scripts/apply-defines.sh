#!/usr/bin/env bash
#
# Write the constants declared under "defines" in sandbox.config.json into
# wp-config.php (run via `npm run setup`, before the setup script so it sees
# them). Idempotent — `wp config set` updates an existing constant in place and
# inserts new ones in the right spot (above the "stop editing" marker), so we
# don't have to know where in the file they belong.
#
# sandbox.config.json format:
#   { "defines": {
#       "WP_DEBUG": true,                       // bool/number -> raw PHP literal
#       "WP_MEMORY_LIMIT": "256M",              // string      -> quoted
#       "MY_FLAG": { "value": "X", "raw": true } // force a raw (unquoted) value
#   }}
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

CONFIG="sandbox.config.json"
if [ ! -f "$CONFIG" ]; then
  echo "→ No $CONFIG — skipping defines."
  exit 0
fi

# Flatten "defines" to tab-separated rows: name<TAB>raw(0|1)<TAB>value.
# JSON booleans/numbers become raw PHP literals (true/false/256); strings are
# quoted by WP-CLI; an object { value, raw } lets you force either.
rows="$(node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const defines = cfg.defines || {};
  for (const [name, v] of Object.entries(defines)) {
    let value, raw;
    if (v !== null && typeof v === "object") { value = String(v.value); raw = v.raw ? "1" : "0"; }
    else if (typeof v === "boolean" || typeof v === "number") { value = String(v); raw = "1"; }
    else { value = String(v); raw = "0"; }
    process.stdout.write([name, raw, value].join("\t") + "\n");
  }
' "$CONFIG")"

if [ -z "$rows" ]; then
  echo "→ No defines listed in $CONFIG."
  exit 0
fi

printf '%s\n' "$rows" | while IFS=$'\t' read -r name raw value; do
  [ -n "$name" ] || continue
  args=(config set "$name" "$value" --type=constant)
  [ "$raw" = "1" ] && args+=(--raw)
  echo "→ define( '$name', … )"
  # </dev/null so `docker compose exec` doesn't swallow the loop's remaining rows.
  docker compose exec -T workspace wp "${args[@]}" </dev/null
done

echo "✓ wp-config.php constants applied."
