// Minimal static-file handler for the UI. GET only, confined to the UI root
// (no path traversal), content-type by extension. Buildless: serves the files
// in server/ui as-is.

import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export function makeStaticHandler(uiRoot) {
  return async function serveStatic(ctx) {
    const { res } = ctx;
    // ctx.params.rest is the path after /ui/ (or empty for /ui or /).
    let rel = (ctx.params.rest || '').replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const full = normalize(join(uiRoot, rel));
    try {
      const real = await realpath(full);
      const rootReal = await realpath(uiRoot);
      if (real !== rootReal && !real.startsWith(rootReal + '/')) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const st = await stat(real);
      if (!st.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[extname(real)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      createReadStream(real).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  };
}
