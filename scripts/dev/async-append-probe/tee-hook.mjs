#!/usr/bin/env node
/**
 * Probe-only hook tee: records the host stdin/stdout of the REAL pd-hook, then
 * forwards the hook's stdout to the host unchanged. It exists so the probe can
 * show which hook invocation produced the appended directive, without mocking
 * the hook itself.
 *
 * Env:
 *   PROBE_HOOK     absolute path to packages/codex-adapter/dist/pd-hook.js
 *   PROBE_LOG_DIR  directory for one JSON record per invocation
 *
 * argv[2] is the hook event name (SessionStart / UserPromptSubmit /
 * PreToolUse / PostToolUse / Stop) as configured in CODEX_HOME/hooks.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const event = process.argv[2] ?? 'unknown';
const hook = process.env.PROBE_HOOK;
const logDir = process.env.PROBE_LOG_DIR;
if (!hook || !logDir) {
  process.stderr.write('tee-hook: PROBE_HOOK and PROBE_LOG_DIR are required\n');
  process.exit(1);
}

const stdin = fs.readFileSync(0, 'utf8');
const startedAt = Date.now();
const result = spawnSync(process.execPath, [hook], {input: stdin, env: process.env, encoding: 'utf8', windowsHide: true});
const completedAt = Date.now();
const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';

let parsed = null;
try {
  parsed = JSON.parse(stdin);
} catch {
  parsed = null;
}
fs.mkdirSync(logDir, {recursive: true});
fs.writeFileSync(
  path.join(logDir, `${event}-${startedAt}-${process.pid}.json`),
  JSON.stringify({event, startedAt, completedAt, stdin: parsed, stdout, stderr, status: result.status}, null, 2),
);
process.stdout.write(stdout);
process.exit(result.status ?? 0);
