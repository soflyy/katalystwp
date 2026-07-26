// JSON-file registry — the source of truth for env → metadata. Mutations are
// serialized through an async mutex and persisted with an atomic temp+rename so
// a crash mid-write can't corrupt it.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Minimal promise-chain mutex (no deps). runExclusive(fn) serializes callers.
export function createMutex() {
  let tail = Promise.resolve();
  return function runExclusive(fn) {
    const result = tail.then(() => fn());
    // Keep the chain alive regardless of fn outcome; swallow here so one
    // rejection doesn't poison the queue (callers still see their own result).
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}

export class Registry {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, environments: {} };
    this.mutex = createMutex();
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.environments) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await mkdir(dirname(this.path), { recursive: true });
      await this._persist();
    }
    return this;
  }

  list() {
    return Object.values(this.data.environments);
  }

  get(id) {
    return this.data.environments[id] || null;
  }

  getByName(name) {
    return this.list().find((e) => e.name === name) || null;
  }

  usedPorts() {
    return new Set(this.list().map((e) => e.port));
  }

  usedNames() {
    return new Set(this.list().map((e) => e.name));
  }

  // Serialized read-modify-write: mutate(data) gets the live data object and may
  // change it; the result is persisted atomically. Returns mutate()'s return.
  mutate(fn) {
    return this.mutex(async () => {
      const ret = await fn(this.data);
      await this._persist();
      return ret;
    });
  }

  // Convenience: patch one environment's fields and persist.
  update(id, patch) {
    return this.mutate((data) => {
      const env = data.environments[id];
      if (!env) return null;
      Object.assign(env, patch);
      return env;
    });
  }

  async _persist() {
    const tmp = join(dirname(this.path), `.registry.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }
}
