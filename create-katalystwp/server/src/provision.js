// Compose selected presets (in order) + optional custom fields into one
// provision object the scaffolder understands. Pure (no I/O), so it's shared by
// the route layer (on-demand creates) and the manager (warm-pool builds).
//
// setup scripts run sequentially, dev scripts run concurrently in the single dev
// container, defines merge (later wins), activate lists concatenate (deduped),
// app (container) ports union — the allocator assigns each a unique host port.
// Returns null when there's nothing to provision.
// Where a composed setup script records the labels of presets whose script
// failed (inside the workspace container; /home/node is the env's bind-mounted
// workspace/ dir, so the manager reads it from the host as
// <env.dir>/workspace/.katalyst-setup-failures).
export const SETUP_FAILURES_FILE = '/home/node/.katalyst-setup-failures';
export const SETUP_FAILURES_HOST_REL = 'workspace/.katalyst-setup-failures';

// Expand a preset id list with each preset's `requires` (recursively), keeping
// dependencies BEFORE their dependents and the caller's order otherwise.
// Unknown ids throw (400). Cycles are tolerated (visited set).
export function expandPresetIds(presetIds, getPreset) {
  const out = [];
  const visit = (id, stack) => {
    if (out.includes(id)) return;
    if (stack.includes(id)) return; // cycle guard
    const p = getPreset(id);
    if (!p) { const e = new Error(`unknown preset "${id}"`); e.status = 400; throw e; }
    for (const dep of p.requires || []) visit(dep, [...stack, id]);
    if (!out.includes(id)) out.push(id);
  };
  for (const id of presetIds) visit(id, []);
  return out;
}

export function composeProvision(presets, custom) {
  const parts = presets.map((p) => ({
    label: p.name, setupScript: p.setupScript, devScript: p.devScript, defines: p.defines, activate: p.activate, appPorts: p.appPorts,
  }));
  if (custom) parts.push({ label: 'Custom', ...custom });
  if (!parts.length) return null;

  // Each preset's script runs in its own `set -e` subshell. A failing preset
  // no longer aborts the whole setup (which used to leave the env "failed"
  // with everything after it skipped — e.g. Sidekick failing to activate
  // because Agent Connector wasn't selected); it is logged, its label is
  // appended to SETUP_FAILURES_FILE, and the next preset runs. The manager
  // reads that file after setup and surfaces it as `setupWarnings`.
  const setupChunks = parts
    .filter((p) => p.setupScript && p.setupScript.trim())
    .map((p) => {
      // Label lands inside single quotes below — strip anything that could break out.
      const label = String(p.label).replace(/['"\\$`]/g, '');
      // NOTE: the subshell must NOT be the condition of `if`/`!`/`&&` — bash
      // suppresses errexit inside such conditions, so a failing command would
      // not abort the chunk. Run it as a plain command and test $? afterwards.
      return `# ===== ${label} =====\n(\n  set -euo pipefail\n${p.setupScript.trim()}\n)\n`
        + `if [ $? -ne 0 ]; then\n`
        + `  echo '✖ preset "${label}" setup failed — continuing with the next preset' >&2\n`
        + `  printf '%s\\n' '${label}' >> "${SETUP_FAILURES_FILE}"\n`
        + `fi\n`;
    });
  const setupScript = setupChunks.length
    ? `#!/usr/bin/env bash\nset -uo pipefail\nrm -f "${SETUP_FAILURES_FILE}"\n\n${setupChunks.join('\n')}`
    : '';

  const devs = parts.filter((p) => p.devScript && p.devScript.trim());
  let devScript = '';
  if (devs.length === 1) devScript = devs[0].devScript;
  else if (devs.length > 1) {
    devScript = '#!/usr/bin/env bash\n# composed dev scripts — run concurrently in one dev container\n'
      + devs.map((d) => `# --- ${d.label} ---\n(\n${d.devScript.trim()}\n) &`).join('\n')
      + '\nwait\n';
  }

  const defines = Object.assign({}, ...parts.map((p) => p.defines || {}));
  const activate = [];
  for (const p of parts) for (const s of p.activate || []) if (!activate.includes(s)) activate.push(s);
  const appPorts = [...new Set(parts.flatMap((p) => p.appPorts || []))];

  if (!setupScript && !devScript && !activate.length && !Object.keys(defines).length && !appPorts.length) return null;
  return { setupScript, devScript, defines, activate, appPorts, presetName: presets.map((p) => p.name).join(' + ') || null };
}
