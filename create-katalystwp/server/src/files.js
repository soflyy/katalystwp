// Files in an environment's workspace, addressed by their in-container path
// (/home/node/… or relative to /home/node; the workspace dir is bind-mounted
// there): previews and downloads for the UI, and uploads a message can attach.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, stat, chown, rm, open, readdir } from 'node:fs/promises';
import { join, extname, basename, isAbsolute, relative, resolve } from 'node:path';
import { httpErr } from './ops.js';

const HOME = '/home/node';
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// SVG is previewed as text on purpose: served as an image and opened directly
// it would run script on the UI's origin.
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

const workspaceOf = (env) => join(env.dir, 'workspace');

// Map an in-container path onto the host workspace, refusing anything that
// resolves (symlinks included) outside it. A relative path that isn't under
// /home/node is looked up as relative to the folder an agent was working in.
async function resolveInWorkspace(env, path) {
  const rel = isAbsolute(path) ? relative(HOME, path) : path;
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw httpErr(400, 'path must be inside /home/node');
  const root = await realpath(workspaceOf(env));
  let real;
  try { real = await realpath(resolve(root, rel)); } catch {
    real = isAbsolute(path) ? null : await findBySuffix(root, rel);
    if (!real) throw httpErr(404, 'file not found');
  }
  if (real !== root && !real.startsWith(root + '/')) throw httpErr(400, 'path must be inside /home/node');
  return real;
}

// Agents name files relative to the repo they cd'd into (admin/src/pages/
// Connect.jsx), so find the workspace folder that holds `rel`: the shallowest
// one, and only if it's the only one at that depth. Skips dependency folders,
// doesn't follow symlinks, and gives up after a few thousand folders.
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);
async function findBySuffix(root, rel) {
  let level = [root];
  let seen = 0;
  for (let depth = 0; depth <= 6 && level.length && seen < 5000; depth++) {
    const found = [];
    const next = [];
    for (const dir of level) {
      seen++;
      try { if ((await stat(join(dir, rel))).isFile()) found.push(join(dir, rel)); } catch {}
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) next.push(join(dir, e.name));
    }
    if (found.length === 1) return realpath(found[0]);
    if (found.length > 1) throw httpErr(404, `file not found: ${found.length} files end with ${rel}`);
    level = next;
  }
  return null;
}

// A file counts as text when its first 8 KB has no NUL byte.
async function looksLikeText(real) {
  const fh = await open(real, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0);
    return !buffer.subarray(0, bytesRead).includes(0);
  } finally { await fh.close(); }
}

// GET /environments/:id/files?path=…[&download=1]. Preview (default) serves
// images as themselves and text files as sandboxed text/plain; download serves
// any file as an attachment.
export async function serveFile(ctx, env) {
  const path = ctx.query.get('path') || '';
  const real = await resolveInWorkspace(env, path);
  const st = await stat(real);
  if (!st.isFile()) throw httpErr(404, 'file not found');
  const headers = { 'cache-control': 'private, max-age=60', 'x-content-type-options': 'nosniff', 'content-length': st.size };
  if (ctx.query.get('download')) {
    headers['content-type'] = 'application/octet-stream';
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(real))}`;
  } else if (IMAGE_TYPES[extname(real).toLowerCase()]) {
    if (st.size > MAX_BYTES) throw httpErr(413, 'image too large to preview');
    headers['content-type'] = IMAGE_TYPES[extname(real).toLowerCase()];
  } else {
    if (!(await looksLikeText(real))) throw httpErr(415, 'binary file; download it instead');
    if (st.size > MAX_TEXT_BYTES) throw httpErr(413, 'file too large to preview; download it instead');
    headers['content-type'] = 'text/plain; charset=utf-8';
    headers['content-security-policy'] = 'sandbox';
  }
  ctx.res.writeHead(200, headers);
  createReadStream(real).pipe(ctx.res);
}

// POST /environments/:id/uploads?name=… with the raw file as the body. Saved to
// workspace/uploads/<date>/<id>-<name>, owned like the workspace so the agent
// can read it. Returns the in-container path.
export async function upload(ctx, env) {
  const original = String(ctx.query.get('name') || 'file').split(/[\\/]/).pop();
  const safe = original.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-100) || 'file';
  const day = new Date().toISOString().slice(0, 10);
  const root = workspaceOf(env);
  const dir = join(root, 'uploads', day);
  const name = `${Date.now().toString(36)}-${safe}`;
  const file = join(dir, name);
  const { uid, gid } = await stat(root);
  await mkdir(dir, { recursive: true });
  await chown(join(root, 'uploads'), uid, gid);
  await chown(dir, uid, gid);

  const size = await new Promise((done, fail) => {
    let bytes = 0;
    const out = createWriteStream(file);
    ctx.req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { ctx.req.unpipe(out); out.destroy(); fail(httpErr(413, 'file larger than 25 MB')); }
    });
    ctx.req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => done(bytes));
    ctx.req.pipe(out);
  }).catch(async (err) => { await rm(file, { force: true }); throw err; });

  await chown(file, uid, gid);
  ctx.send(201, { path: `${HOME}/uploads/${day}/${name}`, name: original, size, type: ctx.req.headers['content-type'] || '' });
}
