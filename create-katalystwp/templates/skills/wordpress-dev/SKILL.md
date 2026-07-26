---
name: wordpress-dev
description: >-
  The sandbox's Docker containers (workspace, db, wordpress, playwright) and how
  to reach the WordPress site — http://wordpress from inside the network, not
  localhost. Load when working with this WordPress install or browsing it.
---

This WordPress install is split across Docker containers on a shared network:

- **workspace** — where you (Claude) run. You land in the workspace root
  (`/home/node`) with the WordPress files at `wp/` (shared with the `wordpress`
  container), plus WP-CLI, Node, Composer, and Claude Code. No web server runs
  here, but WP-CLI talks to the `db` container directly, so `wp …` works. This is
  your primary way to work: **run `wp …` directly in your shell** for any
  WordPress operation, and **edit the files under `wp/` directly** — you have
  full read/write access to the live install, served immediately by the
  `wordpress` container. Reach for these before any MCP ability.
- **db** — MariaDB database (reachable on the network as host `db`).
- **wordpress** — the Apache/PHP web server serving the site at `http://wordpress/`.
- **playwright** — a headless-Chromium Playwright MCP server; point its browser
  at `http://wordpress/`. **Use it to *see* rendered pages** — whenever a task
  involves how something looks (layout, styling, "pixel perfect", does-it-render),
  drive the browser with the `browser_navigate` / `browser_take_screenshot` MCP
  tools rather than guessing from source. Screenshots are written to
  `/home/node/.playwright-output/` — the **same path in your workspace** — so
  after `browser_take_screenshot` you can **`Read` the saved PNG** (the path the
  tool reports) and actually look at it. Tip: set a viewport with `browser_resize`
  first for a predictable capture.

**Reaching the site:** from inside any container (including the Playwright
browser) use `http://wordpress/`, e.g. `http://wordpress/wp-login.php`.
`http://localhost:__WP_PORT__` only works from the user's browser on the host —
it's a host port mapping, not reachable container-to-container. The wp-admin
login is `admin` / `password`.

## Agent Connector for WP

[Agent Connector for WP](https://github.com/soflyy/agent-connector-for-wp)
exposes root-equivalent abilities through the `wordpress` MCP server — shell,
WP-CLI, PHP eval, file read/write/delete/list, and environment inspection.

You rarely need it. Most of its abilities (shell, WP-CLI, file ops) you can
already do faster from your own shell and filesystem in the workspace — prefer
those. The one thing it offers that you can't do from the workspace is running
code **inside the live WordPress runtime**: `agent-connector-for-wp/php-eval`
executes PHP with WordPress fully loaded (plugins, hooks, the DB), as the web
server. Reach for it only when a task genuinely needs that — inspecting a hook's
behavior, calling a plugin's functions, reproducing a request-context bug.

Its abilities aren't top-level MCP tools — discover them with
`mcp-adapter-discover-abilities` and run one (by name, e.g.
`agent-connector-for-wp/php-eval`) via `mcp-adapter-execute-ability`.
