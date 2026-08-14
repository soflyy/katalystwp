// Server configuration, read once from the environment and frozen.
//
// Secrets (the GitHub + Claude tokens, managed on the Settings page) live in
// data/settings.json and the env of the child processes we spawn — never in
// request bodies, responses, the registry, or logs. See log.js for the redactor.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
// The scaffolder repo root (this server lives in <repo>/server).
const DEFAULT_SCAFFOLDER_DIR = resolve(SERVER_ROOT, '..');

function abs(p, fallback) {
  const v = p || fallback;
  return isAbsolute(v) ? v : resolve(SERVER_ROOT, v);
}

function parseRange(raw, fallback) {
  const [lo, hi] = (raw || fallback).split('-').map((n) => parseInt(n.trim(), 10));
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < lo || hi > 65535) {
    throw new Error(`Invalid WP_PORT_RANGE "${raw}" — expected "<lo>-<hi>", e.g. 9000-9999`);
  }
  return { lo, hi };
}

export function loadConfig(env = process.env) {
  // Credentials (GitHub + Claude tokens, WP admin defaults) are managed on the
  // Settings page now and stored in data/settings.json — env vars only SEED that
  // file on first run, so none are required to boot. (DEVBOX_API_TOKEN is the
  // exception — it gates this very API, so it must be set before start.)
  const dataDir = abs(env.DEVBOX_DATA_DIR, join(SERVER_ROOT, 'data'));

  const config = {
    // HTTP
    port: parseInt(env.DEVBOX_PORT || '4000', 10),
    bind: env.DEVBOX_BIND || '127.0.0.1',
    apiToken: env.DEVBOX_API_TOKEN || null, // optional bearer auth

    // Paths
    scaffolderDir: abs(env.SCAFFOLDER_DIR, DEFAULT_SCAFFOLDER_DIR),
    uiRoot: join(SERVER_ROOT, 'ui'),
    dataDir,
    envsDir: abs(env.DEVBOX_ENVS_DIR, join(dataDir, 'envs')),
    registryPath: join(dataDir, 'registry.json'),
    presetsPath: join(dataDir, 'presets.json'),
    settingsPath: join(dataDir, 'settings.json'),
    // Server-scoped XDG_CONFIG_HOME handed to the scaffolder so the WP-admin
    // defaults from Settings seed new sites WITHOUT touching the operator's real
    // ~/.config/create-katalystwp/config.json.
    scaffolderConfigHome: join(dataDir, 'xdg'),
    // Scratch space where the server materializes a create's setup-script /
    // defines files to hand the scaffolder as --setup-script / --defines paths.
    // The scaffolder copies their contents into the project (scripts/user-setup.sh
    // + sandbox.config.json), so these are throwaway and cleaned up after scaffold.
    scratchDir: join(dataDir, 'scratch'),

    // The hostname/IP browsers use to reach this Docker host — handed to the
    // scaffolder as --public-host so setup scripts can build browser-valid URLs
    // (SANDBOX_PUBLIC_HOST). On a remote box set the public IP or a DNS name.
    publicHost: env.DEVBOX_PUBLIC_HOST || 'localhost',

    // Allocation / limits
    portRange: parseRange(env.WP_PORT_RANGE, '9000-9999'),
    // Two independent caps, because stored and running envs cost different
    // resources. maxEnvironments bounds TOTAL stored records (running + stopped +
    // warm pool) — a high safety backstop; the real limit on stored envs is disk
    // (see minFreeDiskGb), since a stopped env idles at ~0 CPU/RAM. maxRunning
    // bounds envs whose containers are up (or coming up) — the CPU/RAM guardrail.
    maxEnvironments: parseInt(env.MAX_ENVIRONMENTS || '200', 10),
    maxRunning: Math.max(1, parseInt(env.MAX_RUNNING || '10', 10)),
    // Refuse new allocations (user create or warm build) when free disk on the
    // data filesystem drops below this — stops a runaway pool from filling the
    // disk. 0 disables the guard.
    minFreeDiskGb: Math.max(0, parseFloat(env.MIN_FREE_DISK_GB || '10')),
    buildConcurrency: Math.max(1, parseInt(env.BUILD_CONCURRENCY || '2', 10)),
    // Status prober: rest between full sweeps, and the delay between probing one
    // env and the next WITHIN a sweep. The sweep is serial (one env at a time),
    // so spacing directly bounds how hard it hits docker — never a burst.
    reconcileIntervalMs: parseInt(env.RECONCILE_INTERVAL_MS || '45000', 10),
    probeSpacingMs: Math.max(0, parseInt(env.PROBE_SPACING_MS || '500', 10)),
    // Warm pool: free env slots reserved for on-demand creates (the pool builder
    // won't fill past maxEnvironments - reserve), and how often it tops up.
    warmPoolReserve: Math.max(0, parseInt(env.WARM_POOL_RESERVE || '5', 10)),
    warmPoolIntervalMs: parseInt(env.WARM_POOL_INTERVAL_MS || '20000', 10),

    // GitHub + Claude tokens are managed in Settings — these env values only
    // seed the settings file on first run.
    seedGithubToken: env.GITHUB_TOKEN || '',
    seedClaudeToken: env.CLAUDE_CODE_OAUTH_TOKEN || '',
    seedCodexToken: env.CODEX_API_KEY || '',
    seedOpencodeToken: env.OPENCODE_API_KEY || '',
    gitAuthorName: env.GIT_AUTHOR_NAME || 'devbox',
    gitAuthorEmail: env.GIT_AUTHOR_EMAIL || 'devbox@localhost',

    // Claude headless sessions. NO Claude token here on purpose — Claude is
    // driven through the env's own scripts/in-workspace.sh, which resolves
    // CLAUDE_CODE_OAUTH_TOKEN from this server process's env (e.g. server/.env)
    // or ~/.agent-sandbox/oauth-token, exactly like `npm run claude`.
    sessionsPath: join(dataDir, 'sessions.json'),
    sessionsDir: join(dataDir, 'sessions'),
    // Default model for sessions. The `opus` alias — resolved by Claude Code in
    // the workspace to the LATEST Opus at run time (no version pinned here) —
    // rather than Claude Code's built-in headless default (Sonnet),
    // since these are throwaway dev boxes where capability matters. Override with
    // any model id via CLAUDE_DEFAULT_MODEL, or per-session in the UI/API.
    claudeDefaultModel: env.CLAUDE_DEFAULT_MODEL || 'opus',
    // Codex (OpenAI) default model. null → let `codex exec` use its own default.
    codexDefaultModel: env.CODEX_DEFAULT_MODEL || null,
    // OpenCode (Zen gateway) default model, format opencode/<model>.
    opencodeDefaultModel: env.OPENCODE_DEFAULT_MODEL || 'opencode/claude-sonnet-4-6',
    sessionRingBufferSize: parseInt(env.SESSION_RING_BUFFER || '500', 10),
  };

  // Exposing this API to the network means exposing root-equivalent control of
  // the Docker host. Refuse to bind a non-loopback address without a bearer
  // token — otherwise anyone who can reach the port can create/destroy envs.
  const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
  if (!loopback.has(config.bind) && !config.apiToken) {
    throw new Error(
      `refusing to bind ${config.bind} (network-exposed) without DEVBOX_API_TOKEN. ` +
        `Set a bearer token (e.g. DEVBOX_API_TOKEN=$(openssl rand -hex 32)) and put this host behind a firewall/VPN.`,
    );
  }

  // Initial secret strings for the log redactor (env-seeded). Tokens managed in
  // Settings are added to the redactor after the settings store loads.
  // SANDBOX_SETUP_ENV_* values (setup secrets forwarded to every env's setup
  // script) are included so a script that echoes one is scrubbed from server
  // output AND the per-env setup log (see _spawnLogged). Best-effort: only the
  // value as stored is known here — a script that transforms it (e.g. base64
  // -d) before printing defeats this.
  const setupEnvSecrets = Object.keys(env)
    .filter((k) => k.startsWith('SANDBOX_SETUP_ENV_'))
    .map((k) => env[k]);
  config.secrets = [config.seedGithubToken, config.seedClaudeToken, config.seedCodexToken, config.seedOpencodeToken, ...setupEnvSecrets].filter(Boolean);
  return Object.freeze(config);
}
