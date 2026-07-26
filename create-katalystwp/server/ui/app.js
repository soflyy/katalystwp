// Devbox Claude-sessions UI — buildless Preact + htm (ES modules from esm.sh).
import { h, render } from 'https://esm.sh/preact@10.24.3';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10.24.3/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
const html = htm.bind(h);

// ---- API ------------------------------------------------------------------
const token = {
  get: () => localStorage.getItem('devbox_token') || '',
  set: (t) => localStorage.setItem('devbox_token', t || ''),
};
async function api(path, opts = {}) {
  const t = token.get();
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(body.error || `${res.status} ${res.statusText}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}
const streamUrl = (id) => {
  const t = token.get();
  return `/sessions/${id}/stream${t ? `?access_token=${encodeURIComponent(t)}` : ''}`;
};

// ---- stream-json → transcript items --------------------------------------
function reduce(items, partialRef, evt) {
  const push = (it) => items.push(it);
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init') push({ kind: 'system', text: `session ${String(evt.session_id || '').slice(0, 8)} · ${evt.model || ''}` });
      break;
    case 'stream_event': {
      const d = evt.event && evt.event.delta;
      if (d && d.type === 'text_delta' && d.text) partialRef.text += d.text;
      break;
    }
    case 'assistant': {
      partialRef.text = '';
      const content = (evt.message && evt.message.content) || [];
      for (const b of content) {
        if (b.type === 'text' && b.text.trim()) push({ kind: 'assistant', text: b.text });
        else if (b.type === 'tool_use') push({ kind: 'tool_use', name: b.name, input: b.input });
      }
      break;
    }
    case 'user_prompt':
      // the message the user sent — claude -p doesn't echo it, so the server records it
      push({ kind: 'user', text: evt.text });
      break;
    case 'user': {
      const content = (evt.message && evt.message.content) || [];
      for (const b of content) {
        if (b.type === 'tool_result') push({ kind: 'tool_result', content: b.content });
      }
      break;
    }
    case 'result':
      push({ kind: 'result', result: evt.result, cost: evt.total_cost_usd, ms: evt.duration_ms, isError: evt.is_error });
      break;
    case 'stderr':
      if (String(evt.text || '').trim()) push({ kind: 'stderr', text: evt.text });
      break;
    case 'control':
      if (evt.subtype === 'turn-start') push({ kind: 'control', text: '— turn —' });
      break;
    case 'raw':
      push({ kind: 'raw', text: evt.text });
      break;
  }
}

// ---- components -----------------------------------------------------------
function StatusDot({ status }) {
  return html`<span class="dot ${status}" title=${status}></span>`;
}

const TRANSIENT_ENV = ['scaffolding', 'setting-up', 'configuring', 'destroying'];

function EnvRow({ env, onAction }) {
  const building = TRANSIENT_ENV.includes(env.status);
  const up = env.status === 'running' || env.status === 'degraded';
  // Link to the WP site on the SAME host the UI was loaded from (not the
  // server's localhost wpUrl) — so it works from a phone/laptop hitting the
  // server's IP, and still works from inside the devbox via localhost.
  const wpUrl = `${location.protocol}//${location.hostname}:${env.port}/`;
  return html`
    <div class="env">
      <div class="env-top">
        <${StatusDot} status=${env.status} /> <span class="env-name" title=${env.displayName ? `${env.displayName} · ${env.name}` : env.name}>${env.displayName || env.name}</span>
        ${env.preset && html`<span class="badge" title="provisioned from preset">${env.preset}</span>`}
        <a class="env-port" href=${wpUrl} target="_blank" rel="noreferrer" title="Open the site front end" onClick=${(e) => e.stopPropagation()}>:${env.port}</a>
        ${(env.appPorts || []).map((p) => html`<a class="env-port" href=${`${location.protocol}//${location.hostname}:${p.host}/`} target="_blank" rel="noreferrer" title=${`App port → container :${p.container}`} onClick=${(e) => e.stopPropagation()}>:${p.host}<span class="muted small">→${p.container}</span></a>`)}
        ${up && html`<button class="env-admin lnk" title="One-click passwordless wp-admin login" onClick=${(e) => { e.stopPropagation(); onAction('admin-login', env); }}>admin ↗</button>`}
      </div>
      <div class="env-actions">
        ${building
          ? html`<span class="muted small">${env.status}…</span>
            <button class="lnk" onClick=${() => onAction('logs', env)}>logs</button>`
          : html`
            ${up && html`<button class="lnk" onClick=${() => onAction('session', env)}>+ session</button>`}
            ${up && html`<button class="lnk" onClick=${() => onAction('stop', env)}>stop</button>`}
            ${env.status === 'stopped' && html`<button class="lnk" onClick=${() => onAction('start', env)}>start</button>`}
            ${env.status === 'failed' && html`<button class="lnk" onClick=${() => onAction('start', env)}>retry</button>`}
            <button class="lnk" onClick=${() => onAction('rename', env)}>rename</button>
            <button class="lnk" onClick=${() => onAction('ssh', env)} title="Copy a command to open a shell / interactive Claude on the box">ssh</button>
            <button class="lnk" onClick=${() => onAction('logs', env)}>logs</button>
            <button class="lnk danger" onClick=${() => onAction('delete', env)}>delete</button>`}
      </div>
    </div>`;
}

function WorkingTag({ since, now }) {
  // Live "working Ns" while a turn is executing (since = turn start = lastActivityAt).
  const ms = (now || Date.now()) - Date.parse(since || '');
  return html`<span class="sess-time working" title="Claude is working right now">working ${fmtDur(ms)}</span>`;
}

function SessionItem({ s, selectedId, onSelect, onDelete, onArchive, onRestore, now }) {
  const running = s.status === 'running';
  return html`
    <div class=${`sess ${s.id === selectedId ? 'active' : ''} ${s.archived ? 'archived' : ''}`} onClick=${() => onSelect(s.id)}>
      <div class="sess-top">
        <${StatusDot} status=${s.status} />
        <span class="sess-title">${s.title || s.id}</span>
        ${running
          ? html`<${WorkingTag} since=${s.lastActivityAt} now=${now} />`
          : html`<span class="sess-time" title=${`last active ${fullTime(s.lastActivityAt)}`}>${fmtAgo(s.lastActivityAt)}</span>`}
        ${s.archived
          ? html`<button class="sess-arch lnk" title="Restore session" onClick=${(e) => { e.stopPropagation(); onRestore(s); }}>↩</button>`
          : html`<button class="sess-arch lnk" title="Archive session (hide, keep transcript)" onClick=${(e) => { e.stopPropagation(); onArchive(s); }}>🗄</button>`}
        <button class="sess-del lnk" title="Delete session" onClick=${(e) => { e.stopPropagation(); onDelete(s); }}>🗑</button>
      </div>
      <div class="sess-sub muted"><span class="agent-tag">${agentLabel(s.agent)}</span> · started ${fmtAgo(s.createdAt, true)} · ${s.turnCount} turn${s.turnCount === 1 ? '' : 's'} · $${(s.costUsd || 0).toFixed(3)}</div>
    </div>`;
}

function Sidebar({ sessions, envs, selectedId, now, onSelect, onNewEnv, onEnvAction, onSettings, onHealth, onDeleteSession, onArchiveSession, onRestoreSession }) {
  const [expanded, setExpanded] = useState(() => new Set());
  // Which envs currently have their "Archived (N)" reveal expanded.
  const [archOpen, setArchOpen] = useState(() => new Set());
  // Declutter long lists: stopped envs (data intact, just parked) are hidden by
  // default. "Active" = anything not stopped (running/degraded/building/failed).
  const [filter, setFilter] = useState('active');
  const activeCount = envs.filter((e) => e.status !== 'stopped').length;
  const stoppedCount = envs.length - activeCount;
  const shown = envs.filter((e) =>
    filter === 'all' ? true : filter === 'stopped' ? e.status === 'stopped' : e.status !== 'stopped');
  const toggle = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleArch = (id) => setArchOpen((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // The environment holding the selected session is always shown open, so a
  // freshly-created/selected session is visible without a manual expand.
  const selEnvId = (sessions.find((s) => s.id === selectedId) || {}).envId;

  return html`
    <aside class="sidebar">
      <div class="side-head">
        <strong>Devbox</strong>
        <div class="side-head-btns">
          <button class="btn small ghost" onClick=${onHealth} title="System health">📊</button>
          <button class="btn small ghost" onClick=${onSettings} title="Settings">⚙</button>
        </div>
      </div>
      <div class="side-section grow">
        <div class="section-head"><span>Environments</span><button class="btn small" onClick=${onNewEnv}>+ Env</button></div>
        <div class="env-filter">
          <button class=${`seg ${filter === 'active' ? 'on' : ''}`} onClick=${() => setFilter('active')}>Active ${activeCount}</button>
          <button class=${`seg ${filter === 'stopped' ? 'on' : ''}`} onClick=${() => setFilter('stopped')}>Stopped ${stoppedCount}</button>
          <button class=${`seg ${filter === 'all' ? 'on' : ''}`} onClick=${() => setFilter('all')}>All ${envs.length}</button>
        </div>
        <div class="side-list">
          ${envs.length === 0 && html`<div class="muted pad small">No environments — create one.</div>`}
          ${envs.length > 0 && shown.length === 0 && html`<div class="muted pad small">No ${filter} environments.</div>`}
          ${shown.map((e) => {
            const envSessions = sessions
              .filter((s) => s.envId === e.id)
              .sort((a, b) => String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));
            // Archived sessions are kept but hidden behind a reveal, so a busy env
            // (20 sessions) can show just the two you're working on.
            const active = envSessions.filter((s) => !s.archived);
            const archived = envSessions.filter((s) => s.archived);
            const open = expanded.has(e.id) || e.id === selEnvId;
            const showArch = archOpen.has(e.id);
            const itemProps = { selectedId, now, onSelect, onDelete: onDeleteSession, onArchive: onArchiveSession, onRestore: onRestoreSession };
            return html`
              <div class="env-group" key=${e.id}>
                <${EnvRow} env=${e} onAction=${onEnvAction} />
                <button class="sess-toggle" onClick=${() => toggle(e.id)}>
                  <span class="chev">${open ? '▾' : '▸'}</span>
                  ${active.length} session${active.length === 1 ? '' : 's'}
                  ${archived.length > 0 && html`<span class="muted small"> · ${archived.length} archived</span>`}
                </button>
                ${open && html`
                  <div class="env-sessions">
                    ${active.length === 0 && archived.length === 0 && html`<div class="muted pad small no-sess">No sessions yet.</div>`}
                    ${active.length === 0 && archived.length > 0 && html`<div class="muted pad small no-sess">No active sessions.</div>`}
                    ${active.map((s) => html`<${SessionItem} ...${itemProps} s=${s} key=${s.id} />`)}
                    ${archived.length > 0 && html`
                      <button class="arch-toggle" onClick=${() => toggleArch(e.id)}>
                        <span class="chev">${showArch ? '▾' : '▸'}</span>
                        Archived (${archived.length})
                      </button>`}
                    ${showArch && archived.map((s) => html`<${SessionItem} ...${itemProps} s=${s} key=${s.id} />`)}
                  </div>`}
              </div>`;
          })}
        </div>
      </div>
    </aside>`;
}

function Bubble({ it }) {
  if (it.kind === 'user') return html`<div class="bubble user"><pre>${it.text}</pre></div>`;
  if (it.kind === 'assistant') return html`<div class="bubble assistant"><pre>${it.text}</pre></div>`;
  if (it.kind === 'system') return html`<div class="chip">${it.text}</div>`;
  if (it.kind === 'control') return html`<div class="divider">${it.text}</div>`;
  if (it.kind === 'tool_use')
    return html`<details class="tool"><summary>🔧 ${it.name}</summary><pre>${JSON.stringify(it.input, null, 2)}</pre></details>`;
  if (it.kind === 'tool_result') {
    const text = typeof it.content === 'string' ? it.content : JSON.stringify(it.content, null, 2);
    return html`<details class="tool result"><summary>↳ result</summary><pre>${text}</pre></details>`;
  }
  if (it.kind === 'result')
    return html`<div class="result-foot ${it.isError ? 'err' : ''}">✓ done · $${(it.cost || 0).toFixed(4)} · ${Math.round((it.ms || 0))}ms</div>`;
  if (it.kind === 'stderr') return html`<div class="stderr"><pre>${it.text}</pre></div>`;
  return html`<div class="raw"><pre>${it.text}</pre></div>`;
}

function SessionView({ session, now, onChanged, onBack, onDelete, onArchive, onRestore }) {
  const [items, setItems] = useState([]);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const partialRef = useRef({ text: '' });
  const seen = useRef(new Set());
  const scroller = useRef(null);
  const stick = useRef(true); // follow the stream only while pinned near the bottom
  const [hasNew, setHasNew] = useState(false);
  const id = session.id;

  useEffect(() => {
    // Reset for the newly-selected session, load history, then go live.
    setItems([]); setPartial(''); partialRef.current = { text: '' }; seen.current = new Set();
    stick.current = true; setHasNew(false);
    let es;
    let cancelled = false;
    (async () => {
      try {
        const { events } = await api(`/sessions/${id}/transcript?tail=5000`);
        const arr = [];
        for (const e of events) { if (e.uuid) seen.current.add(e.uuid); reduce(arr, partialRef.current, e); }
        if (!cancelled) { setItems(arr.slice()); setPartial(partialRef.current.text); }
      } catch { /* fresh session, no transcript */ }
      if (cancelled) return;
      es = new EventSource(streamUrl(id));
      es.onmessage = (m) => {
        let evt; try { evt = JSON.parse(m.data); } catch { return; }
        if (evt.type === 'control' && evt.subtype === 'snapshot') return;
        if (evt.uuid && seen.current.has(evt.uuid)) return;
        if (evt.uuid) seen.current.add(evt.uuid);
        if (evt.type === 'control' && evt.subtype === 'turn-end') { setBusy(false); onChanged && onChanged(); }
        setItems((prev) => { const next = prev.slice(); reduce(next, partialRef.current, evt); return next; });
        setPartial(partialRef.current.text);
      };
      es.onerror = () => {/* EventSource auto-reconnects */};
    })();
    return () => { cancelled = true; if (es) es.close(); };
  }, [id]);

  // Auto-scroll only while pinned to the bottom. If the user scrolled up to read,
  // leave them there and just flag that new content arrived.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else if (items.length || partial) setHasNew(true);
  }, [items, partial]);
  const onTranscriptScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stick.current && hasNew) setHasNew(false);
  };
  const jumpToBottom = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setHasNew(false);
  };

  const running = busy || session.status === 'running';
  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || running) return;
    setInput(''); setBusy(true);
    try { await api(`/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt }) }); onChanged && onChanged(); }
    catch (e) { setBusy(false); alert(`Send failed: ${e.message}`); }
  }, [input, running, id]);
  const interrupt = async () => { try { await api(`/sessions/${id}/interrupt`, { method: 'POST' }); } catch (e) { alert(e.message); } };
  const startEdit = () => { setDraft(session.title || ''); setEditing(true); };
  const saveTitle = async () => {
    const t = draft.replace(/\s+/g, ' ').trim();
    setEditing(false);
    if (!t || t === session.title) return;
    try { await api(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title: t }) }); onChanged && onChanged(); }
    catch (e) { alert(`Rename failed: ${e.message}`); }
  };

  return html`
    <section class="main">
      <header class="bar">
        <div class="bar-title">
          <button class="back btn small ghost" onClick=${onBack} title="Back to list">‹</button>
          <${StatusDot} status=${session.status} />
          ${editing
            ? html`<input class="rename" value=${draft}
                ref=${(el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
                onInput=${(e) => setDraft(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); saveTitle(); } else if (e.key === 'Escape') setEditing(false); }}
                onBlur=${saveTitle} />`
            : html`<strong title="Double-click to rename" onDblClick=${startEdit}>${session.title || id}</strong>
                <button class="lnk small" onClick=${startEdit} title="Rename">✎</button>
                ${session.archived
                  ? html`<button class="lnk small" onClick=${onRestore} title="Restore session">↩</button>`
                  : html`<button class="lnk small" onClick=${onArchive} title="Archive session (hide, keep transcript)">🗄</button>`}
                <button class="lnk small danger" onClick=${onDelete} title="Delete session">🗑</button>`}
        </div>
        <div class="bar-meta muted">
          ${session.envName} · <span class="agent-tag">${agentLabel(session.agent)}</span> · ${session.model || 'default model'} · $${(session.costUsd || 0).toFixed(4)}
          ${session.claudeSessionId && html`· <code title="agent session id">${session.claudeSessionId.slice(0, 8)}</code>`}
        </div>
        <div class="bar-meta muted" title=${`started ${fullTime(session.createdAt)}\nlast active ${fullTime(session.lastActivityAt)}`}>
          started ${fmtAgo(session.createdAt, true)} ·${' '}
          ${session.status === 'running'
            ? html`<${WorkingTag} since=${session.lastActivityAt} now=${now} />`
            : html`last active ${fmtAgo(session.lastActivityAt, true)}`}
        </div>
      </header>
      ${session.sshResumeHint && html`<div class="ssh muted" onClick=${() => copyText(session.sshResumeHint)} title="click to copy">SSH resume: <code>${session.sshResumeHint}</code></div>`}
      <div class="transcript" ref=${scroller} onScroll=${onTranscriptScroll}>
        ${items.map((it, i) => html`<${Bubble} it=${it} key=${i} />`)}
        ${partial && html`<div class="bubble assistant live"><pre>${partial}</pre><span class="cursor">▍</span></div>`}
        ${running && !partial && html`<div class="muted pad">…thinking</div>`}
      </div>
      ${hasNew && html`<button class="new-msgs" onClick=${jumpToBottom}>↓ New messages</button>`}
      <footer class="composer">
        <textarea
          value=${input}
          placeholder=${running ? 'Turn in progress…' : 'Message Claude (Enter to send, Shift+Enter for newline)'}
          disabled=${running}
          onInput=${(e) => setInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        ></textarea>
        ${running
          ? html`<button class="btn warn" onClick=${interrupt}>Interrupt</button>`
          : html`<button class="btn" onClick=${send} disabled=${!input.trim()}>Send</button>`}
      </footer>
    </section>`;
}

function NewSessionModal({ envs, preselect, onClose, onCreate }) {
  const usable = envs.filter((e) => e.status === 'running' || e.status === 'degraded');
  const [envId, setEnvId] = useState(preselect || (usable[0] && usable[0].id));
  const [agent, setAgent] = useState('claude');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState('');
  const create = async () => {
    if (!envId || !prompt.trim()) return;
    try { await onCreate(envId, prompt.trim(), agent, model.trim() || undefined); } catch (e) { setErr(e.message); }
  };
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>New session</h3>
        ${usable.length === 0 && html`<div class="muted">No running environments. Create/start one first.</div>`}
        <label>Environment
          <select value=${envId} onChange=${(e) => setEnvId(e.target.value)}>
            ${usable.map((e) => html`<option value=${e.id} key=${e.id}>${e.name} (:${e.port})</option>`)}
          </select>
        </label>
        <${AgentPicker} agent=${agent} model=${model} prompt=${prompt}
          onAgent=${setAgent} onModel=${setModel} onPrompt=${setPrompt}
          promptLabel="First message" />
        ${err && html`<div class="err-msg">${err}</div>`}
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Cancel</button>
          <button class="btn" onClick=${create} disabled=${!envId || !prompt.trim()}>Create</button>
        </div>
      </div>
    </div>`;
}

function fmtDur(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

// Relative time. Compact ("3m","2h","3d","Jun 26") or long ("3m ago","on Jun 26").
function fmtAgo(iso, long = false) {
  const t = Date.parse(iso || '');
  if (isNaN(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m${long ? ' ago' : ''}`;
  if (s < 86400) return `${Math.round(s / 3600)}h${long ? ' ago' : ''}`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d${long ? ' ago' : ''}`;
  const d = new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return long ? `on ${d}` : d;
}
// Full timestamp for hover/title.
function fullTime(iso) {
  const t = Date.parse(iso || '');
  return isNaN(t) ? '' : new Date(t).toLocaleString();
}
const AGENT_LABELS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const agentLabel = (a) => AGENT_LABELS[a] || 'Claude';
const AGENTS_ORDER = ['claude', 'codex', 'opencode'];

// Curated model choices per agent. The first entry (id '') means "let the agent /
// server default decide". A "Custom…" escape hatch lets you type any id, except
// for agents in NO_CUSTOM_MODEL. Set only at session start. The OpenCode (Zen)
// list is the subset verified usable with our Zen key (see its comment below).
const MODELS = {
  claude: [
    { id: '', label: 'Default' },
    { id: 'fable', label: 'Fable 5' },
    { id: 'opus', label: 'Opus 4.8' },
    { id: 'sonnet', label: 'Sonnet 4.6' },
    { id: 'haiku', label: 'Haiku 4.5' },
  ],
  codex: [
    { id: '', label: 'Default' },
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol (flagship)' },
    { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra (balanced)' },
    { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna (fast/cheap)' },
    { id: 'gpt-5.5', label: 'gpt-5.5' },
    { id: 'gpt-5.4', label: 'gpt-5.4' },
    { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { id: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark (ChatGPT sign-in only)' },
  ],
  // OpenCode (Zen) — the models verified usable with our Zen key (probed via
  // `opencode run -m opencode/<id>`; the gateway catalog is a superset that
  // includes gated/retired models that error on use). Custom… stays available
  // for anything new. Re-probe to refresh: scratchpad/probe2.sh.
  opencode: [
    { id: '', label: 'Default (Claude Sonnet 4.6)' },
    { id: 'opencode/claude-opus-4-8', label: 'claude-opus-4-8' },
    { id: 'opencode/claude-opus-4-7', label: 'claude-opus-4-7' },
    { id: 'opencode/claude-opus-4-6', label: 'claude-opus-4-6' },
    { id: 'opencode/claude-opus-4-5', label: 'claude-opus-4-5' },
    { id: 'opencode/claude-opus-4-1', label: 'claude-opus-4-1' },
    { id: 'opencode/claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { id: 'opencode/claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
    { id: 'opencode/claude-haiku-4-5', label: 'claude-haiku-4-5' },
    { id: 'opencode/gemini-3.5-flash', label: 'gemini-3.5-flash' },
    { id: 'opencode/gemini-3.1-pro', label: 'gemini-3.1-pro' },
    { id: 'opencode/gemini-3-flash', label: 'gemini-3-flash' },
    { id: 'opencode/gpt-5.5', label: 'gpt-5.5' },
    { id: 'opencode/gpt-5.5-pro', label: 'gpt-5.5-pro' },
    { id: 'opencode/gpt-5.4', label: 'gpt-5.4' },
    { id: 'opencode/gpt-5.4-pro', label: 'gpt-5.4-pro' },
    { id: 'opencode/gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { id: 'opencode/gpt-5.4-nano', label: 'gpt-5.4-nano' },
    { id: 'opencode/gpt-5.3-codex', label: 'gpt-5.3-codex' },
    { id: 'opencode/gpt-5.2', label: 'gpt-5.2' },
    { id: 'opencode/gpt-5.2-codex', label: 'gpt-5.2-codex' },
    { id: 'opencode/gpt-5.1', label: 'gpt-5.1' },
    { id: 'opencode/gpt-5.1-codex-max', label: 'gpt-5.1-codex-max' },
    { id: 'opencode/gpt-5.1-codex', label: 'gpt-5.1-codex' },
    { id: 'opencode/gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini' },
    { id: 'opencode/gpt-5', label: 'gpt-5' },
    { id: 'opencode/gpt-5-codex', label: 'gpt-5-codex' },
    { id: 'opencode/gpt-5-nano', label: 'gpt-5-nano' },
    { id: 'opencode/grok-4.5', label: 'grok-4.5' },
    { id: 'opencode/grok-build-0.1', label: 'grok-build-0.1' },
    { id: 'opencode/deepseek-v4-pro', label: 'deepseek-v4-pro' },
    { id: 'opencode/deepseek-v4-flash', label: 'deepseek-v4-flash' },
    { id: 'opencode/glm-5.2', label: 'glm-5.2' },
    { id: 'opencode/glm-5.1', label: 'glm-5.1' },
    { id: 'opencode/glm-5', label: 'glm-5' },
    { id: 'opencode/minimax-m2.7', label: 'minimax-m2.7' },
    { id: 'opencode/kimi-k2.6', label: 'kimi-k2.6' },
    { id: 'opencode/kimi-k2.5', label: 'kimi-k2.5' },
    { id: 'opencode/qwen3.6-plus', label: 'qwen3.6-plus' },
    { id: 'opencode/qwen3.5-plus', label: 'qwen3.5-plus' },
    { id: 'opencode/big-pickle', label: 'big-pickle' },
    { id: 'opencode/deepseek-v4-flash-free', label: 'deepseek-v4-flash-free' },
    { id: 'opencode/mimo-v2.5-free', label: 'mimo-v2.5-free' },
    { id: 'opencode/nemotron-3-ultra-free', label: 'nemotron-3-ultra-free' },
    { id: 'opencode/north-mini-code-free', label: 'north-mini-code-free' },
  ],
};
// Agents whose model list is fixed — no free-text "Custom…" option.
const NO_CUSTOM_MODEL = new Set(['codex']);
const MODEL_CUSTOM = '__custom__';

// Shared agent + model + first-message chooser, used by both the New Session and
// New Environment dialogs so the choices stay identical. Controlled: the parent
// owns agent/model/prompt state (it submits them). Model is start-only by design —
// there's no editor for it after a session begins.
function AgentPicker({ agent, model, prompt, onAgent, onModel, onPrompt, promptLabel = 'First message', promptHint = '', promptRows = 4, promptPlaceholder = 'Describe the task…' }) {
  const [custom, setCustom] = useState(false);
  const list = MODELS[agent] || MODELS.claude;
  const allowCustom = !NO_CUSTOM_MODEL.has(agent);
  const pickAgent = (a) => { onAgent(a); onModel(''); setCustom(false); }; // reset model to default
  const pickModel = (v) => { if (v === MODEL_CUSTOM) { setCustom(true); onModel(''); } else { setCustom(false); onModel(v); } };
  return html`
    <div class="row two">
      <label>Agent
        <select value=${agent} onChange=${(e) => pickAgent(e.target.value)}>
          ${AGENTS_ORDER.map((a) => html`<option value=${a} key=${a}>${agentLabel(a)}</option>`)}
        </select>
      </label>
      <label>Model
        <select value=${custom ? MODEL_CUSTOM : model} onChange=${(e) => pickModel(e.target.value)}>
          ${list.map((m) => html`<option value=${m.id} key=${m.id || 'default'}>${m.label}</option>`)}
          ${allowCustom && html`<option value=${MODEL_CUSTOM}>Custom…</option>`}
        </select>
      </label>
    </div>
    ${custom && html`<label>Custom model id
      <input value=${model} placeholder=${agent === 'opencode' ? 'opencode/provider-model' : 'model id'} onInput=${(e) => onModel(e.target.value)} />
    </label>`}
    <label>${promptLabel}${promptHint && html` <span class="muted small">${promptHint}</span>`}
      <textarea value=${prompt} rows=${promptRows} placeholder=${promptPlaceholder} onInput=${(e) => onPrompt(e.target.value)}></textarea>
    </label>`;
}

function LogViewer({ env, onClose }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const box = useRef(null);
  const stick = useRef(true); // keep pinned to bottom unless the user scrolls up
  const lastChange = useRef({ text: null, at: Date.now() }); // when the log last grew

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const { setup } = await api(`/environments/${env.id}/logs?which=setup&tail=2000`);
        if (stop) return;
        const t = setup || '';
        if (t !== lastChange.current.text) { lastChange.current = { text: t, at: Date.now() }; setText(t); }
        setErr('');
      } catch (e) { if (!stop) setErr(e.message); }
    };
    tick();
    const t = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [env.id]);

  // 1s ticker so the elapsed/idle counters stay live even when the log is quiet.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => { if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight; }, [text]);
  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const building = TRANSIENT_ENV.includes(env.status);
  const startedAt = Date.parse(env.setupStartedAt || env.createdAt || '') || now;
  const idle = now - lastChange.current.at;
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal wide logs" onClick=${(e) => e.stopPropagation()}>
        <h3><${StatusDot} status=${env.status} /> Setup log — ${env.name}
          <span class="muted small">${env.status}${building ? ` · ${fmtDur(now - startedAt)} elapsed` : ''}</span></h3>
        ${building && html`<div class="heartbeat muted small">
          <span class="pulse">●</span> live · last output ${fmtDur(idle)} ago${idle > 15000 ? ' — long step, still working…' : ''}</div>`}
        ${err && html`<div class="err-msg">${err}</div>`}
        ${env.lastError && html`<div class="err-msg">${env.lastError}</div>`}
        <pre class="logbox" ref=${box} onScroll=${onScroll}>${text || '(no output yet…)'}</pre>
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Close</button>
        </div>
      </div>
    </div>`;
}

function NewEnvModal({ presets, onClose, onCreate, onSavePreset, onUpdatePreset, onDeletePreset }) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('claude');
  const [model, setModel] = useState('');
  const [presetIds, setPresetIds] = useState([]); // selected preset ids, in check order
  const [setupScript, setSetupScript] = useState('');
  const [devScript, setDevScript] = useState('');
  const [definesText, setDefinesText] = useState('');
  const [activateText, setActivateText] = useState('');
  const [appPortsText, setAppPortsText] = useState('');
  const [presetName, setPresetName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState(null); // preset id being edited, or null (create mode)
  const [showCustom, setShowCustom] = useState(false); // custom-provisioning <details> open state
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const togglePreset = (id) => setPresetIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Parse the custom fields into a provision object (applied on top of presets),
  // or throw a friendly error. Returns null when no custom fields are set —
  // unless allowEmpty (editing a preset, where an all-blank field set is legal).
  const buildCustom = (allowEmpty = false) => {
    let defines = {};
    const dt = definesText.trim();
    if (dt) {
      let parsed;
      try { parsed = JSON.parse(dt); } catch { throw new Error('Defines must be valid JSON.'); }
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) throw new Error('Defines must be a JSON object of { "WP_CONST": value } pairs.');
      defines = parsed;
    }
    const activate = activateText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const appPorts = appPortsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).map((s) => parseInt(s, 10));
    if (appPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('App ports must be container port numbers (1-65535), e.g. 3000.');
    if (!allowEmpty && !setupScript.trim() && !devScript.trim() && !dt && !activate.length && !appPorts.length) return null;
    return { setupScript, devScript, defines, activate, appPorts };
  };

  // Load a saved preset's fields into the custom-provisioning form for in-place
  // editing (PUT), and open the section so the fields are visible.
  const startEdit = (p) => {
    setEditing(p.id);
    setPresetName(p.name || '');
    setDescription(p.description || '');
    setSetupScript(p.setupScript || '');
    setDevScript(p.devScript || '');
    setDefinesText(p.defines && Object.keys(p.defines).length ? JSON.stringify(p.defines, null, 2) : '');
    setActivateText((p.activate || []).join(', '));
    setAppPortsText((p.appPorts || []).join(', '));
    setShowCustom(true);
    setErr('');
  };
  // Leave edit mode and clear the form back to a blank create state.
  const clearEdit = () => {
    setEditing(null); setPresetName(''); setDescription('');
    setSetupScript(''); setDevScript(''); setDefinesText(''); setActivateText(''); setAppPortsText('');
  };

  const create = async () => {
    setErr('');
    let provision;
    try { provision = buildCustom(); } catch (e) { setErr(e.message); return; }
    setBusy(true);
    try { await onCreate(name.trim() || undefined, provision || undefined, prompt.trim() || undefined, presetIds, agent, model.trim() || undefined); }
    catch (e) { setErr(e.message); setBusy(false); }
  };
  const savePreset = async () => {
    setErr('');
    const nm = presetName.trim();
    if (!nm) { setErr(editing ? 'Preset name is required.' : 'Enter a name to save the custom fields as a preset.'); return; }
    let custom;
    // Editing may legitimately save an all-blank field set; creating cannot.
    try { custom = buildCustom(!!editing); } catch (e) { setErr(e.message); return; }
    if (!editing && !custom) { setErr('Fill in at least one custom field to save as a preset.'); return; }
    const payload = { name: nm, description: description.trim(), ...custom };
    try {
      if (editing) { await onUpdatePreset(editing, payload); clearEdit(); }
      else { await onSavePreset(payload); setPresetName(''); setDescription(''); }
    } catch (e) { setErr(e.message); }
  };
  const deletePreset = async (id) => {
    const p = presets.find((x) => x.id === id);
    if (!p || !confirm(`Delete preset "${p.name}"?`)) return;
    try {
      await onDeletePreset(id);
      setPresetIds((prev) => prev.filter((x) => x !== id));
      if (editing === id) clearEdit();
    } catch (e) { setErr(e.message); }
  };

  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal wide" onClick=${(e) => e.stopPropagation()}>
        <h3>New environment</h3>
        <p class="muted">Builds a fresh WordPress devbox (≈1 min). Compose one or more presets, and/or add custom provisioning below. Leave it all blank for a plain site.</p>
        <label>Name (optional)
          <input value=${name} placeholder="my-devbox (a-z, 0-9, -)" onInput=${(e) => setName(e.target.value)} />
        </label>
        <${AgentPicker} agent=${agent} model=${model} prompt=${prompt}
          onAgent=${setAgent} onModel=${setModel} onPrompt=${setPrompt}
          promptLabel="First prompt" promptRows=${3}
          promptHint="— optional; once the env is ready, a session with this agent/model starts with this"
          promptPlaceholder="e.g. Add a custom field to the Oxygen builder and verify it renders." />
        <label>Presets <span class="muted small">— compose any number; applied in the order you check them</span></label>
        <div class="preset-list">
          ${presets.length === 0 && html`<div class="muted small pad">No saved presets yet.</div>`}
          ${presets.map((p) => html`
            <div class="preset-item" key=${p.id}>
              <label class="preset-check">
                <input type="checkbox" checked=${presetIds.includes(p.id)} onChange=${() => togglePreset(p.id)} />
                <span class="preset-name">${p.name}</span>
                ${p.description && html`<span class="muted small">${p.description}</span>`}
              </label>
              <button class="lnk small" title="Edit preset" onClick=${() => startEdit(p)}>✎</button>
              <button class="lnk danger small" title="Delete preset" onClick=${() => deletePreset(p.id)}>✕</button>
            </div>`)}
        </div>
        <details class="custom-prov" open=${showCustom} onToggle=${(e) => setShowCustom(e.target.open)}>
          <summary>${editing ? html`Editing preset — <strong>${presetName || 'untitled'}</strong>` : 'Custom provisioning (optional, applied after presets)'}</summary>
          <label>Setup script <span class="muted small">— runs once in the workspace as <code>node</code> (cwd /home/node, WordPress at ./wp)</span>
            <textarea class="mono" rows="5" value=${setupScript} placeholder=${'#!/usr/bin/env bash\nset -euo pipefail\ncd /home/node\ngh repo clone owner/repo\n…'} onInput=${(e) => setSetupScript(e.target.value)}></textarea>
          </label>
          <label>Dev script <span class="muted small">— long-running; runs in the <code>dev</code> container for as long as the stack is up</span>
            <textarea class="mono" rows="3" value=${devScript} placeholder=${'#!/usr/bin/env bash\ncd /home/node/breakdance\nnpm run dev:codespace'} onInput=${(e) => setDevScript(e.target.value)}></textarea>
          </label>
          <label>wp-config defines <span class="muted small">— JSON object; booleans/numbers become raw PHP literals</span>
            <textarea class="mono" rows="3" value=${definesText} placeholder=${'{\n  "WP_DEBUG": true,\n  "WP_MEMORY_LIMIT": "512M"\n}'} onInput=${(e) => setDefinesText(e.target.value)}></textarea>
          </label>
          <label>Activate plugins <span class="muted small">— slugs, in order, comma-separated</span>
            <input value=${activateText} placeholder="oxygen-elements, breakdance-elements" onInput=${(e) => setActivateText(e.target.value)} />
          </label>
          <label>App ports <span class="muted small">— container ports of dev servers to publish (each env gets a unique host port; shown next to the site link)</span>
            <input value=${appPortsText} placeholder="3000" onInput=${(e) => setAppPortsText(e.target.value)} />
          </label>
          <div class="row save-preset">
            <input value=${presetName} placeholder=${editing ? 'Preset name…' : 'Save these custom fields as a preset named…'} onInput=${(e) => setPresetName(e.target.value)} />
            <input value=${description} placeholder="Description (optional)" onInput=${(e) => setDescription(e.target.value)} />
            <button class="btn small ghost" onClick=${savePreset} disabled=${!presetName.trim()}>${editing ? 'Update preset' : 'Save preset'}</button>
            ${editing && html`<button class="lnk small" onClick=${clearEdit}>Cancel edit</button>`}
          </div>
        </details>
        ${err && html`<div class="err-msg">${err}</div>`}
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Cancel</button>
          <button class="btn" onClick=${create} disabled=${busy}>${busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>`;
}

// Warm-pool config: per-preset desired ready count + live status + rebuild.
// Polls /pool so "building → ready" transitions show without a manual refresh.
function WarmPoolSection() {
  const [presets, setPresets] = useState([]);
  const [pool, setPool] = useState([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, pl] = await Promise.all([api('/presets'), api('/pool')]);
      setPresets(p.presets); setPool(pl.pool);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  const byId = Object.fromEntries(pool.map((r) => [r.presetId, r]));
  const setCount = async (presetId, count) => {
    setErr('');
    try { const d = await api(`/pool/${presetId}`, { method: 'PUT', body: JSON.stringify({ count: parseInt(count, 10) || 0 }) }); setPool(d.pool); }
    catch (e) { setErr(e.message); }
  };
  const rebuild = async (presetId, name) => {
    if (!confirm(`Rebuild the warm pool for "${name}"? This destroys its pre-built environments and rebuilds them from scratch (each rebuild takes the full ~10-min setup).`)) return;
    setErr('');
    try { const d = await api(`/pool/${presetId}/rebuild`, { method: 'POST' }); setPool(d.pool); }
    catch (e) { setErr(e.message); }
  };

  return html`
    <div class="warmpool">
      <h4>Warm pool</h4>
      <p class="muted small">Keep pre-built (then stopped) environments waiting per preset, so creating one is an instant start instead of a ~10-minute build. Rebuild to refresh a pool after pushing new code that would make it stale.</p>
      ${presets.length === 0 && html`<div class="muted small">No presets yet — create one to warm a pool.</div>`}
      ${presets.map((p) => {
        const st = byId[p.id] || { desired: 0, ready: 0, building: 0, failed: 0 };
        const live = st.ready + st.building + st.failed;
        return html`
          <div class="wp-row" key=${p.id}>
            <span class="wp-name" title=${p.name}>${p.name}</span>
            <span class="wp-status muted small">
              ${st.ready} ready${st.building ? ` · ${st.building} building` : ''}${st.failed ? ` · ${st.failed} failed` : ''}
            </span>
            <label class="wp-keep muted small">keep
              <input class="wp-count" type="number" min="0" max="50" value=${st.desired}
                onChange=${(e) => setCount(p.id, e.target.value)} title="Desired ready count" />
            </label>
            ${live > 0
              ? html`<button class="lnk" onClick=${() => rebuild(p.id, p.name)}>rebuild</button>`
              : html`<span class="wp-spacer"></span>`}
          </div>`;
      })}
      ${err && html`<div class="err-msg">${err}</div>`}
    </div>`;
}

function SettingsModal({ onClose, onLogout }) {
  const [s, setS] = useState(null);
  const [ghToken, setGh] = useState('');
  const [clToken, setCl] = useState('');
  const [cxToken, setCx] = useState('');
  const [ocToken, setOc] = useState('');
  const [wpUser, setWpUser] = useState('');
  const [wpEmail, setWpEmail] = useState('');
  const [wpPass, setWpPass] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try { const d = await api('/settings'); setS(d); setWpUser(d.wpAdminUser || ''); setWpEmail(d.wpAdminEmail || ''); }
      catch (e) { setErr(e.message); }
    })();
  }, []);

  const hint = (f) => (s && s[f] && s[f].set ? `configured ${s[f].hint} · leave blank to keep` : 'not set');
  const save = async () => {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const body = { wpAdminUser: wpUser, wpAdminEmail: wpEmail };
      if (ghToken) body.githubToken = ghToken;
      if (clToken) body.claudeToken = clToken;
      if (cxToken) body.codexToken = cxToken;
      if (ocToken) body.opencodeToken = ocToken;
      if (wpPass) body.wpAdminPassword = wpPass;
      const d = await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
      setS(d); setGh(''); setCl(''); setCx(''); setOc(''); setWpPass(''); setSaved(true);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal settings" onClick=${(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        ${!s && !err && html`<div class="muted">Loading…</div>`}
        ${s && html`
          <p class="muted small">Saved on the server (<code>data/settings.json</code>). Tokens are write-only — set or replace them here; they're never shown back.</p>
          <label>GitHub token <span class="muted small">— ${hint('githubToken')}</span>
            <input type="password" value=${ghToken} placeholder="ghp_… / github_pat_…" onInput=${(e) => setGh(e.target.value)} />
          </label>
          <label>Claude token <span class="muted small">— ${hint('claudeToken')}</span>
            <input type="password" value=${clToken} placeholder="sk-ant-oat… (from claude setup-token)" onInput=${(e) => setCl(e.target.value)} />
          </label>
          <label>Codex token <span class="muted small">— ${hint('codexToken')}</span>
            <input type="password" value=${cxToken} placeholder="sk-… (OpenAI API key)" onInput=${(e) => setCx(e.target.value)} />
          </label>
          <label>OpenCode token <span class="muted small">— ${hint('opencodeToken')}</span>
            <input type="password" value=${ocToken} placeholder="OpenCode Zen API key (opencode.ai/auth)" onInput=${(e) => setOc(e.target.value)} />
          </label>
          <label>WordPress admin username
            <input value=${wpUser} onInput=${(e) => setWpUser(e.target.value)} />
          </label>
          <label>WordPress admin password <span class="muted small">— ${hint('wpAdminPassword')}</span>
            <input type="password" value=${wpPass} placeholder="leave blank to keep" onInput=${(e) => setWpPass(e.target.value)} />
          </label>
          <label>WordPress admin email
            <input value=${wpEmail} onInput=${(e) => setWpEmail(e.target.value)} />
          </label>
          <p class="muted small">Token changes apply to newly-created environments and new Claude turns. WP-admin defaults seed new sites.</p>`}
        <${WarmPoolSection} />
        ${err && html`<div class="err-msg">${err}</div>`}
        ${saved && html`<div class="ok-msg">Saved.</div>`}
        <div class="modal-foot">
          <button class="lnk" onClick=${onLogout} title="Forget the API token on this device">Log out</button>
          <span class="spacer"></span>
          <button class="btn ghost" onClick=${onClose}>Close</button>
          <button class="btn" onClick=${save} disabled=${!s || busy}>${busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>`;
}

function HealthBar({ pct, tone }) {
  const w = Math.min(100, Math.max(0, Math.round(pct || 0)));
  return html`<div class="hbar"><div class=${`hbar-fill ${tone}`} style=${`width:${w}%`}></div></div>`;
}

function HealthModal({ onClose }) {
  const [h, setH] = useState(null);
  const [err, setErr] = useState('');
  const [ctrlMsg, setCtrlMsg] = useState('');
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try { const d = await api('/host'); if (!stop) { setH(d); setErr(''); } }
      catch (e) { if (!stop) setErr(e.message); }
    };
    tick();
    const t = setInterval(tick, 5000); // docker stats is ~2s; poll gently
    return () => { stop = true; clearInterval(t); };
  }, []);

  const gb = (b) => (b == null ? '—' : `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`);
  const tone = (v, warn, bad) => (v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
  const dfRow = (t) => (h && h.docker.df ? h.docker.df.find((r) => r.Type === t) : null);
  const m = h && h.memory, c = h && h.cpu, dsk = h && h.disk, est = h && h.estimate;
  const load1 = c ? c.loadavg[0] : 0;

  const interruptAll = async () => {
    if (!confirm('Interrupt ALL running Claude turns now? (Environments stay up.)')) return;
    try { const r = await api('/control/interrupt-all', { method: 'POST' }); setCtrlMsg(`Interrupted ${r.interrupted} session(s).`); }
    catch (e) { setCtrlMsg(`Failed: ${e.message}`); }
  };
  const stopAll = async () => {
    if (!confirm('Stop ALL environments (containers down)? Running Claude turns are interrupted too.')) return;
    setCtrlMsg('Stopping all environments…');
    try { const r = await api('/control/stop-all', { method: 'POST' }); setCtrlMsg(`Stopped ${r.stopped.length} environment(s).`); }
    catch (e) { setCtrlMsg(`Failed: ${e.message}`); }
  };
  const shutdown = async () => {
    if (!confirm('Shut down EVERYTHING — interrupt Claude, stop all containers, and exit the server process? You will have to restart it from the terminal.')) return;
    setCtrlMsg('Shutting down — stopping all environments and exiting the server…');
    try { await api('/control/shutdown', { method: 'POST' }); } catch { /* the server is exiting; the request may not return */ }
  };

  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal wide health" onClick=${(e) => e.stopPropagation()}>
        <h3>System health</h3>
        ${err && html`<div class="err-msg">${err}</div>`}
        ${!h && !err && html`<div class="muted">Loading… (gathering docker stats, ~2s)</div>`}
        ${h && html`
          <div class="hrow">
            <span class="hlabel">Memory</span>
            <${HealthBar} pct=${m.usedPct} tone=${tone(m.usedPct, 75, 90)} />
            <span class="hval">${gb(m.usedBytes)} used · <b>${gb(m.availableBytes)} free</b> of ${gb(m.totalBytes)}${m.swapTotalBytes ? '' : ' · no swap'}</span>
          </div>
          <div class="hrow">
            <span class="hlabel">CPU load</span>
            <${HealthBar} pct=${(load1 / c.cores) * 100} tone=${tone(load1 / c.cores, 0.7, 1)} />
            <span class="hval">${load1.toFixed(2)} (1m) of ${c.cores} cores · ${c.loadavg.map((x) => x.toFixed(2)).join(' / ')}</span>
          </div>
          ${dsk && html`<div class="hrow">
            <span class="hlabel">Disk</span>
            <${HealthBar} pct=${dsk.usedPct} tone=${tone(dsk.usedPct, 75, 90)} />
            <span class="hval">${gb(dsk.usedBytes)} used · <b>${gb(dsk.availBytes)} free</b> of ${gb(dsk.totalBytes)}</span>
          </div>`}
          <div class="hrow">
            <span class="hlabel">Docker</span>
            <span class="hval wide-val">${h.docker.containersRunning}/${h.docker.containersTotal} containers${dfRow('Images') ? ` · images ${dfRow('Images').Size}` : ''}${dfRow('Build Cache') ? html` · build cache ${dfRow('Build Cache').Size} <span class="muted">(${dfRow('Build Cache').Reclaimable} reclaimable — run docker system prune)</span>` : ''}</span>
          </div>
          <div class=${`health-callout ${est.ramHeadroomEnvs != null && est.ramHeadroomEnvs <= 1 ? 'bad' : ''}`}>
            ${est.ramHeadroomEnvs != null
              ? html`Room for ≈ <b>${est.ramHeadroomEnvs}</b> more environment${est.ramHeadroomEnvs === 1 ? '' : 's'} in RAM — avg <b>${gb(est.avgEnvMemBytes)}</b>/env, ${h.environments.running} running.${m.swapTotalBytes ? '' : ' No swap: when free RAM hits zero the box starts OOM-killing processes, so keep headroom.'}`
              : html`${h.environments.running} environments running.`}
          </div>
          <div class="muted small">Environments: ${h.environments.running}${h.environments.maxRunning ? `/${h.environments.maxRunning}` : ''} running · ${h.environments.count} stored · stored cap ${h.environments.max}</div>
          ${h.perEnv.length > 0 && html`
            <table class="health-table">
              <thead><tr><th>Environment</th><th>Status</th><th>Containers</th><th>Memory</th></tr></thead>
              <tbody>
                ${h.perEnv.map((e) => html`<tr key=${e.name}>
                  <td>${e.name}</td>
                  <td><${StatusDot} status=${e.status} /> ${e.status}</td>
                  <td>${e.containers}</td>
                  <td>${gb(e.memBytes)}</td>
                </tr>`)}
              </tbody>
            </table>`}
        `}
        <div class="health-controls">
          <div class="section-head"><span>Controls</span></div>
          <div class="ctrl-row">
            <button class="btn small ghost" onClick=${interruptAll}>Interrupt all sessions</button>
            <button class="btn small warn" onClick=${stopAll}>Stop all environments</button>
            <button class="btn small danger-btn" onClick=${shutdown}>Shut down server</button>
          </div>
          ${ctrlMsg && html`<div class="muted small ctrl-msg">${ctrlMsg}</div>`}
        </div>
        <div class="modal-foot"><button class="btn ghost" onClick=${onClose}>Close</button></div>
      </div>
    </div>`;
}

function TokenGate({ onSave }) {
  const [val, setVal] = useState(token.get());
  return html`
    <div class="modal-bg">
      <div class="modal">
        <h3>API token</h3>
        <p class="muted">Enter the server's <code>DEVBOX_API_TOKEN</code> (stored in this browser only).</p>
        <input type="password" value=${val} onInput=${(e) => setVal(e.target.value)} placeholder="Bearer token" />
        <div class="modal-foot"><button class="btn" onClick=${() => { token.set(val); onSave(); }}>Save</button></div>
      </div>
    </div>`;
}

function RenameEnvModal({ env, onClose, onSave }) {
  const [val, setVal] = useState(env.displayName || env.name);
  const save = () => onSave(env, val.trim());
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>Rename environment</h3>
        <p class="muted small">List label only. The canonical name <code>${env.name}</code> (its directory and Docker project) is unchanged. Leave blank to reset to it.</p>
        <input autofocus value=${val} placeholder=${env.name}
          onInput=${(e) => setVal(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose(); }} />
        <div class="modal-foot">
          <button class="btn ghost" onClick=${onClose}>Cancel</button>
          <button class="btn" onClick=${save}>Save</button>
        </div>
      </div>
    </div>`;
}

// Copy text to the clipboard. navigator.clipboard only exists on https/localhost,
// so fall back to a hidden-textarea + execCommand('copy') for plain-http origins
// (the common case here: hitting the box by IP). Returns true on success.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to the execCommand path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

function CopyLine({ cmd }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(cmd)) { setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };
  return html`
    <div class="copyline">
      <code>${cmd}</code>
      <button class="btn small ghost" onClick=${copy}>${copied ? 'copied ✓' : 'copy'}</button>
    </div>`;
}

// Per-env SSH helper: the UI can't run the interactive Claude TUI (/plugin,
// /mcp, …) over its headless pipe, so hand the user a paste-ready command to
// reach it on the box. Host = the address they loaded the UI from; dir is the
// env's host path. Both editable by the user (it's just text).
function SshModal({ env, onClose }) {
  const host = location.hostname || 'YOUR_BOX';
  const label = env.displayName || env.name;
  const shellCmd = `ssh root@${host} -t 'cd ${env.dir} && exec bash -l'`;
  const claudeCmd = `ssh root@${host} -t 'cd ${env.dir} && npm run claude'`;
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(host);
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>SSH into ${label}</h3>
        <p class="muted small">Open a shell on the box, in this environment's directory. From there <code>npm run claude</code> gives you the full interactive Claude — <code>/plugin</code>, <code>/mcp</code>, <code>/agents</code>, etc. Anything you set up there persists in the workspace and your UI sessions use it too.</p>
        <label class="muted small">Shell in this environment</label>
        <${CopyLine} cmd=${shellCmd} />
        <label class="muted small">…or jump straight into interactive Claude</label>
        <${CopyLine} cmd=${claudeCmd} />
        ${loopback && html`<p class="muted small">You loaded this UI over <code>${host}</code> — if you SSH from another machine, swap that for the box's hostname/IP.</p>`}
        <div class="modal-foot"><button class="btn" onClick=${onClose}>Close</button></div>
      </div>
    </div>`;
}

function App() {
  const [sessions, setSessions] = useState([]);
  const [envs, setEnvs] = useState([]);
  const [presets, setPresets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [newSession, setNewSession] = useState(null); // null | { preselect? }
  const [showNewEnv, setShowNewEnv] = useState(false);
  const [logEnvId, setLogEnvId] = useState(null);
  const [renameEnv, setRenameEnv] = useState(null);
  const [sshEnv, setSshEnv] = useState(null);
  const [needToken, setNeedToken] = useState(false);
  const [authed, setAuthed] = useState(!!token.get());
  const [showSettings, setShowSettings] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const [s, e, p] = await Promise.all([api('/sessions'), api('/environments'), api('/presets')]);
      setSessions(s.sessions); setEnvs(e.environments); setPresets(p.presets); setNeedToken(false);
    } catch (err) { if (err.status === 401) setNeedToken(true); }
  }, []);

  useEffect(() => { if (authed) { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); } }, [authed, refresh]);

  // Tick once a second ONLY while a session is actively running, so the live
  // "working Ns" counters advance smoothly without re-rendering when idle.
  useEffect(() => {
    if (!sessions.some((s) => s.status === 'running')) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [sessions]);

  if (needToken || !authed) return html`<${TokenGate} onSave=${() => { setAuthed(true); setNeedToken(false); refresh(); }} />`;

  const selected = sessions.find((s) => s.id === selectedId);
  const logEnv = envs.find((e) => e.id === logEnvId);

  const createSession = async (envId, prompt, agent, model) => {
    const s = await api(`/environments/${envId}/sessions`, { method: 'POST', body: JSON.stringify({ prompt, agent, model }) });
    setNewSession(null); await refresh(); setSelectedId(s.id);
  };
  const renameEnvironment = async (env, displayName) => {
    try {
      await api(`/environments/${env.id}`, { method: 'PATCH', body: JSON.stringify({ displayName }) });
      setRenameEnv(null); await refresh();
    } catch (e) { alert(`Rename failed: ${e.message}`); }
  };
  const createEnv = async (name, provision, prompt, presetIds, agent, model) => {
    await api('/environments', { method: 'POST', body: JSON.stringify({ name, provision, prompt, presetIds, agent, model }) });
    setShowNewEnv(false); refresh();
  };
  const savePreset = async (preset) => {
    const p = await api('/presets', { method: 'POST', body: JSON.stringify(preset) });
    await refresh();
    return p;
  };
  const updatePreset = async (id, preset) => {
    const p = await api(`/presets/${id}`, { method: 'PUT', body: JSON.stringify(preset) });
    await refresh();
    return p;
  };
  const deletePreset = async (id) => {
    await api(`/presets/${id}`, { method: 'DELETE' });
    await refresh();
  };
  const deleteSession = async (s) => {
    if (!confirm(`Delete session "${s.title || s.id}"? This removes its transcript.`)) return;
    try {
      await api(`/sessions/${s.id}`, { method: 'DELETE' });
      if (selectedId === s.id) setSelectedId(null);
      await refresh();
    } catch (e) { alert(`Delete failed: ${e.message}`); }
  };
  // Archive/restore are reversible — no confirm. Archiving interrupts any live
  // turn server-side; the transcript and resume id are kept either way.
  const archiveSession = async (s) => {
    try { await api(`/sessions/${s.id}/archive`, { method: 'POST' }); await refresh(); }
    catch (e) { alert(`Archive failed: ${e.message}`); }
  };
  const restoreSession = async (s) => {
    try { await api(`/sessions/${s.id}/restore`, { method: 'POST' }); await refresh(); }
    catch (e) { alert(`Restore failed: ${e.message}`); }
  };
  const envAction = async (action, env) => {
    if (action === 'admin-login') {
      // Open the tab synchronously (in the click gesture) so popup blockers allow
      // it, paint a loading page so it isn't a blank flash, then redirect it to
      // the minted, host-rebased login URL. The API token stays in the POST
      // header — it never appears in any URL.
      const w = window.open('', '_blank');
      if (w) w.document.write(`<!doctype html><meta charset="utf-8"><title>Logging in…</title>`
        + `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;`
        + `background:#0f1115;color:#8b91a3;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">`
        + `Logging into ${env.name} wp-admin…</body>`);
      try {
        const { loginUrl } = await api(`/environments/${env.id}/admin-login`, { method: 'POST' });
        const u = new URL(loginUrl);
        const dest = `${location.protocol}//${location.hostname}:${env.port}/?${u.searchParams.toString()}`;
        if (w) w.location = dest; else window.open(dest, '_blank', 'noopener');
      } catch (e) { if (w) w.close(); alert(`Admin login failed: ${e.message}`); }
      return;
    }
    try {
      if (action === 'logs') return setLogEnvId(env.id);
      if (action === 'rename') return setRenameEnv(env);
      if (action === 'ssh') return setSshEnv(env);
      if (action === 'session') return setNewSession({ preselect: env.id });
      if (action === 'start') await api(`/environments/${env.id}/start`, { method: 'POST' });
      if (action === 'stop') await api(`/environments/${env.id}/stop`, { method: 'POST' });
      if (action === 'delete') {
        if (!confirm(`Destroy environment "${env.displayName || env.name}"? This removes its containers and all its data.`)) return;
        await api(`/environments/${env.id}`, { method: 'DELETE' });
      }
      refresh();
    } catch (e) { alert(`${action} failed: ${e.message}`); }
  };

  return html`
    <div class=${`layout ${selected ? 'has-selection' : ''}`}>
      <${Sidebar} sessions=${sessions} envs=${envs} selectedId=${selectedId} now=${now}
        onSelect=${setSelectedId} onNewEnv=${() => setShowNewEnv(true)}
        onEnvAction=${envAction} onSettings=${() => setShowSettings(true)} onHealth=${() => setShowHealth(true)}
        onDeleteSession=${deleteSession} onArchiveSession=${archiveSession} onRestoreSession=${restoreSession} />
      ${selected
        ? html`<${SessionView} session=${selected} key=${selected.id} now=${now} onChanged=${refresh} onBack=${() => setSelectedId(null)} onDelete=${() => deleteSession(selected)} onArchive=${() => archiveSession(selected)} onRestore=${() => restoreSession(selected)} />`
        : html`<section class="main empty"><div class="muted">
            ${envs.length === 0
              ? html`No environments yet. <button class="btn" onClick=${() => setShowNewEnv(true)}>Create an environment</button> to begin.`
              : html`Select a session, or <button class="btn" onClick=${() => setNewSession({})}>start a new one</button>.`}
          </div></section>`}
      ${newSession && html`<${NewSessionModal} envs=${envs} preselect=${newSession.preselect} onClose=${() => setNewSession(null)} onCreate=${createSession} />`}
      ${showNewEnv && html`<${NewEnvModal} presets=${presets} onClose=${() => setShowNewEnv(false)} onCreate=${createEnv} onSavePreset=${savePreset} onUpdatePreset=${updatePreset} onDeletePreset=${deletePreset} />`}
      ${logEnvId && logEnv && html`<${LogViewer} env=${logEnv} onClose=${() => setLogEnvId(null)} />`}
      ${renameEnv && html`<${RenameEnvModal} env=${renameEnv} onClose=${() => setRenameEnv(null)} onSave=${renameEnvironment} />`}
      ${sshEnv && html`<${SshModal} env=${sshEnv} onClose=${() => setSshEnv(null)} />`}
      ${showSettings && html`<${SettingsModal} onClose=${() => setShowSettings(false)}
        onLogout=${() => { token.set(''); setShowSettings(false); setAuthed(false); setNeedToken(true); }} />`}
      ${showHealth && html`<${HealthModal} onClose=${() => setShowHealth(false)} />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('root'));
