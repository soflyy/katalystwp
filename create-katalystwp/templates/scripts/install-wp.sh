#!/usr/bin/env bash
#
# Install WordPress (admin / password) via WP-CLI in the workspace container and
# enable pretty permalinks (run via `npm run setup`). Idempotent. Assumes the
# stack is up.
#
set -euo pipefail

# This script lives in scripts/ — operate from the project root.
cd "$(dirname "$0")/.."

# Load .env for the host port, used as the site URL.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi
WP_PORT="${WP_PORT:-8080}"
# Admin account — overridable from .env; defaults to admin / password.
WP_ADMIN_USER="${WP_ADMIN_USER:-admin}"
WP_ADMIN_PASSWORD="${WP_ADMIN_PASSWORD:-password}"
WP_ADMIN_EMAIL="${WP_ADMIN_EMAIL:-admin@example.com}"
# Site title — defaults to the project name (set at scaffold time), else a generic.
WP_SITE_TITLE="${WP_SITE_TITLE:-WordPress Dev}"

if docker compose exec -T workspace wp core is-installed >/dev/null 2>&1; then
  echo "✓ WordPress is already installed — nothing to do."
else
  echo "→ Installing WordPress…"
  docker compose exec -T workspace wp core install \
    --url="http://localhost:${WP_PORT}" \
    --title="${WP_SITE_TITLE}" \
    --admin_user="${WP_ADMIN_USER}" \
    --admin_password="${WP_ADMIN_PASSWORD}" \
    --admin_email="${WP_ADMIN_EMAIL}" \
    --skip-email
  cat <<EOF
✓ WordPress installed.
    Site:     http://localhost:${WP_PORT}
    Admin:    http://localhost:${WP_PORT}/wp-admin/  (${WP_ADMIN_USER} / ${WP_ADMIN_PASSWORD})
EOF
fi

# Pretty permalinks (idempotent). Needed so the REST API is reachable at the
# clean /wp-json/ paths (e.g. the WordPress MCP server). WP-CLI's --hard flush
# only writes .htaccess when it detects Apache's mod_rewrite, which it can't from
# the workspace container — so we write the standard rules ourselves (Apache has
# mod_rewrite + AllowOverride All, so they take effect). We write from inside the
# workspace container rather than the host: it owns the WordPress tree (uid 1000,
# see APACHE_RUN_USER in docker-compose.yml), so this doesn't depend on the host
# user's uid matching — which it wouldn't, on Linux.
echo "→ Enabling pretty permalinks…"
docker compose exec -T workspace wp rewrite structure '/%postname%/' >/dev/null
docker compose exec -T workspace sh -c 'cat > wp/.htaccess' <<'HT'
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
HT
echo "✓ Pretty permalinks enabled."
