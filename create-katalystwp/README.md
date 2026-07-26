# create-katalystwp

Scaffold a local **WordPress + AI-agent** development environment (Docker Compose) — WordPress + MariaDB plus an isolated **workspace** container with Node, PHP, WP-CLI, and the AI coding agents **you choose**: [Claude Code](https://claude.com/claude-code) (the default), the [Cursor CLI](https://cursor.com/docs/cli), Codex, OpenCode — or none.

It scaffolds the project **and runs the initial setup** for you — `docker compose up`, then installs WordPress and the configured plugins — so you land on a working site. Pass `--scaffold-only` to just write files and skip Docker. The generated project ships npm scripts (`npm run start`, `npm run bash`, plus one per installed agent — `npm run claude`, …) for everyday use.

## Usage

```bash
# npm create form (the create- prefix enables this):
npm create katalystwp@latest
```

Run in a terminal, it asks a few questions (Enter accepts the default; anything you already gave as an argument or flag is never asked):

1. **Project directory** — suggested `my-site` (or pass it as the first argument)
2. **Host port** for the site — default `8080`
3. **AI coding agents** to install in the workspace — pick from Claude Code (default), Cursor CLI, Codex CLI, OpenCode, all, or **none**; only what you pick gets installed
4. **WordPress plugins** to pre-install — wordpress.org slugs or `.zip` URLs, default none

Non-interactively (CI, scripts, or `--yes`) it takes those defaults and prints them. Flags answer a question in advance — flagged choices are never asked:

```bash
# or directly with npx:
npx create-katalystwp my-site

# accept all defaults, no questions (port 8080, Claude Code, no extra plugins):
npx create-katalystwp my-site --yes

# choose everything up front:
npx create-katalystwp my-site --port=8090 --agents=claude,cursor --plugins=akismet

# no agents — plain WordPress + workspace (Node, PHP, WP-CLI, MCP servers):
npx create-katalystwp my-site --agents=none

# run a setup script in the workspace, add wp-config constants, and activate
# plugins (in order) it drops into wp-content — see "Customizing setup" below:
npx create-katalystwp my-site \
  --setup-script=./setup.sh \
  --defines=./defines.json \
  --activate=oxygen-elements,breakdance-elements,breakdance-main

# just write files, don't touch Docker:
npx create-katalystwp my-site --scaffold-only
```

> Through `npm create`, put the flags after `--`, e.g.
> `npm create katalystwp@latest my-site -- --port=8090`.

Docker must be running. When it finishes you have a live site at **http://localhost:8080** — log in at `/wp-admin` with `admin` / `password` (the default; configurable in `.env` via `WP_ADMIN_USER` / `WP_ADMIN_PASSWORD`). Then:

```bash
cd my-site
npm run start      # bring the stack up next time (it stays up otherwise)
npm run bash       # shell into the workspace container
npm run claude     # launch Claude Code in the workspace
npm run cursor     # launch the Cursor CLI agent in the workspace
```

**Claude auto-login (same as [agent-sandbox](https://github.com/louisreingold/agent-sandbox)):** mint a token once on your host with `claude setup-token` and save it to `~/.agent-sandbox/oauth-token` (or `export CLAUDE_CODE_OAUTH_TOKEN=<token>`). `npm run claude` resolves the token from either source and forwards it into the workspace by name (so the value never appears on the command line), and the workspace's entrypoint pre-clears Claude's three first-run gates (login picker, `--dangerously-skip-permissions` warning, trust-folder dialog) — so Claude lands **straight at the prompt**, logged in, no `/login`. No token found? Claude just starts and you `/login` once; it persists in `workspace/` across rebuilds.

**Cursor auto-login:** the same flow with a Cursor API key — generate one in the Cursor dashboard (**Settings → API Keys**) and save it to `~/.agent-sandbox/cursor-api-key` (or `export CURSOR_API_KEY=<key>`). `npm run cursor` resolves and forwards it by name, then launches with `--force --approve-mcps` so the agent runs commands and uses the sandbox's MCP servers without prompting. No key found? Cursor starts unauthenticated and you can `cursor-agent login` once; it persists in `workspace/`.

## What gets scaffolded

```
my-site/
├── docker-compose.yml      # db + wordpress + workspace + playwright services
├── docker-compose.override.yml  # only if a dev script was set — adds the long-running `dev` service
├── workspace.Dockerfile    # Node + Claude Code + Cursor CLI + PHP + WP-CLI (runs as non-root)
├── .env                    # DB creds + WP_PORT
├── .gitignore              # ignores the bind-mounted data dirs
├── package.json            # the npm-scripts UX (setup/start/stop/bash/claude/cursor/wp/reset)
├── sandbox.config.json     # plugins to install, wp-config defines, setup/dev scripts & activation order for `npm run setup`
├── php/php.ini             # custom PHP overrides for the wordpress container (upload limits, etc.)
├── scripts/                # provisioning steps run by initial-setup.sh (install-wp, defines, user setup script, plugins, agent-connector, mcp, skills) + in-workspace.sh (credential-resolving launcher for bash/claude/cursor)
├── bin/                    # cursor-wp-mcp-helper — Node CLI for the WordPress MCP server, baked onto the workspace PATH
├── skills/                 # agent skills installed into the workspace (wordpress-dev, cursor-wp-mcp-helper) — copied to both ~/.claude/skills and ~/.cursor/skills
└── README.md
```

WordPress data, the database, and the workspace home are bind-mounted into `wp/`, `db/`, and `workspace/` in the project, so everything is visible on your machine and survives restarts.

## Customizing setup

Beyond the bundled plugins, you can run a one-time setup script, add `wp-config.php` constants, activate plugins in a chosen order, and keep a long-running dev script (a watcher, say) alive alongside the stack. These are flags on the create command, persisted into the project's `sandbox.config.json` (and, for the dev service, a generated `docker-compose.override.yml`), so they re-apply on `npm run setup` / `npm run reset` — the project stays self-contained.

```bash
npx create-katalystwp my-site \
  --port=8090 \
  --setup-script=./setup.sh \
  --dev-script=./dev.sh \
  --defines=./defines.json \
  --activate=oxygen-elements,breakdance-elements,breakdance-main
```

On the first `npm run setup` the **one-time** steps run in order: install WordPress → apply `--defines` → run `--setup-script` → install bundled `plugins` and activate the `--activate` list. So a plugin your script drops into `wp-content` exists by the time it's activated. The `--dev-script` runs separately and continuously (see below).

- **`--setup-script=PATH`** — a shell script run **inside the workspace container as `node`** — the same environment `npm run bash` gives you, with the working directory at `/home/node` and WordPress at `/home/node/wp`. Use it to clone a repo and run its installer, build a plugin/theme, seed content, etc. It's piped in over stdin, so `gh repo clone <repo>` lands a checkout right next to `./wp`. `npm run setup` may run it again, so guard side effects (e.g. skip a clone when the directory already exists). To clone a **private** repo, authenticate `gh` once inside (`npm run bash` → `gh auth login`; it persists in `workspace/`), or export `GH_TOKEN` on your host before setup — it's forwarded into the container.

- **`--dev-script=PATH`** (or **`--dev-command="…"`** for a one-liner) — a shell script that runs in its **own long-running `dev` container** for as long as the stack is up — e.g. `cd /home/node/my-plugin && npm run watch`. It reuses the workspace image, so it runs as `node` with the same `/home/node` mount (a checkout your setup script cloned at `/home/node/<repo>` is visible to it). It's supervised: started by `npm run start`, stopped by `npm run stop`, and **restarted if it exits** — so a crashed watcher, or one whose target directory isn't there yet (setup still running), self-heals. Follow it with `npm run dev:logs`. Adding it generates a `docker-compose.override.yml` (auto-merged by Compose) and `scripts/dev.sh`.

- **`--defines=PATH`** — a JSON file of `{ "WP_CONST": value }` pairs written into `wp-config.php` as constants via `wp config set`, which places them correctly (above the "stop editing" marker) and updates them in place on re-run. Booleans and numbers become raw PHP literals (`define( 'WP_DEBUG', true )`); strings are quoted (`define( 'WP_MEMORY_LIMIT', '512M' )`). Use `{ "value": "...", "raw": true }` to force a raw (unquoted) value.

  ```json
  {
    "WP_DEBUG": true,
    "WP_MEMORY_LIMIT": "512M"
  }
  ```

  > **Why key:value rather than a raw `wp-config` snippet?** You don't have to worry about *where* in the file each `define()` lands or about duplicating one that already exists — `wp config set` handles placement and is idempotent.

- **`--agents=LIST`** — which AI coding agents to install in the workspace image: comma-separated from `claude`, `cursor`, `codex`, `opencode`, or `all` / `none`. Default: `claude`. Only the selected agents are installed, get an npm script (`npm run <agent>`), and are wired to the MCP servers — nothing else is baked in.

- **`--plugins=LIST`** — WordPress plugins to pre-install: comma-separated wordpress.org slugs or `.zip` URLs. Shorthand for adding entries to `plugins` in `sandbox.config.json` (see below), which offers per-plugin options.

- **`--yes` / `-y`** — accept every default without asking (prompts only appear in an interactive terminal anyway).

- **`--activate=a,b,c`** — plugin slugs to activate, in this exact order, **after** the setup script. This is for plugins that are already present (e.g. dropped into `wp-content` by your script) — there's nothing to download, just activate. For plugins installed from wordpress.org or a `.zip`, use `plugins` in `sandbox.config.json` (see below) instead.

- **`--app-ports=LIST`** — host ports to publish on the **workspace** container for dev servers your setup/dev scripts run — e.g. a Next.js app on 3000. A bare `3000` publishes `3000:3000`; `9101:3000` maps host 9101 to container 3000; comma-separate for several (one mapping per container port — a later entry for the same container port replaces the earlier one, so a CLI flag overrides a preset's). The `dev` container **shares the workspace's network namespace**, so one list covers a server started by the dev script *or* by an agent in the workspace — and other containers (WordPress PHP, the Playwright browser) reach it at `http://workspace:<port>` either way. The server must listen on `0.0.0.0` (most dev servers, incl. `next dev`, do by default) — one bound to `127.0.0.1` is invisible to the published port *and* to other containers. ⚠️ Published ports bind `0.0.0.0` and **bypass ufw-style host firewalls**; on an internet-facing host, restrict them upstream (cloud firewall/VPN).

- **`--public-host=HOST`** — the hostname/IP *browsers* use to reach this Docker host (default `localhost`; set your server's IP or a DNS name on a remote box). Written to `.env` as `PUBLIC_HOST`. Nothing binds to it — it exists so setup scripts can build URLs that are valid outside the Docker network.

### Environment passed to setup scripts

The setup script runs with these variables, so it can wire URLs without hardcoding ports:

- `SANDBOX_PUBLIC_HOST` — the `--public-host` value.
- `SANDBOX_WP_PORT` — the site's published host port (`--port`).
- `SANDBOX_APP_PORT_<container>` — the host port for each `--app-ports` entry (e.g. `--app-ports=9101:3000` → `SANDBOX_APP_PORT_3000=9101`).
- **`SANDBOX_SETUP_ENV_<NAME>` passthrough** — any variable with this prefix in the environment of `npm run setup` reaches the script as plain `<NAME>`, the same pattern as a GitHub Codespaces secret. Use it to hand secrets (API keys, a whole `.env` file) to provisioning without baking them into the script. Values are forwarded by name (never on a command line), but your script's own `echo`s can still leak them — don't print them. Multiline values can't survive an env file, so store those **base64-encoded** and decode in the script:

  ```bash
  # host:  export SANDBOX_SETUP_ENV_MY_APP_DOTENV_BASE64="$(base64 -w0 .env)"
  # setup script:
  printf '%s' "$MY_APP_DOTENV_BASE64" | base64 -d > /home/node/my-app/.env
  ```

A worked example (Breakdance) lives in [`examples/`](examples/).

### `sandbox.config.json`

The flags above just write into this file; you can also edit it directly and `npm run reset`:

```json
{
  "agents": ["claude"],
  "plugins": [
    "ai",
    { "source": "akismet", "activate": false, "version": "5.3" },
    { "source": "https://example.com/plugin.zip", "activate": true }
  ],
  "defines": { "WP_DEBUG": true, "WP_MEMORY_LIMIT": "512M" },
  "setupScript": "scripts/user-setup.sh",
  "devScript": "scripts/dev.sh",
  "activate": ["oxygen-elements", "breakdance-elements", "breakdance-main"]
}
```

- `agents` — a record of which AI agents this sandbox was scaffolded with (informational: the installs are baked into `workspace.Dockerfile` at scaffold time, so editing this list doesn't change the image).

- `plugins` — installed (and activated unless `"activate": false`) from a wordpress.org slug or a URL/path to a `.zip`. `version` is optional (slugs only).
- `defines` — `wp-config.php` constants (see `--defines` above).
- `setupScript` — project-relative path to the one-time script run in the workspace (`--setup-script` copies your file here as `scripts/user-setup.sh`).
- `devScript` — project-relative path to the long-running dev script (`--dev-script` / `--dev-command` writes it to `scripts/dev.sh` and adds the `dev` service via `docker-compose.override.yml`). Edit `scripts/dev.sh` and `npm run restart` to change what it runs.
- `activate` — slugs activated in order, after `setupScript` (see `--activate` above).
- `appPorts` — `[{ "host": 9101, "container": 3000 }]` pairs published on the workspace container (see `--app-ports` above). Recorded here so `SANDBOX_APP_PORT_<container>` is re-derived on every `npm run setup`; the actual publishing lives in `docker-compose.yml`, so editing this alone doesn't open a port.

## Requirements

- Node.js >= 18 (to run the CLI and the project's npm scripts)
- Docker with Compose v2 (to actually run the environment)

## User config (defaults for every sandbox)

Set defaults once and they apply to every project you scaffold (and every environment the devbox server creates) — at `~/.config/create-katalystwp/config.json` (or `$XDG_CONFIG_HOME/...`):

```json
{
  "wpAdminUser": "admin",
  "wpAdminPassword": "change-me",
  "wpAdminEmail": "you@example.com"
}
```

At scaffold time these seed the new project's `.env` (`WP_ADMIN_USER` / `WP_ADMIN_PASSWORD` / `WP_ADMIN_EMAIL`); with no config file they fall back to `admin` / `password`. To override for a single project, edit that project's `.env` and `npm run reset`. (Keep the password free of shell metacharacters, or quote it in `.env` — the setup scripts source `.env`.)

## Build your own `npm create` command

This package is also a library. If you ship a WordPress plugin (or a stack of them), you can publish your **own** `create-<brand>` command that scaffolds this same sandbox with your plugins pre-installed — no fork, you just depend on this package.

1. Create a package named `create-<brand>` and add this one as a dependency:

   ```bash
   mkdir create-oxygen-wp && cd create-oxygen-wp
   npm init -y
   npm install create-katalystwp
   ```

2. Point its `bin` at a one-file script that calls `create()` with a preset. A preset adds plugins — each entry is a wordpress.org slug, or `{ source, activate?, version? }` where `source` is a slug or a URL/path to a `.zip` (the same format the generated project's `sandbox.config.json` uses):

   ```js
   #!/usr/bin/env node
   import { create } from 'create-katalystwp';

   create({
     preset: {
       name: 'oxygen-wp', // so messages read `npm create oxygen-wp`
       plugins: [
         { source: 'https://example.com/oxygen.zip', activate: true },
       ],
     },
   });
   ```

   ```json
   {
     "name": "create-oxygen-wp",
     "type": "module",
     "bin": { "create-oxygen-wp": "index.js" },
     "dependencies": { "create-katalystwp": "^0.7.0" }
   }
   ```

3. Publish it. Now anyone can run:

   ```bash
   npm create oxygen-wp my-site
   ```

   They get the full sandbox (WordPress + Claude Code + Cursor CLI + the WordPress & Playwright MCP servers + Root for Agents) **plus your plugins**, installed and activated on the first `npm run setup`.

Your preset's plugins are **appended** to the defaults, so `mcp-adapter` and `root-for-agents` are always present. Everything else — templates, Docker setup, the `npm run …` UX — is inherited from this package, so improvements here flow to every `create-<brand>` that depends on it.

A preset can also carry the same customizations as the CLI flags above — they're merged into the generated `sandbox.config.json` (and combine with anything the end user passes):

```js
create({
  preset: {
    name: 'breakdance-wp',
    plugins: [{ source: 'https://example.com/breakdance.zip', activate: true }],
    agents: ['claude'], // default agent selection for your brand (user can still override)
    defines: { WP_DEBUG: true, WP_MEMORY_LIMIT: '512M' },
    activate: ['oxygen-elements', 'breakdance-elements', 'breakdance-main'],
    setupScript: 'set -euo pipefail\ncd /home/node\n# …clone/build/seed here…\n',
    devScript: 'cd /home/node/breakdance && npm run dev\n',
  },
});
```

`setupScript` / `devScript` here are the scripts' **contents** (strings), written into the project as `scripts/user-setup.sh` / `scripts/dev.sh`. A user's `--setup-script=PATH` / `--dev-script=PATH` overrides them.

> **Premium plugins:** a *public* `create-<brand>` can only bake in a `.zip` URL that's publicly reachable. For licensed plugins, point at a gated endpoint you control, or have your wrapper read the URL from a prompt or an env var instead of hardcoding it.

## Contributing

Working on the scaffolder itself, or cutting a release? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-2.0-or-later
