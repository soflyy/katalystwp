# devbox-server

A small HTTP control server (with a web UI) that manages many WordPress devbox environments — each a full [`create-katalystwp`](../README.md) stack — on a single Docker host, and **drives Claude Code headlessly inside each one** with live streaming to the browser.

It is dependency-free on the server side (bare Node `http`) because it controls Docker and launches agents — keep its supply-chain surface at zero. The UI is buildless (Preact + htm via CDN). It is **not** published to npm (the root package's `files` allowlist excludes `server/`).

The server is a **thin orchestrator over the scaffolded project's own scripts**: it creates envs the normal way and drives them through `npm run …` and `scripts/in-workspace.sh` (the same proven path `npm run claude` uses), all on the **default compose project** (the dir basename) so the server and the project's scripts always agree.

## How it works

- **Create**: runs the standard scaffolder once — `node ../index.js <dir> --port=N` — which scaffolds **and** `npm run setup` (build + boot + provision). Default compose project = the env name. Bounded by a build semaphore.
- **Git auth**: configures `gh` + git identity inside the workspace from the shared `GITHUB_TOKEN` (non-fatal).
- **Provisioning via presets**: an environment is provisioned by the **presets** chosen at create time (composable — pick several, applied in order). A preset carries a setup script, a long-running dev script, wp-config defines, an ordered plugin-activation list, and `appPorts` — container ports of dev servers the scripts run (e.g. `[3000]` for a Next.js app). Each app port gets a **unique host port per env** from `WP_PORT_RANGE` (same allocator as the WP port), published on the workspace container and linked on the env card; the setup script learns the mapping via `SANDBOX_APP_PORT_<container>` / `SANDBOX_PUBLIC_HOST` (see the root README). Built-ins include **Oxygen** (build Breakdance/Oxygen from source), **FutureLayer** (Breakdance + the app-dot-futurelayer Next.js app on an app port), and **Agent Connector (dev)** (replace the release-zip gateway with a live git checkout — clone → `composer install --no-dev` → symlink into `wp-content/plugins` → activate). Presets live in `data/presets.json`, managed in the UI / via `/presets`.
- **Setup secrets**: any `SANDBOX_SETUP_ENV_<NAME>` variable in the server's environment (e.g. set in `server/.env`) is forwarded to every env's setup script as plain `<NAME>` — the Codespaces-secret pattern. Store multiline values (a whole app `.env`) **base64-encoded** (env files are single-line): `SANDBOX_SETUP_ENV_MY_DOTENV_BASE64=$(base64 -w0 .env)`, then `printf '%s' "$MY_DOTENV_BASE64" | base64 -d > …` in the preset's setup script. Like the tokens, these never appear in request bodies or responses. They DO reach **every** env's setup script (scripts are arbitrary shell, creatable via `POST /presets`), so treat them as readable by anything holding the API token. The as-stored values are fed to the log redactor and scrubbed from server output and the per-env setup logs as a backstop — but a script that transforms a value before printing (e.g. `base64 -d`) defeats that, so the rule stands: setup scripts don't print secrets.
- **Warm pool**: provisioning a fresh env takes minutes (build + WP setup). To make creation instant, the server keeps a configurable number of **pre-built, then stopped** envs waiting per preset (set per preset in Settings, or via `PUT /pool/:presetId`). A create that matches a single warmed preset (no custom overrides) **claims** a ready env and just `start`s it (cached, seconds) instead of building; the pool refills in the background, bounded by the build semaphore and leaving `WARM_POOL_RESERVE` free slots for on-demand creates. Pushed new code and the pool is stale? `POST /pool/:presetId/rebuild` (or the Settings button) nukes and rebuilds it. Warm members are tagged in the registry and hidden from the env list.
- **Claude sessions**: each user message spawns `claude -p [--resume <id>] --output-format stream-json …` via the env's own `scripts/in-workspace.sh` (so auth = the proven token path; the server holds no Claude token). stdout is streamed to the browser over **SSE**; the session id + result + cost are persisted (`data/sessions.json`, raw events in `data/sessions/<id>.ndjson`). Resumable from the UI **and** by SSH (`bash scripts/in-workspace.sh claude --resume <id>`).
- **Turn lifecycle / reaping**: a `claude -p` turn runs *inside* the workspace container, so it survives a server restart. The server reaps in-container turns on **interrupt**, on **shutdown**, and on **startup** (any `claude -p` still running when the server boots is an orphan from a previous run) — so a resume never spawns a duplicate that races the orphan. A plain restart (Ctrl+C) reaps turns but leaves the env containers up, so sessions resume cleanly.
- **Control / shutdown**: `POST /control/interrupt-all` (stop all turns), `/control/stop-all` (stop every env's containers), `/control/shutdown` (stop everything + exit the process) — surfaced as buttons on the Health screen.
- **Credentials are server-side** (`GITHUB_TOKEN`/Claude token, managed on the Settings page) — never accepted in request bodies, returned, or logged.

## Configuration (env)

| Var | Default | Notes |
| --- | --- | --- |
| `DEVBOX_API_TOKEN` | — | the API password — required to bind a non-loopback address. Seeds nothing; set before start. |
| `GITHUB_TOKEN` | — | **seed only** — GitHub token for clone/commit/push. Managed on the Settings page (`data/settings.json`); this env var just seeds it on first run. |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | **seed only** — Claude token, likewise managed in Settings. Forwarded by `in-workspace.sh` exactly like `npm run claude` (or put it in `~/.agent-sandbox/oauth-token`). |
| `CLAUDE_DEFAULT_MODEL` | `opus` | default model for Claude sessions (`opus` → latest Opus 4.8); set any model id to override, per-session via the API |
| `SESSION_RING_BUFFER` | `500` | live events buffered per session for late SSE subscribers |
| `DEVBOX_PORT` | `4000` | API listen port |
| `DEVBOX_BIND` | `127.0.0.1` | bind address. `0.0.0.0` (or a specific IP) to reach it over the network — **requires `DEVBOX_API_TOKEN`** (the server refuses to start network-exposed without one) and a firewall/VPN |
| `DEVBOX_API_TOKEN` | — | if set, all routes require `Authorization: Bearer <token>` |
| `WP_PORT_RANGE` | `9000-9999` | host ports to allocate from (the env's WP port **and** its app ports) |
| `DEVBOX_PUBLIC_HOST` | `localhost` | hostname/IP browsers use to reach this Docker host (your server's public IP / DNS name) — used in every returned URL (`wpUrl`, admin-login `loginUrl`) and passed to the scaffolder as `--public-host` so setup scripts can build browser-valid URLs |
| `SANDBOX_SETUP_ENV_*` | — | setup secrets forwarded to every env's setup script with the prefix stripped (see above) |
| `MAX_ENVIRONMENTS` | `25` | hard cap on environments |
| `BUILD_CONCURRENCY` | `2` | simultaneous `docker build`/setup runs |
| `DEVBOX_ENVS_DIR` | `data/envs` | where stacks are scaffolded |
| `SCAFFOLDER_DIR` | repo root | path to the scaffolder (`index.js`) |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `devbox` / `devbox@localhost` | commit identity |
| `RECONCILE_INTERVAL_MS` | `45000` | status reconcile loop interval |
| `WARM_POOL_RESERVE` | `5` | free env slots the warm pool leaves for on-demand creates (it won't fill past `MAX_ENVIRONMENTS − reserve`) |
| `WARM_POOL_INTERVAL_MS` | `20000` | warm-pool top-up loop interval |

## Run

Put your tokens in `server/.env` (next to `package.json`). It's gitignored and
loaded automatically on `npm start` (via Node's built-in env-file support — no
dependency). Real environment variables already set take precedence, so
systemd/`export` setups keep working.

```bash
cd server
cp .env.example .env      # set DEVBOX_API_TOKEN (GitHub/Claude tokens can be set in the UI)
npm start
```

`.env` example:

```ini
DEVBOX_API_TOKEN=$(openssl rand -hex 32)   # paste a generated value
GITHUB_TOKEN=ghp_...                       # optional seed; or set it in Settings
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...      # optional seed; or set it in Settings
```

Or pass them inline / via your process manager instead of a file:

```bash
DEVBOX_API_TOKEN=secret GITHUB_TOKEN=… npm start
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/environments` | `{name?}` → 202 `{id,name,port,wpUrl,status}`; runs the async pipeline |
| `GET` | `/environments` | list with live status |
| `GET` | `/environments/:id` | one env (by id or name) |
| `GET` | `/environments/:id/logs?which=setup&tail=N` | setup log |
| `POST` | `/environments/:id/admin-login` | mint a one-time passwordless wp-admin login URL |
| `POST` | `/environments/:id/stop` | stop containers |
| `POST` | `/environments/:id/start` | bring containers back up + re-auth git |
| `DELETE` | `/environments/:id` | stop + remove the dir; cascades to its sessions |
| `POST` | `/environments/:id/sessions` | `{prompt,model?}` → 202; start a Claude session (env must be running) |
| `POST` | `/sessions/:id/messages` | `{prompt}` → 202; continue the session (`--resume`); 409 if a turn is active |
| `GET` | `/sessions` / `/sessions/:id` | list / one session (id, claudeSessionId, status, cost, `sshResumeHint`) |
| `GET` | `/sessions/:id/stream` | **SSE** live stream-json (auth: bearer or `?access_token=`) |
| `GET` | `/sessions/:id/transcript?tail=N` | full event history; `&partials=live\|none` drops token deltas, `&clip=N` truncates giant strings (screenshots, file blobs) |
| `POST` | `/sessions/:id/interrupt` | SIGINT the active turn |
| `DELETE` | `/sessions/:id` | forget the session |
| `GET` | `/host` | system health: memory/CPU/disk, docker df, per-env container memory, RAM-headroom estimate |
| `GET` / `PUT` | `/settings` | tokens + WP-admin defaults (secrets masked on read) |
| `GET` | `/pool` | warm-pool status per preset `{presetId,name,desired,ready,building,failed}` |
| `PUT` | `/pool/:presetId` | `{count}` → set how many pre-built envs to keep ready (0 = off) |
| `POST` | `/pool/:presetId/rebuild` | destroy that preset's warm envs (stale code) → the loop refills |
| `POST` | `/control/interrupt-all` | interrupt every running Claude turn (containers stay up) |
| `POST` | `/control/stop-all` | stop every env's containers (and interrupt their turns) |
| `POST` | `/control/shutdown` | full teardown: stop everything + exit the server process |
| `GET` | `/` , `/ui/*` | the web UI (static; shell unauthenticated, data APIs authed) |

```bash
H='-H Authorization:Bearer secret'
curl -s $H -XPOST localhost:4000/environments -d '{"name":"my-devbox"}'
curl -s $H -XPOST localhost:4000/environments/my-devbox/sessions -d '{"prompt":"summarize the README"}'
curl -N $H localhost:4000/sessions/<id>/stream         # live stream-json
curl -s $H -XPOST localhost:4000/sessions/<id>/messages -d '{"prompt":"now add a CHANGELOG entry"}'
```

## MCP

The same surface is exposed as an **MCP server** at `POST /mcp` (Streamable
HTTP transport, stateless, hand-rolled — still zero dependencies), so any MCP
client (Claude Code, Cursor, claude.ai, …) can drive the server with typed
tools instead of raw curl. From a machine that can reach the server:

```bash
claude mcp add --transport http katalyst http://<host>:4000/mcp \
  --header "Authorization: Bearer $DEVBOX_API_TOKEN"
```

(Use `https://` if the server sits behind TLS — see **HTTPS on a bare IP** below.)

Same bearer auth as the JSON API. ~30 tools mirroring everything above —
environments (create / wait / logs / start / stop / destroy / admin-login),
presets, warm pool, host health, and full agent-session driving
(`start_session` → `wait_for_turn` → `send_message`), plus `get_instructions`,
which returns a complete usage guide. The tool list, that guide, and the MCP
`initialize.instructions` field are all generated from the single tool table in
`src/mcp.js`, so docs can't drift from the callable surface. Both endpoints
share one ops layer (`src/ops.js`); deliberately **not** exposed over MCP:
settings writes (credential rotation) and `/control/shutdown`.

## HTTPS on a bare IP

Running network-exposed, the bearer token otherwise crosses the wire in
cleartext. You don't need a domain to fix that: Let's Encrypt issues
publicly-trusted certificates **for IP addresses** (GA since 2026-01, ~6-day
lifetime via the `shortlived` ACME profile), and Caddy ≥ 2.10 auto-obtains and
renews them. Bind the server to loopback (`DEVBOX_BIND=127.0.0.1`,
`DEVBOX_PORT=4001`) and put Caddy on the public port — see
[`deploy/Caddyfile.example`](deploy/Caddyfile.example). Ports 80/443 must stay
reachable for ACME validation. SSE session streams work through the proxy
unchanged.

This covers the control plane (API/MCP/UI/token). The per-env WordPress sites
on their own ports remain plain HTTP until they're proxied too (requires
compose port rebinding + WP siteurl scheme changes — tracked separately).

## Web UI

Open `http://<host>:<port>/` and enter the `DEVBOX_API_TOKEN`. List sessions across all devboxes, watch a session stream live (token-by-token, with tool calls), send messages, interrupt, start a new session (pick a devbox + model), and copy the SSH-resume command. Buildless (Preact + htm from a CDN) — to run fully offline, vendor those into `ui/vendor/`.

## Scale note

Each environment is ~4 containers (MariaDB, Apache/PHP, Node workspace, headless Chromium). Hundreds *running simultaneously* on one box is unrealistic — the registry can track 100s, but the running working-set is bounded by host RAM/CPU/disk. Use `MAX_ENVIRONMENTS`, the build semaphore, `GET /host`, and `stop` idle envs. Future optimization: build the (identical) workspace image once and reference it by tag instead of per-env `build:`.
