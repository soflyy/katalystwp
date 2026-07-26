// JSON-file store of Claude sessions — the durable record of each conversation.
// Mirrors registry.js (shared async mutex + atomic temp+rename write).
//
// A "session" is the durable thread (our stable id + the claude session_id used
// for --resume). A "turn" is one `claude -p` run; we don't persist turns
// separately beyond turnCount + the per-session ndjson event log.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createMutex } from './registry.js';

export class SessionStore {
  constructor(path) {
    this.path = path;
    this.data = { version: 1, sessions: {} };
    this.mutex = createMutex();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (parsed && parsed.sessions) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await mkdir(dirname(this.path), { recursive: true });
      await this._persist();
    }
    return this;
  }

  list() {
    return Object.values(this.data.sessions);
  }

  get(id) {
    return this.data.sessions[id] || null;
  }

  listByEnv(envId) {
    return this.list().filter((s) => s.envId === envId);
  }

  mutate(fn) {
    return this.mutex(async () => {
      const ret = await fn(this.data);
      await this._persist();
      return ret;
    });
  }

  create(record) {
    return this.mutate((data) => {
      data.sessions[record.id] = record;
      return record;
    });
  }

  update(id, patch) {
    return this.mutate((data) => {
      const s = data.sessions[id];
      if (!s) return null;
      Object.assign(s, patch);
      return s;
    });
  }

  remove(id) {
    return this.mutate((data) => {
      delete data.sessions[id];
    });
  }

  // Boot: a session left `running` had its turn killed when the server stopped.
  // The claude session jsonl persists on disk, so it's resumable — mark it
  // interrupted so the next message resumes it.
  reconcile() {
    return this.mutate((data) => {
      for (const s of Object.values(data.sessions)) {
        if (s.status === 'running') {
          s.status = 'interrupted';
          s.lastError = s.lastError || 'turn interrupted (server restart)';
        }
      }
    });
  }

  async _persist() {
    const tmp = join(dirname(this.path), `.sessions.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }
}
