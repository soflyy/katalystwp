---
name: cursor-wp-mcp-helper
description: Call the worker's configured WordPress MCP endpoint through the cursor-wp-mcp-helper CLI. Use when working with the sandbox WordPress site, the WordPress MCP server, or Agent Connector for WP — especially when native MCP tools are not exposed in the chat but /home/node/.cursor/mcp.json exists.
---

# WordPress MCP Helper (`cursor-wp-mcp-helper`)

`cursor-wp-mcp-helper` calls the WordPress MCP server configured for this worker. It's on the `PATH` (run it bare as `cursor-wp-mcp-helper`, or by full path `/home/node/bin/cursor-wp-mcp-helper`).

It reads `/home/node/.cursor/mcp.json`, pulls the `wordpress` server's `WP_API_URL` / `WP_API_USERNAME` / `WP_API_PASSWORD`, initializes the MCP HTTP session (capturing `Mcp-Session-Id`), and calls the WordPress MCP adapter tools. No credentials are hardcoded — they come from `mcp.json`, which `npm run setup` generates per worker.

## Quick checks

```bash
cursor-wp-mcp-helper endpoint     # show the resolved URL + auth mode
cursor-wp-mcp-helper tools        # list MCP tools
cursor-wp-mcp-helper discover     # list Agent Connector abilities
```

## Common WordPress calls

Run PHP inside the loaded WordPress runtime (plugins + hooks active):

```bash
cursor-wp-mcp-helper php-eval 'return get_bloginfo("name");'
```

Inspect files and environment through MCP:

```bash
cursor-wp-mcp-helper call agent-connector-for-wp/file-list '{"path":"wp-content/plugins"}'
cursor-wp-mcp-helper call agent-connector-for-wp/env-inspect '{}'
```

Get the schema/details for an ability:

```bash
cursor-wp-mcp-helper info agent-connector-for-wp/php-eval
```

Drop to a raw JSON-RPC method if you need something the subcommands don't cover:

```bash
cursor-wp-mcp-helper raw tools/list '{}'
```

Add `--json` for compact output, or `--config <path>` / `--server <name>` to point at a different MCP config or server.

## When to use this

- Use it when WordPress MCP tools are needed but the native MCP tools are **not exposed in chat** (and `/home/node/.cursor/mcp.json` exists).
- Prefer direct `wp --path=/home/node/wp ...` for WP-CLI tasks. The sandbox's WordPress web container may not ship the `wp` binary, so the MCP `wp-cli` ability can fail — the workspace's own WP-CLI is the reliable path.
- Prefer `cursor-wp-mcp-helper php-eval ...` when code must run **inside the live WordPress runtime** with plugins and hooks loaded (something the workspace's WP-CLI can't do).
