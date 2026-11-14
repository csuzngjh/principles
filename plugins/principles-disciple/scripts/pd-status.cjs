#!/usr/bin/env node
/**
 * $pd-cli-operator — calm, actionable workspace + plugin health snapshot.
 *
 * Combines: plugin install + installed-snapshot freshness against its
 * marketplace source, runtime install + pinned version match, Node version,
 * workspace resolution (nearest .pd/config.yaml), host.codex flag state, Codex
 * hook-trust detectability, and (when available) the existing
 * `pd health --host codex --json` output. Read-only: never mutates state
 * (cli-5). Every degraded field carries a reason + nextAction (cli-6).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { codexDir, compareVersionDirs, findPinsBehindCanonical, locatePluginData, locatePluginRoot, locateWorkspace, pdCliCommand, readCanonicalRuntimeVersions, readCheckoutBehindOrigin, readInstalledRuntimeVersions, requireFlagValue, resolvePluginSourceSnapshot } = require('./pd-locate.cjs');

/** Case-insensitive on Windows, where the same directory can resolve with a
 * different drive-letter case than the one setup recorded. */
function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseArgs(argv) {
  const out = { pluginRoot: undefined, pluginData: undefined, workspace: undefined, json: false, pdHealth: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plugin-root') {
      const value = requireFlagValue(argv, i, '--plugin-root');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.pluginRoot = value.value; i += 1;
    } else if (argv[i] === '--plugin-data') {
      const value = requireFlagValue(argv, i, '--plugin-data');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.pluginData = value.value; i += 1;
    } else if (argv[i] === '--workspace') {
      const value = requireFlagValue(argv, i, '--workspace');
      if (!value.ok) return { error: value.reason, nextAction: value.nextAction };
      out.workspace = value.value; i += 1;
    } else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--pd-health') out.pdHealth = true;
    else return { error: `unknown_argument:${argv[i]}` };
  }
  return out;
}

/** Read host.codex.enabled from the workspace config. PD tooling writes both
 * block YAML and flow-style JSON (valid YAML); parse JSON first, then fall
 * back to a line scan of the block form.
 *
 * PRI-645: a fresh workspace ships `features: {}` — the host.codex entry is
 * intentionally absent and its effective value comes from the registry
 * default. A missing entry is therefore NOT an error: it is reported as
 * `{ registryDefault: true }` ("follows registry default"), never as
 * degraded. This script never hardcodes the default value itself — the
 * runtime-resolved state can be cross-checked via `--pd-health`
 * (`pd health --host codex --json`).
 *
 * PRI-645 review round 2: the three states are strictly separated, mirroring
 * validatePdConfig's fail-loud contract (a PRESENT feature entry must be an
 * object with a boolean `enabled`; the features section itself is required):
 *   A. valid explicit override           → { enabled: true|false }
 *   B. valid sparse absence              → { registryDefault: true }
 *     (only when a VALID features section exists and has no host.codex key)
 *   C. malformed / structurally unknown  → { enabled: 'unknown', reason }
 *     → the workspace check degrades (never a health false-positive). */
function readHostCodexFlag(configPath) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return { enabled: 'unknown', reason: 'config_unreadable' }; }
  // ── Flow-style (JSON) path ──
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const features = parsed.features;
      if (typeof features !== 'object' || features === null || Array.isArray(features)) {
        return { enabled: 'unknown', reason: 'features_invalid' };
      }
      if (!Object.hasOwn(features, 'host.codex')) return { registryDefault: true };
      const entry = features['host.codex'];
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof entry.enabled === 'boolean') {
        return { enabled: entry.enabled };
      }
      return { enabled: 'unknown', reason: 'host_codex_entry_invalid' };
    }
  } catch { /* not JSON — fall through to the block-YAML scan */ }
  // ── Block-YAML path (line scan) ──
  const lines = raw.split(/\r?\n/);
  // A flow-style `features:` value cannot be validated line-safely: an empty
  // flow map is valid sparse absence, anything else is treated as unknown.
  for (const line of lines) {
    if (/^features:\s*\{\s*\}$/.test(line)) return { registryDefault: true };
    if (/^features:\s*\S/.test(line)) return { enabled: 'unknown', reason: 'features_invalid' };
  }
  let featuresSectionSeen = false;
  let sawFeaturesChild = false;
  let inFeatures = false;
  let inHostCodex = false;
  let hostIndent = -1;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (/^features:\s*$/.test(line)) { featuresSectionSeen = true; inFeatures = true; sawFeaturesChild = false; inHostCodex = false; hostIndent = -1; continue; }
    if (/^\S/.test(line)) { inFeatures = false; inHostCodex = false; continue; }
    if (!inFeatures) continue;
    sawFeaturesChild = true;
    const indent = /^(\s*)/.exec(line)[1].length;
    if (inHostCodex) {
      if (indent > hostIndent) {
        const enabledMatch = /^\s+enabled:\s*(true|false)\s*$/.exec(line);
        if (enabledMatch) return { enabled: enabledMatch[1] === 'true' };
        if (/^\s+enabled:/.test(line)) return { enabled: 'unknown', reason: 'host_codex_entry_invalid' };
        continue; // other host.codex children (e.g. category) — keep scanning
      }
      // Left the host.codex block without a valid boolean enabled child.
      return { enabled: 'unknown', reason: 'host_codex_entry_invalid' };
    }
    const hostBlock = /^(\s+)host\.codex:\s*$/.exec(line);
    if (hostBlock) { inHostCodex = true; hostIndent = hostBlock[1].length; continue; }
    if (/^\s+host\.codex:\s*\S/.test(line)) return { enabled: 'unknown', reason: 'host_codex_entry_invalid' };
  }
  // EOF inside a host.codex block that never showed a boolean enabled child.
  if (inHostCodex) return { enabled: 'unknown', reason: 'host_codex_entry_invalid' };
  if (featuresSectionSeen) {
    // `features:` with no child at all parses as null → validatePdConfig-invalid.
    return sawFeaturesChild ? { registryDefault: true } : { enabled: 'unknown', reason: 'features_invalid' };
  }
  return { enabled: 'unknown', reason: 'features_invalid' };
}

function detectHookTrust() {
  const configToml = path.join(codexDir(), 'config.toml');
  try {
    const raw = fs.readFileSync(configToml, 'utf8');
    const match = /^\s*(?:hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/m.exec(raw);
    if (!match) return { detectable: false, trusted: undefined, reason: 'hooks_setting_not_found', nextAction: 'Run /hooks in Codex and trust the Principles Disciple hooks.' };
    return { detectable: true, trusted: match[1] === 'true' };
  } catch {
    return { detectable: false, trusted: undefined, reason: 'config_toml_not_found', nextAction: 'Run Codex once to create ~/.codex/config.toml, then re-run $pd-cli-operator.' };
  }
}

// Freshness comparison is possible only for a cache install backed by a local
// marketplace source whose plugin entry this script can locate. The reasons
// below mean the comparison is NOT AVAILABLE — by design (no local source) or
// because the source uses a layout we do not model. None of them fails the
// report: assuming "source == plugin root" made the repo-root marketplace
// layout fail permanently and sent the Owner to fix a healthy checkout
// (PRI-1052).
//
// Deliberately ABSENT: every reason that is decided AFTER the marketplace
// manifest for THIS plugin was read (entry missing, entry without a path,
// entry pointing at a missing path or a file). Those are not "unknown layout",
// they are a source that no longer carries the plugin — the same class the
// freshness check exists to catch, so they stay degraded with an accurate
// diagnosis instead of becoming a silent 0-exit "ok".
const SNAPSHOT_NOT_COMPARABLE = /^(plugin_root_outside_cache|marketplace_source_not_local:|marketplace_manifest_unreadable|marketplace_manifest_invalid|marketplace_plugin_source_not_local:|marketplace_plugin_source_outside_root)/;

function snapshotRecovery(reason) {
  if (reason === 'codex_config_unreadable') return 'Make ~/.codex/config.toml readable so the marketplace source can be compared, then re-run $pd-cli-operator.';
  if (reason.startsWith('marketplace_not_configured:')) return 'The cache holds a plugin whose marketplace is no longer configured: re-add that marketplace, or remove the stale cache directory.';
  if (reason === 'marketplace_source_missing') return 'Repair the local marketplace entry in ~/.codex/config.toml (it has no source path), then re-run $pd-cli-operator.';
  if (reason.startsWith('marketplace_plugin_not_listed:')) return 'The marketplace source does not list principles-disciple in .agents/plugins/marketplace.json: restore that entry (or reinstall from a marketplace that does), then re-run $pd-cli-operator.';
  if (reason === 'marketplace_plugin_source_missing') return 'The marketplace entry for principles-disciple carries no source.path: restore the entry in .agents/plugins/marketplace.json, then re-run $pd-cli-operator.';
  if (reason === 'marketplace_plugin_source_path_missing') return 'The marketplace entry points at a plugin directory that does not exist: restore that directory (or fix source.path) in .agents/plugins/marketplace.json, then re-run $pd-cli-operator.';
  if (reason === 'marketplace_plugin_source_not_directory') return 'The marketplace entry points at a file, not a plugin directory: fix source.path in .agents/plugins/marketplace.json, then re-run $pd-cli-operator.';
  if (reason === 'source_plugin_json_unreadable' || reason === 'source_plugin_version_invalid') return 'Restore the marketplace source checkout (~/.codex/config.toml points at one that no longer carries a readable .codex-plugin/plugin.json); reinstalling from it cannot work until then.';
  return 'Reinstall the plugin from its marketplace source, then re-run $pd-cli-operator.';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`[PD:status] reason=invalid_arguments detail=${args.error} nextAction=Supported: --plugin-root --plugin-data --workspace --json --pd-health`); process.exitCode = 1; return; }

  const report = { node: process.versions.node, checks: [], ok: true };

  const push = (name, state, detail, nextAction) => {
    report.checks.push({ name, state, ...(detail ? { detail } : {}), ...(nextAction ? { nextAction } : {}) });
    if (state !== 'ok') report.ok = false;
  };

  const root = locatePluginRoot(args.pluginRoot);
  if (root.ok) {
    let version = 'unknown';
    try { version = JSON.parse(fs.readFileSync(path.join(root.pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')).version ?? 'unknown'; } catch { /* reported as unknown */ }
    push('plugin', 'ok', `principles-disciple@${version} at ${root.pluginRoot}`);
  } else {
    push('plugin', 'degraded', root.reason, root.nextAction);
  }

  // Every value below (pins, scripts) comes from the LOCATED cache root, so an
  // old snapshot is self-consistent: it reports a healthy pinned match while
  // the marketplace source already ships a newer plugin. Compare the two.
  // Reasons in SNAPSHOT_NOT_COMPARABLE mean the comparison is unavailable (no
  // local source, or a source layout this script cannot resolve); every other
  // reason means a source we DID resolve is unusable, which is degraded — a
  // deleted source checkout or a removed marketplace leaves the cache frozen
  // with no other signal (rc-9).
  if (root.ok) {
    const snapshot = resolvePluginSourceSnapshot(root.pluginRoot);
    const drift = snapshot.ok ? compareVersionDirs(snapshot.installedVersion, snapshot.sourceVersion) : 0;
    if (!snapshot.ok) {
      const detail = `installed snapshot freshness not verifiable (${snapshot.reason})`;
      if (SNAPSHOT_NOT_COMPARABLE.test(snapshot.reason)) push('snapshot', 'ok', detail);
      else push('snapshot', 'degraded', detail, snapshotRecovery(snapshot.reason));
    } else if (drift < 0) {
      push('snapshot', 'degraded',
        `installed plugin ${snapshot.installedVersion} is older than its marketplace source ${snapshot.sourceVersion} (${snapshot.source})`,
        `Re-run the installer: it refreshes this payload in place (codex plugin add principles-disciple@${snapshot.marketplace}, no uninstall) and then aligns the pinned runtime.`);
    } else if (drift > 0) {
      push('snapshot', 'degraded',
        `plugin ${snapshot.installedVersion} is newer than its marketplace source ${snapshot.sourceVersion} — the source checkout at ${snapshot.source} is behind the installed plugin`,
        `Update the marketplace source (git pull in ${snapshot.source}) and re-run the installer so every installed host tracks the same release.`);
    } else {
      // Cache == source says NOTHING about the source being current: a stale
      // local checkout satisfied this check while the PD release installed on
      // the machine had already moved on (false comfort, 2026-11-11). Compare
      // the source's pins against the canonical runtime instead of stopping at
      // "matches marketplace source".
      let sourcePins = null;
      try { sourcePins = JSON.parse(fs.readFileSync(path.join(snapshot.pluginDir, 'runtime-version.json'), 'utf8')); } catch { /* reported below as unverified */ }
      const behind = findPinsBehindCanonical(sourcePins, readCanonicalRuntimeVersions());
      if (behind.length > 0) {
        const pinsText = behind.map((row) => `${row.key}@${row.pinned} < ${row.release}`).join(', ');
        push('snapshot', 'degraded',
          `plugin ${snapshot.installedVersion} matches its marketplace source, but that source is behind the installed PD release (${pinsText})`,
          `Update the marketplace source checkout (git pull in ${snapshot.source}) and re-run the installer — it refreshes the plugin payload and pinned runtime in place on every installed host, no uninstall needed.`);
      } else {
        // Cache == source == this machine's release still does not prove the
        // local source CHECKOUT is current: it can trail its own origin/main
        // (2026-11-11 gap — "matches the marketplace source" was false
        // comfort). Local git state only, no network/fetch.
        const checkout = readCheckoutBehindOrigin(snapshot.source);
        if (checkout.comparable && checkout.behind > 0) {
          push('snapshot', 'degraded',
            `plugin ${snapshot.installedVersion} matches its marketplace source, but that local checkout is ${checkout.behind} commit(s) behind origin/main (${snapshot.source})`,
            `Update the marketplace source checkout (git -C "${snapshot.source}" pull --ff-only), then re-run the installer — it refreshes the plugin payload and pinned runtime in place on every installed host, no uninstall needed.`);
        } else {
          push('snapshot', 'ok', `plugin ${snapshot.installedVersion} matches marketplace source ${snapshot.source}`);
        }
      }
    }
  } else {
    push('snapshot', 'ok', 'installed snapshot freshness not verifiable (plugin_root_not_located)');
  }

  const workspaceDir = path.resolve(args.workspace ?? process.cwd());
  const ws = locateWorkspace(workspaceDir);

  const data = locatePluginData(args.pluginData);
  if (data.ok) {
    const runtimeDir = path.join(data.pluginData, 'runtime');
    let pins = null;
    if (root.ok) {
      try { pins = JSON.parse(fs.readFileSync(path.join(root.pluginRoot, 'runtime-version.json'), 'utf8')); } catch { /* pin check reported as unverified */ }
    }
    const installed = readInstalledRuntimeVersions(runtimeDir);
    const adapter = installed.codexAdapter;
    const hostRuntime = installed.hostRuntime;
    const core = installed.core;
    const mcpServer = installed.mcpServer;
    if (adapter === 'not-installed') {
      push('runtime', 'degraded', 'runtime not installed in plugin data', 'Run the $pd-control setup skill to install the pinned runtime.');
    } else if (core === 'not-installed') {
      push('runtime', 'degraded', 'core runtime not installed in plugin data', 'Re-run $pd-control setup to install the pinned runtime.');
    } else if (pins !== null && typeof pins.mcpServer !== 'string') {
      // rc-9: pd-setup rejects a pin file without mcpServer (missing_pins), so
      // a status "pinned match" here would be a health false-positive.
      push('runtime', 'degraded', 'runtime-version.json has no mcpServer pin (pd-setup rejects this pin file)', 'Reinstall the plugin so runtime-version.json carries the mcpServer pin, then re-run $pd-control setup.');
    } else if (pins === null || typeof pins.codexAdapter !== 'string' || typeof pins.hostRuntime !== 'string' || typeof pins.core !== 'string') {
      push('runtime', 'ok', `adapter@${adapter} host-runtime@${hostRuntime} core@${core} (pin unverified${root.ok ? '' : ' — plugin root not located'})`);
    } else if (adapter !== pins.codexAdapter || hostRuntime !== pins.hostRuntime || core !== pins.core
      || (typeof pins.mcpServer === 'string' && mcpServer !== pins.mcpServer)) {
      const pinnedSuffix = typeof pins.mcpServer === 'string' ? `+mcp-server@${pins.mcpServer}` : '';
      push('runtime', 'degraded', `installed adapter@${adapter}+host-runtime@${hostRuntime}+core@${core}+mcp-server@${mcpServer} != pinned ${pins.codexAdapter}+${pins.hostRuntime}+${pins.core}${pinnedSuffix}`, 'Re-run the installer — it installs the pinned runtime automatically; or run $pd-control setup to realign the runtime with the pinned versions.');
    } else {
      push('runtime', 'ok', `adapter@${adapter} host-runtime@${hostRuntime} core@${core} mcp-server@${mcpServer} (pinned match)`);
    }
    // Gate 4 (PRI-1071): the MCP binding beside the plugin payload is what the
    // launcher reads; a plugin reinstall (codex plugin add) resets the payload
    // and drops it — surfaced as CONFIG_MISSING, never silently ignored.
    if (root.ok && typeof pins?.mcpServer === 'string') {
      const bindingPath = path.join(root.pluginRoot, 'mcp-binding.json');
      try {
        const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
        const bindingOk = binding !== null && typeof binding === 'object'
          && binding.schemaVersion === 'pd.mcp-binding.v1'
          && binding.host === 'codex'
          && typeof binding.workspaceDir === 'string' && path.isAbsolute(binding.workspaceDir)
          && typeof binding.runtimeDir === 'string' && path.isAbsolute(binding.runtimeDir)
          && typeof binding.serverEntry === 'string' && path.isAbsolute(binding.serverEntry)
          && path.resolve(binding.serverEntry) === path.resolve(path.join(binding.runtimeDir, 'node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'))
          && binding.versions !== null && typeof binding.versions === 'object'
          && typeof binding.versions.mcpServer === 'string'
          && binding.versions.mcpServer === mcpServer;
        // A binding whose targets vanished (or that serves a DIFFERENT
        // workspace than the one being inspected) makes the launcher fail or
        // silently feed this host another workspace's evidence — status must
        // not call that healthy.
        const targetsPresent = bindingOk && fs.existsSync(binding.workspaceDir) && fs.existsSync(binding.serverEntry);
        const boundWorkspace = !ws.ok || (bindingOk && samePath(binding.workspaceDir, ws.workspaceDir));
        if (bindingOk && targetsPresent && boundWorkspace) {
          push('mcpBinding', 'ok', `pd-recall bound to mcp-server@${binding.versions.mcpServer} (host ${binding.host})`);
        } else if (bindingOk && !targetsPresent) {
          push('mcpBinding', 'degraded', 'mcp-binding.json points at a missing workspace or MCP server entry', 'Re-run $pd-control setup to rebind the workspace and reinstall the pinned MCP server entry.');
        } else if (bindingOk && !boundWorkspace) {
          push('mcpBinding', 'degraded', `mcp-binding.json is bound to ${binding.workspaceDir}, not the selected workspace ${ws.workspaceDir} (pd-recall would keep serving the bound one)`, 'Re-run $pd-control setup in this workspace to rebind pd-recall.');
        } else {
          push('mcpBinding', 'degraded', 'mcp-binding.json exists but is malformed or does not match the installed MCP server', 'Re-run $pd-control setup to regenerate mcp-binding.json.');
        }
      } catch {
        push('mcpBinding', 'degraded', 'mcp-binding.json missing (plugin reinstalled without setup?)', 'Re-run $pd-control setup to write mcp-binding.json; the MCP server refuses to start without it (fail-closed).');
      }
    }
  } else {
    push('runtime', 'degraded', data.reason, `${data.nextAction} Then run $pd-control setup.`);
  }

  if (ws.ok) {
    const flag = readHostCodexFlag(path.join(ws.workspaceDir, '.pd', 'config.yaml'));
    if (flag.enabled === true) push('workspace', 'ok', `${ws.workspaceDir} — host.codex enabled (config override)`);
    else if (flag.enabled === false) push('workspace', 'degraded', `${ws.workspaceDir} — host.codex DISABLED (config override)`, 'Run $pd-control enable to activate PD.');
    else if (flag.registryDefault) push('workspace', 'ok', `${ws.workspaceDir} — host.codex not overridden in config (follows registry default; run with --pd-health for the runtime-resolved state)`);
    else if (flag.reason === 'features_invalid') push('workspace', 'degraded', `${ws.workspaceDir} — config features section invalid (validatePdConfig would reject it)`, 'Fix the features section in .pd/config.yaml: it must be a map of flag objects ({ id: { category, enabled } }); a missing or non-map section fails config validation.');
    else push('workspace', 'degraded', `${ws.workspaceDir} — host.codex entry invalid (${flag.reason ?? 'parse'})`, 'Fix features.host.codex in .pd/config.yaml: the entry must be an object with a boolean enabled field, or remove the entry to follow the registry default.');
  } else {
    push('workspace', 'degraded', ws.reason, ws.nextAction);
  }

  const trust = detectHookTrust();
  if (trust.trusted === true) push('hookTrust', 'ok', 'hooks enabled in Codex config');
  else if (trust.trusted === false) push('hookTrust', 'degraded', 'hooks disabled in Codex config', 'Set [features] hooks = true in ~/.codex/config.toml (or run codex with --enable hooks).');
  else push('hookTrust', 'degraded', trust.reason, trust.nextAction);

  if (args.pdHealth) {
    const pd = pdCliCommand();
    if (pd) {
      const health = spawnSync(pd.command, [...pd.prefix, 'health', '--host', 'codex', '--json'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PD_INVOCATION_SOURCE: 'plugin-script' },
      });
      if (health.status === 0 && health.stdout.trim()) {
        try { report.pdHealth = JSON.parse(health.stdout); } catch { report.pdHealth = { parseError: true, raw: health.stdout.slice(0, 500) }; }
      } else {
        push('pdHealth', 'degraded', health.error ? 'pd_failed' : `exit_${health.status}`, 'Reinstall the PD CLI: npm install -g @principles/pd-cli');
      }
    } else {
      push('pdHealth', 'degraded', 'pd_not_found', 'Install the PD CLI: npm install -g @principles/pd-cli');
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[PD:status] ${report.ok ? 'healthy' : 'needs attention'}`);
    for (const check of report.checks) {
      const mark = check.state === 'ok' ? '✔' : '✘';
      console.log(`  ${mark} ${check.name}: ${check.detail ?? check.state}`);
      if (check.nextAction) console.log(`      next → ${check.nextAction}`);
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

main();
