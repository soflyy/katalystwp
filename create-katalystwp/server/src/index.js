#!/usr/bin/env node
// Devbox control server entrypoint: load .env, load config, init the registry,
// wire routes, start the HTTP server and the reconcile/supervision loop.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from './config.js';
import { initLog, addSecrets, log } from './log.js';
import { Registry } from './registry.js';
import { PresetStore } from './presets.js';
import { SettingsStore } from './settings.js';
import { Manager } from './manager.js';
import { SessionStore } from './sessions.js';
import { SessionBus } from './sessionbus.js';
import { ClaudeEngine, reapAgents } from './claude.js';
import { buildRoutes } from './routes.js';
import { createServer } from './http.js';

// Load server/.env (or $DEVBOX_ENV_FILE) into process.env if present, using
// Node's built-in loader (no dependency). Real environment variables already
// set take precedence, so systemd/export-based setups keep working.
function loadDotenv() {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = process.env.DEVBOX_ENV_FILE || join(serverRoot, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
    return envFile;
  }
  return null;
}

async function main() {
  const envFile = loadDotenv();
  const config = loadConfig();
  initLog(config.secrets);
  if (envFile) log.info(`loaded env from ${envFile}`);

  const registry = await new Registry(config.registryPath).load();
  const presets = await new PresetStore(config.presetsPath).load();
  // Mutable settings (tokens + WP-admin defaults), seeded from env on first run.
  const settings = await new SettingsStore(config.settingsPath, {
    githubToken: config.seedGithubToken,
    claudeToken: config.seedClaudeToken,
    codexToken: config.seedCodexToken,
    opencodeToken: config.seedOpencodeToken,
  }).load();
  addSecrets(settings.secrets()); // redact the stored tokens from logs too
  const manager = new Manager(config, registry, settings);
  manager.presets = presets; // warm-pool builder reads preset definitions

  // Claude session subsystem.
  const sessionStore = await new SessionStore(config.sessionsPath).load();
  await sessionStore.reconcile(); // running → interrupted (resumable; jsonl persists)
  const sessionBus = new SessionBus(config.sessionRingBufferSize);
  const claudeEngine = new ClaudeEngine(config, sessionStore, sessionBus, settings);
  const sessions = { store: sessionStore, engine: claudeEngine, bus: sessionBus };

  // An agent turn (`claude -p` / `codex exec`) runs inside the workspace container
  // and SURVIVES a server restart. This new server owns no turns yet, so any still
  // running in a container is an orphan from a previous run — reap them, otherwise
  // a resume would spawn a second agent that races the orphan. Best-effort.
  await Promise.allSettled(registry.list().map((e) => reapAgents(e)));

  // When an env finishes provisioning, optionally kick off its initial session
  // (the prompt passed to POST /environments). Decoupled via this hook so the
  // manager doesn't depend on the session engine directly.
  manager.onEnvReady = async (env, { prompt, model, agent }) => {
    const s = await claudeEngine.newSession(env, { prompt, model, agent });
    log.info(`[${env.name}] started initial session ${s.id}`);
  };

  const routes = buildRoutes(config, registry, manager, sessions, presets, settings);
  const server = createServer(config, routes);

  server.listen(config.port, config.bind, () => {
    log.info(`devbox-server listening on http://${config.bind}:${config.port}`);
    log.info(
      `envs dir: ${config.envsDir} | port range: ${config.portRange.lo}-${config.portRange.hi} | ` +
        `max: ${config.maxEnvironments} | auth: ${config.apiToken ? 'bearer' : 'none'} | UI: http://${config.bind}:${config.port}/`,
    );
    manager.startReconcileLoop();
    manager.startPoolLoop();
  });

  // On a plain restart (Ctrl+C / SIGTERM) we reap the in-container agent turns
  // (claude/codex) so they don't orphan — but leave the env CONTAINERS running, so
  // a restart is seamless and sessions resume cleanly (no duplicate). Full teardown
  // incl. stopping containers is the explicit /control/shutdown action.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down — reaping active agent turns (containers stay up)');
    manager.stopReconcileLoop?.(); // stop the status prober before teardown
    try {
      claudeEngine.interruptAll();
      await Promise.race([
        Promise.allSettled(registry.list().map((e) => reapAgents(e))),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch { /* exiting regardless */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // A long-running control plane must never die on a stray async error.
  process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err));
  process.on('uncaughtException', (err) => log.error('uncaughtException:', err));
}

main().catch((err) => {
  // Pre-log-init failures (e.g. missing config) print plainly.
  console.error(`devbox-server failed to start: ${err.message}`);
  process.exit(1);
});
