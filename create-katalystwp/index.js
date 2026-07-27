#!/usr/bin/env node
/**
 * create-katalystwp
 *
 * Scaffolds a local WordPress + AI-agent dev environment (Docker Compose) into
 * a target directory, then runs `npm run setup` (docker compose up + WordPress
 * and plugin install). Pass --scaffold-only to write files and skip Docker.
 *
 * Usage:
 *   npm create katalystwp -- [dir] [--port=8080] [--agents=claude,cursor|all|none] [--plugins=a,b] [--yes] [--setup-script=PATH] [--dev-script=PATH] [--defines=PATH] [--activate=a,b,c] [--scaffold-only]
 *   npx create-katalystwp [dir] [...same flags]
 *
 * In an interactive terminal, choices not covered by flags are asked as
 * questions (port / agents / plugins); otherwise defaults apply.
 *
 * The scaffolding logic lives in engine.js, which is also exported for
 * downstream `create-<brand>` packages — see the README.
 */

import { create } from './engine.js';

// Explicit exit: the interactive prompts (@clack/core) and the press-Enter
// finish step touch process.stdin, which can otherwise keep the event loop
// alive after all work is done.
create().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
