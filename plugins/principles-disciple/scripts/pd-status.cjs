#!/usr/bin/env node
/**
 * $pd-status — calm, actionable workspace + plugin health snapshot.
 *
 * Combines: plugin install, runtime install + pinned version match, Node
 * version, workspace resolution (nearest .pd/config.yaml), host.codex flag
 * state, Codex hook-trust detectability, and (when available) the existing
 * `pd health --host codex --json` output. Read-only: never mutates state
 * (cli-5). Every degraded field carries a reason + nextAction (cli-6).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { codexDir, locatePluginData, locatePluginRoot, locateWorkspace, pdCliCommand, requireFlagValue } = require('./pd-locate.cjs');

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

function readInstalledVersion(runtimeDir, packageName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'node_modules', packageName, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'not-installed';
  }
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
 * (`pd health --host codex --json`). */
function readHostCodexFlag(configPath) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return { enabled: 'unknown', reason: 'config_unreadable' }; }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const features = parsed.features;
      if (typeof features === 'object' && features !== null && !Array.isArray(features) && Object.hasOwn(features, 'host.codex')) {
        const entry = features['host.codex'];
        if (typeof entry === 'object' && entry !== null && !Array.isArray(entry) && typeof entry.enabled === 'boolean') {
          return { enabled: entry.enabled };
        }
      }
      return { registryDefault: true };
    }
  } catch { /* not JSON — fall through to the block-YAML scan */ }
  const lines = raw.split(/\r?\n/);
  let inFeatures = false;
  let inHostCodex = false;
  for (const line of lines) {
    if (/^features:\s*$/.test(line)) { inFeatures = true; inHostCodex = false; continue; }
    if (/^\S/.test(line)) { inFeatures = false; inHostCodex = false; continue; }
    if (inFeatures && /^\s+host\.codex:\s*$/.test(line)) { inHostCodex = true; continue; }
    if (inHostCodex) {
      const match = /^\s+enabled:\s*(true|false)\s*$/.exec(line);
      if (match) return { enabled: match[1] === 'true' };
    }
  }
  return { registryDefault: true };
}

function detectHookTrust() {
  const configToml = path.join(codexDir(), 'config.toml');
  try {
    const raw = fs.readFileSync(configToml, 'utf8');
    const match = /\bhooks\s*=\s*(true|false)/.exec(raw);
    if (!match) return { detectable: false, trusted: undefined, reason: 'hooks_setting_not_found', nextAction: 'Run /hooks in Codex and trust the Principles Disciple hooks.' };
    return { detectable: true, trusted: match[1] === 'true' };
  } catch {
    return { detectable: false, trusted: undefined, reason: 'config_toml_not_found', nextAction: 'Run Codex once to create ~/.codex/config.toml, then re-run $pd-status.' };
  }
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

  const data = locatePluginData(args.pluginData);
  if (data.ok) {
    const runtimeDir = path.join(data.pluginData, 'runtime');
    let pins = null;
    if (root.ok) {
      try { pins = JSON.parse(fs.readFileSync(path.join(root.pluginRoot, 'runtime-version.json'), 'utf8')); } catch { /* pin check reported as unverified */ }
    }
    const adapter = readInstalledVersion(runtimeDir, '@principles/codex-adapter');
    const hostRuntime = readInstalledVersion(runtimeDir, '@principles/host-runtime');
    if (adapter === 'not-installed') {
      push('runtime', 'degraded', 'runtime not installed in plugin data', 'Run the $pd-setup skill to install the pinned runtime.');
    } else if (pins === null || typeof pins.codexAdapter !== 'string' || typeof pins.hostRuntime !== 'string') {
      push('runtime', 'ok', `adapter@${adapter} host-runtime@${hostRuntime} (pin unverified${root.ok ? '' : ' — plugin root not located'})`);
    } else if (adapter !== pins.codexAdapter || hostRuntime !== pins.hostRuntime) {
      push('runtime', 'degraded', `installed adapter@${adapter}+host-runtime@${hostRuntime} != pinned ${pins.codexAdapter}+${pins.hostRuntime}`, 'Re-run $pd-setup to realign the runtime with the pinned versions.');
    } else {
      push('runtime', 'ok', `adapter@${adapter} host-runtime@${hostRuntime} (pinned match)`);
    }
  } else {
    push('runtime', 'degraded', data.reason, `${data.nextAction} Then run $pd-setup.`);
  }

  const workspaceDir = path.resolve(args.workspace ?? process.cwd());
  const ws = locateWorkspace(workspaceDir);
  if (ws.ok) {
    const flag = readHostCodexFlag(path.join(ws.workspaceDir, '.pd', 'config.yaml'));
    if (flag.enabled === true) push('workspace', 'ok', `${ws.workspaceDir} — host.codex enabled (config override)`);
    else if (flag.enabled === false) push('workspace', 'degraded', `${ws.workspaceDir} — host.codex DISABLED (config override)`, 'Run $pd-disable --enable (or set features.host.codex.enabled=true in .pd/config.yaml) to activate PD.');
    else if (flag.registryDefault) push('workspace', 'ok', `${ws.workspaceDir} — host.codex not overridden in config (follows registry default; run with --pd-health for the runtime-resolved state)`);
    else push('workspace', 'degraded', `${ws.workspaceDir} — host.codex state unknown (${flag.reason ?? 'parse'})`, 'Inspect features.host.codex in .pd/config.yaml.');
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
      const health = spawnSync(pd.command, [...pd.prefix, 'health', '--host', 'codex', '--json'], { encoding: 'utf8', timeout: 60_000 });
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
