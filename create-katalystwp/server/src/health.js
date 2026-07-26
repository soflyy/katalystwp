// System-health snapshot: memory, CPU load, disk, and Docker resource usage,
// plus per-environment container memory and a "how many more envs fit" estimate.
//
// The crash vector on a typical (swap-less) cloud box is MEMORY — once RAM is
// exhausted the OOM killer starts dropping processes — so RAM headroom is the
// headline. Disk is the slower-burning second risk (image layers + build cache +
// each env's bind-mounted WordPress/node_modules).

import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { run } from './docker.js';

// /proc/meminfo (kB) → bytes. MemAvailable is the kernel's own estimate of how
// much can be allocated before swapping/OOM — the number that matters.
function parseMeminfo(text) {
  const kv = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) kv[m[1]] = parseInt(m[2], 10) * 1024;
  }
  const total = kv.MemTotal || 0;
  const available = kv.MemAvailable != null ? kv.MemAvailable : kv.MemFree || 0;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    usedPct: total ? Math.round(((total - available) / total) * 100) : null,
    swapTotalBytes: kv.SwapTotal || 0,
    swapUsedBytes: Math.max(0, (kv.SwapTotal || 0) - (kv.SwapFree || 0)),
  };
}

// "1.151GiB / 31.34GiB" → bytes (the used part).
function parseMemUsage(s) {
  const m = String(s).match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!m) return 0;
  const mult = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
    KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

async function diskFor(path) {
  try {
    const { stdout } = await run('df', ['-PB1', path]);
    const f = stdout.trim().split('\n').slice(-1)[0].split(/\s+/);
    const totalBytes = parseInt(f[1], 10);
    const usedBytes = parseInt(f[2], 10);
    const availBytes = parseInt(f[3], 10);
    return { totalBytes, usedBytes, availBytes, usedPct: totalBytes ? Math.round((usedBytes / totalBytes) * 100) : null };
  } catch { return null; }
}

async function dockerStats() {
  try {
    const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'], { timeout: 25_000 });
    return stdout.trim().split('\n').filter(Boolean).map((l) => {
      const [name, mem, cpu] = l.split('\t');
      return { name, memBytes: parseMemUsage(mem), cpuPct: parseFloat(cpu) || 0 };
    });
  } catch { return []; }
}

async function dockerDf() {
  try {
    const { stdout } = await run('docker', ['system', 'df', '--format', 'json']);
    return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return null; }
}

async function count(args) {
  try {
    const { stdout } = await run('docker', args);
    return stdout.trim() ? stdout.trim().split('\n').length : 0;
  } catch { return null; }
}

export async function systemHealth(config, registry) {
  const envs = registry.list();
  const [meminfoText, disk, stats, df, running, total] = await Promise.all([
    readFile('/proc/meminfo', 'utf8').catch(() => ''),
    diskFor(config.dataDir),
    dockerStats(),
    dockerDf(),
    count(['ps', '-q']),
    count(['ps', '-aq']),
  ]);

  const memory = parseMeminfo(meminfoText);
  const cpu = { cores: os.cpus().length, loadavg: os.loadavg() };

  // Per-env container memory: a container belongs to env <name> when its name is
  // "<name>" or "<name>-<service>-N" (compose default project = the env name).
  const perEnv = envs
    .map((e) => {
      const cs = stats.filter((s) => s.name === e.name || s.name.startsWith(`${e.name}-`));
      return { name: e.name, status: e.status, containers: cs.length, memBytes: cs.reduce((a, c) => a + c.memBytes, 0) };
    })
    .sort((a, b) => b.memBytes - a.memBytes);

  const liveEnvs = perEnv.filter((e) => e.containers > 0);
  const envMemBytes = liveEnvs.reduce((a, e) => a + e.memBytes, 0);
  const avgEnvMemBytes = liveEnvs.length ? Math.round(envMemBytes / liveEnvs.length) : 0;
  // How many more like-sized envs fit in the currently-available RAM.
  const ramHeadroomEnvs = avgEnvMemBytes ? Math.floor(memory.availableBytes / avgEnvMemBytes) : null;

  return {
    memory,
    cpu,
    disk,
    docker: { df, containersRunning: running, containersTotal: total },
    environments: { count: envs.length, max: config.maxEnvironments, running: liveEnvs.length, maxRunning: config.maxRunning },
    perEnv,
    estimate: { avgEnvMemBytes, ramHeadroomEnvs },
  };
}
