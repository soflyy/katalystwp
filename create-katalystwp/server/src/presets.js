// Provisioning presets — saved, reusable "blueprints" for a new environment:
// a setup script (run in the workspace as `node`), wp-config `defines`, and an
// ordered `activate` list. These map 1:1 to the scaffolder's --setup-script /
// --defines / --activate flags (see engine.js / PR #34).
//
// Presets live in the server's DATA dir (data/presets.json), NOT in the repo —
// they're user data, editable and deletable from the UI. The file is seeded
// once, on first run, with a built-in "Oxygen" preset (the PR's breakdance
// example); after that the on-disk copy is authoritative and the seed never
// runs again, so user edits/deletes stick.
//
// Mirrors registry.js: an async mutex serializes mutations and each write is an
// atomic temp+rename so a crash mid-write can't corrupt the file.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createMutex } from './registry.js';

// First-run seed. Kept here as bootstrap defaults only — the live, editable copy
// lives in data/presets.json. The Oxygen / Breakdance / FutureLayer presets all
// build soflyy/breakdance from source (private — GH_TOKEN is forwarded into the
// workspace during setup); they differ only in BREAKDANCE_MODE and which plugins
// they activate.
const BREAKDANCE_SETUP_SCRIPT = `#!/usr/bin/env bash
# Build Breakdance from source. Runs in the workspace as \`node\`, cwd /home/node,
# WordPress at /home/node/wp. Idempotent: skip the clone if present.
set -euo pipefail
cd /home/node
if [ ! -d /home/node/breakdance ]; then
  gh repo clone soflyy/breakdance
fi
# no-plugin-activate (soflyy/breakdance#9441): build + symlink, but DON'T let
# setup.sh activate every breakdance plugin — the preset's own \`activate\` list
# decides which ones go live.
cd /home/node/breakdance && ./scripts/setup.sh --wp-root=/home/node/wp no-plugin-activate
`;

// Shared from-source dev constants; BREAKDANCE_MODE is set per preset. Applied
// before the setup script runs so the builder activates cleanly:
//   BREAKDANCE_DEVELOPMENT_ENVIRONMENT — dev mode.
//   BREAKDANCE_USE_MONOREPO_PATH — load assets from the monorepo checkout.
const BREAKDANCE_BASE_DEFINES = {
  BREAKDANCE_DEVELOPMENT_ENVIRONMENT: true,
  BREAKDANCE_USE_MONOREPO_PATH: true,
  WP_DEBUG: true,
  WP_DEBUG_LOG: true,
  WP_DEBUG_DISPLAY: false,
  SCRIPT_DEBUG: true,
  WP_MEMORY_LIMIT: '512M',
  DISALLOW_FILE_MODS: false,
};

// Long-running dev build (runs in the dedicated 'dev' container for as long as
// the stack is up; the dev-supervisor self-heals until the breakdance checkout
// the setup script clones exists).
const BREAKDANCE_DEV_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
cd /home/node/breakdance
npm run dev:codespace
`;

// FutureLayer = Breakdance-from-source + the app-dot-futurelayer Next.js app
// (which \`npm run dev:codespace\` also starts, on container port 3000 — pair
// with appPorts: [3000] so browsers can reach it). This block wires WP to the
// local app the way the monorepo's GitHub Codespace did:
//   - plugin URL overrides: PHP → http://workspace:3000 (the dev container
//     shares the workspace's network namespace); browser → the published host
//     port (SANDBOX_APP_PORT_3000 @ SANDBOX_PUBLIC_HOST).
//   - the app's .env, decoded from the base64 server secret forwarded as
//     LOCAL_DEV_APP_DOT_FUTURELAYER_DOT_ENV_FILE_CONTENTS_BASE64 (see
//     "Setup secrets" in README.md). Without it the app boots with every
//     integration (Clerk, Supabase, OpenAI, …) dead.
//   - the canonical-upload-URLs mu-plugin, pinned to this env's public URL, so
//     uploads made via http://wordpress (Playwright/MCP) don't save that
//     internal host into attachment URLs.
const FUTURELAYER_SETUP_SCRIPT = `${BREAKDANCE_SETUP_SCRIPT}
# ---- FutureLayer app (app-dot-futurelayer) ----
wp option update futurelayer_app_url_override_backend "http://workspace:3000"
if [ -n "\${SANDBOX_APP_PORT_3000:-}" ]; then
  wp option update futurelayer_app_url_override_browser "http://\${SANDBOX_PUBLIC_HOST:-localhost}:\${SANDBOX_APP_PORT_3000}"
fi

if [ -n "\${LOCAL_DEV_APP_DOT_FUTURELAYER_DOT_ENV_FILE_CONTENTS_BASE64:-}" ]; then
  if ! printf '%s' "\$LOCAL_DEV_APP_DOT_FUTURELAYER_DOT_ENV_FILE_CONTENTS_BASE64" | base64 -d > /home/node/breakdance/apps/app-dot-futurelayer/.env; then
    echo "ERROR: LOCAL_DEV_APP_DOT_FUTURELAYER_DOT_ENV_FILE_CONTENTS_BASE64 did not decode — is it valid base64 (base64 -w0 .env)?" >&2
    exit 1
  fi
  echo "wrote apps/app-dot-futurelayer/.env"
else
  echo "WARNING: LOCAL_DEV_APP_DOT_FUTURELAYER_DOT_ENV_FILE_CONTENTS_BASE64 not set — the FutureLayer app will run without secrets"
fi

MU_SRC=/home/node/breakdance/.devcontainer/mu-plugin-canonical-upload-urls.php
if [ -f "\$MU_SRC" ]; then
  mkdir -p /home/node/wp/wp-content/mu-plugins
  cp -f "\$MU_SRC" /home/node/wp/wp-content/mu-plugins/canonical-upload-urls.php
  wp config set FUTURELAYER_DEV_CANONICAL_URL "http://\${SANDBOX_PUBLIC_HOST:-localhost}:\${SANDBOX_WP_PORT:-80}" --type=constant
fi
`;

// Agent Connector (dev): replace the release-zip gateway the scaffolder installs
// with a live git checkout of the repo, so an agent develops the real plugin.
// Runs as a setup script (cwd /home/node); the scaffolder's install-agent-connector.sh
// then sees it already active and keeps the checkout instead of reinstalling the
// release. gh uses the GH_TOKEN/GITHUB_TOKEN forwarded into the workspace.
const AGENT_CONNECTOR_SETUP_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
SLUG=agent-connector-for-wp
DEST=/home/node/$SLUG

# Drop any release-zip copies, then check out the repo (idempotent: update if present).
wp plugin delete "$SLUG" universal-abilities-plugin >/dev/null 2>&1 || true
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --all --prune
else
  rm -rf "$DEST"
  gh repo clone soflyy/agent-connector-for-wp "$DEST"
fi

# Symlink both the gateway and the Universal Abilities companion from the checkout,
# composer-install where needed (vendor/ is gitignored), and activate in order
# (the companion declares Requires Plugins: agent-connector-for-wp).
link_plugin() {
  subdir="$1"; slug="$2"
  [ -d "$DEST/$subdir" ] || return 0
  [ -f "$DEST/$subdir/composer.json" ] && composer install --no-dev --no-interaction --no-progress -d "$DEST/$subdir"
  rm -rf "/home/node/wp/wp-content/plugins/$slug"
  ln -s "$DEST/$subdir" "/home/node/wp/wp-content/plugins/$slug"
}
link_plugin plugin "$SLUG"
link_plugin universal-abilities-plugin universal-abilities-plugin
wp plugin activate "$SLUG"
wp plugin activate universal-abilities-plugin || true

# If the repo ships a skill installer, link its skill(s) into the agents' dirs (non-fatal).
SKILL_INSTALLER="$DEST/abilities-generator/scripts/install-skill.sh"
if [ -f "$SKILL_INSTALLER" ]; then
  ( cd "$DEST/abilities-generator" && bash scripts/install-skill.sh ) || echo "  (claude skill install failed; continuing)"
  ( cd "$DEST/abilities-generator" && CLAUDE_SKILLS_DIR=/home/node/.cursor/skills bash scripts/install-skill.sh ) || echo "  (cursor skill install failed; continuing)"
fi
echo "✓ agent-connector-for-wp + universal-abilities-plugin now served from the git checkout at $DEST"
`;

const SEED_PRESETS = [
  {
    name: 'Oxygen',
    description: 'Oxygen builder, built from soflyy/breakdance (BREAKDANCE_MODE=oxygen).',
    setupScript: BREAKDANCE_SETUP_SCRIPT,
    defines: { BREAKDANCE_MODE: 'oxygen', ...BREAKDANCE_BASE_DEFINES },
    activate: ['oxygen-elements', 'breakdance-elements', 'breakdance-main'],
    devScript: BREAKDANCE_DEV_SCRIPT,
  },
  {
    name: 'Breakdance',
    description: 'Breakdance builder, built from soflyy/breakdance (BREAKDANCE_MODE=breakdance).',
    setupScript: BREAKDANCE_SETUP_SCRIPT,
    defines: { BREAKDANCE_MODE: 'breakdance', ...BREAKDANCE_BASE_DEFINES },
    // Order matters: elements → main → woocommerce.
    activate: ['breakdance-elements', 'breakdance-main', 'breakdance-woocommerce'],
    devScript: BREAKDANCE_DEV_SCRIPT,
  },
  {
    name: 'FutureLayer',
    description: 'Breakdance + the FutureLayer plugin and app-dot-futurelayer (Next.js, published on an app port), built from soflyy/breakdance.',
    setupScript: FUTURELAYER_SETUP_SCRIPT,
    defines: { BREAKDANCE_MODE: 'breakdance', ...BREAKDANCE_BASE_DEFINES },
    // Breakdance order, then breakdance-ai, then futurelayer-plugin.
    activate: ['breakdance-elements', 'breakdance-main', 'breakdance-woocommerce', 'breakdance-ai', 'futurelayer-plugin'],
    devScript: BREAKDANCE_DEV_SCRIPT,
    appPorts: [3000],
  },
  {
    name: 'Agent Connector (dev)',
    description: 'Develop agent-connector-for-wp (gateway + Universal Abilities) from a live git checkout.',
    setupScript: AGENT_CONNECTOR_SETUP_SCRIPT,
    defines: {},
    activate: [],
    devScript: '',
  },
];

export class PresetStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, presets: {} };
    this.mutex = createMutex();
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.presets) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Fresh install: seed the built-in presets, then persist.
      await mkdir(dirname(this.path), { recursive: true });
      for (const p of SEED_PRESETS) this._insert(p);
      await this._persist();
    }
    return this;
  }

  list() {
    return Object.values(this.data.presets).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  get(id) {
    return this.data.presets[id] || null;
  }

  create(input) {
    return this.mutex(async () => {
      const rec = this._insert(input);
      await this._persist();
      return rec;
    });
  }

  update(id, patch) {
    return this.mutex(async () => {
      const rec = this.data.presets[id];
      if (!rec) return null;
      const now = new Date().toISOString();
      Object.assign(rec, sanitize(patch), { id: rec.id, createdAt: rec.createdAt, updatedAt: now });
      await this._persist();
      return rec;
    });
  }

  remove(id) {
    return this.mutex(async () => {
      const existed = !!this.data.presets[id];
      delete this.data.presets[id];
      await this._persist();
      return existed;
    });
  }

  // Insert into the in-memory map without persisting (caller persists).
  _insert(input) {
    const id = `preset_${randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    const rec = { id, ...sanitize(input), createdAt: now, updatedAt: now };
    this.data.presets[id] = rec;
    return rec;
  }

  async _persist() {
    const tmp = join(dirname(this.path), `.presets.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }
}

// Coerce a preset's user-supplied fields into the stored shape. (Field-level
// validation — slug/const-name shapes — happens at the route layer.)
function sanitize(input = {}) {
  return {
    name: String(input.name || '').trim() || 'Untitled',
    description: typeof input.description === 'string' ? input.description : '',
    setupScript: typeof input.setupScript === 'string' ? input.setupScript : '',
    devScript: typeof input.devScript === 'string' ? input.devScript : '',
    defines:
      input.defines && typeof input.defines === 'object' && !Array.isArray(input.defines) ? input.defines : {},
    activate: Array.isArray(input.activate)
      ? input.activate.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
      : [],
    appPorts: Array.isArray(input.appPorts)
      ? [...new Set(input.appPorts.map((p) => parseInt(p, 10)).filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535))]
      : [],
  };
}
