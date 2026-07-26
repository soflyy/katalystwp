// Mutable app settings — the secrets + defaults a user edits on the Settings
// page, persisted to data/settings.json. Mirrors registry.js (async mutex +
// atomic temp+rename write).
//
// Holds the GitHub token (git auth in the workspace), the Claude OAuth token
// (injected into the `claude` spawn env), and the default WordPress admin
// account seeded into new sites. The DEVBOX_API_TOKEN (the app's bearer
// password) is NOT here — it gates access to this very API, so it stays an env
// var set before the server starts.
//
// On first run the file is seeded from the environment (GITHUB_TOKEN,
// CLAUDE_CODE_OAUTH_TOKEN) so existing .env-based setups keep working; after
// that the file is authoritative.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createMutex } from './registry.js';

// Fields treated as secrets: masked in API responses, only overwritten when a
// non-empty value is supplied, and fed to the log redactor.
const SECRET_FIELDS = ['githubToken', 'claudeToken', 'codexToken', 'opencodeToken', 'wpAdminPassword'];

function defaults() {
  return {
    githubToken: '',
    claudeToken: '',
    codexToken: '',
    opencodeToken: '',
    wpAdminUser: 'admin',
    wpAdminPassword: 'password',
    wpAdminEmail: 'admin@example.com',
    // Warm pool: { [presetId]: desiredReadyCount }. How many pre-built (then
    // stopped) environments to keep waiting per preset. Empty = pooling off.
    warmPool: {},
  };
}

export class SettingsStore {
  // `seed` supplies env-derived initial values used only when the file is absent.
  constructor(path, seed = {}) {
    this.path = path;
    this.seed = seed;
    this.data = { version: 1, settings: defaults() };
    this.mutex = createMutex();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      if (parsed && parsed.settings) this.data = { version: 1, settings: { ...defaults(), ...parsed.settings } };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await mkdir(dirname(this.path), { recursive: true });
      const seeded = {};
      for (const [k, v] of Object.entries(this.seed)) if (typeof v === 'string' && v) seeded[k] = v;
      this.data = { version: 1, settings: { ...defaults(), ...seeded } };
      await this._persist();
    }
    return this;
  }

  // Full settings incl. secret values — server-side use only (never sent to a client).
  get() {
    return { ...this.data.settings };
  }

  // Current secret strings, for the log redactor.
  secrets() {
    return SECRET_FIELDS.map((k) => this.data.settings[k]).filter((s) => typeof s === 'string' && s.length >= 6);
  }

  // Client-safe view: secrets masked to { set, hint }, never the raw value.
  publicView() {
    const s = this.data.settings;
    const mask = (v) => (v ? { set: true, hint: `••••${String(v).slice(-4)}` } : { set: false });
    return {
      githubToken: mask(s.githubToken),
      claudeToken: mask(s.claudeToken),
      codexToken: mask(s.codexToken),
      opencodeToken: mask(s.opencodeToken),
      wpAdminUser: s.wpAdminUser,
      wpAdminEmail: s.wpAdminEmail,
      wpAdminPassword: mask(s.wpAdminPassword),
      warmPool: { ...(s.warmPool || {}) },
    };
  }

  // Set the desired warm-pool count for one preset (0 removes it). Kept separate
  // from update() because it's config, not a masked-secret form field.
  setWarmPool(presetId, count) {
    return this.mutex(async () => {
      const n = Math.max(0, Math.min(50, parseInt(count, 10) || 0));
      const warmPool = { ...(this.data.settings.warmPool || {}) };
      if (n === 0) delete warmPool[presetId];
      else warmPool[presetId] = n;
      this.data.settings = { ...this.data.settings, warmPool };
      await this._persist();
      return warmPool;
    });
  }

  // Apply a patch from the Settings form. Non-secret fields are set when a
  // non-empty value is given; secret fields are overwritten only when non-empty
  // (a blank field means "leave the stored secret unchanged"), so saving the
  // form doesn't wipe a token you didn't retype.
  update(patch = {}) {
    return this.mutex(async () => {
      const next = { ...this.data.settings };
      for (const k of ['wpAdminUser', 'wpAdminEmail']) {
        if (typeof patch[k] === 'string' && patch[k].trim()) next[k] = patch[k].trim();
      }
      for (const k of SECRET_FIELDS) {
        if (typeof patch[k] === 'string' && patch[k] !== '') next[k] = patch[k];
      }
      this.data.settings = next;
      await this._persist();
      return this.publicView();
    });
  }

  async _persist() {
    const tmp = join(dirname(this.path), `.settings.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }
}
