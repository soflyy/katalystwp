# katalystwp monorepo

`create-katalystwp/` is the published scaffolder (`npm create katalystwp`);
its `server/` subdir is the unpublished devbox control server. Generated
projects are fully self-contained (zero npm deps — bash + docker + the
dependency-free `scripts/katalyst.mjs` menu) and are FROZEN at scaffold time:
nothing in a generated project auto-updates when this package updates.

## Known code duplication (intentional, revisit when touching any copy)

The shipped per-site menu (`create-katalystwp/templates/scripts/katalyst.mjs`)
must be dependency-free, so it duplicates helpers that also exist in the
package (which can use @clack/core):

- **Brand styling** — `pink` / `dim` / OSC-8 `link` exist in `engine.js`
  (exported), `ui.js` (imports engine's), and `katalyst.mjs` (own copy).
- **Arrow-key select** — two implementations: `ui.js` `choose()` (@clack/core
  render) and `katalyst.mjs` `choose()` (hand-rolled readline raw-mode, plus
  number-key shortcuts).
- **Port checks / npm spawn / openBrowser** — small copies in `engine.js` and
  `katalyst.mjs`.
- **`ADMIN_LOGIN_PHP` one-click wp-admin mint** — THREE copies: `engine.js`,
  `templates/scripts/katalyst.mjs`, `server/src/routes.js`. All hardcode the
  Agent Connector FQCN `AgentConnectorForWp\DefaultAbilities\Services\AdminLoginLink`
  (an external repo, github.com/soflyy/agent-connector-for-wp). If that class
  moves, all three break silently — update together.

Why not share a module: generated projects must work offline with no
node_modules, and the server is deliberately dependency-free. If an updater
command lands (see `docs/katalyst-manager-plan.md` for the manager plan),
refreshing `scripts/katalyst.mjs` in existing projects becomes its job.

## Gotchas

- Commit messages / PR bodies that mention commands: NEVER inline with
  `-m "…"` — backticks execute under zsh. Write to a file, `git commit -F`.
- Raw ESC/BEL bytes keep sneaking into edited JS via ANSI strings — normalize
  to backslash-u001b / backslash-u0007 string escapes (files look "binary" to grep otherwise).
- The compose project name comes from the top-level `name:` in the generated
  `docker-compose.yml`; the server's allocator collision check and
  health.js container matching know about the `katalyst-` prefix.
- Testing interactive prompts with expect(1): clack's diff renderer emits
  char-split frames — pattern-match only on first renders and plain
  console.log lines; drive prompts by timing; `katalyst.mjs`'s own menu
  renders whole frames and supports number-key selection (easier to drive).
