#!/usr/bin/env node
/**
 * PRI-343: postinstall hook — auto-configure allowConversationAccess.
 *
 * Runs during `npm install` (i.e. `openclaw plugins install principles-disciple`).
 * Sets plugins.entries['principles-disciple'].hooks.allowConversationAccess = true
 * in ~/.openclaw/openclaw.json so users never need to manually run
 * `openclaw config set ... allowConversationAccess true`.
 *
 * Design constraints:
 *  - Idempotent: safe to run multiple times.
 *  - BOM-resistant: strip U+FEFF before JSON.parse (PowerShell UTF8 writes add BOM).
 *  - Atomic write: temp file + rename to avoid partial writes.
 *  - Never fail the install: all errors are caught and logged to stderr.
 *  - No dependencies: pure Node.js built-ins (fs, path, os).
 */
'use strict';

const { existsSync, readFileSync, writeFileSync, renameSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const PLUGIN_ID = 'principles-disciple';
const CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

function log(msg) {
  process.stderr.write(`[PD:postinstall] ${msg}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

try {
  if (!existsSync(CONFIG_PATH)) {
    // OpenClaw not initialized yet — nothing to configure.
    // The plugin's module-level auto-fix will handle this when OpenClaw is set up later.
    log(`No openclaw.json at ${CONFIG_PATH} — skipping (will auto-fix on first load).`);
    process.exit(0);
  }

  // BOM-resistant read
  const raw = readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  const cfg = JSON.parse(raw);

  if (!isRecord(cfg)) {
    log(`openclaw.json is not a JSON object — skipping.`);
    process.exit(0);
  }

  // Ensure plugins.entries path exists
  if (!isRecord(cfg.plugins)) cfg.plugins = {};
  if (!isRecord(cfg.plugins.entries)) cfg.plugins.entries = {};

  const rawEntry = cfg.plugins.entries[PLUGIN_ID];
  const entry = isRecord(rawEntry) ? rawEntry : { enabled: true };

  if (!isRecord(entry.hooks)) entry.hooks = {};

  if (entry.hooks.allowConversationAccess === true) {
    // Already configured — nothing to do.
    process.exit(0);
  }

  // Set allowConversationAccess = true
  entry.hooks.allowConversationAccess = true;
  cfg.plugins.entries[PLUGIN_ID] = entry;

  // Atomic write: temp file + rename
  const tmpPath = CONFIG_PATH + '.tmp.' + Date.now();
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  renameSync(tmpPath, CONFIG_PATH);

  log(`allowConversationAccess auto-configured to true in ${CONFIG_PATH}`);
} catch (err) {
  // Never fail the install — the plugin's module-level auto-fix will retry on load.
  log(`Auto-configuration failed: ${err instanceof Error ? err.message : String(err)}`);
  log(`The plugin will retry on first load. If it still fails, run:`);
  log(`  openclaw config set plugins.entries.principles-disciple.hooks.allowConversationAccess true`);
  process.exit(0);
}
