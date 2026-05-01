#!/usr/bin/env node
/**
 * Runtime V2 Chain UAT — automated acceptance test for the full pain-to-ledger chain.
 *
 * Usage:
 *   node scripts/uat/runtime-v2-chain-uat.mjs --workspace <path> --count <N>
 *
 * Runs N consecutive pd pain record commands and verifies:
 *   - Every run produces painId, taskId, runId, artifactId, candidateIds, ledgerEntryIds
 *   - Candidate audit returns "ok" after each run
 *   - Consistency and latency statistics
 *
 * Requirements:
 *   - XIAOMI_KEY environment variable
 *   - Built pd-cli (npx pd must be resolvable)
 */

import { execSync } from 'child_process';
import * as path from 'path';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { workspace: '', count: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' || argv[i] === '-w') {
      args.workspace = argv[++i] ?? '';
    } else if (argv[i] === '--count') {
      args.count = parseInt(argv[++i] ?? '5', 10);
    }
  }
  return args;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJsonOutput(output) {
  // Try direct parse first (output is pure JSON)
  try {
    return JSON.parse(output.trim());
  } catch {
    // ignore
  }
  // Find the last line that looks like a JSON object
  const lines = output.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        return JSON.parse(line);
      } catch {
        // keep searching
      }
    }
  }
  throw new Error(`No JSON found in output: ${output.slice(0, 200)}`);
}

function now() {
  return new Date().toISOString();
}

function log(msg) {
  console.log(`[${now()}] ${msg}`);
}

function warn(msg) {
  console.warn(`[${now()}] WARN: ${msg}`);
}

function error(msg) {
  console.error(`[${now()}] ERROR: ${msg}`);
}

function pd(args, workspace, timeoutMs = 300_000) {
  // All args are program-generated (no user input) — safe for shell execution
  const cmd = `pd ${args.join(' ')} --workspace "${workspace}"`;
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.stdout) return err.stdout;
    if (err.stderr) throw new Error(err.stderr?.toString() ?? err.message);
    throw err;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.workspace) {
    error('--workspace <path> is required');
    process.exit(1);
  }

  const count = Math.max(1, Math.min(args.count, 50));
  const workspace = path.resolve(args.workspace);

  log(`Runtime V2 Chain UAT — workspace: ${workspace}, count: ${count}`);
  log('');

  // 1. Check environment
  if (!process.env.XIAOMI_KEY) {
    error('XIAOMI_KEY environment variable not set');
    process.exit(1);
  }
  log('✓ XIAOMI_KEY is set');

  // 2. Runtime probe
  log('Probing runtime...');
  try {
    const probeOut = pd(['runtime', 'probe', '--runtime', 'pi-ai', '--json'], workspace, 60_000);
    const probe = parseJsonOutput(probeOut);
    if (probe.status === 'succeeded' && probe.health?.healthy) {
      log(`✓ Runtime probe OK (${probe.provider}/${probe.model})`);
    } else {
      warn(`Runtime probe returned status=${probe.status}, health=${JSON.stringify(probe.health)}`);
    }
  } catch (err) {
    error(`Runtime probe failed: ${err.message}`);
    process.exit(1);
  }

  // 3. Run N pain records
  log('');
  log(`Running ${count} pain record iterations...`);
  log('');

  const results = [];

  for (let i = 0; i < count; i++) {
    const reason = `UAT chain test ${i + 1}/${count} — ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    log(`[${i + 1}/${count}] Recording pain: "${reason}"`);

    const iterStart = Date.now();
    let recordOutput;
    try {
      recordOutput = pd(['pain', 'record', '--reason', reason, '--score', '85', '--source', 'manual', '--json'], workspace);
    } catch (err) {
      results.push({
        iteration: i + 1,
        status: 'script_error',
        failureCategory: 'runtime_unavailable',
        error: err.message,
        wallTimeMs: Date.now() - iterStart,
      });
      error(`  FAIL: ${err.message}`);
      continue;
    }

    const wallTimeMs = Date.now() - iterStart;
    let parsed;
    try {
      parsed = parseJsonOutput(recordOutput);
    } catch {
      results.push({
        iteration: i + 1,
        status: 'parse_error',
        failureCategory: 'output_invalid',
        rawOutput: recordOutput.slice(0, 500),
        wallTimeMs,
      });
      error('  FAIL: could not parse JSON output');
      continue;
    }

    // Run candidate audit
    let auditStatus = 'unknown';
    try {
      const auditOut = pd(['candidate', 'audit', '--json'], workspace, 30_000);
      const audit = parseJsonOutput(auditOut);
      auditStatus = audit.status ?? 'unknown';
    } catch (err) {
      auditStatus = `audit_error: ${err.message}`;
    }

    const entry = {
      iteration: i + 1,
      painId: parsed.painId,
      taskId: parsed.taskId,
      runId: parsed.runId,
      artifactId: parsed.artifactId,
      candidateIds: parsed.candidateIds ?? [],
      ledgerEntryIds: parsed.ledgerEntryIds ?? [],
      status: parsed.status ?? 'unknown',
      failureCategory: parsed.failureCategory,
      latencyMs: parsed.latencyMs,
      wallTimeMs,
      auditStatus,
    };

    results.push(entry);

    const icon = entry.status === 'succeeded' ? '✓' : '✗';
    log(`  ${icon} status=${entry.status} ` +
      `candidates=${entry.candidateIds.length} ` +
      `ledger=${entry.ledgerEntryIds.length} ` +
      `latency=${entry.wallTimeMs}ms ` +
      `audit=${auditStatus}` +
      (entry.failureCategory ? ` category=${entry.failureCategory}` : ''));
  }

  // 4. Summary
  log('');
  log('═'.repeat(60));
  log('SUMMARY');
  log('═'.repeat(60));

  const succeeded = results.filter(r => r.status === 'succeeded');
  const failed = results.filter(r => r.status === 'failed' || r.status === 'script_error' || r.status === 'parse_error');
  const successRate = count > 0 ? succeeded.length / count : 0;

  // Latency stats
  const latencies = results
    .map(r => r.wallTimeMs)
    .filter(ms => typeof ms === 'number' && ms > 0)
    .sort((a, b) => a - b);

  function percentile(arr, p) {
    if (arr.length === 0) return undefined;
    const idx = Math.ceil(arr.length * p / 100) - 1;
    return arr[Math.max(0, idx)];
  }

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  // Failure categories
  const failuresByCategory = {};
  for (const r of results) {
    const cat = r.failureCategory ?? (r.status !== 'succeeded' ? 'unknown' : null);
    if (cat) {
      failuresByCategory[cat] = (failuresByCategory[cat] ?? 0) + 1;
    }
  }

  // Ledger consistency
  const auditsOk = results.filter(r => r.auditStatus === 'ok').length;
  const ledgerConsistencyOk = auditsOk === results.length;

  // CandidateIds/LedgerEntryIds non-empty check
  const allHaveCandidates = results.every(r => r.candidateIds && r.candidateIds.length > 0);
  const allHaveLedger = results.every(r => r.ledgerEntryIds && r.ledgerEntryIds.length > 0);

  const summary = {
    generatedAt: now(),
    workspace,
    totalIterations: count,
    successful: succeeded.length,
    failed: failed.length,
    successRate: Number(successRate.toFixed(2)),
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    failuresByCategory,
    ledgerConsistencyOk,
    allHaveCandidates,
    allHaveLedger,
  };

  console.log(JSON.stringify(summary, null, 2));

  log('');
  if (successRate === 1 && allHaveCandidates && allHaveLedger && ledgerConsistencyOk) {
    log('✓ ALL CHECKS PASSED');
  } else {
    if (successRate < 1) warn(`successRate=${successRate} (target: 1.0)`);
    if (!allHaveCandidates) warn('Some iterations have empty candidateIds');
    if (!allHaveLedger) warn('Some iterations have empty ledgerEntryIds');
    if (!ledgerConsistencyOk) warn('Ledger consistency degraded');
    process.exit(1);
  }
}

main().catch(err => {
  error(`Fatal: ${err.message}`);
  process.exit(1);
});
