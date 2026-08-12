// Shared operations used by BOTH API surfaces: the JSON HTTP routes
// (routes.js) and the MCP endpoint (mcp.js). Extracted so the two cannot
// drift — one implementation of env lookup, env-create composition (incl. the
// warm-pool fast path), admin-login minting, session shaping, and input
// validation. Endpoint files stay thin: parse transport, call ops, shape reply.

import { rm } from 'node:fs/promises';
import { exec } from './docker.js';
import { AGENTS } from './claude.js';
import { composeProvision } from './provision.js';

export function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Run inside the workspace via `wp eval`: mint a one-time admin login URL for the
// site's first administrator through the agent-connector ability's service. The
// FQCN is the same whether the companion ships as default- or universal-abilities.
const ADMIN_LOGIN_PHP = `
$admins = get_users(array('role' => 'administrator', 'number' => 1, 'orderby' => 'ID'));
$u = $admins ? $admins[0] : null;
if (!$u) { fwrite(STDERR, 'no administrator user'); exit(1); }
$cls = 'AgentConnectorForWp\\DefaultAbilities\\Services\\AdminLoginLink';
if (!class_exists($cls)) { fwrite(STDERR, 'abilities plugin (admin login) not active'); exit(1); }
$r = $cls::create($u->ID, 'index.php', 300);
if (is_wp_error($r)) { fwrite(STDERR, $r->get_error_message()); exit(1); }
echo $r['login_url'];
`;

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i; // plugin slug
const CONST_RE = /^[A-Za-z_][A-Za-z0-9_]*$/; // PHP constant name

// Validate the activate list + defines map shared by provision and presets.
// Throws 400 on a bad slug / constant name / defines shape.
export function validateProvisionFields(body = {}) {
  const setupScript = typeof body.setupScript === 'string' ? body.setupScript : '';
  const devScript = typeof body.devScript === 'string' ? body.devScript : '';

  let activate = [];
  if (body.activate != null) {
    if (!Array.isArray(body.activate)) throw httpErr(400, 'activate must be an array of plugin slugs');
    activate = body.activate.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
    for (const s of activate) if (!SLUG_RE.test(s)) throw httpErr(400, `invalid plugin slug "${s}"`);
  }

  let defines = {};
  if (body.defines != null) {
    if (typeof body.defines !== 'object' || Array.isArray(body.defines)) {
      throw httpErr(400, 'defines must be a JSON object of { "WP_CONST": value } pairs');
    }
    defines = body.defines;
    for (const k of Object.keys(defines)) if (!CONST_RE.test(k)) throw httpErr(400, `invalid define name "${k}"`);
  }

  // Container ports to publish per env (each gets a unique host port from the
  // allocator), e.g. [3000] for a Next.js dev server.
  let appPorts = [];
  if (body.appPorts != null) {
    if (!Array.isArray(body.appPorts)) throw httpErr(400, 'appPorts must be an array of container ports, e.g. [3000]');
    appPorts = body.appPorts.map((p) => parseInt(p, 10));
    for (const p of appPorts) {
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw httpErr(400, `invalid app port "${p}" — expected an integer 1-65535`);
    }
    appPorts = [...new Set(appPorts)];
  }

  return { setupScript, devScript, activate, defines, appPorts };
}

// A preset additionally carries name/description.
export function validatePreset(body = {}) {
  const name = String((body && body.name) || '').trim();
  if (!name) throw httpErr(400, 'preset name is required');
  return { name, description: typeof body.description === 'string' ? body.description : '', ...validateProvisionFields(body) };
}

// Custom (ad-hoc) provision fields for a create. Returns null when nothing was
// specified (a blank WordPress env, or presets-only).
export function normalizeProvision(body) {
  if (!body || typeof body !== 'object') return null;
  const { setupScript, devScript, activate, defines, appPorts } = validateProvisionFields(body);
  if (!setupScript && !devScript && !activate.length && !Object.keys(defines).length && !appPorts.length) return null;
  return { setupScript, devScript, activate, defines, appPorts };
}

// Build the shared ops bundle. `sessions` bundles { store, engine, bus }.
export function buildOps(config, registry, manager, sessions, presets) {
  const envByRef = (ref) => {
    const rec = registry.get(ref) || registry.getByName(ref);
    if (!rec) throw httpErr(404, `environment "${ref}" not found`);
    return rec;
  };

  const sessionByRef = (ref) => {
    const s = sessions.store.get(ref);
    if (!s) throw httpErr(404, `session "${ref}" not found`);
    return s;
  };

  const assertUsable = async (env) => {
    if (!(await manager.usable(env))) throw httpErr(409, `environment "${env.name}" is not running`);
  };

  // Fully remove a session: stop any active turn, drop its event stream + log
  // file, and delete the record. Used by session delete and env destroy.
  const deleteSession = async (s) => {
    sessions.engine.interrupt(s.id);
    sessions.bus.clear(s.id);
    await sessions.store.remove(s.id);
    if (s.eventLogPath) await rm(s.eventLogPath, { force: true }).catch(() => {});
  };

  // Destroy an env and everything tied to it (sessions cascade).
  const destroyEnvironment = async (env) => {
    sessions.engine.killEnvSessions(env.id);
    for (const s of sessions.store.listByEnv(env.id)) await deleteSession(s);
    await manager.destroy(env);
  };

  const sshHint = (s) => {
    const env = registry.get(s.envId);
    if (!env || !s.claudeSessionId) return null;
    return (AGENTS[s.agent] || AGENTS.claude).resumeHint(env.dir, s.claudeSessionId);
  };

  const publicSession = (s) => ({
    id: s.id,
    envId: s.envId,
    envName: s.envName,
    agent: s.agent || 'claude',
    claudeSessionId: s.claudeSessionId,
    cwd: s.cwd,
    model: s.model,
    title: s.title,
    status: sessions.engine.isActive(s.id) ? 'running' : s.status,
    turnCount: s.turnCount,
    lastResult: s.lastResult,
    costUsd: s.costUsd,
    lastError: s.lastError,
    archived: !!s.archived,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    sshResumeHint: sshHint(s),
  });

  // One-click passwordless wp-admin login: mint a one-time, 5-min link via the
  // agent-connector ability already installed in every env. Returns a localhost
  // URL with the token; callers rebase the host:port (redemption uses the
  // request host, so the token is host-agnostic).
  const mintAdminLogin = async (env) => {
    await assertUsable(env);
    let res;
    try {
      res = await exec(env, 'workspace', ['wp', 'eval', ADMIN_LOGIN_PHP], { timeout: 30_000 });
    } catch (err) {
      throw httpErr(502, `could not mint admin login link: ${String(err.stderr || err.message || '').trim().slice(0, 200)}`);
    }
    const url = String(res.stdout || '').trim();
    if (!/^https?:\/\/\S*acfw_login=/.test(url)) {
      throw httpErr(502, `admin login link unavailable: ${String(res.stderr || url || '').trim().slice(0, 200)}`);
    }
    return { loginUrl: url };
  };

  // Create an environment: compose any selected presets (in order) with optional
  // custom fields; a single preset with no custom overrides can claim a warm
  // pre-built env (seconds) instead of building (~10m). Async either way — the
  // caller polls until `running`. Throws AllocationError on capacity/name issues.
  const createEnvironment = async (body = {}) => {
    const presetIds = Array.isArray(body.presetIds) ? body.presetIds : [];
    const selected = presetIds.map((pid) => {
      const p = presets.get(pid);
      if (!p) throw httpErr(400, `unknown preset "${pid}"`);
      return p;
    });
    const custom = normalizeProvision(body.provision);
    const provision = composeProvision(selected, custom);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
    const agent = AGENTS[body.agent] ? body.agent : undefined; // first-prompt session agent; else default

    if (presetIds.length === 1 && !custom) {
      const claimed = await manager.claimAndStart(presetIds[0], { name: body.name, prompt: prompt || undefined, model, agent });
      if (claimed) {
        return { id: claimed.id, name: claimed.name, port: claimed.port, appPorts: claimed.appPorts ?? [], wpUrl: claimed.wpUrl, status: 'configuring', warm: true };
      }
    }

    const record = await manager.createEnvironment({ name: body.name, provision, prompt: prompt || undefined, model, agent });
    return { id: record.id, name: record.name, port: record.port, appPorts: record.appPorts ?? [], wpUrl: record.wpUrl, status: record.status, warm: false };
  };

  return {
    envByRef,
    sessionByRef,
    assertUsable,
    deleteSession,
    destroyEnvironment,
    publicSession,
    mintAdminLogin,
    createEnvironment,
  };
}
