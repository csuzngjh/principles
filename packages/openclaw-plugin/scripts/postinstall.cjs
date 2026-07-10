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
 *  - File-locked: uses O_EXCL lock file to prevent races with concurrent writers.
 *  - Never fail the install: all errors are caught and logged to stderr.
 *  - No dependencies: pure Node.js built-ins (fs, path, os).
 */
'use strict';

const { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, statSync, writeSync, fsyncSync, constants } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const PLUGIN_ID = 'principles-disciple';
const CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');
const LOCK_PATH = CONFIG_PATH + '.lock';
const LOCK_MAX_RETRIES = 20;
const LOCK_BASE_DELAY_MS = 25;

function log(msg) {
  process.stderr.write(`[PD:postinstall] ${msg}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryAcquireLock() {
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
    const fd = openSync(LOCK_PATH, flags, 0o600);
    try {
      writeSync(fd, String(process.pid));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function readLockPid() {
  try {
    const content = readFileSync(LOCK_PATH, 'utf8');
    const pid = parseInt(content.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function cleanupStaleLock() {
  try {
    const stat = statSync(LOCK_PATH);
    const pid = readLockPid();
    const isStale = Date.now() - stat.mtimeMs > 10000;
    const isDead = pid === null || !isProcessAlive(pid);
    if (isStale || isDead) {
      try {
        unlinkSync(LOCK_PATH);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function acquireLockSync() {
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    if (tryAcquireLock()) return true;
    if (!cleanupStaleLock()) {
      const delay = LOCK_BASE_DELAY_MS * Math.pow(2, Math.min(attempt, 5));
      const jitter = delay * 0.2 * Math.random();
      const waitUntil = Date.now() + delay + jitter;
      while (Date.now() < waitUntil) { /* spin */ }
      continue;
    }
    if (tryAcquireLock()) return true;
  }
  return false;
}

function releaseLock() {
  try {
    const pid = readLockPid();
    if (pid === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // best effort
  }
}

try {
  if (!existsSync(CONFIG_PATH)) {
    log(`No openclaw.json at ${CONFIG_PATH} — skipping (will auto-fix on first load).`);
    process.exit(0);
  }

  const locked = acquireLockSync();
  if (!locked) {
    log(`Could not acquire config lock — skipping (will auto-fix on first load).`);
    process.exit(0);
  }

  let exitCode = 0;
  try {
    // BOM-resistant read
    const raw = readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
    const cfg = JSON.parse(raw);

    if (!isRecord(cfg)) {
      log(`openclaw.json is not a JSON object — skipping.`);
    } else {
      // Ensure plugins.entries path exists
      if (!isRecord(cfg.plugins)) cfg.plugins = {};
      if (!isRecord(cfg.plugins.entries)) cfg.plugins.entries = {};

      const rawEntry = cfg.plugins.entries[PLUGIN_ID];
      const entry = isRecord(rawEntry) ? rawEntry : { enabled: true };

      if (!isRecord(entry.hooks)) entry.hooks = {};

      if (entry.hooks.allowConversationAccess !== true) {
        // Set allowConversationAccess = true
        entry.hooks.allowConversationAccess = true;
        cfg.plugins.entries[PLUGIN_ID] = entry;

        // Atomic write: temp file + rename
        const tmpPath = CONFIG_PATH + '.tmp.' + Date.now();
        writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
        renameSync(tmpPath, CONFIG_PATH);

        log(`allowConversationAccess auto-configured to true in ${CONFIG_PATH}`);
      }
    }
  } catch (innerErr) {
    log(`Auto-configuration failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
    log(`The plugin will retry on first load. If it still fails, run:`);
    log(`  openclaw config set plugins.entries.principles-disciple.hooks.allowConversationAccess true`);
  } finally {
    releaseLock();
  }
  process.exit(exitCode);
} catch (err) {
  // Never fail the install — the plugin's module-level auto-fix will retry on load.
  log(`Auto-configuration failed: ${err instanceof Error ? err.message : String(err)}`);
  log(`The plugin will retry on first load. If it still fails, run:`);
  log(`  openclaw config set plugins.entries.principles-disciple.hooks.allowConversationAccess true`);
  process.exit(0);
}
