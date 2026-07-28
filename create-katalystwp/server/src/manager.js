// Orchestrates the environment lifecycle: allocate → scaffold → setup → git auth
// → running, plus stop/start/destroy, status, logs, and a reconcile loop that
// keeps recorded status in sync with the containers.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

import { allocate, AllocationError } from './allocator.js';
import * as docker from './docker.js';
import * as gitauth from './gitauth.js';
import { computeStatus, coreUp, publicView, TRANSIENT } from './status.js';
import { composeProvision } from './provision.js';
import { log, redact } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Statuses where an env is consuming compute — its containers are up, or a
// pipeline is bringing them up. These count against maxRunning (the CPU/RAM
// cap). Stopped/failed/destroying envs cost disk, not compute, so they don't.
const COMPUTE_STATUSES = new Set(['running', 'degraded', 'scaffolding', 'setting-up', 'configuring']);

// Counting semaphore to bound concurrent (heavy) docker builds.
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export class Manager {
  constructor(config, registry, settings) {
    this.config = config;
    this.registry = registry;
    this.settings = settings;
    this.jobs = new Map(); // id -> transient state string
    this.buildSem = new Semaphore(config.buildConcurrency);
    // Last `docker compose ps` result per env id ({ ps, at }). The background
    // prober (reconcile sweep) is the ONLY thing that polls docker on a timer;
    // the read path (describe/list) serves from this cache so status requests
    // never fan out docker work — no matter how many clients poll how fast.
    this.probeCache = new Map(); // id -> { ps, at }
  }

  // ---- running cap --------------------------------------------------------
  //
  // Envs whose containers are up (or being brought up) cost CPU/RAM; stopped
  // ones (incl. the warm pool) cost only disk. maxRunning bounds the former so
  // a large stored fleet can't peg the host. Enforced at every boot point:
  // create, restart (start), warm claim, and warm build.

  _runningCount() {
    return this.registry.list().filter((e) => COMPUTE_STATUSES.has(e.status)).length;
  }

  // Throw (AllocationError, so routes map it to a 503) if booting one more env
  // would exceed maxRunning. Warm builds phrase it as a deferral — maintainPool
  // catches and retries next tick.
  _assertRunRoom({ pool = false } = {}) {
    const n = this._runningCount();
    if (n >= this.config.maxRunning) {
      throw new AllocationError(
        pool
          ? `warm build deferred: ${n}/${this.config.maxRunning} running`
          : `at running capacity: ${n}/${this.config.maxRunning} running — stop an env or raise MAX_RUNNING`,
        503,
      );
    }
  }

  // Write the WP-admin defaults from Settings into a server-scoped
  // XDG_CONFIG_HOME config.json that the scaffolder reads (seeds each new site's
  // admin account). Kept out of the operator's real ~/.config.
  async _writeScaffolderConfig() {
    const s = this.settings.get();
    const dir = join(this.config.scaffolderConfigHome, 'create-katalystwp');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ wpAdminUser: s.wpAdminUser, wpAdminPassword: s.wpAdminPassword, wpAdminEmail: s.wpAdminEmail }, null, 2),
    );
  }

  // ---- create -------------------------------------------------------------

  async createEnvironment({ name, provision, prompt, model, agent } = {}) {
    this._assertRunRoom(); // a create boots immediately — count it against maxRunning
    // The provision's app (container) ports get their host ports reserved here,
    // atomically with the WP port.
    const record = await allocate(this.registry, this.config, { nameHint: name, appPorts: provision?.appPorts ?? [] });
    this.jobs.set(record.id, 'scaffolding');
    // Materialize the provisioning inputs to files the scaffolder can read, and
    // record the preset name (if any) for display. Done before the (async)
    // pipeline so a write error surfaces synchronously to the caller.
    let provisionPlan = null;
    if (provision) {
      provisionPlan = await this._materializeProvision(record, provision);
      if (provision.presetName) await this.registry.update(record.id, { preset: provision.presetName });
    }
    // Optional: once the env is up, start an agent session with this prompt
    // (carried in-memory through the pipeline; see onEnvReady).
    const initial = prompt ? { prompt, model, agent } : null;
    // Fire-and-forget pipeline; status is observable via GET.
    this._pipeline(record, { provisionPlan, initial }).catch((err) => log.error(`[${record.name}] pipeline crashed:`, err));
    return record;
  }

  // Write the setup script + defines to the env's scratch dir and assemble the
  // scaffolder flags. Returns { args, scratchDir } or null when there's nothing
  // to provision. The scaffolder copies these into the project, so they're
  // throwaway (cleaned up after the scaffold step).
  async _materializeProvision(record, { setupScript, devScript, defines, activate }) {
    const scratchDir = join(this.config.scratchDir, record.name);
    const args = [];
    const hasDefines = defines && Object.keys(defines).length > 0;
    if (setupScript || devScript || hasDefines) await mkdir(scratchDir, { recursive: true });
    if (setupScript) {
      const p = join(scratchDir, 'user-setup.sh');
      await writeFile(p, setupScript);
      args.push(`--setup-script=${p}`);
    }
    if (devScript) {
      const p = join(scratchDir, 'dev.sh');
      await writeFile(p, devScript);
      args.push(`--dev-script=${p}`);
    }
    if (hasDefines) {
      const p = join(scratchDir, 'defines.json');
      await writeFile(p, JSON.stringify(defines, null, 2));
      args.push(`--defines=${p}`);
    }
    if (activate && activate.length) args.push(`--activate=${activate.join(',')}`);
    if (!args.length) return null;
    return { args, scratchDir };
  }

  async _pipeline(record, { provisionPlan = null, initial = null, pool = false } = {}) {
    const { config, registry } = this;
    try {
      await mkdir(config.envsDir, { recursive: true });

      // 1. Create the environment the NORMAL way: the standard scaffolder
      //    scaffolds the project AND runs `npm run setup` (build + boot +
      //    provision) in one shot. Default compose project = dir basename =
      //    record.name, so the project's own scripts + in-workspace.sh agree.
      //    Bounded by the build semaphore; output captured to the setup log.
      this.jobs.set(record.id, 'setting-up');
      await registry.update(record.id, { status: 'setting-up', setupStartedAt: new Date().toISOString() });
      await this._writeScaffolderConfig(); // seed WP-admin defaults for the scaffolder
      const scaffoldArgs = [
        join(config.scaffolderDir, 'index.js'),
        record.dir,
        `--port=${record.port}`,
        // The server's sessions can drive any of the supported agents (model
        // chooser: Claude, Codex, OpenCode; SSH: Cursor), so install them all —
        // the scaffolder's default is Claude-only.
        '--agents=all',
        `--public-host=${config.publicHost}`,
        ...(record.appPorts?.length ? [`--app-ports=${record.appPorts.map((p) => `${p.host}:${p.container}`).join(',')}`] : []),
        ...(provisionPlan ? provisionPlan.args : []),
      ];
      await this.buildSem.run(() =>
        this._spawnLogged('node', scaffoldArgs, {
          logPath: record.setupLogPath,
          truncate: true,
          timeout: 30 * 60 * 1000,
          env: { XDG_CONFIG_HOME: config.scaffolderConfigHome },
        }),
      );
      // The scaffolder has copied the provisioning inputs into the project
      // (scripts/user-setup.sh + sandbox.config.json); the scratch copies are
      // no longer needed. Re-runs (npm run setup/reset, "retry") use the
      // project's own copies, so this doesn't break recovery.
      if (provisionPlan) await rm(provisionPlan.scratchDir, { recursive: true, force: true }).catch(() => {});
      await registry.update(record.id, { setupFinishedAt: new Date().toISOString() });

      // 2. Configure GitHub auth + git identity in the workspace (non-fatal),
      //    so an agent can clone/commit/push. (Provisioning — incl. swapping a
      //    plugin for a git checkout — is done by presets during setup now.)
      this.jobs.set(record.id, 'configuring');
      await registry.update(record.id, { status: 'configuring' });
      await gitauth.configure(record, config, this.settings.get().githubToken);

      // 3. Up and provisioned.
      await registry.update(record.id, { status: 'running', lastError: null });
      if (pool) {
        // Warm-pool build: it's built and healthy — stop it so it waits cheaply,
        // and mark it claimable. (start is the fast cached `up -d --build`.)
        await this.stop(record);
        await registry.update(record.id, { poolReady: true });
        log.info(`[pool] ${record.name} ready (preset ${record.pool})`);
      } else if (initial?.prompt) {
        // Env is up — fire the optional initial session. Best-effort: its failure
        // must not fail the environment (the env itself is fine).
        try { await this.onEnvReady?.(record, initial); }
        catch (err) { log.warn(`[${record.name}] initial session failed:`, err.message); }
      }
    } catch (err) {
      log.error(`[${record.name}] setup failed:`, err.message);
      await registry.update(record.id, { status: 'failed', lastError: truncate(redactErr(err)) });
    } finally {
      this.jobs.delete(record.id);
      // Drop any probe cache so describe() reflects the freshly persisted status
      // right away (consistent with start()/_claimPipeline); avoids a stale ps
      // briefly overriding the real state on the read path.
      this.probeCache.delete(record.id);
    }
  }

  // ---- status / describe --------------------------------------------------

  // Live single-env probe: hits docker, refreshes the cache, returns the ps.
  // Used by the background sweep and by user-initiated actions (start/stop,
  // pre-exec gate) — NOT by the polled read path.
  async _probe(record) {
    const ps = await docker.ps(record);
    this.probeCache.set(record.id, { ps, at: Date.now() });
    return ps;
  }

  // Read-path status: served from the probe cache, never touches docker. On a
  // cache miss (env not yet swept, e.g. right after boot or a lifecycle action)
  // fall back to the persisted record status so the answer is still sane.
  _gather(record) {
    const jobState = this.jobs.get(record.id) || null;
    const cached = this.probeCache.get(record.id);
    if (!cached) {
      const status = jobState && TRANSIENT.has(jobState) ? jobState : record.status;
      return { ps: null, status };
    }
    const status = computeStatus({ record, jobState, ps: cached.ps });
    return { ps: cached.ps, status };
  }

  async describe(record) {
    const { status } = this._gather(record);
    return publicView(record, { status });
  }

  async list() {
    // Warm-pool members are infrastructure, not user envs — hide them from the
    // list (they surface via the pool status API instead).
    return Promise.all(this.registry.list().filter((r) => !r.pool).map((r) => this.describe(r)));
  }

  // Is the env's core stack up (so we can exec claude/agents in it)? A live,
  // on-demand single-env probe — this gates a real action, so it must be fresh,
  // not cached. Refreshes the cache as a side effect.
  async usable(record) {
    return coreUp(await this._probe(record));
  }

  // ---- lifecycle ----------------------------------------------------------

  // Lifecycle through the env's own npm scripts (default compose project).

  async stop(record) {
    await docker.npmRun(record, 'stop', { timeout: 120_000 });
    await this.registry.update(record.id, { status: 'stopped' });
    // Drop the (now stale) cached ps so describe reflects the new status
    // immediately rather than showing "running" until the next sweep.
    this.probeCache.delete(record.id);
    return this.describe(record);
  }

  async start(record) {
    this._assertRunRoom(); // restarting a stopped env brings its containers back up
    this.jobs.set(record.id, 'configuring');
    try {
      await docker.npmRun(record, 'start', { timeout: 600_000 }); // up -d --build (cached)
      await gitauth.configure(record, this.config, this.settings.get().githubToken);
      await this.registry.update(record.id, { status: 'running', lastError: null });
    } finally {
      this.jobs.delete(record.id);
    }
    this.probeCache.delete(record.id); // stale cache → fall back to fresh status
    return this.describe(record);
  }

  async destroy(record) {
    this.jobs.set(record.id, 'destroying');
    try {
      // `npm run down` (compose down). Data is in bind mounts (no named volumes),
      // so removing the dir clears it.
      await docker.npmRun(record, 'down', { timeout: 180_000 }).catch((e) => log.warn(`[${record.name}] down failed:`, e.message));
      await rm(record.dir, { recursive: true, force: true }).catch((e) =>
        log.warn(`[${record.name}] dir removal failed:`, e.message),
      );
      await this.registry.mutate((data) => {
        delete data.environments[record.id];
      });
    } finally {
      this.jobs.delete(record.id);
      this.probeCache.delete(record.id); // env gone → drop its cache entry
    }
  }

  async logs(record, which = 'setup', tail = 200) {
    const out = {};
    if (which === 'setup' || which === 'all') out.setup = await tailFile(record.setupLogPath, tail);
    return out;
  }

  // Stop every running environment's containers (used by the control panel /
  // shutdown). Returns the names that were stopped.
  async stopAll() {
    const running = this.registry.list().filter((r) => r.status !== 'stopped');
    const results = await Promise.allSettled(running.map((r) => this.stop(r)));
    return running.filter((_, i) => results[i].status === 'fulfilled').map((r) => r.name);
  }

  // ---- reconcile loop (supervisor) ----------------------------------------

  // One paced sweep: probe every env ONE AT A TIME, waiting for each to finish
  // before starting the next, with a fixed delay in between. This is the single
  // background poller — it deliberately trickles docker work so a large fleet
  // can never pin the host the way a per-request fan-out did. Each probe also
  // refreshes the read cache that describe()/list() serve from.
  async reconcile() {
    const records = this.registry.list();
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (this.jobs.has(record.id)) continue; // pipeline owns it (don't probe/clobber)
      try {
        const ps = await this._probe(record);
        await this._reconcileStatus(record, ps);
      } catch (err) {
        log.warn(`[${record.name}] reconcile error:`, err.message);
      }
      // Breathe between envs so the sweep is a trickle, not a burst. (No delay
      // after the last one.)
      if (i < records.length - 1) await sleep(this.config.probeSpacingMs);
    }
  }

  // Fold a fresh ps into the persisted status (side of reconcile that writes).
  async _reconcileStatus(record, ps) {
    if (!coreUp(ps)) {
      // Containers down: a running/degraded env is now stopped; one left
      // mid-pipeline by a crash/restart is failed; stopped stays stopped.
      const s = record.status;
      if (s === 'running' || s === 'degraded') {
        await this.registry.update(record.id, { status: 'stopped' });
      } else if (['setting-up', 'configuring', 'scaffolding'].includes(s)) {
        await this.registry.update(record.id, { status: 'failed', lastError: record.lastError || 'interrupted (server restart or crash)' });
      }
      return;
    }
    // Containers up → running.
    if (record.status !== 'running' && record.status !== 'stopped') {
      await this.registry.update(record.id, { status: 'running' });
    }
  }

  // Self-rescheduling loop: the next sweep is armed only AFTER the current one
  // finishes (plus a rest gap), so sweeps can never overlap or stack up even if
  // one runs long. A plain setInterval could pile sweeps on top of each other
  // under load — exactly the failure mode this replaces.
  startReconcileLoop() {
    this._reconcileStopped = false;
    const loop = async () => {
      if (this._reconcileStopped) return;
      try {
        await this.reconcile();
      } catch (e) {
        log.warn('reconcile loop error:', e.message);
      }
      if (this._reconcileStopped) return;
      this.reconcileTimer = setTimeout(loop, this.config.reconcileIntervalMs);
      this.reconcileTimer.unref?.();
    };
    loop(); // run one sweep at boot, then rest → sweep → rest → …
  }

  stopReconcileLoop() {
    this._reconcileStopped = true;
    clearTimeout(this.reconcileTimer);
  }

  // ---- warm pool ----------------------------------------------------------
  //
  // Keep N pre-built-then-stopped envs per preset waiting, so creating from a
  // warmed preset is a fast cached `start` (claimAndStart) instead of a ~10-min
  // build. Desired counts live in settings.warmPool ({ [presetId]: n }); warm
  // members are tagged `pool: presetId` (+ `poolReady` once built). The preset
  // store is wired in as `this.presets` at boot (index.js).

  poolEntries() {
    return Object.entries(this.settings.get().warmPool || {});
  }

  // Live per-preset status for the settings UI.
  poolStatus() {
    const byPreset = new Map();
    const ensure = (pid) => {
      if (!byPreset.has(pid)) byPreset.set(pid, { presetId: pid, desired: 0, ready: 0, building: 0, failed: 0 });
      return byPreset.get(pid);
    };
    for (const [pid, n] of this.poolEntries()) ensure(pid).desired = Math.max(0, parseInt(n, 10) || 0);
    for (const e of this.registry.list()) {
      if (!e.pool) continue;
      const row = ensure(e.pool);
      if (e.status === 'failed') row.failed += 1;
      else if (e.poolReady) row.ready += 1;
      else row.building += 1;
    }
    return [...byPreset.values()].map((r) => ({ ...r, name: this.presets?.get(r.presetId)?.name || null }));
  }

  // Atomically claim a ready warm env for a preset, converting it to a normal
  // env (drops the pool tag; the typed name becomes its display label).
  async claimPoolEnv(presetId, { name } = {}) {
    return this.registry.mutate((data) => {
      const cand = Object.values(data.environments).find(
        (e) => e.pool === presetId && e.poolReady === true && !this.jobs.has(e.id),
      );
      if (!cand) return null;
      cand.pool = null;
      cand.poolReady = false;
      if (name && name.trim()) cand.displayName = name.trim().slice(0, 80);
      return cand;
    });
  }

  // Create-from-warmed-preset fast path: claim + cached start + optional initial
  // session, refilling the pool. Returns the claimed record, or null if none
  // was ready (caller falls back to a normal build).
  async claimAndStart(presetId, { name, prompt, model, agent } = {}) {
    this._assertRunRoom(); // claiming + starting a warm env boots it (before touching the pool)
    const record = await this.claimPoolEnv(presetId, { name });
    if (!record) return null;
    this.jobs.set(record.id, 'configuring');
    this._claimPipeline(record, { prompt, model, agent }).catch((err) => log.error(`[${record.name}] claim crashed:`, err));
    this.maintainPoolSoon(); // top the pool back up
    return record;
  }

  async _claimPipeline(record, initial = {}) {
    const { registry, config } = this;
    try {
      await docker.npmRun(record, 'start', { timeout: 600_000 }); // up -d --build (cached)
      await gitauth.configure(record, config, this.settings.get().githubToken);
      await registry.update(record.id, { status: 'running', lastError: null });
      if (initial.prompt) {
        try { await this.onEnvReady?.(registry.get(record.id), initial); }
        catch (err) { log.warn(`[${record.name}] initial session failed:`, err.message); }
      }
    } catch (err) {
      log.error(`[${record.name}] claim-start failed:`, err.message);
      await registry.update(record.id, { status: 'failed', lastError: truncate(redactErr(err)) });
    } finally {
      this.jobs.delete(record.id);
      // A claimed warm member carries a stale probe cache (it showed the env
      // stopped while it waited in the pool). Drop it — like start() does — so
      // describe() serves the fresh persisted status ('running') immediately
      // instead of computing 'stopped' from the stale ps until the next sweep
      // (which made the new env flicker into the Stopped tab and back).
      this.probeCache.delete(record.id);
    }
  }

  // Build one warm env for a preset (allocate with reserve-aware cap → pipeline →
  // stop → poolReady). May throw AllocationError when capacity/reserve is hit.
  async _buildPoolEnv(presetId) {
    const preset = this.presets?.get(presetId);
    if (!preset) return;
    this._assertRunRoom({ pool: true }); // a build boots the stack before stopping it
    const provision = composeProvision([preset], null);
    const record = await allocate(this.registry, this.config, { pool: presetId, appPorts: provision?.appPorts ?? [] });
    this.jobs.set(record.id, 'scaffolding');
    await this.registry.update(record.id, { preset: preset.name });
    const provisionPlan = provision ? await this._materializeProvision(record, provision) : null;
    this._pipeline(record, { provisionPlan, pool: true }).catch((err) => log.error(`[pool ${preset.name}] pipeline crashed:`, err));
  }

  // Top up / clean up the pool to match desired counts. Idempotent and mutually
  // exclusive (timer + on-demand callers can't double-build).
  async maintainPool() {
    if (!this.presets || this._poolBusy) return;
    this._poolBusy = true;
    try {
      for (const [presetId, desiredRaw] of this.poolEntries()) {
        const desired = Math.max(0, parseInt(desiredRaw, 10) || 0);
        const preset = this.presets.get(presetId);
        let mine = this.registry.list().filter((e) => e.pool === presetId);

        // Stale config (preset deleted): tear down its warm envs.
        if (!preset) {
          for (const e of mine) if (!this.jobs.has(e.id)) await this.destroy(e).catch(() => {});
          continue;
        }

        // Discard failed warm envs; finalize crash-orphaned ones (built but never
        // stopped/marked — e.g. server died between 'running' and stop()).
        for (const e of mine) {
          if (this.jobs.has(e.id)) continue;
          if (e.status === 'failed') {
            log.warn(`[pool ${preset.name}] discarding failed warm env ${e.name}`);
            await this.destroy(e).catch(() => {});
          } else if (!e.poolReady && e.setupFinishedAt) {
            if (e.status === 'running' || e.status === 'degraded') await this.stop(e).catch(() => {});
            await this.registry.update(e.id, { poolReady: true });
          }
        }

        mine = this.registry.list().filter((e) => e.pool === presetId && e.status !== 'failed');
        const ready = mine.filter((e) => e.poolReady).length;
        const building = mine.length - ready;
        // Cap concurrent warm builds so on-demand creates always keep a build
        // slot (a single broken preset also can't pile up — at most one build is
        // in flight, re-checked each tick). Each build is fire-and-forget.
        const inFlightCap = Math.max(1, this.config.buildConcurrency - 1);
        let slots = Math.min(inFlightCap - building, desired - mine.length);
        while (slots > 0) {
          try {
            await this._buildPoolEnv(presetId);
          } catch (err) {
            log.info(`[pool ${preset.name}] hold: ${err.message}`); // at capacity/reserve — retry next tick
            break;
          }
          slots -= 1;
        }
      }
    } finally {
      this._poolBusy = false;
    }
  }

  // Debounced background top-up (after a claim or a config change).
  maintainPoolSoon() {
    if (this._poolSoon) return;
    this._poolSoon = setTimeout(() => {
      this._poolSoon = null;
      this.maintainPool().catch((e) => log.warn('pool maintain error:', e.message));
    }, 1500);
    this._poolSoon.unref?.();
  }

  // Nuke a preset's warm envs (e.g. stale after a git push); the loop refills.
  async rebuildPool(presetId) {
    const mine = this.registry.list().filter((e) => e.pool === presetId);
    await Promise.allSettled(mine.map((e) => this.destroy(e)));
    this.maintainPoolSoon();
    return mine.length;
  }

  startPoolLoop() {
    const tick = () => this.maintainPool().catch((e) => log.warn('pool loop error:', e.message));
    tick();
    this.poolTimer = setInterval(tick, this.config.warmPoolIntervalMs);
    this.poolTimer.unref?.();
  }

  // ---- helpers ------------------------------------------------------------

  _spawnLogged(cmd, args, { cwd, env, logPath, truncate = false, timeout } = {}) {
    return new Promise((resolve, reject) => {
      mkdirSync(dirname(logPath), { recursive: true });
      const stream = createWriteStream(logPath, { flags: truncate ? 'w' : 'a' });
      stream.on('error', (err) => reject(err)); // never let a log FS error crash the server
      stream.write(`\n=== ${new Date().toISOString()} $ ${cmd} ${args.join(' ')} ===\n`);
      const child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
      });
      let timer;
      if (timeout) timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      // Redact known secrets from the setup log — it's served raw by
      // GET /environments/:id/logs, so a setup script that echoes a forwarded
      // secret must not put it behind a bearer-token read. Chunk-wise, so a
      // secret split across two chunks can slip through — a backstop, not a
      // guarantee (the real rule stays: setup scripts don't print secrets).
      const writeRedacted = (chunk) => stream.write(redact(chunk.toString()));
      child.stdout.on('data', writeRedacted);
      child.stderr.on('data', writeRedacted);
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        stream.end();
        reject(err);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        stream.end();
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code} (see ${logPath})`));
      });
    });
  }
}

function truncate(s, n = 600) {
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
}
function redactErr(err) {
  return redact(err && err.message ? err.message : String(err));
}
async function tailFile(path, n) {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n').slice(-n).join('\n');
  } catch {
    return null;
  }
}
