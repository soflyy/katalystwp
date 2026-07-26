// Pure live-status computation. Reconciles two signals the caller gathers:
//   - jobState: the transient state of an in-flight create/start pipeline (or null)
//   - ps:       parsed `docker compose ps` for the project
//
// "degraded" = some but not all core containers are up.

export const TRANSIENT = new Set(['scaffolding', 'setting-up', 'configuring', 'destroying']);

// Services whose "running" state means the stack is up. Playwright is present
// but not gated on (it's the heaviest and least essential to core operation).
const CORE_SERVICES = ['db', 'wordpress', 'workspace'];

function runningServices(ps) {
  const running = new Set();
  for (const svc of ps) {
    const name = svc.Service || svc.service;
    const state = (svc.State || svc.state || '').toLowerCase();
    if (name && state === 'running') running.add(name);
  }
  return running;
}

export function coreUp(ps) {
  const running = runningServices(ps);
  return CORE_SERVICES.every((s) => running.has(s));
}

export function anyUp(ps) {
  return runningServices(ps).size > 0;
}

export function computeStatus({ record, jobState, ps }) {
  // An in-flight pipeline wins — it's the authoritative transient state.
  if (jobState && TRANSIENT.has(jobState)) return jobState;

  // Sticky failure until the user acts (start/destroy).
  if (record.status === 'failed' && !coreUp(ps)) return 'failed';

  if (!anyUp(ps)) return 'stopped';
  if (!coreUp(ps)) return 'degraded'; // some but not all core services up
  return 'running';
}

// Public-facing view of an environment (no secrets).
export function publicView(record, { status }) {
  return {
    id: record.id,
    name: record.name,
    // Optional user-set list label; the canonical `name` (dir + compose project)
    // never changes. UI shows displayName when present, else name.
    displayName: record.displayName || null,
    // Host path of the scaffolded stack — used by the UI to build an SSH command
    // (cd into it, then `npm run claude` for the interactive TUI).
    dir: record.dir,
    port: record.port,
    // Host-published dev-server ports ({ host, container }) — the UI links them
    // like `port`, rebased on the browser's hostname.
    appPorts: record.appPorts ?? [],
    wpUrl: record.wpUrl,
    status,
    preset: record.preset || null,
    createdAt: record.createdAt,
    setupStartedAt: record.setupStartedAt,
    lastError: record.lastError,
  };
}
