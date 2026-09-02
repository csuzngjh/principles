#!/usr/bin/env node
/**
 * $pd-disable — the Codex kill switch (mvp-q-3).
 *
 * Sets features.host.codex.enabled=false in the nearest .pd/config.yaml.
 * Every Codex hook then returns the neutral allow/empty result with an
 * observable skip reason, and no PD business state is written. OpenClaw and
 * all workspace owner data (.pd/, .state/) are untouched. Run with --enable
 * to re-activate. Uninstalling the plugin is a separate action and is NOT
 * required to stop PD behavior.
 *
 * The edit is targeted and line-based (zero dependencies, works even when the
 * runtime is not installed): only the `enabled:` line that is a DIRECT child
 * of the `features: → host.codex:` block is rewritten — the scan stops at the
 * first non-empty line at or below host.codex's own indent, so a sibling
 * feature's `enabled:` can never be touched. Flow-style (JSON) configs are
 * handled via a JSON parse path. Writes go through write-temp-then-rename.
 *
 * PRI-645: a fresh workspace ships `features: {}` — the host.codex entry is
 * intentionally ABSENT and its effective value comes from the registry
 * default. The kill switch is an explicit Owner action, so a missing (or
 * enabled-less) host.codex entry is resolved by INSERTING an explicit
 * `{category: core, enabled: <target>}` override — never by failing. Failure
 * stays reserved for configs whose features section cannot be safely
 * line-edited at all (section missing / non-empty flow style).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { locateWorkspace, requireFlagValue } = require('./pd-locate.cjs');

function fail(reason, nextAction) {
  console.error(`[PD:disable] status=failed reason=${reason}`);
  console.error(`[PD:disable] nextAction=${nextAction}`);
  process.exitCode = 1;
}

/** Rewrite the enabled value among the DIRECT children of the host.codex
 * block in BLOCK-style YAML. Returns the new content, undefined when the
 * block/entry cannot be located safely (never touches a sibling feature). */
function rewriteBlockYaml(raw, target) {
  const lines = raw.split(/\r?\n/);
  let inFeatures = false;
  let hostLine = -1;
  let hostIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^features:\s*$/.test(line)) { inFeatures = true; continue; }
    if (/^\S/.test(line)) { if (inFeatures && hostLine === -1) inFeatures = false; continue; }
    if (inFeatures) {
      const match = /^(\s+)host\.codex:\s*$/.exec(line);
      if (match) { hostLine = i; hostIndent = match[1].length; break; }
    }
  }
  if (hostLine === -1) return undefined;
  for (let i = hostLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const indentMatch = /^(\s*)/.exec(line);
    const indent = indentMatch ? indentMatch[1].length : 0;
    // Leaving the host.codex block: any non-empty line at or above its indent.
    if (indent <= hostIndent) {
      // Block ended without an enabled child — insert one as the block's
      // first direct child (PRI-645: entry present but enabled-less).
      const pad = ' '.repeat(hostIndent + 2);
      lines.splice(i, 0, `${pad}enabled: ${target}`);
      return lines.join('\n');
    }
    if (indent !== hostIndent + 2) continue; // deeper-nested content is not a direct child
    const enabledMatch = /^enabled:\s*(true|false)\s*$/.exec(line.trim());
    if (enabledMatch) {
      lines[i] = line.replace(/enabled:\s*(true|false)/, `enabled: ${target}`);
      return lines.join('\n');
    }
    // Other direct children (e.g. "category: core") — keep scanning.
  }
  // host.codex was the last block in the file without an enabled child.
  const pad = ' '.repeat(hostIndent + 2);
  lines.push(`${pad}enabled: ${target}`);
  return lines.join('\n');
}

/** PRI-645 sparse bootstrap: insert a brand-new host.codex block when the
 * features section exists but has no host.codex entry. Handles the two fresh
 * shapes PD writes — block-style section and the empty flow map
 * `features: {}`. Returns undefined for shapes that cannot be line-edited
 * safely (features section absent / non-empty flow style). */
function insertBlockYamlEntry(raw, target) {
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^features:\s*$/.test(line)) {
      lines.splice(i + 1, 0,
        '  host.codex:',
        '    category: core',
        `    enabled: ${target}`);
      return lines.join('\n');
    }
    if (/^features:\s*\{\s*\}$/.test(line)) {
      lines.splice(i, 1,
        'features:',
        '  host.codex:',
        '    category: core',
        `    enabled: ${target}`);
      return lines.join('\n');
    }
  }
  return undefined;
}

/** FLOW-style (JSON) configs — our own production tests and some tools write
 * JSON, which is valid YAML the runtime reads fine. Mutate via JSON parse.
 * PRI-645: a missing host.codex key (sparse fresh config) is resolved by
 * inserting the explicit Owner override. */
function rewriteJsonConfig(raw, target) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const features = parsed.features;
  if (typeof features !== 'object' || features === null || Array.isArray(features)) return undefined;
  if (!Object.hasOwn(features, 'host.codex')) {
    features['host.codex'] = { category: 'core', enabled: target };
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }
  const entry = features['host.codex'];
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || typeof entry.enabled !== 'boolean') return undefined;
  if (entry.enabled === target) return raw;
  entry.enabled = target;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  let workspaceArg;
  let target = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--workspace') {
      const value = requireFlagValue(argv, i, '--workspace');
      if (!value.ok) { fail(value.reason, value.nextAction); return; }
      workspaceArg = value.value; i += 1;
    } else if (argv[i] === '--enable') target = true;
    else { fail(`unknown_argument:${argv[i]}`, 'Supported: --workspace <dir> --enable'); return; }
  }

  const ws = locateWorkspace(workspaceArg ?? process.cwd());
  if (!ws.ok) { fail(ws.reason, ws.nextAction); return; }
  const configPath = path.join(ws.workspaceDir, '.pd', 'config.yaml');

  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (error) {
    fail(`config_unreadable:${error.message.slice(0, 160)}`, `Fix read access to ${configPath} and retry.`);
    return;
  }

  const next = rewriteBlockYaml(raw, target) ?? insertBlockYamlEntry(raw, target) ?? rewriteJsonConfig(raw, target);
  if (next === undefined) {
    fail('host_codex_entry_missing', `Add this block under features: in ${configPath}:\n  host.codex:\n    category: core\n    enabled: ${target}`);
    return;
  }
  if (next === raw) {
    console.log(`[PD:disable] already ${target ? 'enabled' : 'disabled'} — no change (${configPath})`);
    return;
  }

  const tempPath = `${configPath}.pd-disable-tmp`;
  fs.writeFileSync(tempPath, next, 'utf8');
  fs.renameSync(tempPath, configPath);

  console.log(`[PD:disable] host.codex.enabled=${target} written to ${configPath}`);
  console.log(target
    ? '  PD Codex behavior is ACTIVE again — prompt injection, tool gating, and pain capture resume on the next hook invocation.'
    : '  PD Codex behavior is now STOPPED: every Codex hook returns the neutral allow/empty result with a skip reason, and no PD business state is written. OpenClaw and workspace data are untouched.');
  if (!target) console.log('  re-enable → run $pd-disable --enable (or set features.host.codex.enabled=true manually).');
}

main();
