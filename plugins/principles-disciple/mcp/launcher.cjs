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
 * plugin payload root, validates it strictly, injects the trusted env, and
 * runs the shared server entry IN-PROCESS — one process per host, and the
 * host owns this PID's lifecycle (no daemon, no extra children).
 *
 * Fail-closed: a missing/invalid binding, workspace, or server entry exits
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

function fail(reason, nextAction) {
  process.stderr.write(JSON.stringify({ launcher: 'pd-mcp', status: 'failed', reason, nextAction }) + '\n');
  process.exit(1);
}

// rc-1/rc-3/rc-5: the binding file is read as untrusted; every field is
// validated before use and unknown content is never coerced.
let raw;
try {
  raw = fs.readFileSync(path.join(__dirname, '..', 'mcp-binding.json'), 'utf8');
} catch {
  fail('binding_missing', 'Re-run the PD host setup (Codex: $pd-control setup) so mcp-binding.json is written into the plugin directory.');
}
let binding;
try {
  binding = JSON.parse(raw);
} catch {
  fail('binding_unreadable', 'Re-run the PD host setup to regenerate a valid mcp-binding.json.');
}
if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
  fail('binding_invalid', 'Re-run the PD host setup to regenerate a valid mcp-binding.json.');
}
if (binding.schemaVersion !== BINDING_SCHEMA) {
  fail(`binding_schema_unsupported:${typeof binding.schemaVersion === 'string' ? binding.schemaVersion : 'non-string'}`, 'The plugin and the PD installation come from different generations. Re-run the PD host setup after updating PD.');
}
if (!KNOWN_HOSTS.includes(binding.host)) {
  fail('binding_host_invalid', 'Re-run the PD host setup; the host marker is written by the PD installer and must not be edited.');
}
if (typeof binding.workspaceDir !== 'string' || !path.isAbsolute(binding.workspaceDir)) {
  fail('binding_workspace_invalid', 'Re-run the PD host setup so the binding records the absolute governance workspace directory.');
}
if (typeof binding.serverEntry !== 'string' || !path.isAbsolute(binding.serverEntry)) {
  fail('binding_server_entry_invalid', 'Re-run the PD host setup so the binding records the absolute MCP server entry path.');
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
try {
  if (!fs.statSync(binding.serverEntry).isFile()) throw new Error('not a file');
} catch {
  fail('server_entry_missing', 'The pinned PD MCP server is not installed. Re-run the PD host setup to install the pinned runtime.');
}

// The binding is the ONLY authority for the business workspace (SPEC §3.5):
// it overrides any inherited value and the server validates it fail-closed.
process.env.PD_MCP_WORKSPACE_DIR = binding.workspaceDir;
process.env.PD_MCP_HOST = binding.host;

// Run the shared server entry in-process (single process per host).
import(pathToFileURL(binding.serverEntry).href)
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
