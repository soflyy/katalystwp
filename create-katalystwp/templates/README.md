# __PROJECT_NAME__

Local WordPress + AI-agent development sandbox, running on Docker.

Four services:

- **db** — MariaDB
- **wordpress** — WordPress on `http://localhost:__WP_PORT__`
- **workspace** — an isolated dev container (Node + PHP + WP-CLI + Composer + the AI coding agents chosen at scaffold time — see `agents` in `sandbox.config.json`) that mounts the same WordPress files and reaches the site/DB over the Docker network
- **playwright** — a [Playwright MCP](https://github.com/microsoft/playwright-mcp) server (headless Chromium) that the agents drive to browse the site

All data lives in bind-mounted folders in this directory (`db/` and `workspace/` — the latter holds WordPress at `workspace/wp` plus your checkouts), so it survives restarts and is browsable on your machine. They're git-ignored.

## Requirements

- Docker (with Compose v2)
- Node.js (only to run the npm scripts below)

## Usage

Everything goes through the Katalyst menu:

```bash
npm run katalyst
```

It starts the site if it's stopped, shows your links and login, and offers: **Open WP Admin** (one-click, already logged in), **Open the site**, launching an installed AI agent, a **sandbox shell**, and **Exit** — which stops the site so nothing keeps idling in the background. Only one menu runs per site (a second `npm run katalyst` tells you where the first one lives, via `.katalyst.lock`).

The site itself is at **http://localhost:__WP_PORT__**; wp-admin credentials live in `.env`:

- **Username:** `WP_ADMIN_USER` (default `admin`)
- **Password:** `WP_ADMIN_PASSWORD` (generated per site at scaffold time)

WordPress and the plugins in [`sandbox.config.json`](#plugins-sandboxconfigjson) were installed when this project was created. The provisioning is idempotent — if you edit `sandbox.config.json`, re-run `npm run setup` to apply it (already-done steps are skipped; it does **not** reinstall WordPress).

| Script | What it does |
| --- | --- |
| `npm run setup` | Re-run provisioning (idempotent): start the stack, apply `sandbox.config.json`, install missing plugins |
| `npm run start` | Bring the containers up without the menu (`docker compose up -d --build`) |
| `npm run stop` | Stop containers (keep data) |
| `npm run down` | Stop + remove containers (data preserved in `db/`, `workspace/`) |
| `npm run restart` | Restart containers |
| `npm run logs` | Tail logs from all services |
| `npm run ps` | Show container status |
| `npm run katalyst` | The Katalyst menu: starts the site if stopped, site links, one-click wp-admin login, launch an agent, sandbox shell. Exit stops the site |
| `npm run bash` | Shell into the workspace container (lands in the workspace root `/home/node`, with WordPress at `wp/`) |
# >>> agent:claude
| `npm run claude` | Launch Claude Code in the workspace |
# <<< agent:claude
# >>> agent:cursor
| `npm run cursor` | Launch the Cursor CLI agent in the workspace (`--force --approve-mcps`, safe because it's contained) |
# <<< agent:cursor
# >>> agent:codex
| `npm run codex` | Launch OpenAI Codex in the workspace |
# <<< agent:codex
# >>> agent:opencode
| `npm run opencode` | Launch OpenCode in the workspace |
# <<< agent:opencode
| `npm run wp` | Run WP-CLI, e.g. `npm run wp -- plugin list` |
| `npm run reset` | ⚠️ Wipe all data and rebuild from scratch |

## Updating Katalyst's files

The menu checks once a day for a newer Katalyst and shows an **Update Katalyst** item when one exists. You can also run it manually from this directory:

```bash
npx create-katalystwp@latest update
```

It explains what it will replace, recommends a backup, and asks for confirmation. It refreshes only Katalyst's own tooling (`scripts/`, the menu, Dockerfiles, compose file, this README) — never your WordPress site, database, `.env`, `sandbox.config.json` settings, `php/php.ini`, or `scripts/user-setup.sh` / `scripts/dev.sh`; npm scripts you added are preserved.

## Plugins (`sandbox.config.json`)

Your own plugins to install during `npm run setup` are declared in `sandbox.config.json`. It ships empty (the MCP/agent plugins are installed separately — see [MCP](#notes) below) — add your own:

```json
{
  "plugins": [
    "woocommerce",
    { "source": "https://example.com/your-plugin.zip", "activate": true }
  ]
}
```

- **`source`** — a [wordpress.org](https://wordpress.org/plugins/) slug (e.g. `"ai"`) or a URL/path to a plugin `.zip`.
- **`activate`** — activate after install (default `true`).
- **`version`** — optional, wordpress.org slugs only (e.g. `"5.3"`).

A bare string is shorthand for `{ "source": "<string>", "activate": true }`. After editing, re-run `npm run setup` (it's idempotent — already-installed plugins are skipped), or apply just the plugin step with `bash scripts/install-plugins.sh`.

## Notes

- **Working on a plugin/theme?** Installed ones live at `workspace/wp/wp-content/plugins/…` (or `themes/…`) on your machine — `wp/wp-content/…` from inside the workspace container. Edit them either place — same files, served live.
- **Developing a plugin/theme from its own repo?** You land in the workspace root (`/home/node`) with WordPress nested at `wp/`, so check it out as a sibling of `wp` and symlink it into place — keeping your repo out of the WordPress tree:
  ```bash
  npm run bash                                  # land in the workspace root
  git clone <your-plugin-repo> my-plugin        # checked out next to wp/, not inside it
  composer install -d my-plugin                 # Composer is available globally
  ln -s /home/node/my-plugin wp/wp-content/plugins/my-plugin
  wp plugin activate my-plugin
  ```
  The workspace root is mounted into the wordpress container at the same path, so Apache follows the symlink and serves the plugin live.
# >>> agent:claude
- **Claude login (auto):** `npm run claude` resolves your Claude token and logs you in automatically — no `/login`, landing straight at the prompt. It looks for the token in this order: `$CLAUDE_CODE_OAUTH_TOKEN` in your shell, then `$CLAUDE_SANDBOX_TOKEN_FILE`, then `~/.agent-sandbox/oauth-token` (the same file the standalone [agent-sandbox](https://github.com/louisreingold/agent-sandbox) uses — mint one on your host with `claude setup-token`). The token is forwarded by name (`docker compose exec -e CLAUDE_CODE_OAUTH_TOKEN`), so its value never lands on the command line, and the workspace's entrypoint pre-clears Claude's three first-run gates (login-method picker, `--dangerously-skip-permissions` warning, "trust this folder?" dialog) so an authenticated session isn't stopped by any onboarding screen. No token anywhere? Claude just starts and you `/login` once; that login persists in `workspace/` across rebuilds.
# <<< agent:claude
# >>> agent:cursor
- **Cursor login (auto):** `npm run cursor` resolves your Cursor API key the same way: `$CURSOR_API_KEY` in your shell, then `$CURSOR_API_KEY_FILE`, then `~/.agent-sandbox/cursor-api-key` (one line — generate a key in the Cursor dashboard under **Settings → API Keys**). It's forwarded by name (`docker compose exec -e CURSOR_API_KEY`), so the value never lands on the command line, and Cursor launches with `--force --approve-mcps` so it auto-approves commands and the sandbox's MCP servers — safe because the container is a throwaway sandbox. No key anywhere? Cursor starts unauthenticated and you can `cursor-agent login` once; that login persists in `workspace/` across rebuilds.
# <<< agent:cursor
- **WordPress MCP helper:** the workspace ships a small CLI, `cursor-wp-mcp-helper` (also at `/home/node/bin/cursor-wp-mcp-helper`), that calls the site's WordPress MCP server over HTTP — handy for an agent whose chat doesn't surface the native MCP tools. It reads the endpoint + credentials from `~/.cursor/mcp.json` (no baked secrets), e.g. `cursor-wp-mcp-helper discover`, `cursor-wp-mcp-helper php-eval 'return get_bloginfo("name");'`. The bundled `cursor-wp-mcp-helper` skill documents it for agents.
- **WP-CLI** talks to the database automatically over the Docker network.
- **MCP:** `npm run setup` connects every installed agent to two MCP servers automatically (Claude at user scope — `claude mcp list` shows them; Cursor via `~/.cursor/mcp.json`; Codex via `~/.codex/config.toml`; OpenCode via `~/.config/opencode/opencode.json`; re-add or tweak with `bash scripts/connect-mcp.sh`):
  - **wordpress** — the site's MCP server, provided by [Agent Connector for WP](https://github.com/soflyy/agent-connector-for-wp) (which bundles [`mcp-adapter`](https://github.com/WordPress/mcp-adapter) and registers its abilities through WordPress core's Abilities API, in core as of WordPress 7.0). Setup installs and enables it, then registers it with the installed agents through [Automattic's `mcp-wordpress-remote`](https://www.npmjs.com/package/@automattic/mcp-wordpress-remote) — a small stdio proxy run via `npx` that connects to the site's MCP endpoint (`http://wordpress/wp-json/mcp/mcp-adapter-default-server`) and authenticates with a WordPress Application Password setup mints for `admin`. It exposes root-equivalent abilities (shell, WP-CLI, PHP eval, filesystem) — but the workspace already has WP-CLI and direct filesystem access to `wp/`, so the agents prefer those and only reach for this when they need code to run inside the **live WordPress runtime** (e.g. PHP eval with plugins and hooks loaded). Fine to expose because this is a trusted, throwaway dev sandbox.
  - **playwright** — the [Playwright MCP](https://github.com/microsoft/playwright-mcp) server (a separate container with headless Chromium), over HTTP. The agents use it to navigate, click, and screenshot the site. **From the browser, the site is `http://wordpress`** (the Docker-network address), not `localhost:__WP_PORT__` — the site URL is derived from the request host so both work without redirects.
