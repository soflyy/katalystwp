// Compose selected presets (in order) + optional custom fields into one
// provision object the scaffolder understands. Pure (no I/O), so it's shared by
// the route layer (on-demand creates) and the manager (warm-pool builds).
//
// setup scripts run sequentially, dev scripts run concurrently in the single dev
// container, defines merge (later wins), activate lists concatenate (deduped),
// app (container) ports union — the allocator assigns each a unique host port.
// Returns null when there's nothing to provision.
export function composeProvision(presets, custom) {
  const parts = presets.map((p) => ({
    label: p.name, setupScript: p.setupScript, devScript: p.devScript, defines: p.defines, activate: p.activate, appPorts: p.appPorts,
  }));
  if (custom) parts.push({ label: 'Custom', ...custom });
  if (!parts.length) return null;

  const setupChunks = parts
    .filter((p) => p.setupScript && p.setupScript.trim())
    .map((p) => `# ===== ${p.label} =====\n${p.setupScript.trim()}\n`);
  const setupScript = setupChunks.length
    ? `#!/usr/bin/env bash\nset -euo pipefail\n\n${setupChunks.join('\n')}`
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
