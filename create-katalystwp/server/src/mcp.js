// MCP endpoint — Model Context Protocol over the Streamable HTTP transport,
// stateless, zero dependencies. `POST /mcp` accepts JSON-RPC 2.0 messages and
// answers with plain JSON (no SSE; every tool call is a single response, which
// the spec allows). Auth is the same bearer token as the JSON API — from a
// local Claude Code:
//
//   claude mcp add --transport http katalyst http://<host>:4000/mcp \
//     --header "Authorization: Bearer $DEVBOX_API_TOKEN"
//
// Tools are thin wrappers over the SAME ops/manager/session layer routes.js
// uses (see ops.js) — no business logic lives here. The single TOOLS table
// below generates `tools/list`, the `initialize.instructions` guide, and the
// `get_instructions` tool, so the docs an agent sees can never drift from the
// tools it can call.

import { route } from './http.js';
import { systemHealth } from './health.js';
import { AGENTS } from './claude.js';
import { httpErr, validatePreset } from './ops.js';

const LATEST_PROTOCOL = '2025-06-18';
const KNOWN_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
const SERVER_INFO = { name: 'katalyst-devbox', title: 'Katalyst Devbox Server', version: '0.1.0' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildMcpRoutes(config, registry, manager, sessions, presets, settings, ops) {
  // ---- tool table ---------------------------------------------------------
  // { name, category, description, inputSchema, handler }. Keep descriptions
  // agent-facing: what it does, when to use it, what comes back.
  const str = (description) => ({ type: 'string', description });
  const int = (description) => ({ type: 'integer', description });
  const ENV_ARG = str('Environment name or id (both accepted everywhere).');
  const SESSION_ARG = str('Session id (from start_session / list_sessions).');
  const PRESET_ARG = str('Preset id (from list_presets).');
  // Built from live config so the docs can never disagree with the default.
  const MODEL_ARG = str(
    `Model for the session (optional). Omit for the server default — "${config.claudeDefaultModel}", which Claude Code resolves to the latest Opus. ` +
    'Accepts any Claude Code model alias or id (e.g. opus, sonnet, haiku, claude-fable-5), passed verbatim to the agent CLI. ' +
    'Fixed for the session\'s lifetime; codex/opencode agents have their own defaults.',
  );
  const args = (properties = {}, required = []) => ({ type: 'object', properties, required });

  // Poll an env by id until its status settles (running/failed), it disappears,
  // or the timeout elapses. Used by wait_for_environment.
  const pollEnv = async (id, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rec = registry.get(id);
      if (!rec) throw httpErr(410, 'environment was destroyed while waiting');
      const view = await manager.describe(rec);
      if (view.status === 'running' || view.status === 'failed' || Date.now() >= deadline) {
        return {
          ...view,
          done: view.status === 'running' || view.status === 'failed',
          hint: view.status === 'running' ? undefined
            : view.status === 'failed' ? 'setup failed — read get_setup_logs, then destroy_environment and recreate'
            : 'still provisioning — call wait_for_environment again (cold builds take ~10 min)',
        };
      }
      await sleep(2000);
    }
  };

  const TOOLS = [
    // ---- meta -------------------------------------------------------------
    {
      name: 'get_instructions',
      category: 'Meta',
      description: 'Full usage guide for this server: concepts, workflows, status lifecycle, gotchas, and the complete tool reference. Call this first if you have not read the instructions yet.',
      inputSchema: args(),
      handler: async () => instructions, // same text initialize returns
    },
    {
      name: 'host_health',
      category: 'Meta',
      description: 'Host capacity and health: memory/CPU/disk, docker usage, per-environment memory, and an estimate of how many more environments fit. Check before creating several environments.',
      inputSchema: args(),
      handler: async () => ({ ...(await systemHealth(config, registry)), sessions: sessions.store.list().length }),
    },

    // ---- environments -----------------------------------------------------
    {
      name: 'list_environments',
      category: 'Environments',
      description: 'List all environments with live status, WordPress URL, and ports.',
      inputSchema: args(),
      handler: async () => ({ environments: await manager.list() }),
    },
    {
      name: 'get_environment',
      category: 'Environments',
      description: 'Describe one environment: status, wpUrl, ports, preset provenance, lastError.',
      inputSchema: args({ env: ENV_ARG }, ['env']),
      handler: async ({ env }) => manager.describe(ops.envByRef(env)),
    },
    {
      name: 'create_environment',
      category: 'Environments',
      description: 'Create a WordPress environment (async — returns immediately; follow with wait_for_environment). Compose presets via presetIds (see list_presets); a single preset with no custom provision claims a pre-built warm env in seconds, otherwise a cold build takes ~10 min. Optional prompt starts an agent session automatically once the env is ready.',
      inputSchema: args({
        name: str('Environment name, ^[a-z0-9][a-z0-9-]{1,38}$, unique. Omit for an auto-generated one.'),
        presetIds: { type: 'array', items: { type: 'string' }, description: 'Preset ids to compose, in order (from list_presets).' },
        prompt: str('Optional first agent prompt — starts a session automatically when the env becomes ready.'),
        model: MODEL_ARG,
        agent: str(`Agent for that first session: ${Object.keys(AGENTS).join(' | ')} (default claude).`),
        provision: {
          type: 'object',
          description: 'Custom provisioning on top of (or instead of) presets. Note: any custom provision disables the warm-pool fast path.',
          properties: {
            setupScript: str('Bash run once in the workspace after WordPress is up.'),
            devScript: str('Long-running dev/watch script.'),
            activate: { type: 'array', items: { type: 'string' }, description: 'Plugin slugs to activate, in order.' },
            defines: { type: 'object', description: 'wp-config PHP defines, { "WP_CONST": value }.' },
            appPorts: { type: 'array', items: { type: 'integer' }, description: 'Extra container ports to publish (e.g. [3000]).' },
          },
        },
      }),
      handler: (body) => ops.createEnvironment(body),
    },
    {
      name: 'duplicate_environment',
      category: 'Environments',
      description: 'Clone an existing environment into a new one — full copy of the WordPress database, files, plugins, and git checkouts on a fresh name and port. Agent sessions do NOT carry over. The source briefly stops during the copy (status "duplicating"), then restarts itself. Async — follow with wait_for_environment on the COPY. Useful as a snapshot before risky changes, or to A/B a fix against a baseline.',
      inputSchema: args({
        env: ENV_ARG,
        name: str('Name for the copy (same rules as create_environment). Omit for an auto-generated one.'),
        prompt: str('Optional first agent prompt — starts a session in the copy once it is ready.'),
        model: MODEL_ARG,
        agent: str(`Agent for that first session: ${Object.keys(AGENTS).join(' | ')} (default claude).`),
      }, ['env']),
      handler: (body) => ops.duplicateEnvironment(ops.envByRef(body.env), body),
    },
    {
      name: 'wait_for_environment',
      category: 'Environments',
      description: 'Block until an environment reaches running or failed (or the timeout passes — then call again; cold builds take ~10 min). Returns the environment description plus done:true/false.',
      inputSchema: args({ env: ENV_ARG, timeoutSeconds: int('Max seconds to wait, 5-600 (default 120).') }, ['env']),
      handler: async ({ env, timeoutSeconds }) => {
        const t = Math.min(Math.max(parseInt(timeoutSeconds, 10) || 120, 5), 600);
        return pollEnv(ops.envByRef(env).id, t * 1000);
      },
    },
    {
      name: 'get_setup_logs',
      category: 'Environments',
      description: 'Tail an environment\'s logs. which: "setup" (provisioning log — read this when a create fails), "dev" (dev/watch script), or "all".',
      inputSchema: args({ env: ENV_ARG, which: str('setup | dev | all (default setup).'), tail: int('Lines to tail, max 5000 (default 200).') }, ['env']),
      handler: async ({ env, which, tail }) =>
        manager.logs(ops.envByRef(env), which || 'setup', Math.min(parseInt(tail, 10) || 200, 5000)),
    },
    {
      name: 'start_environment',
      category: 'Environments',
      description: 'Start a stopped environment\'s containers (data was preserved).',
      inputSchema: args({ env: ENV_ARG }, ['env']),
      handler: ({ env }) => manager.start(ops.envByRef(env)),
    },
    {
      name: 'stop_environment',
      category: 'Environments',
      description: 'Stop an environment\'s containers. Data is preserved; start_environment resumes it.',
      inputSchema: args({ env: ENV_ARG }, ['env']),
      handler: ({ env }) => manager.stop(ops.envByRef(env)),
    },
    {
      name: 'destroy_environment',
      category: 'Environments',
      description: 'Destroy an environment permanently: stop and remove its containers, delete its directory, and delete all its agent sessions. Irreversible.',
      inputSchema: args({ env: ENV_ARG }, ['env']),
      handler: async ({ env }) => { await ops.destroyEnvironment(ops.envByRef(env)); return { deleted: true }; },
    },
    {
      name: 'set_environment_label',
      category: 'Environments',
      description: 'Set the display label shown in lists (canonical name/URL unchanged). Empty label resets to the canonical name.',
      inputSchema: args({ env: ENV_ARG, label: str('New display label (empty to reset).') }, ['env']),
      handler: async ({ env, label }) => {
        const rec = ops.envByRef(env);
        const clean = String(label ?? '').replace(/\s+/g, ' ').trim();
        return manager.describe(await registry.update(rec.id, { displayName: clean ? clean.slice(0, 80) : null }));
      },
    },
    {
      name: 'mint_admin_login',
      category: 'Environments',
      description: 'Mint a one-time, 5-minute, passwordless wp-admin login URL for a running environment. No password needed — just open the returned loginUrl.',
      inputSchema: args({ env: ENV_ARG }, ['env']),
      handler: ({ env }) => ops.mintAdminLogin(ops.envByRef(env)),
    },

    // ---- presets ----------------------------------------------------------
    {
      name: 'list_presets',
      category: 'Presets',
      description: 'List provisioning presets (saved blueprints: setup script, plugins to activate, defines, app ports). Use their ids in create_environment.',
      inputSchema: args(),
      handler: async () => ({ presets: presets.list() }),
    },
    {
      name: 'create_preset',
      category: 'Presets',
      description: 'Create a provisioning preset.',
      inputSchema: args({
        name: str('Preset name (required).'),
        description: str('What this preset sets up.'),
        setupScript: str('Bash run once in the workspace after WordPress is up.'),
        devScript: str('Long-running dev/watch script.'),
        activate: { type: 'array', items: { type: 'string' }, description: 'Plugin slugs to activate, in order.' },
        defines: { type: 'object', description: 'wp-config PHP defines.' },
        appPorts: { type: 'array', items: { type: 'integer' }, description: 'Extra container ports to publish.' },
      }, ['name']),
      handler: (body) => presets.create(validatePreset(body)),
    },
    {
      name: 'update_preset',
      category: 'Presets',
      description: 'REPLACE a preset\'s definition (PUT semantics — send the FULL object; omitted provision fields are cleared, so read it from list_presets first and modify).',
      inputSchema: args({
        presetId: PRESET_ARG,
        name: str('Preset name (required).'),
        description: str('What this preset sets up.'),
        setupScript: str('Bash run once in the workspace after WordPress is up.'),
        devScript: str('Long-running dev/watch script.'),
        activate: { type: 'array', items: { type: 'string' }, description: 'Plugin slugs to activate, in order.' },
        defines: { type: 'object', description: 'wp-config PHP defines.' },
        appPorts: { type: 'array', items: { type: 'integer' }, description: 'Extra container ports to publish.' },
      }, ['presetId', 'name']),
      handler: async ({ presetId, ...body }) => {
        const rec = await presets.update(presetId, validatePreset(body));
        if (!rec) throw httpErr(404, `preset "${presetId}" not found`);
        return rec;
      },
    },
    {
      name: 'delete_preset',
      category: 'Presets',
      description: 'Delete a preset (existing environments built from it are unaffected).',
      inputSchema: args({ presetId: PRESET_ARG }, ['presetId']),
      handler: async ({ presetId }) => {
        if (!(await presets.remove(presetId))) throw httpErr(404, `preset "${presetId}" not found`);
        return { deleted: true };
      },
    },

    // ---- warm pool --------------------------------------------------------
    {
      name: 'pool_status',
      category: 'Warm pool',
      description: 'Warm-pool status per preset: desired/ready/building/failed counts. Ready members make create_environment near-instant for that preset.',
      inputSchema: args(),
      handler: async () => ({ pool: manager.poolStatus() }),
    },
    {
      name: 'set_pool_size',
      category: 'Warm pool',
      description: 'Set the desired number of pre-built warm environments kept ready for a preset (0 turns its pool off). The pool refills in the background.',
      inputSchema: args({ presetId: PRESET_ARG, count: int('Desired ready count, 0-50.') }, ['presetId', 'count']),
      handler: async ({ presetId, count }) => {
        if (!presets.get(presetId)) throw httpErr(404, `preset "${presetId}" not found`);
        await settings.setWarmPool(presetId, Math.max(0, Math.min(50, parseInt(count, 10) || 0)));
        manager.maintainPoolSoon();
        return { pool: manager.poolStatus() };
      },
    },
    {
      name: 'rebuild_pool',
      category: 'Warm pool',
      description: 'Discard a preset\'s warm environments so they rebuild from current code (use after changing the preset). The pool refills in the background.',
      inputSchema: args({ presetId: PRESET_ARG }, ['presetId']),
      handler: async ({ presetId }) => {
        if (!presets.get(presetId)) throw httpErr(404, `preset "${presetId}" not found`);
        return { rebuilt: await manager.rebuildPool(presetId), pool: manager.poolStatus() };
      },
    },

    // ---- agent sessions ---------------------------------------------------
    {
      name: 'start_session',
      category: 'Agent sessions',
      description: 'Start a headless agent session (claude | codex | opencode) inside a RUNNING environment with a first prompt. Async — returns the session immediately; follow with wait_for_turn to get the answer.',
      inputSchema: args({
        env: ENV_ARG,
        prompt: str('The first prompt/task for the agent.'),
        model: MODEL_ARG,
        agent: str(`Agent CLI to use: ${Object.keys(AGENTS).join(' | ')} (default claude).`),
      }, ['env', 'prompt']),
      handler: async ({ env, prompt, model, agent }) => {
        const rec = ops.envByRef(env);
        await ops.assertUsable(rec);
        const p = String(prompt || '').trim();
        if (!p) throw httpErr(400, 'prompt is required');
        return ops.publicSession(await sessions.engine.newSession(rec, { prompt: p, model, agent: AGENTS[agent] ? agent : 'claude' }));
      },
    },
    {
      name: 'send_message',
      category: 'Agent sessions',
      description: 'Send the next prompt to an existing session (resumes the same conversation). One turn at a time — errors if a turn is in progress. Async — follow with wait_for_turn.',
      inputSchema: args({ sessionId: SESSION_ARG, prompt: str('The next prompt.') }, ['sessionId', 'prompt']),
      handler: async ({ sessionId, prompt }) => {
        const s = ops.sessionByRef(sessionId);
        if (sessions.engine.isActive(s.id)) throw httpErr(409, 'a turn is already in progress for this session');
        const env = registry.get(s.envId);
        if (!env) throw httpErr(410, 'the environment for this session no longer exists');
        await ops.assertUsable(env);
        const p = String(prompt || '').trim();
        if (!p) throw httpErr(400, 'prompt is required');
        await sessions.engine.sendMessage(env, s, { prompt: p });
        return ops.publicSession(sessions.store.get(s.id));
      },
    },
    {
      name: 'wait_for_turn',
      category: 'Agent sessions',
      description: 'Block until the session\'s current turn finishes (or the timeout passes — then call again). Returns the session with lastResult = the agent\'s final answer (truncated; use get_transcript for the full trail) and done:true/false.',
      inputSchema: args({ sessionId: SESSION_ARG, timeoutSeconds: int('Max seconds to wait, 5-600 (default 60).') }, ['sessionId']),
      handler: async ({ sessionId, timeoutSeconds }) => {
        const t = Math.min(Math.max(parseInt(timeoutSeconds, 10) || 60, 5), 600);
        const deadline = Date.now() + t * 1000;
        for (;;) {
          const s = ops.sessionByRef(sessionId); // throws 404 if deleted mid-wait
          if (!sessions.engine.isActive(s.id)) return { ...ops.publicSession(s), done: true };
          if (Date.now() >= deadline) {
            return { ...ops.publicSession(s), done: false, hint: 'turn still running — call wait_for_turn again' };
          }
          await sleep(1000);
        }
      },
    },
    {
      name: 'list_sessions',
      category: 'Agent sessions',
      description: 'List agent sessions, optionally filtered by environment, status, or archived ("only" | "exclude"; default both, flagged).',
      inputSchema: args({ env: ENV_ARG, status: str('Filter: running | completed | interrupted | failed.'), archived: str('"only" | "exclude" (default: include both).') }),
      handler: async ({ env, status, archived }) => {
        let list = sessions.store.list();
        if (env) { const rec = ops.envByRef(env); list = list.filter((s) => s.envId === rec.id); }
        if (status) list = list.filter((s) => ops.publicSession(s).status === status);
        if (archived === 'only') list = list.filter((s) => s.archived);
        else if (archived === 'exclude') list = list.filter((s) => !s.archived);
        return { sessions: list.map(ops.publicSession) };
      },
    },
    {
      name: 'get_session',
      category: 'Agent sessions',
      description: 'One session: status, turnCount, lastResult, cost, timestamps.',
      inputSchema: args({ sessionId: SESSION_ARG }, ['sessionId']),
      handler: async ({ sessionId }) => ops.publicSession(ops.sessionByRef(sessionId)),
    },
    {
      name: 'get_transcript',
      category: 'Agent sessions',
      description: 'The session\'s event history (assistant/user messages incl. tool use, and per-turn results). Token-by-token partials are excluded unless includePartial, and giant strings inside events (screenshots, whole-file tool results) are truncated to clipChars.',
      inputSchema: args({
        sessionId: SESSION_ARG,
        tail: int('Events to return from the end, max 5000 (default 200).'),
        includePartial: { type: 'boolean', description: 'Include raw stream_event token deltas (verbose; default false).' },
        clipChars: int('Max chars per string inside an event before truncation, 0 = unlimited (default 16384).'),
      }, ['sessionId']),
      handler: ({ sessionId, tail, includePartial, clipChars }) =>
        ops.readTranscript(ops.sessionByRef(sessionId), {
          tail: Math.min(parseInt(tail, 10) || 200, 5000),
          partials: includePartial ? 'all' : 'none',
          clip: clipChars === 0 ? 0 : Math.max(0, parseInt(clipChars, 10) || 16384),
        }),
    },
    {
      name: 'interrupt_session',
      category: 'Agent sessions',
      description: 'Interrupt the session\'s in-flight turn (like pressing Esc). The session survives and can be resumed with send_message.',
      inputSchema: args({ sessionId: SESSION_ARG }, ['sessionId']),
      handler: async ({ sessionId }) => {
        const s = ops.sessionByRef(sessionId);
        if (!sessions.engine.interrupt(s.id)) throw httpErr(409, 'no active turn to interrupt');
        return ops.publicSession(sessions.store.get(s.id));
      },
    },
    {
      name: 'rename_session',
      category: 'Agent sessions',
      description: 'Set a session\'s title.',
      inputSchema: args({ sessionId: SESSION_ARG, title: str('New title.') }, ['sessionId', 'title']),
      handler: async ({ sessionId, title }) => {
        const s = ops.sessionByRef(sessionId);
        const clean = String(title || '').replace(/\s+/g, ' ').trim();
        if (!clean) throw httpErr(400, 'title is required');
        return ops.publicSession(await sessions.store.update(s.id, { title: clean.slice(0, 200) }));
      },
    },
    {
      name: 'archive_session',
      category: 'Agent sessions',
      description: 'Archive a session (hidden from default lists; transcript and resume id persist). Interrupts any in-flight turn first.',
      inputSchema: args({ sessionId: SESSION_ARG }, ['sessionId']),
      handler: async ({ sessionId }) => {
        const s = ops.sessionByRef(sessionId);
        sessions.engine.interrupt(s.id);
        return ops.publicSession(await sessions.store.update(s.id, { archived: true }));
      },
    },
    {
      name: 'restore_session',
      category: 'Agent sessions',
      description: 'Un-archive a session.',
      inputSchema: args({ sessionId: SESSION_ARG }, ['sessionId']),
      handler: async ({ sessionId }) =>
        ops.publicSession(await sessions.store.update(ops.sessionByRef(sessionId).id, { archived: false })),
    },
    {
      name: 'delete_session',
      category: 'Agent sessions',
      description: 'Delete a session permanently (record, transcript, resume id). Irreversible — archive_session if you might want it back.',
      inputSchema: args({ sessionId: SESSION_ARG }, ['sessionId']),
      handler: async ({ sessionId }) => { await ops.deleteSession(ops.sessionByRef(sessionId)); return { deleted: true }; },
    },

    // ---- control ----------------------------------------------------------
    {
      name: 'interrupt_all_sessions',
      category: 'Control',
      description: 'Interrupt every running agent turn across all sessions. Environments keep running.',
      inputSchema: args(),
      handler: async () => ({ interrupted: sessions.engine.interruptAll() }),
    },
    {
      name: 'stop_all_environments',
      category: 'Control',
      description: 'Stop ALL environments\' containers (interrupts their agent turns too). Data preserved; start each again individually.',
      inputSchema: args(),
      handler: async () => { sessions.engine.interruptAll(); return { stopped: await manager.stopAll() }; },
    },
  ];
  // Deliberately NOT exposed over MCP: settings writes (credential rotation)
  // and /control/shutdown (kills the control server) — those stay browser-only.

  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const instructions = buildInstructions(TOOLS, config);

  // ---- JSON-RPC dispatch --------------------------------------------------
  const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  const dispatch = async (msg) => {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: KNOWN_PROTOCOLS.has(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions,
        });
      }
      case 'ping':
        return rpcResult(msg.id, {});
      case 'tools/list':
        return rpcResult(msg.id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const { name, arguments: toolArgs } = msg.params || {};
        const tool = byName.get(name);
        if (!tool) return rpcError(msg.id, -32602, `unknown tool "${name}"`);
        try {
          const data = await tool.handler(toolArgs || {});
          const result = { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
          if (data && typeof data === 'object' && !Array.isArray(data)) result.structuredContent = data;
          return rpcResult(msg.id, result);
        } catch (err) {
          // Tool failures are results (isError), not protocol errors, per spec.
          return rpcResult(msg.id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
        }
      }
      default:
        return rpcError(msg.id, -32601, `method "${msg.method}" not supported`);
    }
  };

  return [
    route('POST', '/mcp', async (ctx) => {
      const msg = ctx.body;
      if (Array.isArray(msg)) return ctx.send(400, rpcError(null, -32600, 'JSON-RPC batching is not supported'));
      if (!msg || msg.jsonrpc !== '2.0') return ctx.send(400, rpcError(msg?.id ?? null, -32600, 'expected a JSON-RPC 2.0 message'));
      // Notifications (and client responses) get 202 + no body.
      if (msg.id === undefined || msg.id === null || !msg.method) {
        ctx.res.writeHead(202).end();
        return;
      }
      ctx.send(200, await dispatch(msg));
    }),
    // Stateless server: no server-initiated SSE stream, no session to delete.
    route('GET', '/mcp', async (ctx) => ctx.send(405, { error: 'no server stream — POST JSON-RPC messages to /mcp' })),
    route('DELETE', '/mcp', async (ctx) => ctx.send(405, { error: 'stateless server — no session to delete' })),
  ];
}

// ---- generated instructions ----------------------------------------------
// Built from the same TOOLS table that serves tools/list, so the guide always
// matches the callable surface. Served as initialize.instructions AND via the
// get_instructions tool.
function buildInstructions(tools, config) {
  const sig = (t) => {
    const req = new Set(t.inputSchema.required || []);
    const names = Object.keys(t.inputSchema.properties || {});
    return `${t.name}(${names.map((n) => (req.has(n) ? n : `${n}?`)).join(', ')})`;
  };
  const categories = [...new Set(tools.map((t) => t.category))];
  const reference = categories
    .map((c) => `### ${c}\n${tools.filter((t) => t.category === c).map((t) => `- **${sig(t)}** — ${t.description}`).join('\n')}`)
    .join('\n\n');

  return `# Katalyst Devbox Server

You are connected to a devbox control server that manages many self-contained
**WordPress dev environments** on one Docker host and can drive coding agents
(claude | codex | opencode) **headlessly inside each one**. Each environment is
a live WordPress site (wpUrl) plus a workspace container with WP-CLI, Node,
git, gh, and the agent CLIs. Environments are provisioned by composable
**presets** (setup script, plugins, wp-config defines, extra ports).

## Core workflows

**Create an environment and open its site:**
1. \`list_presets\` → pick preset id(s). \`host_health\` first if creating several.
2. \`create_environment({ presetIds: [id] })\` — returns immediately (async).
3. \`wait_for_environment({ env })\` until \`done: true\` and status \`running\`
   (warm claims take seconds; cold builds ~10 min — just call it again on timeout).
4. \`mint_admin_login({ env })\` → one-time passwordless wp-admin URL; the site
   itself is at the environment's \`wpUrl\`.

**Drive an agent inside an environment (the main loop):**
1. \`start_session({ env, prompt })\` — async, returns the session id.
2. \`wait_for_turn({ sessionId })\` until \`done: true\` — \`lastResult\` is the
   agent's final answer (truncated to ~4000 chars).
3. \`get_transcript({ sessionId })\` when you need the full tool-use trail.
4. \`send_message({ sessionId, prompt })\` to continue the same conversation,
   then \`wait_for_turn\` again. One turn at a time per session.

Passing \`prompt\` to \`create_environment\` fuses the two flows: the session
starts automatically the moment the env is ready.

Both accept an optional \`model\` — any Claude Code alias or id, passed verbatim
to the agent CLI. Omitted, a claude session runs the server default
("${config.claudeDefaultModel}", resolved by Claude Code to the latest Opus).
The model is fixed for the session's lifetime.

\`duplicate_environment({ env })\` clones an existing environment — full DB +
files copy on a fresh name and port (the source briefly stops during the copy,
then restarts; sessions don't carry over). Also accepts \`prompt\`/\`model\`, and
is followed with \`wait_for_environment\` on the copy like a create.

## Environment status lifecycle
\`scaffolding\` → \`setting-up\` → \`configuring\` → **\`running\`** (create pipeline; wait it out)
· \`degraded\` (some containers down) · \`stopped\` (resume with start_environment)
· \`failed\` (read get_setup_logs, then usually destroy and recreate)
· \`duplicating\` (a copy of this env is being taken — it restarts on its own).

## Rules and gotchas
- Environment names: \`^[a-z0-9][a-z0-9-]{1,38}$\`, unique. Omit to auto-generate.
- Everything async returns BEFORE the work finishes — use the wait_* tools.
- Each environment costs a few GB of RAM: check \`host_health\` before mass-creating; creation errors "at capacity" when full.
- \`update_preset\` REPLACES the whole preset — read it first, send the full object.
- After editing a preset, \`rebuild_pool\` so its warm environments rebuild from the new definition.
- Credentials (GitHub/Claude tokens) are managed server-side by the operator — never send or request them.
- \`destroy_environment\` and \`delete_session\` are irreversible; prefer stop/archive when unsure.

## Tool reference

${reference}
`;
}
