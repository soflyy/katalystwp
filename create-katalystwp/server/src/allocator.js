// Allocates a unique {id, name, project, port, dir} for a new environment and
// writes the reservation into the registry — all inside the registry mutex, so
// concurrent POST /environments can't collide on names, ports, or projects.

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { statfs } from 'node:fs/promises';
import { listProjects } from './docker.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
const ADJECTIVES = ['brisk', 'calm', 'keen', 'bold', 'wise', 'swift', 'lucky', 'sunny', 'quiet', 'vivid'];
const NOUNS = ['otter', 'falcon', 'maple', 'cedar', 'comet', 'pixel', 'harbor', 'meadow', 'river', 'ember'];

export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function randomName() {
  const a = ADJECTIVES[randomBytes(1)[0] % ADJECTIVES.length];
  const n = NOUNS[randomBytes(1)[0] % NOUNS.length];
  const suffix = randomBytes(2).toString('hex');
  return `${a}-${n}-${suffix}`;
}

// True if the port is free to bind on the loopback interface right now.
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export class AllocationError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

// Free gibibytes on the filesystem holding `path`, or null if it can't be read
// (never block an allocation on a stat failure — treat unknown as "room").
async function freeDiskGb(path) {
  try {
    const s = await statfs(path);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return null;
  }
}

// Returns the reservation record (already persisted into the registry with
// status "scaffolding"). `appPorts` is a list of CONTAINER ports the env's
// provisioning wants published (e.g. [3000] for a Next.js dev server); each
// gets a unique HOST port from the same range as the WP port, recorded as
// record.appPorts = [{ host, container }].
export async function allocate(registry, config, { nameHint, pool = null, appPorts = [] } = {}) {
  return registry.mutate(async (data) => {
    const envs = Object.values(data.environments);
    // Warm-pool builds must leave a reserve of free slots for on-demand creates,
    // so they stop short of the hard cap; user creates may use the full cap.
    const cap = pool ? Math.max(0, config.maxEnvironments - config.warmPoolReserve) : config.maxEnvironments;
    if (envs.length >= cap) {
      throw new AllocationError(
        pool
          ? `warm pool deferred: ${envs.length}/${config.maxEnvironments} env(s), reserving ${config.warmPoolReserve} free slot(s)`
          : `at capacity: ${envs.length}/${config.maxEnvironments} environments (raise MAX_ENVIRONMENTS)`,
        503,
      );
    }

    // Disk guard: the real limit on stored envs is disk, not a count. Stat the
    // data filesystem (envsDir may not exist yet; dataDir shares its filesystem).
    if (config.minFreeDiskGb > 0) {
      const freeGb = await freeDiskGb(config.dataDir);
      if (freeGb !== null && freeGb < config.minFreeDiskGb) {
        throw new AllocationError(
          `low disk: ${freeGb.toFixed(1)}GB free < ${config.minFreeDiskGb}GB floor` +
            (pool ? ' (warm build deferred)' : ' — free space or add disk (raise/lower MIN_FREE_DISK_GB)'),
          507,
        );
      }
    }

    const usedNames = new Set(envs.map((e) => e.name));
    const existingProjects = new Set(await listProjects());

    // Resolve a unique name.
    let name = nameHint;
    if (name !== undefined && name !== null && name !== '') {
      if (!isValidName(name)) {
        throw new AllocationError(
          `invalid name "${name}" — must match ${NAME_RE} (lowercase letters, digits, hyphens; 2-39 chars)`,
          400,
        );
      }
      if (usedNames.has(name) || existingProjects.has(name)) {
        throw new AllocationError(`name "${name}" is already in use`, 409);
      }
    } else {
      do {
        name = randomName();
      } while (usedNames.has(name) || existingProjects.has(name));
    }

    // Resolve unique, currently-free host ports in the configured range: the
    // WP port first, then one per requested app (container) port. One shared
    // used-set covers every env's WP port AND app ports, so allocations can't
    // collide across environments.
    const usedPorts = new Set(envs.flatMap((e) => [e.port, ...(e.appPorts ?? []).map((ap) => ap.host)]));
    const takePort = async () => {
      for (let p = config.portRange.lo; p <= config.portRange.hi; p += 1) {
        if (usedPorts.has(p)) continue;
        if (await isPortFree(p)) {
          usedPorts.add(p);
          return p;
        }
      }
      throw new AllocationError(`no free port in range ${config.portRange.lo}-${config.portRange.hi}`, 503);
    };
    const port = await takePort();
    const allocatedAppPorts = [];
    for (const container of appPorts) {
      allocatedAppPorts.push({ host: await takePort(), container });
    }

    const id = `env_${randomBytes(5).toString('hex')}`;
    const dir = join(config.envsDir, name);
    const record = {
      id,
      name,
      // Compose project name = the dir basename (the default), so the server's
      // `docker compose` calls, the project's own `npm run …` scripts, and
      // `scripts/in-workspace.sh` all target the same project.
      project: name,
      dir,
      port,
      // Host-published dev-server ports ({ host, container }), allocated from
      // the same range as `port`. Empty for envs that don't publish any.
      appPorts: allocatedAppPorts,
      wpUrl: `http://localhost:${port}`,
      status: 'scaffolding',
      createdAt: new Date().toISOString(),
      setupStartedAt: null,
      setupFinishedAt: null,
      lastError: null,
      // Setup log lives OUTSIDE the env dir (the scaffolder requires an empty
      // target dir).
      setupLogPath: join(config.dataDir, 'logs', `${name}.log`),
      // Warm-pool members carry the preset id they were built for; poolReady is
      // set once built + stopped. Both null/false for normal envs.
      pool: pool || null,
      poolReady: false,
    };
    data.environments[id] = record;
    return record;
  });
}
