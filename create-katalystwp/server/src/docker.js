// Thin wrappers over `docker compose` / `npm` for a scaffolded environment.
//
// Everything runs IN the env's directory with the DEFAULT compose project name
// (the dir basename) — the same project the env's own `npm run …` scripts and
// `scripts/in-workspace.sh` use. No `-p` override, so the server and the
// project's scripts always agree. execFile with an argv array (no shell); the
// only user value (the env name) is charset-restricted. Secrets pass by name
// (`-e NAME`) with values injected into the child env — never on argv.

import { execFile } from 'node:child_process';
import { join } from 'node:path';

const DEFAULT_TIMEOUT = 15_000;

export function run(file, args, { cwd, env, timeout = DEFAULT_TIMEOUT, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd, env: env ? { ...process.env, ...env } : process.env, timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          err.message = `${file} ${args.join(' ')} failed: ${err.message}\n${stderr || ''}`.trim();
          return reject(err);
        }
        resolve({ stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

// `docker compose <rest>` in the env dir (default project = dir basename).
export function compose(env, rest, opts = {}) {
  return run('docker', ['compose', ...rest], { cwd: env.dir, ...opts });
}

// Run one of the env's own npm scripts (start/stop/down/…) — drives the project
// through its own scripts rather than a hand-built parallel.
export function npmRun(env, script, opts = {}) {
  return run('npm', ['run', script], { cwd: env.dir, ...opts });
}

// `docker compose ps --format json` → array of service status objects.
export async function ps(env) {
  try {
    const { stdout } = await compose(env, ['ps', '--format', 'json', '--all']);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// Run a command inside a service. `detach` → `-d`; envNames are forwarded by
// name only (values come from the spawned child's env).
export function exec(env, service, argv, { detach = false, envNames = [], envValues = {}, tty = false, timeout } = {}) {
  const flags = [];
  if (detach) flags.push('-d');
  if (!tty) flags.push('-T');
  for (const name of envNames) flags.push('-e', name);
  return compose(env, ['exec', ...flags, service, ...argv], { env: envValues, timeout });
}

// List compose projects known to the daemon (for name-collision checks).
export async function listProjects() {
  try {
    const { stdout } = await run('docker', ['compose', 'ls', '--all', '--format', 'json']);
    const arr = JSON.parse(stdout.trim() || '[]');
    return arr.map((p) => p.Name);
  } catch {
    return [];
  }
}

export { join };
