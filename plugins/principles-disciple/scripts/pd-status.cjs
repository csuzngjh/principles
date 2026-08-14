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
const { codexDir, locatePluginData, locatePluginRoot, locateWorkspace } = require('./pd-locate.cjs');

function parseArgs(argv) {
  const out = { pluginRoot: undefined, pluginData: undefined, workspace: undefined, json: false, pdHealth: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--plugin-root') out.pluginRoot = argv[++i];
    else if (argv[i] === '--plugin-data') out.pluginData = argv[++i];
    else if (argv[i] === '--workspace') out.workspace = argv[++i];
    else if (argv[i] === '--json') out.json = true;
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

/** Minimal, dependency-free read of the host.codex enabled value written by
 * PD tooling (stable "features:" → "host.codex:" → "enabled:" shape). */
function readHostCodexFlag(configPath) {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return { enabled: 'unknown', reason: 'config_unreadable' }; }
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
  return { enabled: 'unknown', reason: 'host_codex_entry_missing' };
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
    try { pins = JSON.parse(fs.readFileSync(path.join(root.ok ? root.pluginRoot : '', 'runtime-version.json'), 'utf8')); } catch { /* pin check skipped */ }
    const adapter = readInstalledVersion(runtimeDir, '@principles/codex-adapter');
    const hostRuntime = readInstalledVersion(runtimeDir, '@principles/host-runtime');
    if (adapter === 'not-installed') {
      push('runtime', 'degraded', 'runtime not installed in plugin data', 'Run the $pd-setup skill to install the pinned runtime.');
    } else if (pins && (adapter !== pins.codexAdapter || hostRuntime !== pins.hostRuntime)) {
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
    if (flag.enabled === true) push('workspace', 'ok', `${ws.workspaceDir} — host.codex enabled`);
    else if (flag.enabled === false) push('workspace', 'degraded', `${ws.workspaceDir} — host.codex DISABLED`, 'Set features.host.codex.enabled=true in .pd/config.yaml (or run $pd-disable --enable) to activate PD.');
    else push('workspace', 'degraded', `${ws.workspaceDir} — host.codex state unknown (${flag.reason ?? 'parse'})`, 'Inspect features.host.codex in .pd/config.yaml.');
  } else {
    push('workspace', 'degraded', ws.reason, ws.nextAction);
  }

  const trust = detectHookTrust();
  if (trust.trusted === true) push('hookTrust', 'ok', 'hooks enabled in Codex config');
  else if (trust.trusted === false) push('hookTrust', 'degraded', 'hooks disabled in Codex config', 'Set [features] hooks = true in ~/.codex/config.toml (or run codex with --enable hooks).');
  else push('hookTrust', 'degraded', trust.reason, trust.nextAction);

  if (args.pdHealth) {
    const pd = spawnSync(process.platform === 'win32' ? 'pd.cmd' : 'pd', ['health', '--host', 'codex', '--json'], { encoding: 'utf8', timeout: 60_000 });
    if (pd.status === 0 && pd.stdout.trim()) {
      try { report.pdHealth = JSON.parse(pd.stdout); } catch { report.pdHealth = { parseError: true, raw: pd.stdout.slice(0, 500) }; }
    } else {
      push('pdHealth', 'degraded', pd.error ? 'pd_not_found' : `exit_${pd.status}`, 'Install the PD CLI: npm install -g @principles/pd-cli');
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
