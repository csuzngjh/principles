#!/usr/bin/env node
/**
 * PD MCP launcher — SPEC-PD-MCP-GATE4-001 §3.3/§3.5 (Gate 4-A freeze).
 *
 * This is the CANONICAL copy. The WorkBuddy plugin payload
 * (packages/workbuddy-adapter/plugin/mcp/launcher.cjs) and the OpenClaw
 * plugin payload (packages/openclaw-plugin/mcp/launcher.cjs) carry
 * byte-identical copies — pinned by the pd-mcp-server architecture guard
 * test G4-7. Change it here first, then propagate.
 *
 * The host starts this launcher via the plugin's PD-owned MCP config
 * (Codex: .mcp.json with cwd = installed plugin root; WorkBuddy:
 * ${CODEBUDDY_PLUGIN_ROOT} placeholders; OpenClaw: plugin-root-relative
 * args). It reads the PD-owned machine-local `mcp-binding.json` beside the
 * plugin payload root, validates it strictly against the payload's own host
 * marker and the installed package bytes, injects the trusted env, and runs
 * the shared server entry IN-PROCESS — one process per host, and the host
 * owns this PID's lifecycle (no daemon, no extra children).
 *
 * Binding security (Gate 4 P2): the binding is untrusted input. The host is
 * derived from the payload marker beside this launcher (never from the
 * binding itself), the entry must equal the canonical path for that host's
 * runtime layout, symlinks may not escape the recorded runtime directory, and
 * the installed package identity/version must agree with the binding and the
 * plugin's runtime pin. A binding copied from another host fails closed.
 *
 * Fail-closed: a missing/invalid binding, host mismatch, workspace, or server
 * entry exits
 * 1 with ONE sanitized stderr JSON line BEFORE any MCP traffic — the host
 * reports the server as failed to start (honest, recoverable state). No
 * cwd/HOME fallback exists by design (SPEC §3.5).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const BINDING_SCHEMA = 'pd.mcp-binding.v1';
const KNOWN_HOSTS = ['codex', 'openclaw', 'workbuddy'];
// The payload marker that identifies which host owns THIS launcher copy.
const HOST_MARKERS = [
  ['codex', path.join('.codex-plugin', 'plugin.json')],
  ['workbuddy', path.join('.codebuddy-plugin', 'plugin.json')],
  ['openclaw', 'openclaw.plugin.json'],
];
// Canonical server entry per host, relative to the binding's runtimeDir:
// Codex installs into its plugin-data npm runtime (node_modules layout);
// OpenClaw/WorkBuddy bind to the shared ~/.pd/runtime component layout.
const SERVER_ENTRY_SEGMENTS = {
  codex: ['node_modules', '@principles', 'pd-mcp-server', 'dist', 'index.js'],
  openclaw: ['pd-mcp-server', 'dist', 'index.js'],
  workbuddy: ['pd-mcp-server', 'dist', 'index.js'],
};
const SERVER_PACKAGE_NAME = '@principles/pd-mcp-server';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(reason, nextAction) {
  process.stderr.write(JSON.stringify({ launcher: 'pd-mcp', status: 'failed', reason, nextAction }) + '\n');
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

const pluginRoot = path.join(__dirname, '..');

// rc-1/rc-3: the payload marker is the host authority. Exactly one marker
// must exist; ambiguity (tampered/copied payload) is never resolved by guess.
const detectedHosts = HOST_MARKERS
  .filter(([, marker]) => {
    try {
      return fs.statSync(path.join(pluginRoot, marker)).isFile();
    } catch {
      return false;
    }
  })
  .map(([markerHost]) => markerHost);
if (detectedHosts.length !== 1) {
  fail(
    detectedHosts.length === 0 ? 'host_marker_missing' : `host_marker_ambiguous:${detectedHosts.join(',')}`,
    'Reinstall the PD plugin from its marketplace source; the host payload marker is missing or ambiguous.',
  );
}
const host = detectedHosts[0];

// rc-1/rc-3/rc-5: the binding file is read as untrusted; every field is
// validated before use and unknown content is never coerced.
let raw;
try {
  raw = fs.readFileSync(path.join(pluginRoot, 'mcp-binding.json'), 'utf8');
} catch {
  fail('binding_missing', 'Re-run the PD host setup (Codex: $pd-control setup) so mcp-binding.json is written into the plugin directory.');
}
let binding;
try {
  binding = JSON.parse(raw);
} catch {
  fail('binding_unreadable', 'Re-run the PD host setup to regenerate a valid mcp-binding.json.');
}
if (!isRecord(binding)) {
  fail('binding_invalid', 'Re-run the PD host setup to regenerate a valid mcp-binding.json.');
}
if (binding.schemaVersion !== BINDING_SCHEMA) {
  // rc-8/rc-9: this value is untrusted and the reason lands in host logs —
  // report a bounded identifier, never the raw string.
  const schemaKind = typeof binding.schemaVersion === 'string'
    ? binding.schemaVersion.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60)
    : 'non-string';
  fail(`binding_schema_unsupported:${schemaKind}`, 'The plugin and the PD installation come from different generations. Re-run the PD host setup after updating PD.');
}
if (!KNOWN_HOSTS.includes(binding.host)) {
  fail('binding_host_invalid', 'Re-run the PD host setup; the host marker is written by the PD installer and must not be edited.');
}
// A binding copied from another host's payload would make this launcher pass
// the wrong workspace and entry to the server — fail closed instead.
if (binding.host !== host) {
  fail(`binding_host_mismatch:${binding.host}!=${host}`, 'This mcp-binding.json belongs to a different host payload. Re-run the PD host setup for THIS host.');
}
if (typeof binding.workspaceDir !== 'string' || !path.isAbsolute(binding.workspaceDir)) {
  fail('binding_workspace_invalid', 'Re-run the PD host setup so the binding records the absolute governance workspace directory.');
}
if (typeof binding.runtimeDir !== 'string' || !path.isAbsolute(binding.runtimeDir)) {
  fail('binding_runtime_dir_invalid', 'Re-run the PD host setup so the binding records the absolute pinned-runtime directory.');
}
if (typeof binding.serverEntry !== 'string' || !path.isAbsolute(binding.serverEntry)) {
  fail('binding_server_entry_invalid', 'Re-run the PD host setup so the binding records the absolute MCP server entry path.');
}
if (!isRecord(binding.versions) || typeof binding.versions.mcpServer !== 'string' || !SEMVER.test(binding.versions.mcpServer)) {
  fail('binding_versions_invalid', 'Re-run the PD host setup to regenerate the binding version record.');
}

// Canonical path: the entry must be exactly the documented server entry for
// this host's runtime layout — not merely an existing JavaScript file.
const expectedEntry = path.join(binding.runtimeDir, ...SERVER_ENTRY_SEGMENTS[host]);
if (!samePath(binding.serverEntry, expectedEntry)) {
  fail(`server_entry_not_canonical:${host}`, 'The binding points outside the documented MCP server entry. Re-run the PD host setup; do not edit mcp-binding.json by hand.');
}

let realRuntimeDir;
try {
  realRuntimeDir = fs.realpathSync(binding.runtimeDir);
} catch {
  fail('runtime_dir_missing', 'The pinned PD runtime is not installed. Re-run the PD host setup to install it.');
}
if (!fs.statSync(realRuntimeDir).isDirectory()) {
  fail('runtime_dir_missing', 'The pinned PD runtime directory is not a directory. Re-run the PD host setup to repair it.');
}

let realEntry;
try {
  realEntry = fs.realpathSync(expectedEntry);
} catch {
  fail('server_entry_missing', 'The pinned PD MCP server is not installed. Re-run the PD host setup to install the pinned runtime.');
}
// Symlink/junction escape defence: an entry that resolves outside the
// recorded runtime tree can never be the installed component.
if (!isInside(realRuntimeDir, realEntry)) {
  fail('server_entry_escape', 'The MCP server entry resolves outside the pinned runtime directory. Re-run the PD host setup; if it repeats, reinstall PD.');
}
if (!fs.statSync(realEntry).isFile()) {
  fail('server_entry_missing', 'The pinned PD MCP server entry is not a file. Re-run the PD host setup to install the pinned runtime.');
}

// Package identity/version: the entry must belong to the installed package,
// and both the binding and (Codex) the plugin runtime pin must agree with the
// bytes on disk. A stale or forged binding cannot silently launch another
// version of the server.
const packageManifest = readJson(path.join(path.dirname(path.dirname(realEntry)), 'package.json'));
if (packageManifest === undefined || packageManifest.name !== SERVER_PACKAGE_NAME) {
  fail('server_package_identity_mismatch', 'The MCP server entry does not belong to @principles/pd-mcp-server. Re-run the PD host setup to reinstall the pinned component.');
}
if (typeof packageManifest.version !== 'string' || !SEMVER.test(packageManifest.version)) {
  fail('server_package_version_invalid', 'The installed MCP server package version is unreadable. Re-run the PD host setup to reinstall the pinned component.');
}
if (binding.versions.mcpServer !== packageManifest.version) {
  fail(`binding_version_mismatch:${binding.versions.mcpServer}!=${packageManifest.version}`, 'The binding and the installed MCP server disagree. Re-run the PD host setup so both match the runtime pin.');
}
if (host === 'codex') {
  const pin = readJson(path.join(pluginRoot, 'runtime-version.json'));
  if (pin === undefined || typeof pin.mcpServer !== 'string' || !SEMVER.test(pin.mcpServer) || typeof pin.core !== 'string') {
    fail('runtime_pin_invalid', 'The plugin runtime pin is missing or malformed. Reinstall the PD plugin, then re-run $pd-control setup.');
  }
  if (pin.mcpServer !== packageManifest.version) {
    fail(`runtime_pin_mismatch:mcpServer:${pin.mcpServer}!=${packageManifest.version}`, 'The installed MCP server no longer matches the plugin runtime pin. Re-run $pd-control setup to realign the runtime.');
  }
  if (typeof binding.versions.core === 'string' && binding.versions.core !== pin.core) {
    fail(`runtime_pin_mismatch:core:${binding.versions.core}!=${pin.core}`, 'The binding core version no longer matches the plugin runtime pin. Re-run $pd-control setup to realign the runtime.');
  }
}

let workspaceStat;
try {
  workspaceStat = fs.statSync(binding.workspaceDir);
} catch {
  fail('binding_workspace_missing', 'The bound governance workspace no longer exists. Re-install PD for this host or re-run setup with the correct workspace.');
}
if (!workspaceStat.isDirectory()) {
  fail('binding_workspace_not_directory', 'Re-run the PD host setup so the binding points at the governance workspace directory.');
}

// The binding is the ONLY authority for the business workspace (SPEC §3.5):
// it overrides any inherited value and the server validates it fail-closed.
process.env.PD_MCP_WORKSPACE_DIR = binding.workspaceDir;
process.env.PD_MCP_HOST = host;

// Run the shared server entry in-process (single process per host). Nothing
// above imports the server, so a rejected binding never emits MCP traffic.
import(pathToFileURL(realEntry).href)
  .then((mod) => {
    if (mod === null || typeof mod !== 'object' || typeof mod.main !== 'function') {
      fail('server_entry_invalid', 'The pinned MCP server entry does not export main(). Re-run the PD host setup.');
    }
    return mod.main(process.env).then((code) => {
      if (code !== 0) process.exit(code);
      // code 0: the server owns the event loop from here (stdio transport).
    });
  })
  .catch((error) => {
    // Sanitized: category only — no message/stack/path leak to host logs.
    const kind = error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error';
    fail(`server_startup_failed:${kind.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`, 'Re-run the PD host setup; if it repeats, run the PD host health check (pd health).');
  });
