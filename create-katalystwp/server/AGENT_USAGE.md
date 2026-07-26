# Devbox Server — how to create and manage WordPress environments

You are talking to a **devbox control server** over plain HTTP (JSON). It manages
many self-contained **WordPress dev environments** on one Docker host, and can
**drive Claude Code headlessly** inside each one. Creating one gives you:

- a live **WordPress site** (URL returned to you),
- a workspace container with WP-CLI, Node, `git`, `gh`, and Claude Code,
- the ability to run **headless Claude sessions** in that env and stream them.

An environment is provisioned by the **presets** chosen when it's created
(composable — pick several). A preset can run a setup script (e.g. clone a plugin
repo as a live git checkout, `composer install` it, symlink it into
`wp-content/plugins`, activate it), run a long-running dev/watch script, set
wp-config defines, and activate plugins in order. Built-ins include **Oxygen** /
**Breakdance** / **FutureLayer** (build from `soflyy/breakdance`) and **Agent
Connector (dev)** (check out `agent-connector-for-wp` for the agent to work on).

You do **not** need a special client — every action is an HTTP request you can
make with `curl` (or any HTTP library).

## Connection

Two values the operator gives you (fill these in):

- **Base URL** — e.g. `http://<host>:4000`
- **API token** — the value of `DEVBOX_API_TOKEN`. If the server has one set, you
  MUST send `Authorization: Bearer <token>` on **every** request (you'll get
  `401` otherwise). If the operator says there's no token, omit the header.

```bash
BASE="http://<host>:4000"      # e.g. http://127.0.0.1:4000
TOK="<DEVBOX_API_TOKEN>"        # ask the operator; omit the -H lines if none
```

## Quick start — create an environment and wait until it's ready

Creation is **asynchronous**: `POST /environments` returns immediately with
`202` and `status: "scaffolding"`. The server then builds + boots + provisions
the stack in the background (typically ~1–5 min depending on image cache and
preset). **Poll `GET /environments/<name>` until `status` is `running`.**

```bash
# 1. Create. Body fields are all optional:
#    name, presetIds (array), provision (custom setup), prompt (first Claude message), model
curl -s -H "Authorization: Bearer $TOK" -X POST "$BASE/environments" \
  -d '{"name":"my-devbox"}'
# → {"id":"env_…","name":"my-devbox","port":9000,"wpUrl":"http://localhost:9000","status":"scaffolding"}

# 2. Poll until running (or failed). Repeat every ~10s.
curl -s -H "Authorization: Bearer $TOK" "$BASE/environments/my-devbox"
# → {... "status":"running" ...}
```

If you pass `prompt`, a Claude session starts in the env automatically once it's
running. If you pass `presetIds`, fetch the available ones from `GET /presets`.

## Endpoints

| Method & path | What it does |
| --- | --- |
| `POST /environments` | Create. Body: `{name?, presetIds?, provision?, prompt?, model?}`. → `202` + `{id,name,port,wpUrl,status}`. |
| `GET /environments` | List all envs with live status. |
| `GET /environments/:id` | One env by **name or id**. |
| `GET /environments/:id/logs?which=setup&tail=N` | Setup log (`tail` defaults 200, max 5000). |
| `POST /environments/:id/admin-login` | Mint a **one-time, 5-min, passwordless** wp-admin login URL → `{loginUrl}`. |
| `POST /environments/:id/stop` | Stop the containers (data preserved). → `status:"stopped"`. |
| `POST /environments/:id/start` | Bring a stopped env back up. → `status:"running"`. |
| `DELETE /environments/:id` | Destroy: stop, remove containers, delete the dir; cascades to its sessions. |
| `POST /environments/:id/sessions` | `{prompt,model?}` → start a Claude session (env must be running). |
| `POST /sessions/:id/messages` | `{prompt}` → continue (`--resume`); `409` if a turn is active. |
| `GET /sessions` · `GET /sessions/:id` | list / one session. |
| `GET /sessions/:id/stream` | **SSE** live `stream-json` (auth: bearer or `?access_token=`). |
| `GET /sessions/:id/transcript?tail=N` | full event history. |
| `PATCH /sessions/:id` | `{title}` → rename. |
| `POST /sessions/:id/interrupt` · `DELETE /sessions/:id` | interrupt the turn / delete the session. |
| `GET /presets` · `POST/PUT/DELETE /presets[/:id]` | manage provisioning presets. |
| `GET /host` | system health: memory/CPU/disk, docker usage, per-env memory, RAM headroom. Check before mass-creating. |
| `POST /control/interrupt-all` · `/control/stop-all` · `/control/shutdown` | stop all turns / stop all envs / full teardown + exit. |
| `GET /health` | Liveness of the control server itself. |

## Status values

- `scaffolding` → `setting-up` → `configuring` → **`running`** — the create pipeline; wait it out.
- `running` — core containers (db, wordpress, workspace) are up.
- `degraded` — some but not all core containers are up.
- `stopped` — explicitly stopped; use `POST …/start` to resume.
- `failed` — setup errored; see `lastError` and `GET …/logs?which=setup`. Usually `DELETE` and recreate.

## Driving Claude in an environment

```bash
# start a session (env must be running) → 202 {id, claudeSessionId, status, ...}
curl -s -H "Authorization: Bearer $TOK" -X POST "$BASE/environments/my-devbox/sessions" \
  -d '{"prompt":"List the plugin files and summarize them."}'
# watch it live (SSE; token via query since EventSource can't set headers)
curl -N "$BASE/sessions/<id>/stream?access_token=$TOK"
# continue the same conversation (resumes; one turn at a time → 409 if busy)
curl -s -H "Authorization: Bearer $TOK" -X POST "$BASE/sessions/<id>/messages" -d '{"prompt":"now write tests"}'
```

The stream is newline-delimited `stream-json`: a `system`/`init` event (with
`session_id`), `stream_event` token deltas, `assistant`/`user` messages (incl.
`tool_use`/`tool_result`), and a terminal `result` (with `total_cost_usd`).

A `claude -p` turn runs **inside the workspace container**, so it survives a
control-server restart. The server reaps in-container turns on interrupt,
shutdown, and startup, so a resume never spawns a duplicate. There's also a web
UI at `/`.

## Rules and gotchas

- **Names** must match `^[a-z0-9][a-z0-9-]{1,38}$` and be **unique** (reuse → `409`). Omit `name` for an auto-generated one.
- **Create is async** — poll until `running`, don't treat the `202` as ready.
- **One WordPress port per env** is the only host port; returned as `wpUrl`. Inside the env's containers the site is `http://wordpress`.
- **wp-admin:** `POST /environments/:id/admin-login` returns a one-time passwordless login URL — no need to know the admin password.
- **Capacity:** each env is several containers and a few GB of RAM. Call `GET /host` before creating many (it estimates how many more fit); respect `503 at capacity`.
- **Credentials are the operator's, server-side** (managed on the Settings page) — you never send GitHub/Claude tokens.
- **Errors** are `{"error":"…"}` with a 4xx/5xx status: `401` bad/missing token, `404` unknown env, `409` name taken / turn in progress, `503` at capacity.

## Typical end-to-end flow

1. `POST /environments {"name":"feature-x","prompt":"…"}` → `202`.
2. Poll `GET /environments/feature-x` until `status:"running"`.
3. Drive it with Claude sessions (`POST …/sessions`, stream, `POST …/messages`), and open `wpUrl` (or mint an admin login) for the site.
4. When done: `POST …/stop` to pause (resume later) or `DELETE …` to remove it.
