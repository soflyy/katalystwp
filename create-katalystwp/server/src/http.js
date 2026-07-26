// Bare node:http server with a tiny regex router, JSON body parsing (size
// limited), uniform error envelope, and optional bearer auth. No framework —
// this component controls Docker, so we keep its dependency surface at zero.
//
// Route kinds:
//   'json'   (default) — body parsed, ctx.send writes JSON, bearer required.
//   'sse'    — long-lived stream; handler owns ctx.res; auth accepts bearer OR
//              ?access_token= (EventSource can't set headers).
//   'static' — serves the UI; handler owns ctx.res; the SHELL is unauthenticated
//              (it holds no secrets and prompts for the token client-side).

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from './log.js';

const MAX_BODY = 1 << 20; // 1 MiB

export function createServer(config, routes) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) return send(res, 404, { error: 'not found' });

      const kind = match.kind || 'json';
      // Auth: static shell is open; sse accepts header OR ?access_token=; rest bearer.
      if (config.apiToken && kind !== 'static') {
        const ok = kind === 'sse'
          ? tokenOk(bearer(req) || url.searchParams.get('access_token'), config.apiToken)
          : tokenOk(bearer(req), config.apiToken);
        if (!ok) return send(res, 401, { error: 'unauthorized' });
      }

      const params = url.pathname.match(match.re).groups || {};
      const ctx = {
        params,
        query: url.searchParams,
        req,
        res,
        body: kind === 'json' ? await readJson(req) : {},
        send: (code, data) => send(res, code, data),
      };
      await match.handler(ctx); // sse/static handlers own res and never call send()
    } catch (err) {
      if (res.headersSent) return; // streaming response already started
      if (err.status) return send(res, err.status, { error: err.message });
      log.error('request error:', err);
      send(res, 500, { error: 'internal error', detail: String(err.message || err) });
    }
  });
  return server;
}

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function tokenOk(presented, token) {
  const a = Buffer.from(presented || '');
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'DELETE') return resolve({});
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, data) {
  const payload = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(payload);
}

// Build a route table entry. `path` uses :param segments → named groups. Supports
// a trailing :rest* segment (matches the remainder, incl. slashes) for static.
export function route(method, path, handler, { kind = 'json' } = {}) {
  const pattern = path
    .replace(/:([a-zA-Z]+)\*/g, (_, n) => `(?<${n}>.*)`)
    .replace(/:([a-zA-Z]+)/g, (_, n) => `(?<${n}>[^/]+)`);
  const re = new RegExp('^' + pattern + '/?$');
  return { method, path, re, handler, kind };
}
