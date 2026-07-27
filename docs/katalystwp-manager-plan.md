# Plan: `katalystwp` — the environment manager package

Not built yet. This documents the agreed design so it can be picked up later.

## The naming split (why two packages)

`npm create katalystwp` means "make a new site" — npm's `create` semantics, and
it maps to the `create-katalystwp` package. It cannot also be the manager, so
management gets the plain package name we also want to reserve on npm:

- **`npm create katalystwp@latest`** → scaffold a new environment (exists today)
- **`npx katalystwp`** → manage all existing environments (this plan)

Reserve the `katalystwp` npm name under the soflyy org early, even if the first
publish is a stub.

## What it is

A small CLI, second package in this monorepo (`katalystwp/` next to
`create-katalystwp/`), that reads the shared registry every scaffold already
writes (`~/.katalystwp/environments.json`) and gives it an interactive,
arrow-key front end in the same minimal brand style (`create-katalystwp/ui.js`).

## Commands

- **`npx katalystwp`** (no args, TTY) — the dashboard:
  1. `ui.choose` over environments — `name  ·  :port  ·  up|stopped  ·  agents`
  2. then `ui.choose` over actions for the picked env:
     - **Open site** — browser to `http://<host>:<port>`
     - **Open wp-admin** — mint a one-time passwordless login link (the same
       `wp eval` → Agent Connector `AdminLoginLink::create()` used by the
       create finish step and the devbox server) and open it
     - **Launch <agent>** — one entry per agent in the env's registry record;
       spawn `npm run <agent>` in the env dir with stdio inherit
     - **Start / Stop** — `npm run start|stop` in the env dir (quiet, with the
       single-line progress treatment)
     - **Logs** — `npm run logs` (stdio inherit; Ctrl+C returns to the menu)
     - **Delete** — confirm, then `npm run down`, `rm -rf` the dir, and drop
       the registry entry
     - Back / Quit
  3. loop back to the env list after each action.
- **`npx katalystwp list`** — the non-interactive table (move the current
  `create-katalystwp list` implementation here; keep the old entry point as an
  alias for a while).
- **`npx katalystwp create [args…]`** — passthrough to `create-katalystwp`
  (spawn `npm create katalystwp@latest -- args`), so one command name can do
  everything.

## Implementation notes

- Depend on `create-katalystwp` and import the shared bits instead of
  duplicating them. Prereq exports from `create-katalystwp`:
  - `engine.js`: `loadState` (or a `listEnvironmentsData()` returning rows with
    live status), `portInUse`, `recordEnvironment`, a `forgetEnvironment(dir)`,
    the mint helper (`mintAdminLoginUrl`), `openBrowser`, and the existing
    `AGENTS`, `STATE_DIR`, `STATE_PATH`, `pink`, `dim`.
  - package exports map: add `"./ui": "./ui.js"` so the manager reuses the
    minimal prompt kit (already shipped in the npm `files` list).
- The registry file format is the contract between the two packages — document
  any field additions in both.
- Non-TTY behavior: `npx katalystwp` without a TTY prints the `list` table.
- CI: `.github/workflows/publish.yml` currently publishes only
  `create-katalystwp` on release. Either add a second workflow keyed to
  `katalystwp-v*` tags, or a matrix job that picks the package from the tag
  prefix. First publish of the new name is manual (`npm publish` from
  `katalystwp/`), then configure its Trusted Publisher like the first package.
- The devbox `server/` is unrelated to this: it manages many envs on a remote
  Docker host via HTTP; `katalystwp` manages the local ones recorded in
  `~/.katalystwp`.
