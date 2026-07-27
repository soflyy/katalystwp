#!/usr/bin/env node
/**
 * The Katalyst menu for THIS site — self-contained, no dependencies, works
 * offline. Run via `npm run katalyst` (or node scripts/katalyst.mjs).
 *
 * Starts the site if it's stopped, shows the summary card, then an arrow-key
 * menu: open wp-admin (one-click login), open the site, launch an installed
 * agent, sandbox shell, exit. Exit STOPS the site (Ctrl+C again while
 * stopping leaves it running), so nothing keeps eating resources by accident.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { emitKeypressEvents } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Substituted at scaffold/update time by create-katalystwp.
const VERSION = '__KATALYST_VERSION__';

// ---- styling (KatalystWP pink #ff2d78; honors NO_COLOR / pipes) ------------
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const PINK = (process.env.COLORTERM || '').includes('truecolor') ? '\u001b[38;2;255;45;120m' : '\u001b[38;5;198m';
const pink = (s) => (COLOR ? `${PINK}${s}\u001b[39m` : s);
const dim = (s) => (COLOR ? `\u001b[2m${s}\u001b[22m` : s);
const link = (url) => (process.stdout.isTTY ? pink(`\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007`) : url);

// ---- this project's config -------------------------------------------------
const env = {};
try {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
} catch {
  console.error('✖ No .env here — run this from your Katalyst site directory.');
  process.exit(1);
}
let cfg = {};
try { cfg = JSON.parse(readFileSync('sandbox.config.json', 'utf8')); } catch { /* optional */ }

const PORT = env.WP_PORT || '8080';
const HOST = env.PUBLIC_HOST || 'localhost';
const SITE = `http://${HOST}:${PORT}`;
const AGENT_LABELS = { claude: 'Claude Code', cursor: 'Cursor CLI', codex: 'Codex CLI', opencode: 'OpenCode' };
const agents = (cfg.agents ?? []).filter((k) => AGENT_LABELS[k]);
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// ---- helpers ---------------------------------------------------------------
const portUp = () => new Promise((res) => {
  const s = connect({ port: parseInt(PORT, 10), host: '127.0.0.1' });
  const done = (v) => { s.destroy(); res(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  s.setTimeout(500, () => done(false));
});

const run = (args, opts = {}) => new Promise((res) => {
  const c = spawn(args[0], args.slice(1), opts);
  let out = '';
  if (c.stdout) c.stdout.on('data', (d) => { out += d; });
  if (c.stderr) c.stderr.on('data', (d) => { out += d; });
  c.on('close', (code) => res({ code, out }));
  c.on('error', (err) => res({ code: 1, out: out + String(err) }));
});

// Logs stay hidden only while everything works — on failure, show them.
const showFailure = (title, out, hint) => {
  console.error(`\n✖ ${title}\n`);
  for (const l of out.trimEnd().split('\n').slice(-25)) console.error(`  ${l}`);
  console.error(`\n  ${hint}\n`);
};

const tick = (msg) => process.stdout.write(`\r\u001b[2K  ${pink('…')} ${dim(msg)}`);
const tickDone = () => process.stdout.write('\r\u001b[2K');

function openBrowser(url) {
  if (process.env.KATALYSTWP_NO_OPEN) { console.log(`  ${dim('Open:')} ${url}`); return; }
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* best effort */ }
}

// One-time passwordless wp-admin login via the Agent Connector ability.
const ADMIN_LOGIN_PHP = `
$admins = get_users(array('role' => 'administrator', 'number' => 1, 'orderby' => 'ID'));
$u = $admins ? $admins[0] : null;
if (!$u) { fwrite(STDERR, 'no administrator user'); exit(1); }
$cls = 'AgentConnectorForWp\\\\DefaultAbilities\\\\Services\\\\AdminLoginLink';
if (!class_exists($cls)) { fwrite(STDERR, 'abilities plugin not active'); exit(1); }
$r = $cls::create($u->ID, 'index.php', 300);
if (is_wp_error($r)) { fwrite(STDERR, $r->get_error_message()); exit(1); }
echo $r['login_url'];
`;
async function adminUrl() {
  const { code, out } = await run(['docker', 'compose', 'exec', '-T', 'workspace', 'wp', 'eval', ADMIN_LOGIN_PHP]);
  if (code === 0 && /acfw_login=/.test(out.trim())) {
    try {
      const u = new URL(out.trim());
      u.hostname = HOST;
      u.port = PORT;
      return u.toString();
    } catch { /* fall through */ }
  }
  return `${SITE}/wp-admin`;
}

// Dependency-free arrow-key select. Returns the value, or null on Ctrl+C/EOF.
function choose(message, options) {
  return new Promise((res) => {
    let cursor = 0;
    let lines = 0;
    const draw = (final = false) => {
      if (lines) process.stdout.write(`\u001b[${lines}A\u001b[J`);
      const rows = final
        ? [`${pink('?')} ${dim(message)}`, `${dim('>')} ${options[cursor].label}`]
        : [
          `${pink('?')} ${message}`,
          '',
          ...options.map((o, i) => (i === cursor
            ? `${pink('>')} ${pink(o.label)}${o.hint ? `  ${dim(o.hint)}` : ''}`
            : `  ${o.label}${o.hint ? `  ${dim(o.hint)}` : ''}`)),
        ];
      process.stdout.write(rows.join('\n') + '\n');
      lines = rows.length;
    };
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (value, final) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      draw(final);
      res(value);
    };
    const onKey = (_, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'left' || (key.shift && key.name === 'tab')) cursor = (cursor + options.length - 1) % options.length;
      else if (key.name === 'down' || key.name === 'right' || key.name === 'tab') cursor = (cursor + 1) % options.length;
      else if (key.name === 'return' || key.name === 'enter') return finish(options[cursor].value, true);
      else if ((key.ctrl && key.name === 'c') || key.name === 'escape' || (key.ctrl && key.name === 'd')) return finish(null, false);
      else if (/^[1-9]$/.test(key.name) && options[+key.name - 1]) { cursor = +key.name - 1; return finish(options[cursor].value, true); }
      draw();
    };
    process.stdin.on('keypress', onKey);
    draw();
  });
}

const runInherit = (script) => new Promise((res) => {
  const c = spawn(NPM, ['run', script], { stdio: 'inherit' });
  c.on('close', res);
  c.on('error', res);
});

// Daily, fail-silent check for a newer create-katalystwp (the menu offers an
// "Update Katalyst" item when one exists). Throttled via a shared stamp file;
// offline or slow registries just mean no update item this time.
async function checkUpdate() {
  if (process.env.KATALYSTWP_NO_UPDATE_CHECK) return null;
  const stampPath = join(homedir(), '.katalystwp', 'update-check.json');
  try {
    const s = JSON.parse(readFileSync(stampPath, 'utf8'));
    if (Date.now() - (s.checkedAt ?? 0) < 24 * 60 * 60 * 1000) return s.latest ?? null;
  } catch { /* first check */ }
  try {
    const res = await fetch('https://registry.npmjs.org/create-katalystwp/latest', { signal: AbortSignal.timeout(2500) });
    const latest = (await res.json()).version;
    mkdirSync(join(homedir(), '.katalystwp'), { recursive: true });
    writeFileSync(stampPath, JSON.stringify({ checkedAt: Date.now(), latest }) + '\n');
    return latest;
  } catch {
    return null;
  }
}
// Is version a newer than b? (plain x.y.z compare; false on anything weird)
function newerThan(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Exit stops the site; a second Ctrl+C while stopping leaves it running.
async function stopSite() {
  let leaveRunning = false;
  tick('Stopping the site — Ctrl+C again to leave it running');
  const c = spawn(NPM, ['run', 'stop']);
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  const onInt = () => { leaveRunning = true; c.kill('SIGTERM'); };
  process.on('SIGINT', onInt);
  const code = await new Promise((res) => { c.on('close', res); c.on('error', () => res(1)); });
  process.removeListener('SIGINT', onInt);
  tickDone();
  if (leaveRunning) {
    console.log(`  ${dim('Leaving the site running.')}`);
  } else if (code !== 0) {
    showFailure('Stopping the site failed. Docker output:', out, 'Try: npm run stop   (container status: npm run ps)');
  }
  return !leaveRunning && code === 0;
}

// ---- main ------------------------------------------------------------------
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log(`WordPress ${SITE} · admin ${SITE}/wp-admin (${env.WP_ADMIN_USER || 'admin'})`);
  console.log('Interactive menu needs a terminal. Commands: npm run start | stop | bash' + agents.map((a) => ` | ${a}`).join(''));
  process.exit(0);
}

// One Katalyst per site: a second instance would fight this one for the
// terminal and the containers. The lock records our PID; a stale lock (dead
// PID, or a recycled PID that isn't a katalyst process) is taken over.
const LOCK = '.katalyst.lock';
let lockOwned = false;
try {
  const lock = JSON.parse(readFileSync(LOCK, 'utf8'));
  let alive = false;
  try { process.kill(lock.pid, 0); alive = true; } catch { /* dead */ }
  if (alive) {
    const { out } = await run(['ps', '-o', 'tty=,etime=,command=', '-p', String(lock.pid)]);
    const detail = out.trim();
    // ps unavailable (or ambiguous) → assume it's real rather than clobber it.
    if (!detail || /katalyst\.mjs|npm/.test(detail)) {
      console.error(`✖ Katalyst is already running for this site (PID ${lock.pid}${lock.startedAt ? `, since ${lock.startedAt}` : ''}).`);
      if (detail) console.error(`  ${dim('tty / elapsed / command:')} ${detail}`);
      console.error('  Use it in that terminal — or if it\'s lost/detached, stop it with:');
      console.error(`    kill ${lock.pid}`);
      process.exit(1);
    }
  }
} catch { /* no lock */ }
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n');
lockOwned = true;
process.on('exit', () => { if (lockOwned) { try { unlinkSync(LOCK); } catch { /* gone */ } } });

if (!(await portUp()) && !process.env.KATALYSTWP_NO_START) {
  tick('Starting the site');
  const { code, out } = await run([NPM, 'run', 'start']);
  // compose returning 0 isn't proof — wait for something to actually listen.
  let up = false;
  for (let i = 0; i < 20 && !up; i++) {
    up = await portUp();
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  tickDone();
  if (code !== 0 || !up) {
    showFailure(
      code !== 0 ? 'The site failed to start. Docker output:' : `The site started but nothing is answering on port ${PORT}. Output:`,
      out,
      'Fix and retry with: npm run start   (live container logs: npm run logs)',
    );
    process.exit(1);
  }
}

console.log('');
console.log(`  ${dim('WordPress')}  ${link(SITE)}`);
console.log(`  ${dim('Admin')}      ${link(`${SITE}/wp-admin`)}`);
console.log(`  ${dim('Username')}   ${env.WP_ADMIN_USER || 'admin'}`);
console.log(`  ${dim('Password')}   ${env.WP_ADMIN_PASSWORD || '(see .env)'}`);
console.log('');

const latest = await checkUpdate();
const updateAvailable = newerThan(latest, VERSION);

console.log('Welcome to Katalyst.\n');

let first = true;
for (;;) {
  const choice = await choose(
    first ? 'What do you want to do?' : 'What next?',
    [
      { value: 'admin', label: 'Open WP Admin', hint: 'logged in, one-click' },
      { value: 'site', label: 'Open the site', hint: 'front end' },
      ...agents.map((k) => ({ value: `agent:${k}`, label: `Open ${AGENT_LABELS[k]}`, hint: 'agent in the sandbox' })),
      { value: 'shell', label: 'Sandbox shell', hint: 'a terminal inside the sandbox — WordPress at ./wp' },
      ...(updateAvailable ? [{ value: 'update', label: `Update ${pink('Katalyst')}`, hint: `v${VERSION} → v${latest}` }] : []),
      { value: 'exit', label: 'Exit', hint: 'stops the site — npm run katalyst brings it back' },
    ],
  );
  first = false;
  if (choice === null || choice === 'exit') {
    const stopped = await stopSite();
    console.log(`\n  ${stopped ? `${dim('Site stopped.')} ` : ''}${dim('Your site lives at')} ${process.cwd()}`);
    console.log(`  ${dim('To start it up again and use Katalyst:')}`);
    console.log(`    cd ${process.cwd()}`);
    console.log('    npm run katalyst\n');
    process.exit(0);
  }
  if (choice === 'admin') {
    openBrowser(await adminUrl()); // minted fresh per open (links are one-time)
  } else if (choice === 'site') {
    openBrowser(SITE);
  } else if (choice === 'shell') {
    console.log(`\n  ${pink('Katalyst')} ${dim('sandbox shell — WordPress at ./wp · type')} exit ${dim('to return to Katalyst')}\n`);
    await runInherit('bash');
  } else if (choice === 'update') {
    // Pinned to the checked version (never a bare @latest), inherit the
    // terminal so its output is visible, then re-exec the (possibly replaced)
    // menu script.
    console.log(`\n  ${dim('Updating Katalyst to')} v${latest}${dim('…')}\n`);
    const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    await new Promise((res) => {
      const c = spawn(NPX, ['-y', `create-katalystwp@${latest}`, 'update'], { stdio: 'inherit' });
      c.on('close', res);
      c.on('error', res);
    });
    console.log(`  ${dim('Reopening the menu…')}\n`);
    // Hand the lock to the fresh menu instance we're about to spawn.
    lockOwned = false;
    try { unlinkSync(LOCK); } catch { /* gone */ }
    const c = spawn(process.execPath, ['scripts/katalyst.mjs'], { stdio: 'inherit' });
    c.on('close', (code) => process.exit(typeof code === 'number' ? code : 0));
    c.on('error', () => process.exit(1));
    break;
  } else if (choice.startsWith('agent:')) {
    const k = choice.slice('agent:'.length);
    console.log(`\n  ${dim('Launching')} ${AGENT_LABELS[k]}${dim(' — when you quit it, you return to Katalyst')}\n`);
    await runInherit(k);
  }
}
