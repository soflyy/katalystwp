// Identity rewrite for a duplicated environment directory.
//
// A scaffolded project bakes its identity into a handful of files at scaffold
// time (see engine.js copyTemplates). After `cp -a`-ing a source env dir, these
// must be re-stamped so the copy is a self-consistent NEW project:
//
//   - docker-compose.yml — the top-level `name: katalyst-<name>` compose
//     project, plus the host side of any --app-ports mappings. CRITICAL: an
//     unchanged project name would make `docker compose` treat the copy as the
//     SOURCE project and clobber its containers.
//   - .env — WP_PORT (the one published host port). CRITICAL: same port would
//     collide with the source on boot.
//   - sandbox.config.json — appPorts[{host,container}], read by
//     run-setup-script.sh on setup re-runs.
//   - package.json / README.md / skills/…/SKILL.md — cosmetic name + port
//     mentions (but agents read them, so stale ports would mislead).
//
// Everything else (scripts, wp-config extras, the WP site itself) is
// host-agnostic by design: WP_HOME/WP_SITEURL derive from the request host, and
// the project's scripts read WP_PORT from .env at run time.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Apply `fn` to a file's text and write it back if changed. Critical files must
// exist (`required`); cosmetic ones are skipped when absent.
async function rewrite(path, fn, { required = false } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (!required && err.code === 'ENOENT') return;
    throw err;
  }
  const out = fn(text);
  if (out !== text) await writeFile(path, out);
}

// portMap: [{ container, oldHost, newHost }] for every published app port.
export async function rewriteCloneIdentity(dir, { oldName, newName, oldPort, newPort, portMap = [] }) {
  await rewrite(join(dir, 'docker-compose.yml'), (t) => {
    let out = t.replace(/^name: katalyst-.*$/m, `name: katalyst-${newName}`);
    if (!out.includes(`name: katalyst-${newName}`)) {
      throw new Error('docker-compose.yml: compose project name line not found — refusing to boot a copy that would clobber the source project');
    }
    for (const { container, oldHost, newHost } of portMap) {
      out = out.replaceAll(`"${oldHost}:${container}"`, `"${newHost}:${container}"`);
    }
    return out;
  }, { required: true });

  await rewrite(join(dir, '.env'), (t) => {
    const out = t.replace(/^WP_PORT=.*$/m, `WP_PORT=${newPort}`);
    if (!out.includes(`WP_PORT=${newPort}`)) {
      throw new Error('.env: WP_PORT line not found — refusing to boot a copy on the source\'s port');
    }
    return out;
  }, { required: true });

  // Recorded app ports (exported to setup scripts as SANDBOX_APP_PORT_<container>).
  if (portMap.length) {
    await rewrite(join(dir, 'sandbox.config.json'), (t) => {
      const cfg = JSON.parse(t);
      if (Array.isArray(cfg.appPorts)) {
        const newHostFor = new Map(portMap.map((m) => [m.container, m.newHost]));
        cfg.appPorts = cfg.appPorts.map((p) => (newHostFor.has(p.container) ? { ...p, host: newHostFor.get(p.container) } : p));
      }
      return JSON.stringify(cfg, null, 2) + '\n';
    });
  }

  // Cosmetic, best-effort. Name replacement is confined to exact-quoted /
  // heading positions — a short name like "test" replaced globally would
  // corrupt unrelated prose ("latest").
  await rewrite(join(dir, 'package.json'), (t) => t.replace(`"name": "${oldName}"`, `"name": "${newName}"`));
  await rewrite(join(dir, 'README.md'), (t) =>
    t.replace(/^# .*$/m, `# ${newName}`).replaceAll(`localhost:${oldPort}`, `localhost:${newPort}`));
  await rewrite(join(dir, 'skills', 'wordpress-dev', 'SKILL.md'), (t) =>
    t.replaceAll(`localhost:${oldPort}`, `localhost:${newPort}`));
}
