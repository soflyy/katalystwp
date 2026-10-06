// Devbox Claude-sessions UI — buildless Preact + htm (ES modules from esm.sh).
import { h, render } from 'https://esm.sh/preact@10.24.3';
import { useState, useEffect, useRef, useCallback } from 'https://esm.sh/preact@10.24.3/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { marked } from 'https://esm.sh/marked@18.1.0';
import DOMPurify from 'https://esm.sh/dompurify@3.4.16';
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
// Upload one file into an env's workspace (raw body); resolves to { path, … }.
async function uploadFile(envId, file) {
  const res = await fetch(`/environments/${envId}/uploads?name=${encodeURIComponent(file.name || 'pasted.png')}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.get()}`, 'content-type': file.type || 'application/octet-stream' },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}
const streamUrl = (id) => {
  const t = token.get();
  return `/sessions/${id}/stream${t ? `?access_token=${encodeURIComponent(t)}` : ''}`;
};
// Links to an env's site (WP + app ports): hostname rebased on how THIS
// browser reached the UI (works from a phone/laptop even when the server's
// configured host differs), scheme taken from the env's own wpUrl — per env,
// because envs from before an https switch stay plain http until migrated
// (TLS phase 2, issue #73). location.protocol would mint dead links for them.
const envSiteUrl = (env, port, query = '') => {
  const scheme = String(env.wpUrl || '').startsWith('https:') ? 'https' : 'http';
  return `${scheme}://${location.hostname}:${port}/${query}`;
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
      push({ kind: 'user', text: evt.text, files: evt.files || [] });
      break;
    case 'user': {
      const content = (evt.message && evt.message.content) || [];
      for (const b of content) {
        if (b.type === 'tool_result') push({ kind: 'tool_result', content: b.content, isError: !!b.is_error });
      }
      break;
    }
    case 'result':
      // The turn is over: whatever the live line held is now an assistant bubble.
      partialRef.text = '';
      push({ kind: 'result', result: evt.result, cost: evt.total_cost_usd, ms: evt.duration_ms, isError: evt.is_error });
      break;
    case 'stderr':
      if (String(evt.text || '').trim()) push({ kind: 'stderr', text: evt.text });
      break;
    case 'control':
      if (evt.subtype === 'turn-start') push({ kind: 'control', text: 'Turn' });
      if (evt.subtype === 'turn-end') partialRef.text = '';
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

// Inline line icons (Lucide, ISC license), so every glyph renders the same on
// every OS instead of mixing color emoji with font symbols.
const ICONS = {
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  menu: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  trash: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  terminal: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  paperclip: '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"/>',
  file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
  output: '<path d="m15 10 5 5-5 5"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
};
function Icon({ name, size = 14 }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ICONS[name] || '' }}></svg>`;
}

// Small dropdown for a row's secondary actions. Closes on outside click / Escape.
function ActionMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return html`
    <div class="menu-wrap" ref=${ref}>
      <button class="btn icon ghost" title="More actions" aria-haspopup="menu" aria-expanded=${open} onClick=${(e) => { e.stopPropagation(); setOpen(!open); }}><${Icon} name="more" /></button>
      ${open && html`
        <div class="menu" role="menu">
          ${items.filter(Boolean).map((it) => html`
            <button role="menuitem" class=${`menu-item ${it.danger ? 'danger' : ''}`} key=${it.label} title=${it.title || ''}
              onClick=${(e) => { e.stopPropagation(); setOpen(false); it.onClick(); }}>${it.label}</button>`)}
        </div>`}
    </div>`;
}

const TRANSIENT_ENV = ['scaffolding', 'setting-up', 'configuring', 'destroying', 'duplicating'];

function EnvRow({ env, onAction, onTag }) {
  const building = TRANSIENT_ENV.includes(env.status);
  const up = env.status === 'running' || env.status === 'degraded';
  // Link to the WP site on the SAME host the UI was loaded from (not the
  // server's localhost wpUrl) — so it works from a phone/laptop hitting the
  // server's IP, and still works from inside the devbox via localhost.
  const wpUrl = envSiteUrl(env, env.port);
  const warnings = env.setupWarnings || [];
  const act = (a) => () => onAction(a, env);
  return html`
    <div class="env">
      <div class="env-top">
        <${StatusDot} status=${env.status} /> <span class="env-name" title=${env.displayName ? `${env.displayName} · ${env.name}` : env.name}>${env.displayName || env.name}</span>
        <a class="env-port" href=${wpUrl} target="_blank" rel="noreferrer" title="Open the site front end" onClick=${(e) => e.stopPropagation()}>:${env.port}</a>
        ${(env.appPorts || []).map((p) => html`<a class="env-port" href=${envSiteUrl(env, p.host)} target="_blank" rel="noreferrer" title=${`App port → container :${p.container}`} onClick=${(e) => e.stopPropagation()}>:${p.host}</a>`)}
        ${up && html`<button class="env-admin" title="One-click passwordless wp-admin login" onClick=${(e) => { e.stopPropagation(); onAction('admin-login', env); }}>Admin <${Icon} name="external" size=${12} /></button>`}
      </div>
      <div class="env-meta">
        ${env.preset && html`<span class="badge" title="provisioned from preset">${env.preset}</span>`}
        ${warnings.length > 0 && html`<button class="badge warn" title=${`Setup finished, but these presets' scripts failed: ${warnings.join(', ')}. Open the logs.`} onClick=${act('logs')}><${Icon} name="alert" size=${11} /> ${warnings.length} preset${warnings.length > 1 ? 's' : ''} failed</button>`}
        ${(env.tags || []).map((t) => html`<button class="tag-chip" key=${t} title=${`Filter by tag "${t}"`} onClick=${(e) => { e.stopPropagation(); onTag && onTag(t); }}>#${t}</button>`)}
        <span class="env-actions">
          ${building
            ? html`<span class="muted small">${env.status}…</span>
              <button class="lnk" onClick=${act('logs')}>Logs</button>`
            : html`
              ${up && html`<button class="lnk" onClick=${act('session')}><${Icon} name="plus" size=${12} /> Session</button>`}
              ${env.status === 'stopped' && html`<button class="lnk" onClick=${act('start')}>Start</button>`}
              ${env.status === 'failed' && html`<button class="lnk" title=${env.initialPrompt && !env.initialPromptFiredAt ? 'Start the containers and fire the saved first prompt' : 'Start the containers again'} onClick=${act('start')}>Retry</button>`}
              <${ActionMenu} items=${[
                up && { label: 'Stop', onClick: act('stop') },
                up && { label: 'Update agents', title: 'Update the Claude Code / Codex / OpenCode CLIs inside this env (npm -g @latest). Needed for new models like Opus 5.5.', onClick: act('update-agents') },
                (up || env.status === 'stopped') && { label: 'Duplicate', title: 'Clone this environment (full data copy on a new port)', onClick: act('duplicate') },
                { label: 'Rename & tag', onClick: act('rename') },
                { label: 'SSH', title: 'Copy a command to open a shell / interactive Claude on the box', onClick: act('ssh') },
                { label: 'Setup logs', onClick: act('logs') },
                { label: 'Delete', danger: true, onClick: act('delete') },
              ]} />`}
        </span>
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
          ? html`<button class="sess-arch lnk" title="Restore session" onClick=${(e) => { e.stopPropagation(); onRestore(s); }}><${Icon} name="restore" size=${13} /></button>`
          : html`<button class="sess-arch lnk" title="Archive session (hide, keep transcript)" onClick=${(e) => { e.stopPropagation(); onArchive(s); }}><${Icon} name="archive" size=${13} /></button>`}
        <button class="sess-del lnk" title="Delete session" onClick=${(e) => { e.stopPropagation(); onDelete(s); }}><${Icon} name="trash" size=${13} /></button>
      </div>
      <div class="sess-sub muted"><span class="agent-tag">${agentLabel(s.agent)}</span> · started ${fmtAgo(s.createdAt, true)} · ${s.turnCount} turn${s.turnCount === 1 ? '' : 's'} · $${(s.costUsd || 0).toFixed(3)}</div>
    </div>`;
}

// The devbox's name in the sidebar header; click to rename (saved in settings).
function BoxName({ name, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelled = useRef(false);
  // Enter and Escape both end the edit by blurring, so it saves (or not) once.
  const finish = () => {
    const t = draft.replace(/\s+/g, ' ').trim();
    setEditing(false);
    if (!cancelled.current && t && t !== name) onRename(t);
    cancelled.current = false;
  };
  return editing
    ? html`<input class="rename box-name-input" value=${draft} maxLength="40"
        ref=${(el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
        onInput=${(e) => setDraft(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') { cancelled.current = true; e.target.blur(); } }}
        onBlur=${finish} />`
    : html`<button class="box-name" title="Rename" onClick=${() => { setDraft(name); setEditing(true); }}>${name}</button>`;
}

function Sidebar({ name, onRename, sessions, envs, selectedId, now, onSelect, onNewEnv, onEnvAction, onSettings, onHealth, onCloseDrawer, onDeleteSession, onArchiveSession, onRestoreSession }) {
  const [expanded, setExpanded] = useState(() => new Set());
  // Which envs currently have their "Archived (N)" reveal expanded.
  const [archOpen, setArchOpen] = useState(() => new Set());
  // Declutter long lists: stopped envs (data intact, just parked) are hidden by
  // default. "Active" = anything not stopped (running/degraded/building/failed).
  const [filter, setFilter] = useState('active');
  // Free-text filter across name/displayName/preset/tags, and a grouping mode
  // (persisted — it's a lasting preference, unlike the transient search).
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState(() => { try { return localStorage.getItem('devbox_env_groupby') || 'none'; } catch { return 'none'; } });
  const pickGroupBy = (g) => { setGroupBy(g); try { localStorage.setItem('devbox_env_groupby', g); } catch { /* private mode */ } };
  const [collapsed, setCollapsed] = useState(() => new Set()); // collapsed group keys
  const toggleGroup = (k) => setCollapsed((prev) => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  const activeCount = envs.filter((e) => e.status !== 'stopped').length;
  const stoppedCount = envs.length - activeCount;
  const q = query.trim().toLowerCase().replace(/^#/, ''); // "#demo" ≡ "demo"
  const matchesQuery = (e) => !q
    || e.name.toLowerCase().includes(q)
    || (e.displayName || '').toLowerCase().includes(q)
    || (e.preset || '').toLowerCase().includes(q)
    || (e.tags || []).some((t) => t.includes(q));
  // Most-recently-used first: an env's recency is its newest session activity
  // (fall back to createdAt) — so "the one I touched last week" floats up
  // through a wall of stopped envs.
  const lastTouched = {};
  for (const s of sessions) {
    const t = String(s.lastActivityAt || '');
    if (t > (lastTouched[s.envId] || '')) lastTouched[s.envId] = t;
  }
  const recency = (e) => lastTouched[e.id] || String(e.createdAt || '');
  const shown = envs
    .filter((e) => (filter === 'all' ? true : filter === 'stopped' ? e.status === 'stopped' : e.status !== 'stopped'))
    .filter(matchesQuery)
    .sort((a, b) => recency(b).localeCompare(recency(a)));
  // Grouping: 'preset' buckets by preset; 'tag' lists an env under EACH of its
  // tags (untagged last). [key, envs] pairs; key null = flat list, no headers.
  const groups = (() => {
    if (groupBy === 'preset') {
      const m = new Map();
      for (const e of shown) {
        const k = e.preset || 'no preset';
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(e);
      }
      return [...m.entries()].sort(([a], [b]) => (a === 'no preset') - (b === 'no preset') || a.localeCompare(b));
    }
    if (groupBy === 'tag') {
      const m = new Map();
      for (const e of shown) {
        const keys = (e.tags && e.tags.length) ? e.tags : ['untagged'];
        for (const k of keys) {
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(e);
        }
      }
      return [...m.entries()].sort(([a], [b]) => (a === 'untagged') - (b === 'untagged') || a.localeCompare(b));
    }
    return [[null, shown]];
  })();
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
        <${BoxName} name=${name} onRename=${onRename} />
        <div class="side-head-btns">
          <button class="btn icon ghost" onClick=${onHealth} title="System health"><${Icon} name="activity" /></button>
          <button class="btn icon ghost" onClick=${onSettings} title="Settings"><${Icon} name="settings" /></button>
          <button class="mobile-only btn icon ghost" onClick=${onCloseDrawer} title="Close"><${Icon} name="x" /></button>
        </div>
      </div>
      <div class="side-section grow">
        <div class="section-head"><span>Environments</span><button class="btn small" onClick=${onNewEnv}><${Icon} name="plus" size=${13} /> Env</button></div>
        <div class="env-filter">
          <button class=${`seg ${filter === 'active' ? 'on' : ''}`} onClick=${() => setFilter('active')}>Active ${activeCount}</button>
          <button class=${`seg ${filter === 'stopped' ? 'on' : ''}`} onClick=${() => setFilter('stopped')}>Stopped ${stoppedCount}</button>
          <button class=${`seg ${filter === 'all' ? 'on' : ''}`} onClick=${() => setFilter('all')}>All ${envs.length}</button>
        </div>
        <div class="env-tools">
          <input class="env-search" type="search" placeholder="Search name, preset, #tag…" value=${query} onInput=${(e) => setQuery(e.target.value)} />
          <select class="env-groupby" value=${groupBy} onChange=${(e) => pickGroupBy(e.target.value)} title="Group environments">
            <option value="none">flat</option>
            <option value="preset">by preset</option>
            <option value="tag">by tag</option>
          </select>
        </div>
        <div class="side-list">
          ${envs.length === 0 && html`<div class="muted pad small">No environments — create one.</div>`}
          ${envs.length > 0 && shown.length === 0 && html`<div class="muted pad small">${q ? `No matches for “${query.trim()}”.` : `No ${filter} environments.`}</div>`}
          ${groups.map(([groupKey, groupEnvs]) => html`
            ${groupKey !== null && html`
              <button class="group-head" key=${`h:${groupKey}`} onClick=${() => toggleGroup(groupKey)}>
                <span class="chev"><${Icon} name=${collapsed.has(groupKey) ? 'right' : 'down'} size=${12} /></span>
                ${groupBy === 'tag' && groupKey !== 'untagged' ? `#${groupKey}` : groupKey}
                <span class="muted small">${groupEnvs.length}</span>
              </button>`}
            ${(groupKey === null || !collapsed.has(groupKey)) && groupEnvs.map((e) => {
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
                <div class="env-group" key=${groupKey === null ? e.id : `${groupKey}:${e.id}`}>
                  <${EnvRow} env=${e} onAction=${onEnvAction} onTag=${setQuery} />
                  <button class="sess-toggle" onClick=${() => toggle(e.id)}>
                    <span class="chev"><${Icon} name=${open ? 'down' : 'right'} size=${12} /></span>
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
                          <span class="chev"><${Icon} name=${showArch ? 'down' : 'right'} size=${12} /></span>
                          Archived (${archived.length})
                        </button>`}
                      ${showArch && archived.map((s) => html`<${SessionItem} ...${itemProps} s=${s} key=${s.id} />`)}
                    </div>`}
                </div>`;
            })}`)}
        </div>
      </div>
    </aside>`;
}

// A single runaway blob (base64 screenshot, whole-file tool payload) can be
// 1MB+ — clip what lands in the DOM so the transcript stays scrollable. The
// history fetch is clipped server-side too; this also covers live SSE events.
function clipText(t, max = 20000) {
  const s = typeof t === 'string' ? t : String(t ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…[+${(s.length - max).toLocaleString()} chars clipped]` : s;
}

// One-line preview of a tool call / result for its collapsed row.
const oneLine = (t, max = 110) => {
  const line = String(t ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};
// Tool results are a string or a list of content blocks; show the blocks' text.
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content.map((b) => {
    if (b && b.type === 'text') return b.text;
    if (b && b.type === 'image') return '[image]';
    if (b && b.type === 'tool_reference') return b.tool_name;
    return JSON.stringify(b, null, 2);
  }).join('\n');
}
// Result preview: the first line that isn't a markdown heading or code fence,
// minus list markers.
function resultPreview(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !l.startsWith('#') && !l.startsWith('```')) || lines[0] || '';
  return oneLine(line.replace(/^[-*]\s+/, ''));
}
function toolPreview(input) {
  if (!input || typeof input !== 'object') return oneLine(input);
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'filename', 'description', 'prompt']) {
    if (typeof input[k] === 'string' && input[k].trim()) return oneLine(input[k]);
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return oneLine(first || (Object.keys(input).length ? JSON.stringify(input) : ''));
}

// Agent replies are markdown: parse, sanitize, and open links in a new tab.
// Finished messages are cached by text, since the transcript re-renders on
// every streamed event.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noreferrer noopener'); }
});
// Markdown images become links, so a relative path doesn't load as a broken <img>.
marked.use({ renderer: { image({ href, text }) { return `<a href="${String(href).replace(/"/g, '&quot;')}">${text || href}</a>`; } } });
const toHtml = (text) => withFileActions(DOMPurify.sanitize(marked.parse(clipText(text), { gfm: true })));
const mdCache = new Map();
function markdown(text) {
  let out = mdCache.get(text);
  if (out === undefined) {
    if (mdCache.size > 500) mdCache.clear();
    out = toHtml(text);
    mdCache.set(text, out);
  }
  return out;
}

// Workspace file paths (absolute under /home/node, or relative to it with a
// directory part) get preview and download buttons, served by
// /environments/:id/files.
const FILE_PATH_SRC = String.raw`(?:\/home\/node\/|\.{1,2}\/|\.?[\w@-][\w@.-]*\/)[\w@./-]*[\w@-]\.[A-Za-z0-9]{1,8}`;
const FILE_PATH = new RegExp(String.raw`(?<![\w@:/.-])${FILE_PATH_SRC}(?![\w@/-]|\.[A-Za-z0-9])`, 'g');
const FILE_PATH_ONLY = new RegExp(`^${FILE_PATH_SRC}$`);
const isFilePath = (s) => FILE_PATH_ONLY.test(String(s || '').trim());
const isImagePath = (s) => /\.(png|jpe?g|gif|webp)$/i.test(String(s || ''));
const fileUrl = (envId, path, extra = '') => `/environments/${envId}/files?path=${encodeURIComponent(path)}${extra}`;
// Uploads carry an id prefix (files.js); drop it for display.
const fileName = (path) => {
  const name = path.split('/').pop();
  return path.startsWith('/home/node/uploads/') ? name.replace(/^[a-z0-9]+-/, '') : name;
};

// Fetch with the token in a header (not the URL) and save the file.
async function downloadFile(envId, path) {
  const res = await fetch(fileUrl(envId, path, '&download=1'), { headers: { authorization: `Bearer ${token.get()}` } });
  if (!res.ok) { const body = await res.json().catch(() => ({})); alert(`Download failed: ${body.error || res.status}`); return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = fileName(path);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The buttons as markup, for injecting into rendered markdown (clicks are
// delegated via data-act / data-file).
const iconSvg = (name, size) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const fileActionsHtml = (path) => `<span class="file-acts">`
  + `<button class="file-act" data-act="preview" data-file="${escAttr(path)}" title="Preview">${iconSvg('eye', 12)}</button>`
  + `<button class="file-act" data-act="download" data-file="${escAttr(path)}" title="Download">${iconSvg('download', 12)}</button></span>`;
// After sanitizing: inline code and links that name a workspace file get the
// buttons; such links lose their href (it would point at the UI server).
function withFileActions(safeHtml) {
  const t = document.createElement('template');
  t.innerHTML = safeHtml;
  for (const el of t.content.querySelectorAll('code, a')) {
    if (el.tagName === 'CODE' && el.closest('pre')) continue;
    const ref = el.tagName === 'CODE' ? el.textContent.trim() : el.getAttribute('href');
    if (!isFilePath(ref)) continue;
    if (el.tagName === 'A') el.removeAttribute('href');
    el.insertAdjacentHTML('afterend', fileActionsHtml(ref));
  }
  return t.innerHTML;
}
const onFileActionClick = (acts) => (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !acts) return;
  e.preventDefault();
  acts[btn.dataset.act](btn.dataset.file);
};

function FileActions({ path, acts }) {
  const run = (fn) => (e) => { e.preventDefault(); e.stopPropagation(); fn(path); };
  return html`<span class="file-acts">
    <button class="file-act" title="Preview" onClick=${run(acts.preview)}><${Icon} name="eye" size=${12} /></button>
    <button class="file-act" title="Download" onClick=${run(acts.download)}><${Icon} name="download" size=${12} /></button>
  </span>`;
}

// Plain text with preview / download buttons after each workspace file path.
function FileRefs({ text, acts }) {
  const str = String(text ?? '');
  if (!acts) return str;
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(FILE_PATH)) {
    let end = m.index + m[0].length;
    end += (str.slice(end).match(/^:\d+(?::\d+)?/) || [''])[0].length; // keep a path:line suffix together
    parts.push(str.slice(last, end), html`<${FileActions} path=${m[0]} acts=${acts} />`);
    last = end;
  }
  if (!parts.length) return str;
  parts.push(str.slice(last));
  return html`${parts}`;
}

// Text previews of markdown render and of code highlight, with a toggle back to
// the raw text. highlight.js loads on the first code preview.
const CODE_LANGS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  json: 'json', php: 'php', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', sql: 'sql', ini: 'ini', toml: 'ini', diff: 'diff', patch: 'diff',
};
const extOf = (path) => (path.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
const isMarkdownPath = (path) => ['md', 'markdown', 'mdx'].includes(extOf(path));
let hljsLoad = null;
const loadHljs = () => (hljsLoad ||= import('https://esm.sh/@highlightjs/cdn-assets@11.12.0/es/highlight.min.js').then((m) => m.default));

// Preview a workspace file: images as images, text as text.
function FileModal({ envId, path, onClose }) {
  const [view, setView] = useState({ loading: true });
  const [raw, setRaw] = useState(false);
  const [highlighted, setHighlighted] = useState(null);
  const text = view.text != null ? clipText(view.text, 200000) : null;
  const lang = CODE_LANGS[extOf(path)];
  const isMd = isMarkdownPath(path);
  useEffect(() => {
    if (text == null || !lang) return;
    let live = true;
    loadHljs().then((hljs) => { if (live) setHighlighted(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value); }).catch(() => {});
    return () => { live = false; };
  }, [text, lang]);
  const pretty = isMd && text ? DOMPurify.sanitize(marked.parse(text, { gfm: true })) : highlighted;
  useEffect(() => {
    let live = true;
    let objectUrl = null;
    (async () => {
      try {
        const res = await fetch(fileUrl(envId, path), { headers: { authorization: `Bearer ${token.get()}` } });
        if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `${res.status} ${res.statusText}`); }
        if ((res.headers.get('content-type') || '').startsWith('image/')) {
          objectUrl = URL.createObjectURL(await res.blob());
          if (live) setView({ image: objectUrl });
        } else {
          const text = await res.text();
          if (live) setView({ text });
        }
      } catch (e) { if (live) setView({ error: e.message }); }
    })();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); document.removeEventListener('keydown', onKey); };
  }, [envId, path]);
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <figure class="file-modal" onClick=${(e) => e.stopPropagation()}>
        ${view.loading && html`<div class="muted pad">Loading…</div>`}
        ${view.error && html`<div class="err-msg">${view.error}</div>`}
        ${view.image && html`<img src=${view.image} alt=${path} />`}
        ${text != null && (!pretty || raw
          ? html`<pre class="file-text">${text}</pre>`
          : isMd
            ? html`<div class="file-text md" dangerouslySetInnerHTML=${{ __html: pretty }} />`
            : html`<pre class="file-text"><code dangerouslySetInnerHTML=${{ __html: pretty }} /></pre>`)}
        <figcaption>
          <span class="file-modal-path">${path}</span>
          <span class="file-modal-acts">
            ${pretty && html`<span class="view-toggle">
              <button class=${`seg ${raw ? '' : 'on'}`} onClick=${() => setRaw(false)}>${isMd ? 'Rendered' : 'Highlighted'}</button>
              <button class=${`seg ${raw ? 'on' : ''}`} onClick=${() => setRaw(true)}>Raw</button>
            </span>`}
            <button class="btn icon ghost" title="Download" onClick=${() => downloadFile(envId, path)}><${Icon} name="download" /></button>
            <button class="btn icon ghost" title="Close" onClick=${onClose}><${Icon} name="x" /></button>
          </span>
        </figcaption>
      </figure>
    </div>`;
}

function SentFiles({ paths, envId, acts }) {
  const thumb = (f) => fileUrl(envId, f, `&access_token=${encodeURIComponent(token.get())}`);
  return html`<div class="sent-files">${paths.map((f) => html`
    <span class="file-chip" key=${f} title=${f}>
      ${isImagePath(f) ? html`<img src=${thumb(f)} alt="" />` : html`<${Icon} name="file" size=${12} />`}
      <span class="file-chip-name">${fileName(f)}</span>
      <${FileActions} path=${f} acts=${acts} />
    </span>`)}</div>`;
}

function Bubble({ it, envId, acts }) {
  if (it.kind === 'user') {
    return html`<div class="bubble user"><pre>${clipText(it.text)}</pre>
      ${it.files && it.files.length > 0 && html`<${SentFiles} paths=${it.files} envId=${envId} acts=${acts} />`}</div>`;
  }
  if (it.kind === 'assistant')
    return html`<div class="bubble assistant md" onClick=${onFileActionClick(acts)} dangerouslySetInnerHTML=${{ __html: markdown(it.text) }}></div>`;
  if (it.kind === 'system') return html`<div class="chip">${it.text}</div>`;
  if (it.kind === 'control') return html`<div class="divider">${it.text}</div>`;
  if (it.kind === 'tool_use')
    return html`<details class="tool"><summary><${Icon} name="terminal" size=${13} /><span class="tool-name">${it.name}</span><span class="tool-prev"><${FileRefs} text=${toolPreview(it.input)} acts=${acts} /></span></summary><pre>${clipText(JSON.stringify(it.input, null, 2))}</pre></details>`;
  if (it.kind === 'tool_result') {
    const text = resultText(it.content);
    return html`<details class=${`tool result ${it.isError ? 'err' : ''}`}><summary><${Icon} name="output" size=${13} /><span class="tool-prev"><${FileRefs} text=${resultPreview(text) || '(no output)'} acts=${acts} /></span></summary><pre><${FileRefs} text=${clipText(text)} acts=${acts} /></pre></details>`;
  }
  if (it.kind === 'result')
    return html`<div class="result-foot ${it.isError ? 'err' : ''}">${it.isError ? 'Failed' : 'Done'} · ${fmtDur(it.ms)} · $${(it.cost || 0).toFixed(2)}</div>`;
  if (it.kind === 'stderr') return html`<div class="stderr"><pre>${clipText(it.text)}</pre></div>`;
  return html`<div class="raw"><pre>${clipText(it.text)}</pre></div>`;
}

function SessionView({ session, now, onChanged, onMenu, onDelete, onArchive, onRestore }) {
  const [items, setItems] = useState([]);
  const [partial, setPartial] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [effort, setEffort] = useState(''); // per-message effort; '' = the session's own
  const [copied, setCopied] = useState(false);
  const [previewPath, setPreviewPath] = useState(null); // workspace file shown in FileModal
  const fileActs = { preview: setPreviewPath, download: (path) => downloadFile(session.envId, path) };
  // Files attached to the next message: uploaded as soon as they're added.
  const [attachments, setAttachments] = useState([]); // { key, name, preview, path, error }
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);
  // One paste from the user's own machine: SSH in and resume this session in interactive Claude.
  const resumeCmd = session.sshResumeHint ? `ssh -t root@${location.hostname} '${session.sshResumeHint}'` : '';
  const copyResume = async () => { if (await copyText(resumeCmd)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } };
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
    setItems([]); setPartial(''); setLoading(true); setLoadErr('');
    partialRef.current = { text: '' }; seen.current = new Set();
    stick.current = true; setHasNew(false);
    let es;
    let cancelled = false;
    (async () => {
      try {
        // partials=live: skip token deltas of completed messages (they're
        // superseded by their assistant events and dominate a long turn's
        // payload) — the server keeps just the tail that rebuilds the
        // in-progress line. A missing log is a 200 with events:[] — a catch
        // here is a real failure, so show it instead of a blank transcript.
        const { events } = await api(`/sessions/${id}/transcript?tail=5000&partials=live&clip=16384`);
        const arr = [];
        for (const e of events) { if (e.uuid) seen.current.add(e.uuid); reduce(arr, partialRef.current, e); }
        if (!cancelled) { setItems(arr.slice()); setPartial(partialRef.current.text); }
      } catch (e) { if (!cancelled) setLoadErr(e.message || 'failed to load history'); }
      if (cancelled) return;
      setLoading(false);
      es = new EventSource(streamUrl(id));
      // The server replays its ring buffer (backlog) on every connect, then
      // sends a `snapshot` control event before going live. Backlog token
      // deltas must NOT feed the live line: the history load above already
      // rebuilt it, and deltas of completed messages were filtered out of
      // that response (partials=live) — so their uuids aren't in `seen`, while
      // the assistant events that would reset the line ARE. Replaying them
      // used to concatenate every message of the turn into a phantom bubble
      // that outlived the "done" footer. Re-armed on each auto-reconnect.
      let replaying = true;
      es.onopen = () => { replaying = true; };
      es.onmessage = (m) => {
        let evt; try { evt = JSON.parse(m.data); } catch { return; }
        if (evt.type === 'control' && evt.subtype === 'snapshot') { replaying = false; return; }
        if (evt.uuid && seen.current.has(evt.uuid)) return;
        if (evt.uuid) seen.current.add(evt.uuid);
        if (evt.type === 'control' && evt.subtype === 'turn-end') { setBusy(false); onChanged && onChanged(); }
        // Control events carry no uuid, so a replayed turn-start would also
        // duplicate the "— turn —" divider history already drew; the turn-end
        // side effect above still runs so a reconnect mid-turn can't leave the
        // composer stuck disabled.
        if (replaying && (evt.type === 'stream_event' || evt.type === 'control')) return;
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

  const addFiles = (files) => {
    for (const file of files) {
      const key = `${Date.now()}-${Math.random()}`;
      const preview = /^image\/(png|jpe?g|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [...prev, { key, name: file.name || 'pasted.png', preview, path: null, error: '' }]);
      uploadFile(session.envId, file).then(
        (r) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, path: r.path } : a))),
        (e) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, error: e.message } : a))),
      );
    }
  };
  const removeAttachment = (key) => setAttachments((prev) => {
    const gone = prev.find((a) => a.key === key);
    if (gone && gone.preview) URL.revokeObjectURL(gone.preview);
    return prev.filter((a) => a.key !== key);
  });
  const uploading = attachments.some((a) => !a.path && !a.error);

  const running = busy || session.status === 'running';
  const send = useCallback(async () => {
    const prompt = input.trim();
    if (!prompt || running || uploading) return;
    const files = attachments.filter((a) => a.path).map((a) => a.path);
    setInput(''); setBusy(true);
    try {
      await api(`/sessions/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt, ...(effort ? { effort } : {}), ...(files.length ? { files } : {}) }) });
      attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      setAttachments([]);
      onChanged && onChanged();
    } catch (e) { setBusy(false); setInput(prompt); alert(`Send failed: ${e.message}`); }
  }, [input, effort, running, uploading, attachments, id]);
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
          <button class="mobile-only btn icon ghost" onClick=${onMenu} title="Environments & sessions"><${Icon} name="menu" /></button>
          <${StatusDot} status=${session.status} />
          ${editing
            ? html`<input class="rename" value=${draft}
                ref=${(el) => { if (el && document.activeElement !== el) { el.focus(); el.select(); } }}
                onInput=${(e) => setDraft(e.target.value)}
                onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); saveTitle(); } else if (e.key === 'Escape') setEditing(false); }}
                onBlur=${saveTitle} />`
            : html`<strong title="Double-click to rename" onDblClick=${startEdit}>${session.title || id}</strong>
                <button class="lnk icon-lnk" onClick=${startEdit} title="Rename"><${Icon} name="pencil" size=${13} /></button>
                ${session.archived
                  ? html`<button class="lnk icon-lnk" onClick=${onRestore} title="Restore session"><${Icon} name="restore" size=${13} /></button>`
                  : html`<button class="lnk icon-lnk" onClick=${onArchive} title="Archive session (hide, keep transcript)"><${Icon} name="archive" size=${13} /></button>`}
                <button class="lnk icon-lnk danger" onClick=${onDelete} title="Delete session"><${Icon} name="trash" size=${13} /></button>`}
          ${resumeCmd && html`<button class="lnk" onClick=${copyResume} title="Copy a command to continue this session in Claude in your own terminal"><${Icon} name="terminal" size=${13} /> ${copied ? 'Copied' : 'Resume'}</button>`}
        </div>
        <div class="bar-meta muted">
          ${session.envName} · <span class="agent-tag">${agentLabel(session.agent)}</span> · ${session.model || 'default model'} · $${(session.costUsd || 0).toFixed(4)}
          ${session.claudeSessionId && html` · <code title="agent session id">${session.claudeSessionId.slice(0, 8)}</code>`}
        </div>
        <div class="bar-meta muted" title=${`started ${fullTime(session.createdAt)}\nlast active ${fullTime(session.lastActivityAt)}`}>
          started ${fmtAgo(session.createdAt, true)} ·${' '}
          ${session.status === 'running'
            ? html`<${WorkingTag} since=${session.lastActivityAt} now=${now} />`
            : html`last active ${fmtAgo(session.lastActivityAt, true)}`}
        </div>
      </header>
      <div class="transcript" ref=${scroller} onScroll=${onTranscriptScroll}>
        ${loading && !loadErr && html`<div class="muted pad">loading history…</div>`}
        ${loadErr && html`<div class="err-msg">could not load history: ${loadErr}</div>`}
        ${items.map((it, i) => html`<${Bubble} it=${it} key=${i} envId=${session.envId} acts=${fileActs} />`)}
        ${running && partial && html`<div class="bubble assistant live" onClick=${onFileActionClick(fileActs)}><div class="md" dangerouslySetInnerHTML=${{ __html: toHtml(partial) }}></div><span class="cursor">▍</span></div>`}
        ${running && !partial && !loading && html`<div class="muted pad">…thinking</div>`}
      </div>
      ${hasNew && html`<button class="new-msgs" onClick=${jumpToBottom}>↓ New messages</button>`}
      <footer class=${`composer ${dragging ? 'dragging' : ''}`}
        onDragOver=${(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop=${(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); }}>
        <div class="composer-main">
          ${attachments.length > 0 && html`<div class="attach-row">${attachments.map((a) => html`
            <span class=${`attach-chip ${a.error ? 'err' : ''}`} key=${a.key} title=${a.error || a.name}>
              ${a.preview ? html`<img src=${a.preview} alt="" />` : html`<${Icon} name="file" size=${13} />`}
              <span class="attach-name">${a.error ? `${a.name}: ${a.error}` : a.name}</span>
              ${!a.path && !a.error && html`<span class="muted small">uploading…</span>`}
              <button class="lnk icon-lnk" title="Remove" onClick=${() => removeAttachment(a.key)}><${Icon} name="x" size=${12} /></button>
            </span>`)}</div>`}
          <textarea
            value=${input}
            placeholder=${running ? 'Turn in progress…' : 'Message Claude (Enter to send, Shift+Enter for newline)'}
            disabled=${running}
            onInput=${(e) => setInput(e.target.value)}
            onPaste=${(e) => { const files = [...((e.clipboardData && e.clipboardData.files) || [])]; if (files.length) { e.preventDefault(); addFiles(files); } }}
            onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          ></textarea>
        </div>
        <div class="composer-side">
          <div class="composer-tools">
            <button class="btn icon ghost" title="Attach files (or drop or paste them)" disabled=${running} onClick=${() => fileInput.current && fileInput.current.click()}><${Icon} name="paperclip" /></button>
            <input type="file" multiple hidden ref=${fileInput} onChange=${(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
            <${EffortSelect} levels=${effortsFor(session.agent, session.model)} value=${effort} onChange=${setEffort} />
          </div>
          ${running
            ? html`<button class="btn ghost" onClick=${interrupt}>Interrupt</button>`
            : html`<button class="btn ghost" onClick=${send} disabled=${!input.trim() || uploading}>${uploading ? 'Uploading…' : 'Send'}</button>`}
        </div>
      </footer>
      ${previewPath && html`<${FileModal} envId=${session.envId} path=${previewPath} onClose=${() => setPreviewPath(null)} />`}
    </section>`;
}

function NewSessionModal({ envs, preselect, onClose, onCreate }) {
  const usable = envs.filter((e) => e.status === 'running' || e.status === 'degraded');
  const [envId, setEnvId] = useState(preselect || (usable[0] && usable[0].id));
  const [agent, setAgent] = useState('claude');
  const [model, setModel] = useState(() => defaultModel('claude'));
  const [effort, setEffort] = useState('');
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState('');
  const create = async () => {
    if (!envId || !prompt.trim()) return;
    try { await onCreate(envId, prompt.trim(), agent, withEffort(model.trim(), effort) || undefined); } catch (e) { setErr(e.message); }
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
        <${AgentPicker} agent=${agent} model=${model} effort=${effort} prompt=${prompt}
          onAgent=${setAgent} onModel=${setModel} onEffort=${setEffort} onPrompt=${setPrompt} onSubmit=${create}
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

// Curated model choices per agent. The first entry is preselected; an id of ''
// means "let the agent / server default decide". A "Custom…" escape hatch lets
// you type any id, except for agents in NO_CUSTOM_MODEL. Set only at session
// start. The OpenCode (Zen) list is the subset verified usable with our Zen key
// (see its comment below).
// Fable is pinned by full id: the `fable` alias flips between 5 and 5.1 by
// Claude Code version (≥ 2.1.257 → 5.1) and by provider, so the alias would
// silently pick a different model in an older workspace. Sonnet/haiku use the
// family alias on purpose — "latest of the family" is what we want there
// (Claude Code 2.1.291 resolves sonnet → Sonnet 5.5).
// `efforts` lists the effort levels a model accepts, as of 2026-10-06. Claude:
// the API's per-model effort support (Haiku 4.5 rejects effort). Codex: the
// supported_reasoning_levels in Codex's model list, or OpenAI's model page for
// models no longer in it; "ultra" and "none" are left out because the server
// only passes low–max. No `efforts` = unknown, so no effort picker.
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS = {
  claude: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', aliases: ['opus'], efforts: ALL_EFFORTS }, // `opus` is the server's CLAUDE_DEFAULT_MODEL
    { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: ALL_EFFORTS },
    { id: 'claude-fable-5', label: 'Fable 5', efforts: ALL_EFFORTS },
    { id: 'sonnet', label: 'Sonnet 5.5', efforts: ALL_EFFORTS },
    { id: 'haiku', label: 'Haiku 4.5', efforts: [] },
  ],
  codex: [
    // Codex picks its own default model; low–xhigh is what every model in its list accepts.
    { id: '', label: 'Default', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-6-astra', label: 'gpt-6-astra', efforts: ALL_EFFORTS }, // flagship; needs codex-cli ≥ 0.153 in the workspace
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', efforts: ALL_EFFORTS },
    { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', efforts: ALL_EFFORTS }, // balanced
    { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna', efforts: ALL_EFFORTS }, // fast / cheap
    { id: 'gpt-5.5', label: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.4', label: 'gpt-5.4', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' }, // ChatGPT sign-in only
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
// Reasoning effort is picked per message (EffortSelect) and sent as the model's
// "@effort" suffix, which the server splits into --effort / -c
// model_reasoning_effort= (claude.js). OpenCode passes -m through verbatim.
const NO_EFFORT = new Set(['opencode']);
const defaultModel = (agent) => (MODELS[agent] || MODELS.claude)[0].id;
const stripEffort = (model) => String(model || '').replace(/@(low|medium|high|xhigh|max)$/i, '');
const withEffort = (model, effort) => (effort ? `${stripEffort(model)}@${effort}` : model);
// Effort levels the given agent/model accepts; [] when unknown (custom ids can
// carry their own @effort).
function effortsFor(agent, model) {
  if (NO_EFFORT.has(agent)) return [];
  const id = stripEffort(model);
  const entry = (MODELS[agent] || []).find((m) => m.id === id || (m.aliases || []).includes(id));
  return (entry && entry.efforts) || [];
}

// Effort picker. `stacked` renders it as a form column (dialogs); otherwise it
// sits inline next to the composer's Send button.
function EffortSelect({ levels, value, onChange, stacked = false }) {
  if (!levels.length) return null;
  const select = html`
    <select value=${levels.includes(value) ? value : ''} onChange=${(e) => onChange(e.target.value)}>
      <option value="">Default</option>
      ${levels.map((x) => html`<option value=${x} key=${x}>${x}</option>`)}
    </select>`;
  return stacked
    ? html`<label class="effort-col">Effort ${select}</label>`
    : html`<label class="effort-pick" title="Reasoning effort for this message">Effort ${select}</label>`;
}

// Shared agent + model + first-message chooser, used by both the New Session and
// New Environment dialogs so the choices stay identical. Controlled: the parent
// owns agent/model/prompt state (it submits them). Model is start-only by design —
// there's no editor for it after a session begins.
function AgentPicker({ agent, model, effort, prompt, onAgent, onModel, onEffort, onPrompt, onSubmit, promptLabel = 'First message', promptHint = '', promptRows = 4, promptPlaceholder = 'Describe the task…' }) {
  const [custom, setCustom] = useState(false);
  const list = MODELS[agent] || MODELS.claude;
  const allowCustom = !NO_CUSTOM_MODEL.has(agent);
  const pickAgent = (a) => { onAgent(a); onModel(defaultModel(a)); onEffort(''); setCustom(false); }; // reset model + effort to the agent's default
  const pickModel = (v) => {
    if (v === MODEL_CUSTOM) { setCustom(true); onModel(''); return; }
    setCustom(false); onModel(v);
    if (effort && !effortsFor(agent, v).includes(effort)) onEffort('');
  };
  const levels = effortsFor(agent, model);
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
      <${EffortSelect} stacked levels=${levels} value=${effort} onChange=${onEffort} />
    </div>
    ${custom && html`<label>Custom model id
      <input value=${model} placeholder=${agent === 'opencode' ? 'opencode/provider-model' : 'model id, optionally model@effort'} onInput=${(e) => onModel(e.target.value)} />
    </label>`}
    <label>${promptLabel}${promptHint && html` <span class="hint">${promptHint}</span>`}
      <textarea value=${prompt} rows=${promptRows} placeholder=${promptPlaceholder} onInput=${(e) => onPrompt(e.target.value)}
        onKeyDown=${(e) => { if (onSubmit && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}></textarea>
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
        ${env.initialPrompt?.prompt && html`<details class="tool"><summary>First prompt${env.initialPromptFiredAt ? ' (session started)' : ' (not started yet — fires on retry/start)'}${env.initialPrompt.model ? ` · ${env.initialPrompt.model}` : ''}</summary><pre>${clipText(env.initialPrompt.prompt)}</pre></details>`}
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
  const [model, setModel] = useState(() => defaultModel('claude'));
  const [effort, setEffort] = useState('');
  const [presetIds, setPresetIds] = useState([]); // selected preset ids, in check order
  const [setupScript, setSetupScript] = useState('');
  const [requires, setRequires] = useState([]); // preset ids this preset depends on (editor only)
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

  // Checking a preset also checks what it `requires` (before it) — the server
  // expands dependencies anyway; mirroring it here keeps the list honest.
  const togglePreset = (id) => setPresetIds((prev) => {
    if (prev.includes(id)) return prev.filter((x) => x !== id);
    const next = [...prev];
    const add = (pid, seen = new Set()) => {
      if (next.includes(pid) || seen.has(pid)) return;
      seen.add(pid);
      for (const dep of (presets.find((p) => p.id === pid)?.requires || [])) add(dep, seen);
      if (!next.includes(pid)) next.push(pid);
    };
    add(id);
    return next;
  });
  const presetLabel = (pid) => presets.find((p) => p.id === pid)?.name || pid;

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
    setRequires(p.requires || []);
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
    setSetupScript(''); setDevScript(''); setDefinesText(''); setActivateText(''); setAppPortsText(''); setRequires([]);
  };

  const create = async () => {
    setErr('');
    let provision;
    try { provision = buildCustom(); } catch (e) { setErr(e.message); return; }
    setBusy(true);
    try { await onCreate(name.trim() || undefined, provision || undefined, prompt.trim() || undefined, presetIds, agent, withEffort(model.trim(), effort) || undefined); }
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
    const payload = { name: nm, description: description.trim(), requires, ...custom };
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
        <${AgentPicker} agent=${agent} model=${model} effort=${effort} prompt=${prompt}
          onAgent=${setAgent} onModel=${setModel} onEffort=${setEffort} onPrompt=${setPrompt} onSubmit=${create}
          promptLabel="First prompt" promptRows=${3}
          promptHint="Optional. Once the env is ready, a session with this agent/model starts with this."
          promptPlaceholder="e.g. Add a custom field to the Oxygen builder and verify it renders." />
        <label>Presets <span class="hint">Compose any number; applied in the order you check them</span></label>
        <div class="preset-list">
          ${presets.length === 0 && html`<div class="muted small pad">No saved presets yet.</div>`}
          ${presets.map((p) => html`
            <div class="preset-item" key=${p.id}>
              <label class="preset-check">
                <input type="checkbox" checked=${presetIds.includes(p.id)} onChange=${() => togglePreset(p.id)} />
                <span class="preset-name">${p.name}</span>
                ${(p.requires || []).length > 0 && html`<span class="muted small" title="Auto-included before this preset">requires ${p.requires.map(presetLabel).join(', ')}</span>`}
                ${p.description && html`<span class="muted small">${p.description}</span>`}
              </label>
              <button class="lnk icon-lnk" title="Edit preset" onClick=${() => startEdit(p)}><${Icon} name="pencil" size=${13} /></button>
              <button class="lnk icon-lnk danger" title="Delete preset" onClick=${() => deletePreset(p.id)}><${Icon} name="trash" size=${13} /></button>
            </div>`)}
        </div>
        <details class="custom-prov" open=${showCustom} onToggle=${(e) => setShowCustom(e.target.open)}>
          <summary>${editing ? html`Editing preset — <strong>${presetName || 'untitled'}</strong>` : 'Custom provisioning (optional, applied after presets)'}</summary>
          <label>Setup script <span class="hint">Runs once in the workspace as <code>node</code> (cwd /home/node, WordPress at ./wp)</span>
            <textarea class="mono" rows="5" value=${setupScript} placeholder=${'#!/usr/bin/env bash\nset -euo pipefail\ncd /home/node\ngh repo clone owner/repo\n…'} onInput=${(e) => setSetupScript(e.target.value)}></textarea>
          </label>
          <label>Dev script <span class="hint">Long-running; runs in the <code>dev</code> container for as long as the stack is up</span>
            <textarea class="mono" rows="3" value=${devScript} placeholder=${'#!/usr/bin/env bash\ncd /home/node/breakdance\nnpm run dev:codespace'} onInput=${(e) => setDevScript(e.target.value)}></textarea>
          </label>
          <label>wp-config defines <span class="hint">JSON object; booleans/numbers become raw PHP literals</span>
            <textarea class="mono" rows="3" value=${definesText} placeholder=${'{\n  "WP_DEBUG": true,\n  "WP_MEMORY_LIMIT": "512M"\n}'} onInput=${(e) => setDefinesText(e.target.value)}></textarea>
          </label>
          <label>Activate plugins <span class="hint">Slugs, in order, comma-separated</span>
            <input value=${activateText} placeholder="oxygen-elements, breakdance-elements" onInput=${(e) => setActivateText(e.target.value)} />
          </label>
          <label>App ports <span class="hint">Container ports of dev servers to publish (each env gets a unique host port; shown next to the site link)</span>
            <input value=${appPortsText} placeholder="3000" onInput=${(e) => setAppPortsText(e.target.value)} />
          </label>
          <label>Requires <span class="hint">Presets to provision before this one (auto-included when this preset is picked)</span>
            <div class="preset-list compact">
              ${presets.filter((p) => p.id !== editing).map((p) => html`
                <label class="preset-check" key=${p.id}>
                  <input type="checkbox" checked=${requires.includes(p.id)}
                    onChange=${() => setRequires((prev) => (prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id]))} />
                  <span class="preset-name">${p.name}</span>
                </label>`)}
            </div>
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

  const hint = (f) => (s && s[f] && s[f].set ? `Configured ${s[f].hint} · leave blank to keep` : 'Not set');
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
          <label>GitHub token <span class="hint">${hint('githubToken')}</span>
            <input type="password" value=${ghToken} placeholder="ghp_… / github_pat_…" onInput=${(e) => setGh(e.target.value)} />
          </label>
          <label>Claude token <span class="hint">${hint('claudeToken')}</span>
            <input type="password" value=${clToken} placeholder="sk-ant-oat… (from claude setup-token)" onInput=${(e) => setCl(e.target.value)} />
          </label>
          <label>Codex token <span class="hint">${hint('codexToken')}</span>
            <input type="password" value=${cxToken} placeholder="sk-… (OpenAI API key)" onInput=${(e) => setCx(e.target.value)} />
          </label>
          <label>OpenCode token <span class="hint">${hint('opencodeToken')}</span>
            <input type="password" value=${ocToken} placeholder="OpenCode Zen API key (opencode.ai/auth)" onInput=${(e) => setOc(e.target.value)} />
          </label>
          <label>WordPress admin username
            <input value=${wpUser} onInput=${(e) => setWpUser(e.target.value)} />
          </label>
          <label>WordPress admin password <span class="hint">${hint('wpAdminPassword')}</span>
            <input type="password" value=${wpPass} placeholder="leave blank to keep" onInput=${(e) => setWpPass(e.target.value)} />
          </label>
          <label>WordPress admin email
            <input value=${wpEmail} onInput=${(e) => setWpEmail(e.target.value)} />
          </label>
          <p class="muted small">Token changes apply to newly-created environments and new Claude turns. WP-admin defaults seed new sites.</p>`}
        <${McpConnect} />
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

// Copy-paste command to attach a local MCP client (Claude Code) to this
// server's /mcp endpoint. Assembled entirely client-side: host = the origin
// this page was loaded from, token = the API token this browser is already
// authed with (from localStorage — the server never returns it).
function McpConnect() {
  const t = token.get();
  const cmd = `claude mcp add --transport http katalyst ${location.origin}/mcp`
    + (t ? ` --header "Authorization: Bearer ${t}"` : '');
  return html`
    <div class="mcpconnect">
      <h4>Connect an agent (MCP)</h4>
      <p class="muted small">Run this on your machine to let Claude Code drive this server — create environments,
        run agent sessions, mint admin logins. Any MCP client works (Streamable HTTP endpoint at <code>/mcp</code>).
        The command includes this browser's API token — treat it like a password.</p>
      <${CopyLine} cmd=${cmd} />
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
        ${!h && !err && html`<div class="muted">Loading…</div>`}
        ${h && html`
          <div class="stat-grid">
            <div class="stat">
              <div class="stat-label">Memory</div>
              <div class="stat-value">${gb(m.availableBytes)} <span>free</span></div>
              <${HealthBar} pct=${m.usedPct} tone=${tone(m.usedPct, 75, 90)} />
              <div class="stat-sub">${gb(m.usedBytes)} of ${gb(m.totalBytes)} used</div>
            </div>
            <div class="stat">
              <div class="stat-label">CPU</div>
              <div class="stat-value">${load1.toFixed(2)} <span>load</span></div>
              <${HealthBar} pct=${(load1 / c.cores) * 100} tone=${tone(load1 / c.cores, 0.7, 1)} />
              <div class="stat-sub">${c.cores} cores</div>
            </div>
            ${dsk && html`<div class="stat">
              <div class="stat-label">Disk</div>
              <div class="stat-value">${gb(dsk.availBytes)} <span>free</span></div>
              <${HealthBar} pct=${dsk.usedPct} tone=${tone(dsk.usedPct, 75, 90)} />
              <div class="stat-sub">${gb(dsk.usedBytes)} of ${gb(dsk.totalBytes)} used</div>
            </div>`}
            <div class="stat">
              <div class="stat-label">Environments</div>
              <div class="stat-value">${h.environments.running} <span>running</span></div>
              <div class=${`stat-sub ${est.ramHeadroomEnvs != null && est.ramHeadroomEnvs <= 1 ? 'bad' : ''}`}>${est.ramHeadroomEnvs != null ? `room for ~${est.ramHeadroomEnvs} more` : `${h.environments.count} stored`}</div>
            </div>
          </div>
          ${h.perEnv.length > 0 && html`
            <table class="health-table">
              <tbody>
                ${h.perEnv.map((e) => html`<tr key=${e.name}>
                  <td><${StatusDot} status=${e.status} /> ${e.name}</td>
                  <td class="num">${gb(e.memBytes)}</td>
                </tr>`)}
              </tbody>
            </table>`}
          <div class="health-docker">Docker: ${h.docker.containersRunning} containers${dfRow('Images') ? ` · images ${dfRow('Images').Size}` : ''}${dfRow('Build Cache') ? ` · build cache ${dfRow('Build Cache').Size}` : ''}</div>
        `}
        ${ctrlMsg && html`<div class="muted small ctrl-msg">${ctrlMsg}</div>`}
        <div class="modal-foot">
          <button class="btn small ghost" onClick=${interruptAll}>Interrupt all</button>
          <button class="btn small ghost" onClick=${stopAll}>Stop all</button>
          <button class="btn small ghost danger" onClick=${shutdown}>Shut down</button>
          <span class="spacer"></span>
          <button class="btn ghost" onClick=${onClose}>Close</button>
        </div>
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
  const [tagsText, setTagsText] = useState((env.tags || []).join(', '));
  // Tags are sent as a full-replacement list; the server lowercases + dedupes.
  const save = () => onSave(env, val.trim(), tagsText.split(',').map((t) => t.trim()).filter(Boolean));
  const onKeys = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose(); };
  return html`
    <div class="modal-bg" onClick=${onClose}>
      <div class="modal" onClick=${(e) => e.stopPropagation()}>
        <h3>Rename & tag environment</h3>
        <p class="muted small">List label only. The canonical name <code>${env.name}</code> (its directory and Docker project) is unchanged. Leave blank to reset to it.</p>
        <input autofocus value=${val} placeholder=${env.name}
          onInput=${(e) => setVal(e.target.value)}
          onKeyDown=${onKeys} />
        <label>Tags <span class="hint">Comma-separated; used for search and the "by tag" grouping</span>
          <input value=${tagsText} placeholder="demo, breakdance, client-x"
            onInput=${(e) => setTagsText(e.target.value)}
            onKeyDown=${onKeys} />
        </label>
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
  // On phones the sidebar is an off-canvas drawer (see the mobile media query).
  // It starts open there so first load shows the env/session list, not an
  // empty pane; on desktop the class is inert (sidebar is always visible).
  const [drawerOpen, setDrawerOpen] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [newSession, setNewSession] = useState(null); // null | { preselect? }
  const [showNewEnv, setShowNewEnv] = useState(false);
  const [logEnvId, setLogEnvId] = useState(null);
  const [renameEnv, setRenameEnv] = useState(null);
  const [sshEnv, setSshEnv] = useState(null);
  const [needToken, setNeedToken] = useState(false);
  const [authed, setAuthed] = useState(!!token.get());
  const [showSettings, setShowSettings] = useState(false);
  const [showHealth, setShowHealth] = useState(false);
  const [boxName, setBoxName] = useState('Devbox');
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const [s, e, p] = await Promise.all([api('/sessions'), api('/environments'), api('/presets')]);
      setSessions(s.sessions); setEnvs(e.environments); setPresets(p.presets); setNeedToken(false);
    } catch (err) { if (err.status === 401) setNeedToken(true); }
  }, []);

  useEffect(() => { if (authed) { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); } }, [authed, refresh]);
  useEffect(() => { if (authed) api('/settings').then((d) => d.name && setBoxName(d.name)).catch(() => {}); }, [authed]);
  useEffect(() => { document.title = `${boxName} · Claude sessions`; }, [boxName]);

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
  const renameBox = async (name) => {
    try { const d = await api('/settings', { method: 'PUT', body: JSON.stringify({ name }) }); setBoxName(d.name); }
    catch (e) { alert(`Rename failed: ${e.message}`); }
  };
  const renameEnvironment = async (env, displayName, tags) => {
    try {
      await api(`/environments/${env.id}`, { method: 'PATCH', body: JSON.stringify({ displayName, tags }) });
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
        const dest = envSiteUrl(env, env.port, `?${u.searchParams.toString()}`);
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
      if (action === 'update-agents') {
        if (!confirm(`Update the agent CLIs (Claude Code, Codex, OpenCode) in "${env.displayName || env.name}" to their latest releases?\n\nTakes 1–3 minutes. Survives stop/start; an image rebuild reverts it.`)) return;
        const { before, after } = await api(`/environments/${env.id}/update-agents`, { method: 'POST' });
        alert(['Agents updated:', ...Object.keys(after).map((k) => `  ${k}: ${before[k] || '-'} → ${after[k] || '-'}`)].join('\n'));
      }
      if (action === 'duplicate') {
        // The source stops for a moment while the DB is copied, then restarts.
        const name = prompt(
          `Duplicate "${env.displayName || env.name}"?\n\nFull copy (database, files, plugins) on a new port. `
            + `The source briefly stops during the copy, then restarts.\n\nName for the copy (blank = auto):`, '');
        if (name === null) return;
        const body = name.trim() ? { name: name.trim() } : {};
        await api(`/environments/${env.id}/duplicate`, { method: 'POST', body: JSON.stringify(body) });
      }
      if (action === 'delete') {
        if (!confirm(`Destroy environment "${env.displayName || env.name}"? This removes its containers and all its data.`)) return;
        await api(`/environments/${env.id}`, { method: 'DELETE' });
      }
      refresh();
    } catch (e) { alert(`${action} failed: ${e.message}`); }
  };

  return html`
    <div class=${`layout ${drawerOpen ? 'drawer-open' : ''}`}>
      <${Sidebar} name=${boxName} onRename=${renameBox} sessions=${sessions} envs=${envs} selectedId=${selectedId} now=${now}
        onSelect=${(id) => { setSelectedId(id); setDrawerOpen(false); }} onNewEnv=${() => setShowNewEnv(true)}
        onEnvAction=${envAction} onSettings=${() => setShowSettings(true)} onHealth=${() => setShowHealth(true)}
        onCloseDrawer=${() => setDrawerOpen(false)}
        onDeleteSession=${deleteSession} onArchiveSession=${archiveSession} onRestoreSession=${restoreSession} />
      <div class="scrim" onClick=${() => setDrawerOpen(false)}></div>
      ${selected
        ? html`<${SessionView} session=${selected} key=${selected.id} now=${now} onChanged=${refresh} onMenu=${() => setDrawerOpen(true)} onDelete=${() => deleteSession(selected)} onArchive=${() => archiveSession(selected)} onRestore=${() => restoreSession(selected)} />`
        : html`<section class="main empty">
            <button class="mobile-only menu-btn btn icon ghost" onClick=${() => setDrawerOpen(true)} title="Environments & sessions"><${Icon} name="menu" /></button>
            <div class="muted">
            ${envs.length === 0
              ? html`No environments yet. <button class="btn" onClick=${() => setShowNewEnv(true)}>Create an environment</button> to begin.`
              : html`Select a session, or <button class="btn" onClick=${() => setNewSession({})}>start a new one</button>`}
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
