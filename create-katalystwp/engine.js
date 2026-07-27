/**
 * create-katalystwp — scaffolding engine.
 *
 * `create()` is the reusable entry point. The bundled CLI (index.js) calls it
 * with no preset; downstream `create-<brand>` packages depend on this package
 * and call it with a preset to add their own plugins. See the README section
 * "Build your own npm create command".
 */

import { readdir, mkdir, readFile, writeFile, chown } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, 'templates');

// Template filename -> output filename (dotfiles can't ship as dotfiles in npm).
const RENAME = {
  'env.example': '.env',
  'gitignore': '.gitignore',
};

// Templates emitted only on demand (not copied by the blanket walk). The dev
// service override is written only when the project has a dev script.
const SKIP_TEMPLATES = new Set(['docker-compose.override.yml']);

// When checking that the target dir is empty, these harmless entries don't count.
const ALLOWED_EXISTING = new Set([
  '.git', '.gitignore', '.gitkeep', '.hg', '.svn',
  '.DS_Store', 'Thumbs.db', '.idea', '.vscode',
  'LICENSE', 'LICENSE.md', 'README.md',
]);

// The AI coding agents that CAN be installed into the workspace container.
// Only the ones the user selects (interactively or via --agents) are installed
// — nothing is baked in unasked. `pkg` is the npm package installed in
// workspace.Dockerfile; Cursor uses its own installer (see the
// ">>> agent:cursor" section there). Each key doubles as the generated
// project's npm script name (`npm run claude`, …) and as a section marker
// name in the Dockerfile template.
export const AGENTS = {
  claude:   { label: 'Claude Code', pkg: '@anthropic-ai/claude-code' },
  cursor:   { label: 'Cursor CLI' },
  codex:    { label: 'Codex CLI', pkg: '@openai/codex' },
  opencode: { label: 'OpenCode', pkg: 'opencode-ai' },
};
const DEFAULT_AGENTS = ['claude'];

// ---- terminal styling ------------------------------------------------------
// KatalystWP brand pink (#ff2d78): truecolor where advertised, a close 256-
// color elsewhere. All styling is disabled when piped or NO_COLOR is set.
const COLOR_ON = process.stdout.isTTY && !process.env.NO_COLOR;
const PINK_ON = (process.env.COLORTERM || '').includes('truecolor')
  ? '\u001b[38;2;255;45;120m'
  : '\u001b[38;5;198m';
export const pink = (s) => (COLOR_ON ? `${PINK_ON}${s}\u001b[39m` : s);
export const dim = (s) => (COLOR_ON ? `\u001b[2m${s}\u001b[22m` : s);

// OSC 8 terminal hyperlink (clickable in iTerm2, Windows Terminal, VS Code,
// and most modern emulators; unsupported terminals just show the plain URL,
// and piped output gets the URL untouched). Brand-pink when colors are on.
const termLink = (url) => (process.stdout.isTTY ? pink(`\u001b]8;;${url}${url}\u001b]8;;`) : url);

// Suggested site names: memorable, unique-ish, zero decisions required —
// "pragmatic-monkey-23". Only a suggestion; the user can type anything.
const NAME_ADJECTIVES = [
  'pragmatic', 'angry', 'sleepy', 'brave', 'clever', 'dapper', 'eager', 'fuzzy',
  'gentle', 'happy', 'jolly', 'keen', 'lively', 'mellow', 'nimble', 'plucky',
  'quirky', 'rusty', 'snappy', 'tidy', 'witty', 'zesty', 'bold', 'cosmic',
  'daring', 'electric', 'fancy', 'groovy', 'humble', 'iconic',
];
const NAME_ANIMALS = [
  'monkey', 'gerbil', 'otter', 'badger', 'ferret', 'walrus', 'pelican', 'lemur',
  'gecko', 'heron', 'ibex', 'jackal', 'koala', 'lynx', 'marmot', 'narwhal',
  'ocelot', 'panda', 'quokka', 'raccoon', 'stoat', 'toucan', 'urchin', 'vole',
  'wombat', 'yak', 'zebra', 'beaver', 'condor', 'dingo',
];
export function generateSiteName() {
  const pick = (arr) => arr[randomBytes(1)[0] % arr.length];
  return `${pick(NAME_ADJECTIVES)}-${pick(NAME_ANIMALS)}-${10 + (randomBytes(1)[0] % 90)}`;
}

// Shells don't expand ~ inside interactive answers (and not in every arg
// position either) — do it ourselves so "~/Dev/my-site" never becomes a
// literal "~" directory.
const expandTilde = (p) =>
  (p === '~' ? homedir() : p && (p.startsWith('~/') || p.startsWith('~\\')) ? join(homedir(), p.slice(2)) : p);

// Parse an agents list ("claude,cursor", "all", "none"). Used by --agents and
// by preset.agents. Throws on unknown names so typos fail loudly.
function parseAgentsList(raw, source = '--agents') {
  const items = String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!items.length || items.includes('none')) return [];
  if (items.includes('all')) return Object.keys(AGENTS);
  const bad = items.filter((i) => !AGENTS[i]);
  if (bad.length) {
    throw new Error(`${source}: unknown agent(s): ${bad.join(', ')}. Valid: ${Object.keys(AGENTS).join(', ')}, all, none.`);
  }
  return [...new Set(items)];
}

// ---- environments registry (~/.katalystwp/environments.json) --------------
// Every scaffolded sandbox is recorded here (shared across create-<brand>
// wrappers, since they all use this engine). Used to (a) auto-pick a WP port
// that no other environment — running or stopped — already claims, and (b)
// power the `list` command. Best-effort: a missing/corrupt file is an empty
// registry, and a failed write never breaks scaffolding.
export const STATE_DIR = join(homedir(), '.katalystwp');
export const STATE_PATH = join(STATE_DIR, 'environments.json');

async function loadState() {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, 'utf8'));
    if (s && Array.isArray(s.environments)) return s;
  } catch { /* fall through */ }
  return { environments: [] };
}

async function saveState(state) {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch { /* registry is best-effort */ }
}

// Record (or update, keyed by dir) one environment.
async function recordEnvironment(env) {
  const state = await loadState();
  const i = state.environments.findIndex((e) => e.dir === env.dir);
  if (i >= 0) state.environments[i] = { ...state.environments[i], ...env };
  else state.environments.push(env);
  await saveState(state);
}

// Can we listen on this port? (Docker-published ports bind 0.0.0.0, so they —
// and any other host listener — make this return false.)
function portFree(port) {
  return new Promise((res) => {
    const srv = createServer();
    srv.once('error', () => res(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => srv.close(() => res(true)));
  });
}

// Is something accepting connections on this port right now? (Used by `list`
// to show up/stopped.)
function portInUse(port) {
  return new Promise((res) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); res(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(500, () => done(false));
  });
}

// First port >= `start` that is free on the host AND not claimed by a
// registered environment (which may just be stopped right now).
async function findFreePort(start, claimed) {
  for (let p = start; p < start + 1000; p++) {
    if (claimed.has(p)) continue;
    if (await portFree(p)) return p;
  }
  return start; // pathological — let Docker surface the error
}

// `npx create-<brand> list` — show every registered environment. Entries whose
// directory no longer exists are pruned as we go.
async function listEnvironments() {
  const state = await loadState();
  const kept = [];
  const rows = [];
  for (const env of state.environments) {
    const exists = await stat(env.dir).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) continue; // deleted on disk — drop from the registry
    kept.push(env);
    rows.push({
      name: env.name,
      port: String(env.port),
      status: (await portInUse(env.port)) ? 'up' : 'stopped',
      agents: (env.agents ?? []).join(',') || 'none',
      dir: env.dir,
    });
  }
  if (kept.length !== state.environments.length) await saveState({ ...state, environments: kept });
  if (!rows.length) {
    console.log('\nNo environments yet. Create one with: npm create katalystwp@latest\n');
    return;
  }
  const w = (k, h) => Math.max(h.length, ...rows.map((r) => r[k].length));
  const widths = { name: w('name', 'NAME'), port: w('port', 'PORT'), status: w('status', 'STATUS'), agents: w('agents', 'AGENTS') };
  console.log(`\nEnvironments (${STATE_PATH}):\n`);
  console.log(`  ${'NAME'.padEnd(widths.name)}  ${'PORT'.padEnd(widths.port)}  ${'STATUS'.padEnd(widths.status)}  ${'AGENTS'.padEnd(widths.agents)}  DIR`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(widths.name)}  ${r.port.padEnd(widths.port)}  ${r.status.padEnd(widths.status)}  ${r.agents.padEnd(widths.agents)}  ${r.dir}`);
  }
  console.log('\n  Start/stop one: cd <dir> && npm run start | npm run stop\n');
}

// Local-dev admin password: real enough to not be embarrassing, safe for the
// .env file the setup scripts `source` (lowercase alphanumeric + dashes only).
function generatePassword() {
  const chunk = () => randomBytes(4).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(4, '0').slice(0, 4);
  return `k4t-${chunk()}-${chunk()}`;
}

// Mint a one-time passwordless wp-admin login URL through the Agent Connector
// ability installed in every sandbox — the same mechanism the devbox server's
// /admin-login endpoint uses. Returns the URL, or null if unavailable.
const ADMIN_LOGIN_PHP = `
$admins = get_users(array('role' => 'administrator', 'number' => 1, 'orderby' => 'ID'));
$u = $admins ? $admins[0] : null;
if (!$u) { fwrite(STDERR, 'no administrator user'); exit(1); }
$cls = 'AgentConnectorForWp\\\\DefaultAbilities\\\\Services\\\\AdminLoginLink';
if (!class_exists($cls)) { fwrite(STDERR, 'abilities plugin (admin login) not active'); exit(1); }
$r = $cls::create($u->ID, 'index.php', 300);
if (is_wp_error($r)) { fwrite(STDERR, $r->get_error_message()); exit(1); }
echo $r['login_url'];
`;

function mintAdminLoginUrl(cwd) {
  return new Promise((res) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'workspace', 'wp', 'eval', ADMIN_LOGIN_PHP], { cwd });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => res(code === 0 && /acfw_login=/.test(out.trim()) ? out.trim() : null));
    child.on('error', () => res(null));
  });
}

// Open a URL in the default browser, cross-platform. Fire-and-forget.
function openBrowser(url) {
  const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best-effort */ }
}

// Run `npm run setup` in the project, capturing EVERYTHING to a log file under
// ~/.katalystwp/logs/. The Docker build firehose never reaches the console:
// the setup scripts' own step lines (→ / ✓ / …) are passed to `onStep` — in a
// terminal that feeds a single in-place spinner line, elsewhere they print as
// a plain progress list. --verbose streams the raw output instead. Resolves
// true on success.
function runSetup(cwd, logPath, { verbose, onStep }) {
  return new Promise((res) => {
    const log = createWriteStream(logPath);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(npm, ['run', 'setup'], { cwd });
    let buf = '';
    const onChunk = (chunk) => {
      log.write(chunk);
      if (verbose) { process.stdout.write(chunk); return; }
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (/^(→|✓)/.test(line)) onStep(line);
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('close', (code) => { log.end(); res(code === 0); });
    child.on('error', () => { log.end(); res(false); });
  });
}

// Strip or keep "# >>> agent:<name> … # <<< agent:<name>" sections in a
// template based on the selected agents. The marker lines themselves never
// reach the output.
function applyAgentSections(content, agents) {
  return content.replace(
    /[ \t]*# >>> agent:(\w+)\n([\s\S]*?)[ \t]*# <<< agent:\1\n/g,
    (_, name, body) => (agents.includes(name) ? body : ''),
  );
}

function parseArgs(argv) {
  const out = { dir: null, port: '8080', portExplicit: false, setup: true, setupScript: null, defines: null, activate: [], devScript: null, devCommand: null, appPorts: [], publicHost: 'localhost', agentsRaw: null, pluginsRaw: null, yes: false };
  for (const a of argv) {
    if (a.startsWith('--port=')) { out.port = a.slice('--port='.length); out.portExplicit = true; }
    else if (a.startsWith('--agents=')) out.agentsRaw = a.slice('--agents='.length);
    else if (a.startsWith('--plugins=')) out.pluginsRaw = a.slice('--plugins='.length);
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--setup-script=')) out.setupScript = a.slice('--setup-script='.length);
    else if (a.startsWith('--dev-script=')) out.devScript = a.slice('--dev-script='.length);
    else if (a.startsWith('--dev-command=')) out.devCommand = a.slice('--dev-command='.length);
    else if (a.startsWith('--defines=')) out.defines = a.slice('--defines='.length);
    else if (a.startsWith('--app-ports=')) out.appPorts = parseAppPorts(a.slice('--app-ports='.length));
    else if (a.startsWith('--public-host=')) out.publicHost = a.slice('--public-host='.length).trim() || 'localhost';
    else if (a.startsWith('--activate=')) {
      out.activate = a.slice('--activate='.length).split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--scaffold-only') out.setup = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!a.startsWith('-') && out.dir === null) out.dir = a;
  }
  return out;
}

// Parse --app-ports: comma-separated HOST:CONTAINER pairs (a bare PORT means
// PORT:PORT). These are published on the WORKSPACE service — the dev container
// shares its network namespace (see templates/docker-compose.override.yml), so
// one list covers servers started by the dev script AND by an agent.
//
// One published port per CONTAINER port: a later entry for the same container
// port REPLACES the earlier one. That's what lets a CLI --app-ports=9101:3000
// override a preset's bare 3000 instead of publishing both.
function parseAppPorts(raw) {
  const ports = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = entry.match(/^(\d{1,5})(?::(\d{1,5}))?$/);
    const host = m ? parseInt(m[1], 10) : NaN;
    const container = m ? parseInt(m[2] ?? m[1], 10) : NaN;
    if (!m || host < 1 || host > 65535 || container < 1 || container > 65535) {
      throw new Error(`--app-ports entry "${entry}" is invalid — expected PORT or HOST:CONTAINER (1-65535), e.g. --app-ports=3000 or --app-ports=9101:3000,9102:5173`);
    }
    const i = ports.findIndex((p) => p.container === container);
    if (i >= 0) ports.splice(i, 1); // later mapping for this container port wins
    const hostDup = ports.find((p) => p.host === host);
    if (hostDup) {
      throw new Error(`--app-ports maps host port ${host} to both ${hostDup.container} and ${container}`);
    }
    ports.push({ host, container });
  }
  return ports;
}

// Render the workspace service's published-ports block (replaces the
// __APP_PORTS__ placeholder line in templates/docker-compose.yml). Without
// --app-ports it renders as a how-to comment, so the generated file stays
// self-documenting.
function renderAppPortsBlock(appPorts) {
  if (!appPorts.length) {
    return [
      '    # No app ports are published (scaffolded without --app-ports). To reach a',
      '    # dev server running in this container (or the dev container, which shares',
      '    # its network namespace) from the host, add e.g.:',
      '    #   ports:',
      '    #     - "3000:3000"',
      '    # then `npm run start`. Published ports bind 0.0.0.0 and BYPASS ufw-style',
      '    # host firewalls — on an internet-facing host, restrict them upstream.',
    ].join('\n');
  }
  return [
    '    # Host-published app ports (--app-ports): dev servers listening on the',
    '    # container port (started here or by the dev script — the dev container',
    '    # shares this network namespace) are reachable on the host port. Published',
    '    # ports bind 0.0.0.0 and BYPASS ufw-style host firewalls — on an',
    '    # internet-facing host, restrict them upstream (cloud firewall/VPN).',
    '    ports:',
    ...appPorts.map((p) => `      - "${p.host}:${p.container}"`),
  ].join('\n');
}

function usage(pkg, create) {
  console.log(`${pkg}

Scaffold a local WordPress + AI-agent Docker dev environment.

Usage:
  npm ${create} -- [dir] [options]
  npx ${pkg} [dir] [options]

Commands:
  list                  Show every environment recorded in ~/.katalystwp
                        (name, port, up/stopped, agents, directory).
  menu                  Reopen the Katalyst menu (site links, one-click
                        wp-admin, agents, sandbox shell) for the project in
                        the current directory — what \`npm run katalyst\` runs.

Arguments:
  dir                   Target directory. Asked interactively when omitted
                        (suggested: my-site); non-interactive runs default to
                        the current directory.

Options:
  --port=NNNN           Host port for WordPress. Default: the first free port
                        from 8080 that no other environment claims. An explicit
                        busy port fails fast with a suggestion.
  --agents=LIST         AI coding agents to install in the workspace, comma-
                        separated: ${Object.keys(AGENTS).join(', ')} — or
                        'all' / 'none'. Default: claude (Claude Code).
  --plugins=LIST        WordPress plugins to pre-install, comma-separated
                        wordpress.org slugs or .zip URLs.
  --yes, -y             Accept defaults; never prompt. (Prompts only appear in
                        an interactive terminal anyway — CI and scripts are
                        always non-interactive.)
  --verbose             Stream the full setup output (Docker build and all).
                        By default only the step lines are shown and the full
                        output goes to ~/.katalystwp/logs/<name>.setup.log.
  --setup-script=PATH   Shell script to run inside the workspace (as node) on
                        first setup — e.g. clone a repo and run its installer.
  --dev-script=PATH     Shell script run (as node) in its own long-running 'dev'
                        container for as long as the stack is up — e.g. a watcher.
  --dev-command=STR     Inline form of --dev-script, e.g. --dev-command="cd
                        /home/node/app && npm run watch".
  --defines=PATH        JSON file of { "WP_CONST": value } pairs added to
                        wp-config.php as constants (via \`wp config set\`).
  --activate=a,b,c      Plugin slugs to activate, in this exact order, after the
                        setup script runs (for plugins it dropped into wp-content).
  --app-ports=LIST      Comma-separated host ports to publish on the workspace
                        container for dev servers (a bare PORT means PORT:PORT;
                        HOST:CONTAINER maps them), e.g. --app-ports=3000 or
                        --app-ports=9101:3000. The dev container shares the
                        workspace's network namespace, so these cover servers
                        started by the dev script too. Exposed to setup scripts
                        as SANDBOX_APP_PORT_<container>=<host>.
  --public-host=HOST    Hostname/IP browsers use to reach this Docker host
                        (default: localhost). Written to .env as PUBLIC_HOST and
                        exposed to setup scripts as SANDBOX_PUBLIC_HOST.
  --scaffold-only       Only write files; skip the automatic \`npm run setup\`
`);
}

// User-level config — defaults applied to EVERY scaffold (set once, like
// ~/.claude). Location: $XDG_CONFIG_HOME/create-katalystwp/
// config.json (default ~/.config/…). Keys: wpAdminUser, wpAdminPassword,
// wpAdminEmail. Missing/invalid file → {} (falls back to user "admin" with a
// per-site generated password).
// The devbox server runs as root, so root's config seeds all its envs too.
export const USER_CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'create-katalystwp',
  'config.json',
);

// Pre-rename location (the package was create-wp-local-dev-agent-sandbox) —
// still read so existing users' defaults keep applying.
const LEGACY_USER_CONFIG_PATH = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'create-wp-local-dev-agent-sandbox',
  'config.json',
);

async function loadUserConfig() {
  for (const path of [USER_CONFIG_PATH, LEGACY_USER_CONFIG_PATH]) {
    try {
      const c = JSON.parse(await readFile(path, 'utf8'));
      if (c && typeof c === 'object') return c;
    } catch {
      // try the next location
    }
  }
  return {};
}

// Interactive chooser — runs only in a real terminal and only for choices not
// already made via flags/arguments. Uses @clack/prompts (arrow keys; space
// toggles a selection; Enter accepts). Loaded dynamically so non-interactive
// callers (CI, the devbox server driving index.js from a bare checkout) never
// need the dependency at all — if it's missing we warn and use the defaults.
async function promptForChoices({ dir, defaultDir, agents, defaultAgents }) {
  let ui;
  try {
    ui = await import('./ui.js');
  } catch {
    console.error('⚠ Interactive prompts need this package\'s dependencies (npm install) — using defaults instead.');
    return { dir: dir ?? defaultDir, agents: agents ?? [...defaultAgents] };
  }
  // Ctrl+C (or closing stdin) on any question aborts cleanly before anything
  // is written to disk.
  const answer = (v) => {
    if (ui.isCancel(v)) {
      console.log(`\n${dim('Cancelled — nothing was created.')}\n`);
      process.exit(1);
    }
    return v;
  };

  if (dir == null) {
    console.log(`\nWelcome to ${pink('Katalyst')} — let's create a WordPress environment.\n`);
    const name = answer(await ui.question('Site name', { placeholder: defaultDir, defaultValue: defaultDir })) || defaultDir;
    // Where it lives: a tidy ~/katalyst-sites/<name> by default (everything in
    // one findable place), this folder, or any path. Re-ask on a non-empty
    // choice so the user never answers everything and then hits an error.
    const homeDir = join(homedir(), 'katalyst-sites', name);
    for (;;) {
      const where = answer(await ui.choose('Where should it live?', [
        { value: homeDir, label: `~/katalyst-sites/${name}`, hint: 'recommended' },
        { value: resolve(name), label: `./${name}`, hint: 'inside the current folder' },
        { value: ' custom', label: 'Somewhere else…', hint: 'type a path' },
      ]));
      const candidate = where === ' custom'
        ? expandTilde(answer(await ui.question('Path for the site', { placeholder: `~/katalyst-sites/${name}` })) || homeDir)
        : where;
      const existing = await readdir(resolve(candidate)).catch(() => []);
      const blocking = existing.filter((f) => !ALLOWED_EXISTING.has(f));
      if (!blocking.length) { dir = candidate; break; }
      console.log(`  ${pink('✖')} ${resolve(candidate)} is not empty — pick a new or empty location.`);
    }
  }
  if (agents == null) {
    agents = answer(await ui.pick(
      'Which AI agents should I install?',
      Object.entries(AGENTS).map(([value, a]) => ({ value, label: a.label })),
      { initialValues: [...defaultAgents] },
    ));
  }
  return { dir, agents };
}


async function copyTemplates(srcDir, destDir, vars) {
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (SKIP_TEMPLATES.has(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, RENAME[entry.name] ?? entry.name);
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await copyTemplates(src, dest, vars);
    } else {
      const rendered = applyAgentSections(await readFile(src, 'utf8'), vars.agents)
        .replaceAll('__PROJECT_NAME__', vars.projectName)
        .replaceAll('__WP_PORT__', vars.port)
        .replaceAll('__PUBLIC_HOST__', vars.publicHost)
        .replaceAll('__APP_PORTS__', vars.appPortsBlock)
        .replaceAll('__AGENT_NPM_PKGS__', vars.agentNpmPkgs)
        .replaceAll('__WP_ADMIN_USER__', vars.wpAdminUser)
        .replaceAll('__WP_ADMIN_PASSWORD__', vars.wpAdminPassword)
        .replaceAll('__WP_ADMIN_EMAIL__', vars.wpAdminEmail);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, rendered);
    }
  }
}

// Merge derived settings into the scaffolded sandbox.config.json. `plugins`
// entries are the same shape install-plugins.sh understands (a wordpress.org
// slug string, or { source, activate?, version? }); `activate` is an ordered
// list of slugs to activate after the setup script runs; `defines` is a
// { NAME: value } map applied to wp-config.php; `setupScript` is a path
// (relative to the project) to a script run inside the workspace on setup.
async function applyConfig(targetDir, extra) {
  const cfgPath = join(targetDir, 'sandbox.config.json');
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  // Which agents this sandbox was scaffolded with — informational (the actual
  // installs are baked into workspace.Dockerfile at scaffold time).
  cfg.agents = extra.agents ?? [];
  if (extra.plugins?.length) cfg.plugins = [...(cfg.plugins ?? []), ...extra.plugins];
  if (extra.activate?.length) cfg.activate = [...(cfg.activate ?? []), ...extra.activate];
  if (extra.defines && Object.keys(extra.defines).length) {
    cfg.defines = { ...(cfg.defines ?? {}), ...extra.defines };
  }
  if (extra.setupScript) cfg.setupScript = extra.setupScript;
  if (extra.devScript) cfg.devScript = extra.devScript;
  // Published app ports, recorded so scripts/run-setup-script.sh can export
  // SANDBOX_APP_PORT_<container> to the setup script.
  if (extra.appPorts?.length) cfg.appPorts = extra.appPorts;
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
}

// Read a --defines file: JSON object of { NAME: value } constant pairs.
async function readDefinesFile(path) {
  const raw = await readFile(resolve(path), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--defines file "${path}" is not valid JSON (expected an object of { "WP_CONST": value } pairs).`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--defines file "${path}" must be a JSON object of { "WP_CONST": value } pairs.`);
  }
  return parsed;
}

/**
 * Scaffold the sandbox into a target directory and (unless --scaffold-only) run
 * `npm run setup`.
 *
 * @param {object} [options]
 * @param {object} [options.preset]            Derivative config: { name?, plugins?, activate?, defines?, setupScript? }.
 * @param {string} [options.preset.name]       Short name, e.g. "oxygen-wp" — only used to
 *                                             print the right `npm create <name>` in messages.
 * @param {Array}  [options.preset.plugins]    Extra plugins appended to the defaults.
 * @param {string[]} [options.preset.agents]   Default agents for this brand (keys of AGENTS,
 *                                             e.g. ['claude']) — the user can still override
 *                                             interactively or with --agents.
 * @param {string[]} [options.preset.activate] Plugin slugs to activate (in order) after the setup script.
 * @param {object} [options.preset.defines]    { NAME: value } constants written into wp-config.php.
 * @param {string} [options.preset.setupScript] Shell-script contents run inside the workspace on setup.
 * @param {string} [options.preset.devScript]  Shell-script contents run in the long-running 'dev' container.
 * @param {Array<number|string>} [options.preset.appPorts] Ports published on the workspace container
 *                                             (a number N means N:N; "HOST:CONTAINER" maps them).
 * @param {string[]} [options.argv]            CLI args (default: process.argv.slice(2)).
 */
export async function create({ preset = {}, argv = process.argv.slice(2) } = {}) {
  // What to call this command in help/error text — wrappers pass preset.name.
  const slug = preset.name ?? 'katalystwp';
  const pkg = `create-${slug}`;

  const args = parseArgs(argv);
  if (args.help) {
    usage(pkg, `create ${slug}`);
    return;
  }
  if (args.dir === 'list') {
    await listEnvironments();
    return;
  }
  if (args.dir === 'menu') {
    // The menu ships WITH each project (scripts/katalyst.mjs — offline, no
    // version drift); this subcommand just delegates for convenience. The
    // script prints its own error when run outside a Katalyst project.
    const code = await new Promise((res) => {
      const child = spawn(process.execPath, ['scripts/katalyst.mjs'], { stdio: 'inherit' });
      child.on('close', res);
      child.on('error', () => res(1));
    });
    process.exit(typeof code === 'number' ? code : 1);
  }

  // Read & validate the file-backed inputs first, so a bad --setup-script /
  // --dev-script / --defines path fails before we create or write anything.
  const setupScriptContent = args.setupScript
    ? await readFile(resolve(args.setupScript), 'utf8')
    : (preset.setupScript ?? null);
  // --dev-script PATH wins over --dev-command STRING wins over a preset.
  const devScriptContent = args.devScript
    ? await readFile(resolve(args.devScript), 'utf8')
    : (args.devCommand != null ? args.devCommand + '\n' : (preset.devScript ?? null));
  const cliDefines = args.defines ? await readDefinesFile(args.defines) : null;

  // App ports: preset entries first, CLI entries after — so a CLI mapping for
  // the same container port overrides the preset's (see parseAppPorts).
  const appPorts = parseAppPorts([...(preset.appPorts ?? []), ...args.appPorts.map((p) => `${p.host}:${p.container}`)].join(','));

  // ---- choose directory / agents / plugins / port -------------------------
  // Flags (and the dir argument) decide outright; anything not decided is
  // asked about in an interactive terminal (unless --yes), and falls back to
  // defaults otherwise (non-TTY callers — CI, the devbox server — always take
  // this path; their dir default stays the current directory).
  const defaultAgents = preset.agents != null ? parseAgentsList(preset.agents.join(','), 'preset.agents') : DEFAULT_AGENTS;
  let agents = args.agentsRaw != null ? parseAgentsList(args.agentsRaw) : null;
  let extraPlugins = args.pluginsRaw != null
    ? args.pluginsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  // Port: an explicit --port is validated (fail fast with a clear message
  // instead of Docker's "Bind for 0.0.0.0:NNNN failed" at setup time); without
  // one, the default offered — and used in auto mode — is the first port from
  // 8080 that is free on the host AND not claimed by another registered
  // environment (which may just be stopped right now).
  const state = await loadState();
  const claimed = new Set(state.environments.map((e) => Number(e.port)));
  let port;
  if (args.portExplicit) {
    port = String(args.port);
    const n = parseInt(port, 10);
    if (!(await portFree(n))) {
      const holder = state.environments.find((e) => Number(e.port) === n);
      console.error(`\n✖ Port ${n} is already in use${holder ? ` by your "${holder.name}" environment (${holder.dir})` : ''}.`);
      console.error(`  Free alternative: --port=${await findFreePort(n + 1, claimed)}${holder ? `, or stop that environment: cd ${holder.dir} && npm run stop` : ''}\n`);
      process.exit(1);
    }
  } else {
    port = String(await findFreePort(parseInt(args.port, 10) || 8080, claimed));
  }

  // Only two questions: directory and agents. Port is auto-picked (visible in
  // the summary card, overridable with --port); plugins are flags/preset-only.
  const undecided = args.dir == null || agents == null;
  const canPrompt = !args.yes && process.stdin.isTTY && process.stdout.isTTY;
  const promptRan = undecided && canPrompt;
  if (promptRan) {
    // Suggest a fun unique name whose default location doesn't already exist.
    let suggested = generateSiteName();
    for (let i = 0; i < 5; i++) {
      const exists = await stat(join(homedir(), 'katalyst-sites', suggested)).then(() => true).catch(() => false);
      if (!exists) break;
      suggested = generateSiteName();
    }
    ({ dir: args.dir, agents } = await promptForChoices({
      dir: args.dir, defaultDir: suggested, agents, defaultAgents,
    }));
  }
  agents ??= defaultAgents;
  extraPlugins ??= [];
  args.port = port;

  const targetDir = resolve(expandTilde(args.dir) ?? '.');
  const projectName = basename(targetDir);

  // Interactive users just answered these — only recap when running on
  // defaults/flags, so scripts and CI logs still show what was decided.
  if (!promptRan) {
    console.log(`\n→ Config: directory ${projectName} · port ${port} · agents: ${agents.length ? agents.map((k) => AGENTS[k].label).join(', ') : 'none'} · extra plugins: ${extraPlugins.length ? extraPlugins.join(', ') : 'none'}`);
    if (undecided) {
      console.log('  (defaults — run in an interactive terminal to be asked, or set the dir argument / --port= --agents= --plugins=)');
    }
  }

  await mkdir(targetDir, { recursive: true });

  const existing = await readdir(targetDir).catch(() => []);
  const blocking = existing.filter((f) => !ALLOWED_EXISTING.has(f));
  if (blocking.length) {
    const shown = blocking.slice(0, 5).join(', ') + (blocking.length > 5 ? ', …' : '');
    console.error(`\n✖ ${targetDir} is not empty (found: ${shown}).`);
    console.error('  This scaffolder needs an empty directory. Point it at a new one, e.g.:');
    console.error(`    npm create ${slug}@latest my-site\n`);
    process.exit(1);
  }

  // Admin account: user-level config wins (set once in ~/.config/...);
  // otherwise the username defaults to admin and the password is GENERATED per
  // site (persisted in the project's .env) — never a guessable default.
  const userConfig = await loadUserConfig();
  const adminUser = userConfig.wpAdminUser || 'admin';
  const adminPass = userConfig.wpAdminPassword || generatePassword();
  await copyTemplates(TEMPLATES, targetDir, {
    projectName,
    agents,
    agentNpmPkgs: agents.map((k) => AGENTS[k].pkg).filter(Boolean).map((p) => p + ' ').join(''),
    port: String(args.port),
    publicHost: args.publicHost,
    appPortsBlock: renderAppPortsBlock(appPorts),
    wpAdminUser: adminUser,
    wpAdminPassword: adminPass,
    wpAdminEmail: userConfig.wpAdminEmail || 'admin@example.com',
  });

  // Drop the npm scripts for agents that aren't installed in this sandbox
  // (`npm run claude` when Claude Code isn't in the image would just error).
  {
    const pkgPath = join(targetDir, 'package.json');
    const pkgJson = JSON.parse(await readFile(pkgPath, 'utf8'));
    for (const key of Object.keys(AGENTS)) {
      if (!agents.includes(key)) delete pkgJson.scripts[key];
    }
    await writeFile(pkgPath, JSON.stringify(pkgJson, null, 2) + '\n');
  }

  // A setup script (CLI --setup-script, or a preset's inline script) is copied
  // into the project's scripts/ so the generated project is self-contained — it
  // re-runs on `npm run setup` / `npm run reset` without the original file.
  let setupScriptRel = null;
  if (setupScriptContent != null) {
    setupScriptRel = 'scripts/user-setup.sh';
    await writeFile(join(targetDir, setupScriptRel), setupScriptContent);
  }

  // A dev script runs in its own long-lived 'dev' container (see
  // templates/docker-compose.override.yml). We drop the script at scripts/dev.sh
  // and emit the override that adds the service — both only when one is provided,
  // so projects without a dev script get neither the file nor the extra service.
  let devScriptRel = null;
  if (devScriptContent != null) {
    devScriptRel = 'scripts/dev.sh';
    await writeFile(join(targetDir, devScriptRel), devScriptContent);
    const override = await readFile(join(TEMPLATES, 'docker-compose.override.yml'), 'utf8');
    await writeFile(join(targetDir, 'docker-compose.override.yml'), override);
  }

  await applyConfig(targetDir, {
    agents,
    plugins: [...(preset.plugins ?? []), ...extraPlugins],
    activate: [...(preset.activate ?? []), ...args.activate],
    defines: { ...(preset.defines ?? {}), ...(cliDefines ?? {}) },
    setupScript: setupScriptRel,
    devScript: devScriptRel,
    appPorts,
  });

  // Pre-create the bind-mount host dirs (see docker-compose.yml). If they don't
  // exist when the stack first comes up, Docker creates them as root — on Linux
  // that leaves them owned by root and unwritable from the host.
  for (const d of ['db', 'workspace/wp']) {
    await mkdir(join(targetDir, d), { recursive: true });
  }

  // ./workspace is the workspace container's home (/home/node), and that
  // container runs as the node user (uid/gid 1000). On Linux a bind mount keeps
  // the host's ownership, so node can write there only if the host dir is owned
  // by 1000 — the repo's "anchor everything to uid 1000" model (see
  // APACHE_RUN_USER in docker-compose.yml), which holds when the default Ubuntu
  // host user (also 1000) scaffolds. When scaffolding as root the dir would be
  // root-owned and unwritable, so the agents' configs (~/.claude.json, the seed,
  // ~/.cursor/mcp.json) silently fail to persist. Align it explicitly. (db/ is
  // left alone — the mariadb container manages its own datadir ownership.)
  if (process.getuid && process.getuid() === 0) {
    for (const d of ['workspace', 'workspace/wp']) {
      await chown(join(targetDir, d), 1000, 1000);
    }
  }

  // Register the environment (best-effort) — powers `list` and keeps future
  // scaffolds off this port even while the stack is stopped.
  const setupLog = join(STATE_DIR, 'logs', `${projectName}.setup.log`);
  await recordEnvironment({
    name: projectName,
    dir: targetDir,
    port: parseInt(port, 10),
    agents,
    createdAt: new Date().toISOString(),
    setupLog,
  });

  const cd = args.dir ? args.dir : '.';
  // "command  # what it does" rows, aligned per block.
  const agentCmds = agents.map((k) => [`npm run ${k}`, `launch ${AGENTS[k].label} in the workspace`]);
  const printCmds = (rows) => {
    const w = Math.max(...rows.map(([c]) => c.length)) + 3;
    for (const [c, d] of rows) console.log(`  ${c.padEnd(w)}${d ? `# ${d}` : ''}`);
  };
  // Interactive terminals go straight from the answers to the progress line
  // (the summary card ends with the cd path); non-interactive logs keep this.
  if (!promptRan) console.log(`\n✔ Scaffolded WordPress + agent sandbox in ${targetDir}\n`);

  if (!args.setup) {
    console.log('Next steps:');
    console.log(`  cd ${cd}`);
    printCmds([
      ['npm run setup', 'build, start & install WordPress + plugins (Docker must be running)'],
      ['npm run start', 'subsequent runs: just bring the containers up'],
      ...agentCmds,
    ]);
    console.log('');
    console.log(`Once setup finishes, your site is at ${termLink(`http://${args.publicHost}:${args.port}`)} — log in at /wp-admin with ${adminUser} / ${adminPass} (saved in .env as WP_ADMIN_USER / WP_ADMIN_PASSWORD).`);
    return;
  }

  // In a terminal, setup progress is ONE dim line updating in place with the
  // current step; elsewhere (CI, logs) the steps print as a plain list.
  await mkdir(join(STATE_DIR, 'logs'), { recursive: true }).catch(() => {});
  let progress = null;
  if (!args.verbose && process.stdout.isTTY) {
    try { progress = (await import('./ui.js')).progressLine(); } catch { /* plain list below */ }
  }
  if (progress) {
    progress.tick('starting containers (the first build takes a few minutes)');
  } else {
    console.log(`→ Running initial setup (Docker must be running)… Full log: ${setupLog}\n`);
  }
  const ok = await runSetup(targetDir, setupLog, {
    verbose: args.verbose,
    onStep: (line) => {
      if (progress) progress.tick(line.replace(/^[→✓]\s*/, '').replace(/…$/, ''));
      else if (!args.verbose) console.log(line);
    },
  });
  if (progress) progress.done();
  if (!ok) {
    console.error('\n✖ Initial setup did not finish (is Docker running?). Last lines of the log:\n');
    const logTail = await readFile(setupLog, 'utf8').then((s) => s.trimEnd().split('\n').slice(-15)).catch(() => []);
    for (const l of logTail) console.error(`    ${l}`);
    console.error(`\n  Full log: ${setupLog}`);
    console.error('  Your files are scaffolded — retry with:');
    console.error(`    cd ${cd} && npm run setup\n`);
    process.exit(1);
  }

  console.log(`\n${dim('─'.repeat(48))}`);

  // Interactive terminals land on the Katalyst hub — the project's OWN
  // scripts/katalyst.mjs (it prints the summary card, then the menu; its Exit
  // stops the site). Everything else gets the card + printed commands.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await new Promise((res) => {
      const child = spawn(process.execPath, ['scripts/katalyst.mjs'], { cwd: targetDir, stdio: 'inherit' });
      child.on('close', res);
      child.on('error', res);
    });
  } else {
    console.log('');
    console.log(`  ${dim('WordPress')}  ${termLink(`http://${args.publicHost}:${args.port}`)}`);
    console.log(`  ${dim('Admin')}      ${termLink(`http://${args.publicHost}:${args.port}/wp-admin`)}`);
    console.log(`  ${dim('Username')}   ${adminUser}`);
    console.log(`  ${dim('Password')}   ${adminPass}`);
    for (const p of appPorts) {
      console.log(`  ${dim('App')}        ${termLink(`http://${args.publicHost}:${p.host}`)} → workspace:${p.container}`);
    }
    console.log('');
    console.log(`  cd ${cd}`);
    printCmds([
      ['npm run katalyst', 'the Katalyst menu — site links, agents, shell'],
      ...agentCmds,
      ['npm run bash', 'sandbox shell · stop|start the stack: npm run stop|start'],
      ...(devScriptRel ? [['npm run dev:logs', 'follow the dev script']] : []),
      [`npx ${pkg} list`, 'all your environments'],
    ]);
    console.log('');
  }
}
