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
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

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

Arguments:
  dir                   Target directory. Asked interactively when omitted
                        (suggested: my-site); non-interactive runs default to
                        the current directory.

Options:
  --port=NNNN           Host port for WordPress (default: 8080)
  --agents=LIST         AI coding agents to install in the workspace, comma-
                        separated: ${Object.keys(AGENTS).join(', ')} — or
                        'all' / 'none'. Default: claude (Claude Code).
  --plugins=LIST        WordPress plugins to pre-install, comma-separated
                        wordpress.org slugs or .zip URLs.
  --yes, -y             Accept defaults; never prompt. (Prompts only appear in
                        an interactive terminal anyway — CI and scripts are
                        always non-interactive.)
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
// wpAdminEmail. Missing/invalid file → {} (falls back to admin / password).
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
// already made via flags. Enter accepts the default on every question.
async function promptForChoices({ dir, defaultDir, port, askPort, agents, plugins, defaultAgents }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const keys = Object.keys(AGENTS);
  // A closed stdin (Ctrl+D, or a script that stopped supplying answers) means
  // "accept the defaults for everything else", never a crash.
  let closed = false;
  const ask = async (q) => {
    if (closed) return '';
    try {
      return (await rl.question(q)).trim();
    } catch {
      closed = true;
      return '';
    }
  };
  try {
    if (dir == null) {
      // Re-ask on a non-empty directory so the user doesn't answer everything
      // else first and only then hit the "not empty" error.
      for (;;) {
        const a = await ask(`? Project directory [${defaultDir}]: `);
        const candidate = a || defaultDir;
        const existing = await readdir(resolve(candidate)).catch(() => []);
        const blocking = existing.filter((f) => !ALLOWED_EXISTING.has(f));
        if (!blocking.length || closed) { dir = candidate; break; }
        console.log(`  ✖ ${resolve(candidate)} is not empty — pick a new or empty directory.`);
      }
    }
    if (askPort) {
      const a = await ask(`? Host port for the WordPress site [${port}]: `);
      if (a) port = a;
    }
    if (agents == null) {
      console.log('? AI coding agents to install in the workspace:');
      keys.forEach((k, i) => console.log(`    ${i + 1}) ${AGENTS[k].label}`));
      console.log(`    ${keys.length + 1}) All of the above`);
      console.log('    0) None — plain workspace (Node, PHP, WP-CLI, MCP servers)');
      const def = defaultAgents.map((k) => keys.indexOf(k) + 1).join(',') || '0';
      for (;;) {
        const raw = await ask(`  Numbers, comma-separated [${def} — ${defaultAgents.map((k) => AGENTS[k].label).join(', ') || 'none'}]: `);
        if (!raw) { agents = [...defaultAgents]; break; }
        if (raw === '0' || /^none$/i.test(raw)) { agents = []; break; }
        if (raw === String(keys.length + 1) || /^all$/i.test(raw)) { agents = keys; break; }
        const picked = [];
        let ok = true;
        for (const tok of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
          const k = /^\d+$/.test(tok) ? keys[parseInt(tok, 10) - 1] : keys.find((x) => x === tok.toLowerCase());
          if (!k) { console.log(`  ✖ "${tok}" isn't a choice — enter numbers 0-${keys.length + 1} or agent names.`); ok = false; break; }
          if (!picked.includes(k)) picked.push(k);
        }
        if (ok) { agents = picked; break; }
      }
    }
    if (plugins == null) {
      const raw = await ask('? WordPress plugins to pre-install — wordpress.org slugs or .zip URLs, comma-separated [none]: ');
      plugins = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    }
  } finally {
    rl.close();
  }
  return { dir, port, agents, plugins };
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
  let port = String(args.port);

  const undecided = args.dir == null || agents == null || extraPlugins == null || !args.portExplicit;
  const canPrompt = !args.yes && process.stdin.isTTY && process.stdout.isTTY;
  if (undecided && canPrompt) {
    console.log(`\n${pkg} — press Enter to accept a default; --yes skips these questions.\n`);
    ({ dir: args.dir, port, agents, plugins: extraPlugins } = await promptForChoices({
      dir: args.dir, defaultDir: 'my-site', port, askPort: !args.portExplicit, agents, plugins: extraPlugins, defaultAgents,
    }));
  }
  agents ??= defaultAgents;
  extraPlugins ??= [];
  args.port = port;

  const targetDir = resolve(args.dir ?? '.');
  const projectName = basename(targetDir);

  console.log(`\n→ Config: directory ${projectName} · port ${port} · agents: ${agents.length ? agents.map((k) => AGENTS[k].label).join(', ') : 'none'} · extra plugins: ${extraPlugins.length ? extraPlugins.join(', ') : 'none'}`);
  if (undecided && !canPrompt) {
    console.log('  (defaults — run in an interactive terminal to be asked, or set the dir argument / --port= --agents= --plugins=)');
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

  // User-level defaults (set once in ~/.config/...); fall back to admin/password.
  const userConfig = await loadUserConfig();
  await copyTemplates(TEMPLATES, targetDir, {
    projectName,
    agents,
    agentNpmPkgs: agents.map((k) => AGENTS[k].pkg).filter(Boolean).map((p) => p + ' ').join(''),
    port: String(args.port),
    publicHost: args.publicHost,
    appPortsBlock: renderAppPortsBlock(appPorts),
    wpAdminUser: userConfig.wpAdminUser || 'admin',
    wpAdminPassword: userConfig.wpAdminPassword || 'password',
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

  const cd = args.dir ? args.dir : '.';
  // One aligned "npm run <agent>  # launch <label> in the workspace" line per
  // selected agent, reused in both the scaffold-only and post-setup messages.
  const agentRunLines = agents.map((k) => `${`  npm run ${k}`.padEnd(23)}# launch ${AGENTS[k].label} in the workspace`);
  console.log(`\n✔ Scaffolded WordPress + agent sandbox in ${targetDir}\n`);

  if (!args.setup) {
    console.log('Next steps:');
    console.log(`  cd ${cd}`);
    console.log('  npm run setup        # build, start & install WordPress + plugins (Docker must be running)');
    console.log('  npm run start        # subsequent runs: just bring the containers up');
    for (const l of agentRunLines) console.log(l);
    console.log('');
    console.log(`Once setup finishes, your site is at http://${args.publicHost}:${args.port} — log in at /wp-admin with admin / password (default; set WP_ADMIN_USER / WP_ADMIN_PASSWORD in .env to change).`);
    return;
  }

  console.log('→ Running initial setup (Docker must be running)…\n');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npm, ['run', 'setup'], { cwd: targetDir, stdio: 'inherit' });
  if (res.error || res.status !== 0) {
    console.error('\n✖ Initial setup did not finish (is Docker running?).');
    console.error('  Your files are scaffolded — retry once Docker is up:');
    console.error(`    cd ${cd} && npm run setup\n`);
    process.exit(res.status ?? 1);
  }

  console.log('\nEveryday commands:');
  console.log(`  cd ${cd}`);
  console.log('  npm run start        # bring the stack up next time (it stays up otherwise)');
  for (const l of agentRunLines) console.log(l);
  console.log('  npm run bash         # shell into the workspace container');
  if (devScriptRel) {
    console.log('  npm run dev:logs     # follow the dev script running in the dev container');
  }
  console.log('');
  console.log('───────────────────────────────────────────────');
  console.log('  Your WordPress site is ready:');
  console.log(`    Site:     http://${args.publicHost}:${args.port}`);
  console.log(`    Admin:    http://${args.publicHost}:${args.port}/wp-admin`);
  console.log('    Username: admin');
  console.log('    Password: password');
  for (const p of appPorts) {
    console.log(`    App:      http://${args.publicHost}:${p.host} → workspace:${p.container}`);
  }
  console.log('───────────────────────────────────────────────');
  console.log('');
}
