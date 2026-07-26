// Headless agent turn engine. Each turn spawns the environment's OWN
// scripts/in-workspace.sh to run a coding agent (`claude -p …` or `codex exec …`)
// in the workspace container — reusing the proven auth path (token resolution +
// -e forwarding). The agent's own session/thread id is captured for --resume.
//
// Two agents are supported (chosen per session). Claude's stream-json is recorded
// raw; Codex's `--json` events are normalized into the same event vocabulary the
// UI already renders, so the transcript UI is agent-agnostic.
//
// An agent turn runs INSIDE the workspace container (via `docker compose exec`),
// so it does NOT die when the server / exec client dies — it's reparented to the
// container's init and keeps running. We reap it explicitly on interrupt,
// shutdown, and restart; otherwise a later resume spawns a second agent that
// races the orphan. The slim image has no pkill, so we sweep /proc.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exec } from './docker.js';
import { log, redact } from './log.js';

const AGENT_CWD = '/home/node'; // in-workspace.sh runs the agent here (container WORKDIR)

// Per-agent specifics: how to build the command, which token to inject, and how
// to turn one stdout line into { records[], sessionId?, result?, addCost?, errorText? }.
// `records` are events in the UI's vocabulary (system/assistant/user/result/stderr/raw).
export const AGENTS = {
  claude: {
    label: 'Claude',
    procMatch: 'claude -p ', // cmdline prefix used to reap the in-container turn
    settingsKey: 'claudeToken',
    tokenEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    defaultModel: (config) => config.claudeDefaultModel || null,
    resumeHint: (dir, sid) => `cd ${dir} && bash scripts/in-workspace.sh claude --resume ${sid}`,
    buildArgs(session, prompt) {
      const a = ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--dangerously-skip-permissions'];
      if (session.model) a.push('--model', session.model);
      if (session.claudeSessionId) a.push('--resume', session.claudeSessionId);
      return a;
    },
    parseLine(line) {
      let evt;
      try { evt = JSON.parse(line); } catch { return { records: [{ type: 'raw', text: line }] }; }
      const out = { records: [evt] };
      if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) out.sessionId = evt.session_id;
      if (evt.type === 'result') {
        if (typeof evt.result === 'string') out.result = evt.result;
        if (typeof evt.total_cost_usd === 'number') out.addCost = evt.total_cost_usd;
        if (evt.session_id) out.sessionId = evt.session_id;
        if (evt.is_error) out.errorText = typeof evt.result === 'string' ? evt.result : 'claude reported an error';
      }
      return out;
    },
  },
  codex: {
    label: 'Codex',
    procMatch: 'codex exec', // cmdline prefix used to reap the in-container turn
    settingsKey: 'codexToken',
    tokenEnv: 'CODEX_API_KEY',
    defaultModel: (config) => config.codexDefaultModel || null,
    resumeHint: (dir, sid) => `cd ${dir} && bash scripts/in-workspace.sh codex exec resume ${sid}`,
    buildArgs(session, prompt) {
      // exec-level flags (--json, -C, -m, sandbox bypass) MUST come before the
      // `resume` subcommand — `codex exec resume` has a narrow option set and
      // rejects them. So: codex exec <exec-flags> [resume <id>] <prompt>.
      const a = ['codex', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', AGENT_CWD];
      if (session.model) a.push('-m', session.model);
      if (session.claudeSessionId) a.push('resume', session.claudeSessionId);
      a.push(prompt);
      return a;
    },
    // Normalize codex --json events → the UI's claude-shaped vocabulary.
    parseLine(line) {
      let evt;
      try { evt = JSON.parse(line); } catch { return { records: [{ type: 'raw', text: line }] }; }
      const out = { records: [] };
      const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
      const toolUse = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
      switch (evt.type) {
        case 'thread.started':
          if (evt.thread_id) { out.sessionId = evt.thread_id; out.records.push({ type: 'system', subtype: 'init', session_id: evt.thread_id, model: 'codex' }); }
          break;
        case 'item.completed': {
          const it = evt.item || {};
          if (it.type === 'agent_message' && it.text) { out.records.push(assistantText(it.text)); out.result = it.text; }
          else if (it.type === 'reasoning' && (it.text || it.summary)) out.records.push(assistantText(it.text || it.summary));
          else if (it.type) out.records.push(toolUse(it.type, it)); // command_execution / file_change / tool_call / mcp_tool_call …
          break;
        }
        case 'error':
          out.errorText = String(evt.message || JSON.stringify(evt));
          out.records.push({ type: 'stderr', text: out.errorText });
          break;
        case 'turn.failed':
          out.errorText = `turn failed: ${JSON.stringify(evt.error || evt)}`;
          out.records.push({ type: 'stderr', text: out.errorText });
          break;
        case 'turn.completed':
          out.records.push({ type: 'result', result: '', total_cost_usd: 0, usage: evt.usage });
          break;
        default:
          break; // turn.started, item.started, etc. — nothing to show
      }
      return out;
    },
  },
  opencode: {
    label: 'OpenCode',
    procMatch: 'opencode run', // cmdline prefix used to reap the in-container turn
    settingsKey: 'opencodeToken',
    tokenEnv: 'OPENCODE_API_KEY', // OpenCode Zen gateway key
    defaultModel: (config) => config.opencodeDefaultModel || 'opencode/claude-sonnet-4-6',
    resumeHint: (dir, sid) => `cd ${dir} && bash scripts/in-workspace.sh opencode run -s ${sid}`,
    buildArgs(session, prompt) {
      const a = ['opencode', 'run', '--format', 'json', '--dangerously-skip-permissions', '--dir', AGENT_CWD];
      if (session.model) a.push('-m', session.model);
      if (session.claudeSessionId) a.push('-s', session.claudeSessionId);
      a.push(prompt);
      return a;
    },
    // Normalize `opencode run --format json` events → the UI's claude-shaped
    // vocabulary. Event shapes confirmed against opencode 1.17.11 + the source
    // (sst/opencode cli/cmd/run.ts emits {type, timestamp, sessionID, ...{part|error}}).
    // Top-level types: step_start, text, reasoning, tool_use, step_finish, error.
    // opencode is NOT a token stream here — `text`/`reasoning` carry the COMPLETE
    // segment when it finishes, and `tool_use` fires only when the tool completes
    // or errors. So we emit one assistant bubble per segment (like Codex's
    // item.completed) and an empty `result` footer on the terminal step_finish.
    parseLine(line, pending) {
      let evt;
      try { evt = JSON.parse(line); } catch { return { records: [{ type: 'raw', text: line }] }; }
      const out = { records: [] };
      const part = evt.part || {};
      const sid = evt.sessionID || part.sessionID;
      if (sid) out.sessionId = sid;
      const assistantText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
      switch (String(evt.type || '')) {
        case 'step_start':
          // session chip, once — sessionID rides on every event so guard on pending.
          if (sid && !pending.ocInit) { pending.ocInit = true; out.records.push({ type: 'system', subtype: 'init', session_id: sid, model: 'opencode' }); }
          break;
        case 'text':
          if (typeof part.text === 'string' && part.text) {
            out.records.push(assistantText(part.text));
            pending.ocText = (pending.ocText ? `${pending.ocText}\n\n` : '') + part.text;
            out.result = pending.ocText; // store.lastResult = full answer
          }
          break;
        case 'reasoning':
          if (typeof part.text === 'string' && part.text) out.records.push(assistantText(part.text));
          break;
        case 'tool_use': {
          const st = (part.state && typeof part.state === 'object') ? part.state : {};
          const input = st.input || part.input || {};
          const output = typeof st.output === 'string' ? trunc(st.output, 2000) : st.output;
          out.records.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: part.tool || 'tool', input: { ...input, _status: st.status, _output: output } }] } });
          break;
        }
        case 'step_finish': {
          const cost = Number(part.cost) || 0;
          if (cost) out.addCost = cost;
          pending.ocCost = (pending.ocCost || 0) + cost;
          // reason 'tool-calls' = an intermediate step (more turns follow); anything
          // else (stop/length/…) is terminal → emit the footer. Text lives in the
          // assistant bubbles above, so result is empty (mirrors Codex).
          if (part.reason && part.reason !== 'tool-calls') {
            out.records.push({ type: 'result', result: '', total_cost_usd: pending.ocCost, usage: part.tokens });
          }
          break;
        }
        case 'error':
        case 'session.error': {
          const e = evt.error || {};
          out.errorText = String((e.data && e.data.message) || e.message || e.name || (typeof e === 'string' ? e : JSON.stringify(e)) || 'opencode error');
          out.records.push({ type: 'stderr', text: out.errorText });
          break;
        }
        default:
          break; // step parts we don't render
      }
      return out;
    },
  },
};

const agentFor = (name) => AGENTS[name] || AGENTS.claude;

// Reap any in-container agent turn (claude / codex / opencode) for this env. Best-effort.
const REAP_AGENTS = `self=$$
for sig in TERM KILL; do
  for d in /proc/[0-9]*; do
    pid=\${d#/proc/}; [ "$pid" = "$self" ] && continue
    c=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null)
    case "$c" in "claude -p "*|"codex exec"*|"opencode run"*) kill -$sig "$pid" 2>/dev/null ;; esac
  done
  [ "$sig" = TERM ] && sleep 1
done`;

export async function reapAgents(env) {
  try {
    await exec(env, 'workspace', ['sh', '-c', REAP_AGENTS], { timeout: 15_000 });
  } catch { /* container gone or nothing to kill */ }
}

export class ClaudeEngine {
  constructor(config, store, bus, settings) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.settings = settings;
    this.active = new Map(); // sessionId -> { child, ndjson, interrupting, env }
  }

  isActive(id) {
    return this.active.has(id);
  }

  // Start a brand-new session (turn 1). `agent` is 'claude' (default) or 'codex'.
  async newSession(env, { prompt, model, agent } = {}) {
    const name = AGENTS[agent] ? agent : 'claude';
    const id = `sess_${randomBytes(5).toString('hex')}`;
    const record = {
      id,
      envId: env.id,
      envName: env.name,
      agent: name,
      claudeSessionId: null, // the agent's own resume id (claude session_id / codex thread_id)
      cwd: AGENT_CWD,
      model: model || agentFor(name).defaultModel(this.config) || null,
      title: title(prompt),
      status: 'running',
      turnCount: 0,
      lastResult: null,
      costUsd: 0,
      lastError: null,
      eventLogPath: join(this.config.sessionsDir, `${id}.ndjson`),
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    await this.store.create(record);
    this._runTurn(env, record, prompt);
    return record;
  }

  // Continue an existing session (resume). Caller ensures it isn't already running.
  async sendMessage(env, session, { prompt }) {
    await this.store.update(session.id, { status: 'running', lastActivityAt: new Date().toISOString() });
    this._runTurn(env, { ...session, status: 'running' }, prompt);
  }

  _runTurn(env, session, prompt) {
    const agent = agentFor(session.agent);
    const args = [join(env.dir, 'scripts', 'in-workspace.sh'), ...agent.buildArgs(session, prompt)];

    mkdirSync(this.config.sessionsDir, { recursive: true });
    const ndjson = createWriteStream(session.eventLogPath, { flags: 'a' });
    ndjson.on('error', (e) => log.warn(`[${session.id}] event log write error:`, e.message));
    ndjson.write(`${JSON.stringify({ type: 'control', subtype: 'turn-start', at: new Date().toISOString() })}\n`);

    // The agent doesn't echo the prompt (it's argv), so record it ourselves — to
    // the ndjson (transcript reload) and the live bus. uuid dedupes replay vs SSE.
    const promptEvt = { type: 'user_prompt', text: prompt, uuid: randomUUID() };
    ndjson.write(JSON.stringify(promptEvt) + '\n');
    this.bus.publish(session.id, promptEvt);

    // Inject the agent's token from Settings (if set); else in-workspace.sh falls
    // back to the host env / ~/.agent-sandbox file. stdin ignored → non-TTY → -T.
    const token = this.settings && this.settings.get()[agent.settingsKey];
    const childEnv = token ? { ...process.env, [agent.tokenEnv]: token } : process.env;
    const child = spawn('bash', args, { cwd: env.dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = { child, ndjson, interrupting: false, env };
    this.active.set(session.id, entry);

    let buf = '';
    let stderr = '';
    const pending = { sessionId: session.claudeSessionId, lastResult: null, addCost: 0, errorText: null };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this._handleLine(session, agent, line, ndjson, pending);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
      this.bus.publish(session.id, { type: 'stderr', text: redact(String(d)) });
    });

    const finalize = async (code, signal) => {
      if (buf.trim()) this._handleLine(session, agent, buf, ndjson, pending); // trailing partial line
      buf = '';
      ndjson.end();
      this.active.delete(session.id);
      const interrupted = entry.interrupting || signal === 'SIGINT' || signal === 'SIGTERM';
      const status = interrupted ? 'interrupted' : code === 0 ? 'idle' : 'error';
      const patch = {
        status,
        turnCount: (session.turnCount || 0) + 1,
        lastActivityAt: new Date().toISOString(),
        claudeSessionId: pending.sessionId || session.claudeSessionId || null,
        costUsd: (session.costUsd || 0) + pending.addCost,
      };
      if (pending.lastResult != null) patch.lastResult = trunc(pending.lastResult, 4000);
      if (status === 'error') patch.lastError = trunc(redact(pending.errorText || stderr) || `${agent.label} exited with code ${code}`, 800);
      else if (status === 'idle') patch.lastError = null;
      await this.store.update(session.id, patch);
      this.bus.publish(session.id, { type: 'control', subtype: 'turn-end', code, status });
      log.info(`[${session.id}] ${agent.label} turn ended (${status}, code ${code})`);
    };

    child.on('error', (err) => {
      this.bus.publish(session.id, { type: 'control', subtype: 'spawn-error', error: redact(err.message) });
      finalize(-1, null).catch(() => {});
    });
    child.on('close', (code, signal) => finalize(code, signal).catch((e) => log.warn(`[${session.id}] finalize:`, e.message)));
  }

  // Parse one stdout line via the agent, record its events, capture state.
  _handleLine(session, agent, line, ndjson, pending) {
    const { records = [], sessionId, result, addCost, errorText } = agent.parseLine(line, pending);
    for (const rec of records) {
      ndjson.write(JSON.stringify(rec) + '\n');
      this.bus.publish(session.id, rec);
    }
    if (sessionId && !pending.sessionId) {
      pending.sessionId = sessionId;
      this.store.update(session.id, { claudeSessionId: sessionId }).catch(() => {}); // persist immediately → resumable
    }
    if (typeof result === 'string') pending.lastResult = result;
    if (typeof addCost === 'number') pending.addCost += addCost;
    if (errorText) pending.errorText = errorText;
  }

  interrupt(id) {
    const a = this.active.get(id);
    if (!a) return false;
    a.interrupting = true;
    a.child.kill('SIGINT'); // the local docker-exec client
    if (a.env) reapAgents(a.env).catch(() => {}); // the in-container turn (survives the client)
    return true;
  }

  interruptAll() {
    const ids = [...this.active.keys()];
    for (const id of ids) this.interrupt(id);
    return ids.length;
  }

  killEnvSessions(envId) {
    let env = null;
    for (const s of this.store.listByEnv(envId)) {
      const a = this.active.get(s.id);
      if (a) { a.interrupting = true; a.child.kill('SIGTERM'); env = a.env; }
    }
    if (env) reapAgents(env).catch(() => {});
  }
}

function title(prompt) {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 80)}…` : t || '(empty)';
}
function trunc(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
