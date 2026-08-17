// Endpoint handlers — thin: validate input, call the shared ops layer (ops.js,
// also used by the MCP endpoint) or the manager/session engine directly, shape
// the response. `sessions` bundles { store, engine, bus }.

import { route } from './http.js';
import { addSecrets } from './log.js';
import { systemHealth } from './health.js';
import { AGENTS } from './claude.js';
import { AllocationError } from './allocator.js';
import { composeProvision } from './provision.js';
import { httpErr, validatePreset } from './ops.js';
import { openSse } from './sse.js';
import { makeStaticHandler } from './static.js';

export function buildRoutes(config, registry, manager, sessions, presets, settings, ops) {
  const staticHandler = makeStaticHandler(config.uiRoot);

  const envOr404 = (ctx) => ops.envByRef(ctx.params.id);
  const sessionOr404 = (ctx) => ops.sessionByRef(ctx.params.id);
  const { assertUsable, publicSession } = ops;

  return [
    route('GET', '/health', async (ctx) => ctx.send(200, { ok: true, version: 1 })),

    route('GET', '/host', async (ctx) => {
      const h = await systemHealth(config, registry);
      ctx.send(200, { ...h, sessions: sessions.store.list().length });
    }),

    // ---- control panel (stop / shut down) ---------------------------------
    // Interrupt every running Claude turn (local client + the in-container
    // process, which otherwise survives). Leaves environments running.
    route('POST', '/control/interrupt-all', async (ctx) => {
      ctx.send(200, { interrupted: sessions.engine.interruptAll() });
    }),
    // Stop all environment containers (also interrupts their turns; stopping the
    // container kills anything inside it).
    route('POST', '/control/stop-all', async (ctx) => {
      sessions.engine.interruptAll();
      ctx.send(200, { stopped: await manager.stopAll() });
    }),
    // Full teardown: interrupt turns, stop every env's containers, then exit the
    // server process. The "shut down everything" button.
    route('POST', '/control/shutdown', async (ctx) => {
      sessions.engine.interruptAll();
      ctx.send(202, { shuttingDown: true });
      setTimeout(async () => {
        try { await manager.stopAll(); } catch { /* exiting anyway */ }
        process.exit(0);
      }, 150);
    }),

    // ---- environments -----------------------------------------------------
    route('POST', '/environments', async (ctx) => {
      try {
        const { warm, ...created } = await ops.createEnvironment(ctx.body);
        ctx.send(202, warm ? { ...created, warm } : created);
      } catch (err) {
        if (err instanceof AllocationError) throw httpErr(err.status, err.message);
        throw err;
      }
    }),
    route('GET', '/environments', async (ctx) => ctx.send(200, { environments: await manager.list() })),
    route('GET', '/environments/:id', async (ctx) => ctx.send(200, await manager.describe(envOr404(ctx)))),
    route('GET', '/environments/:id/logs', async (ctx) => {
      const which = ctx.query.get('which') || 'all';
      const tail = Math.min(parseInt(ctx.query.get('tail') || '200', 10) || 200, 5000);
      ctx.send(200, await manager.logs(envOr404(ctx), which, tail));
    }),
    // One-click passwordless wp-admin login (see ops.mintAdminLogin). Returns
    // http://<DEVBOX_PUBLIC_HOST>:<envPort>/?acfw_login=… — directly openable;
    // the UI still rebases host:port onto its own hostname before opening.
    route('POST', '/environments/:id/admin-login', async (ctx) => {
      ctx.send(200, await ops.mintAdminLogin(envOr404(ctx)));
    }),
    // Clone an env: full data copy on a fresh name + port (sessions don't carry
    // over; the source briefly stops during the copy, then restarts). Async
    // like create — 202, then poll the COPY until `running`.
    route('POST', '/environments/:id/duplicate', async (ctx) => {
      try {
        ctx.send(202, await ops.duplicateEnvironment(envOr404(ctx), ctx.body));
      } catch (err) {
        if (err instanceof AllocationError) throw httpErr(err.status, err.message);
        throw err;
      }
    }),
    route('POST', '/environments/:id/stop', async (ctx) => ctx.send(200, await manager.stop(envOr404(ctx)))),
    route('POST', '/environments/:id/start', async (ctx) => {
      try {
        ctx.send(200, await manager.start(envOr404(ctx)));
      } catch (err) {
        if (err instanceof AllocationError) throw httpErr(err.status, err.message);
        throw err;
      }
    }),

    // Rename the list label only — canonical name/dir/compose project are untouched.
    // Blank resets to the canonical name (displayName -> null).
    route('PATCH', '/environments/:id', async (ctx) => {
      const env = envOr404(ctx);
      const label = String(ctx.body.displayName ?? '').replace(/\s+/g, ' ').trim();
      const updated = await registry.update(env.id, { displayName: label ? label.slice(0, 80) : null });
      ctx.send(200, await manager.describe(updated));
    }),
    route('DELETE', '/environments/:id', async (ctx) => {
      // Sessions are tied to their environment: destroying it deletes them all.
      await ops.destroyEnvironment(envOr404(ctx));
      ctx.send(200, { deleted: true });
    }),

    // ---- settings (tokens + WP-admin defaults; secrets masked in responses) --
    route('GET', '/settings', async (ctx) => ctx.send(200, settings.publicView())),
    route('PUT', '/settings', async (ctx) => {
      const view = await settings.update(ctx.body || {});
      addSecrets(settings.secrets()); // keep the log redactor current
      ctx.send(200, view);
    }),

    // ---- provisioning presets (saved blueprints, stored in the data dir) ---
    route('GET', '/presets', async (ctx) => ctx.send(200, { presets: presets.list() })),
    route('POST', '/presets', async (ctx) => {
      const rec = await presets.create(validatePreset(ctx.body));
      ctx.send(201, rec);
    }),
    route('PUT', '/presets/:id', async (ctx) => {
      const rec = await presets.update(ctx.params.id, validatePreset(ctx.body));
      if (!rec) throw httpErr(404, `preset "${ctx.params.id}" not found`);
      ctx.send(200, rec);
    }),
    route('DELETE', '/presets/:id', async (ctx) => {
      if (!(await presets.remove(ctx.params.id))) throw httpErr(404, `preset "${ctx.params.id}" not found`);
      ctx.send(200, { deleted: true });
    }),

    // ---- warm pool (pre-built envs waiting per preset) --------------------
    // Live status (desired/ready/building/failed per preset) for the UI.
    route('GET', '/pool', async (ctx) => ctx.send(200, { pool: manager.poolStatus() })),
    // Set the desired ready count for a preset (0 turns its pool off).
    route('PUT', '/pool/:id', async (ctx) => {
      if (!presets.get(ctx.params.id)) throw httpErr(404, `preset "${ctx.params.id}" not found`);
      const count = Math.max(0, Math.min(50, parseInt(ctx.body.count, 10) || 0));
      await settings.setWarmPool(ctx.params.id, count);
      manager.maintainPoolSoon();
      ctx.send(200, { pool: manager.poolStatus() });
    }),
    // Nuke a preset's warm envs (rebuild after stale code); the loop refills.
    route('POST', '/pool/:id/rebuild', async (ctx) => {
      if (!presets.get(ctx.params.id)) throw httpErr(404, `preset "${ctx.params.id}" not found`);
      const removed = await manager.rebuildPool(ctx.params.id);
      ctx.send(200, { rebuilt: removed, pool: manager.poolStatus() });
    }),

    // ---- agent sessions (claude | codex) ----------------------------------
    route('POST', '/environments/:id/sessions', async (ctx) => {
      const env = envOr404(ctx);
      await assertUsable(env);
      const prompt = (ctx.body.prompt || '').trim();
      if (!prompt) throw httpErr(400, 'prompt is required');
      const agent = AGENTS[ctx.body.agent] ? ctx.body.agent : 'claude';
      const record = await sessions.engine.newSession(env, { prompt, model: ctx.body.model, agent });
      ctx.send(202, publicSession(record));
    }),

    route('POST', '/sessions/:id/messages', async (ctx) => {
      const s = sessionOr404(ctx);
      if (sessions.engine.isActive(s.id)) throw httpErr(409, 'a turn is already in progress for this session');
      const env = registry.get(s.envId);
      if (!env) throw httpErr(410, 'the environment for this session no longer exists');
      await assertUsable(env);
      const prompt = (ctx.body.prompt || '').trim();
      if (!prompt) throw httpErr(400, 'prompt is required');
      await sessions.engine.sendMessage(env, s, { prompt });
      ctx.send(202, publicSession(sessions.store.get(s.id)));
    }),

    route('GET', '/sessions', async (ctx) => {
      let list = sessions.store.list();
      const envId = ctx.query.get('envId');
      const status = ctx.query.get('status');
      // archived filter: "only" (archived), "exclude" (active). Default returns
      // both (with the `archived` flag) so the UI can group them in one fetch.
      const archived = ctx.query.get('archived');
      if (envId) list = list.filter((s) => s.envId === envId);
      if (status) list = list.filter((s) => publicSession(s).status === status);
      if (archived === 'only') list = list.filter((s) => s.archived);
      else if (archived === 'exclude') list = list.filter((s) => !s.archived);
      ctx.send(200, { sessions: list.map(publicSession) });
    }),

    route('GET', '/sessions/:id', async (ctx) => ctx.send(200, publicSession(sessionOr404(ctx)))),

    route('PATCH', '/sessions/:id', async (ctx) => {
      const s = sessionOr404(ctx);
      const title = String(ctx.body.title || '').replace(/\s+/g, ' ').trim();
      if (!title) throw httpErr(400, 'title is required');
      const updated = await sessions.store.update(s.id, { title: title.slice(0, 200) });
      ctx.send(200, publicSession(updated));
    }),

    // Archive: hide a session from the sidebar without deleting it — the record,
    // transcript, and claude/codex resume id all persist, so it can be restored
    // and resumed later. Any in-flight turn is interrupted first (an archived
    // session shouldn't keep working invisibly). Restore just clears the flag.
    route('POST', '/sessions/:id/archive', async (ctx) => {
      const s = sessionOr404(ctx);
      sessions.engine.interrupt(s.id);
      const updated = await sessions.store.update(s.id, { archived: true });
      ctx.send(200, publicSession(updated));
    }),
    route('POST', '/sessions/:id/restore', async (ctx) => {
      const s = sessionOr404(ctx);
      const updated = await sessions.store.update(s.id, { archived: false });
      ctx.send(200, publicSession(updated));
    }),

    // partials: 'all' (default, raw log) | 'live' (only the token deltas that
    // rebuild the in-progress line — what the UI uses) | 'none'.
    // clip: truncate any single string inside an event to N chars (0 = off,
    // the default) — giant tool_results (screenshots, whole files) can be
    // 1MB+ each. The UI passes both; defaults keep the raw-log behavior.
    route('GET', '/sessions/:id/transcript', async (ctx) => {
      const s = sessionOr404(ctx);
      const tail = Math.min(parseInt(ctx.query.get('tail') || '2000', 10) || 2000, 20000);
      const p = ctx.query.get('partials');
      const partials = p === 'live' || p === 'none' ? p : 'all';
      const clip = Math.max(0, Math.min(parseInt(ctx.query.get('clip') || '0', 10) || 0, 1 << 20));
      ctx.send(200, await ops.readTranscript(s, { tail, partials, clip }));
    }),

    route('GET', '/sessions/:id/stream', async (ctx) => {
      const s = sessionOr404(ctx);
      const sse = openSse(ctx.res);
      for (const e of sessions.bus.backlog(s.id)) sse.send(e);
      sse.send({ type: 'control', subtype: 'snapshot', session: publicSession(s) });
      const unsub = sessions.bus.subscribe(s.id, sse.send);
      ctx.req.on('close', () => { unsub(); sse.close(); });
    }, { kind: 'sse' }),

    route('POST', '/sessions/:id/interrupt', async (ctx) => {
      const s = sessionOr404(ctx);
      if (!sessions.engine.interrupt(s.id)) throw httpErr(409, 'no active turn to interrupt');
      ctx.send(200, publicSession(sessions.store.get(s.id)));
    }),

    route('DELETE', '/sessions/:id', async (ctx) => {
      await ops.deleteSession(sessionOr404(ctx));
      ctx.send(200, { deleted: true });
    }),

    // ---- UI (static; shell unauthenticated, data APIs above are authed) ----
    route('GET', '/', staticHandler, { kind: 'static' }),
    route('GET', '/ui/:rest*', staticHandler, { kind: 'static' }),
  ];
}

// composeProvision lives in provision.js (shared with the warm-pool builder in
// manager.js); re-exported here for any existing importers/tests.
export { composeProvision };
