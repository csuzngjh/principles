#!/usr/bin/env node
/**
 * PD-Lab v0.3 T3b test fixture — a deterministic STUB pd-cli.
 *
 * The T3b wiring tests (scripts/__tests__/pd-lab-t3b-harness-wiring.test.ts)
 * copy this file into each synthetic arm worktree as
 * `packages/pd-cli/dist/index.js`. The harness spawns it exactly like the
 * real pd-cli; the stub:
 *   - records every invocation (cmd + full argv) as a JSON line into
 *     `<dir-of---workspace>/stub-cli.log`, so tests can assert the EXACT
 *     child argument vector (score/reason/session/host contract) without
 *     any environment plumbing;
 *   - honors the pain-record contract shapes the harness depends on:
 *     rejects --reason > 500 (the real CLI's MAX_REASON_LENGTH hard reject),
 *     simulates a session binding failure for the T3B_BINDING_FAIL_SENTINEL
 *     marker, and answers a parseable {taskId} JSON on success.
 * It never touches real data, the network, or any model; its only writes are
 * the one append-only log line per invocation inside the synthetic
 * experiment tree.
 */
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const wsIndex = args.indexOf('--workspace');
if (wsIndex >= 0 && wsIndex + 1 < args.length) {
  const log = path.join(path.dirname(String(args[wsIndex + 1])), 'stub-cli.log');
  fs.appendFileSync(log, JSON.stringify({ cmd: args.slice(0, 2).join(' '), args, at: new Date().toISOString() }) + '\n');
}
if (args[0] === 'pain' && args[1] === 'record') {
  const i = args.indexOf('--reason');
  const reason = i >= 0 ? String(args[i + 1]) : '';
  if (reason.includes('T3B_BINDING_FAIL_SENTINEL')) {
    process.stdout.write('{"error":"session_not_found"}');
    process.exit(1);
  }
  if (reason.length > 500) {
    process.stderr.write('--reason exceeds MAX_REASON_LENGTH=500');
    process.exit(1);
  }
  const s = args.indexOf('--session');
  const sid = s >= 0 ? args[s + 1] : null;
  process.stdout.write(JSON.stringify({ ok: true, taskId: 'diagnosis_' + (sid ?? 'unbound'), sessionId: sid }));
  process.exit(0);
}
process.stdout.write('{}');
process.exit(0);
