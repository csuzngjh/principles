#!/usr/bin/env node
/**
 * Runtime V2 Chain UAT — automated acceptance test for the full pain-to-ledger chain.
 *
 * Usage:
 *   node scripts/uat/runtime-v2-chain-uat.mjs --workspace <path> --count <N>
 *
 * PRI-334: By default, this script uses a safe temp workspace to prevent
 * pollution of production workspaces. Use --workspace to override with a
 * specific path, or --allow-production-workspace to force production writes.
 *
 * Runs N consecutive pd pain record commands and verifies:
 *   - Every run produces painId, taskId, runId, artifactId, candidateIds, ledgerEntryIds
 *   - Candidate audit returns "ok" after each run
 *   - Consistency and latency statistics
 *
 * Requirements:
 *   - MINIMAX_CN_API_KEY environment variable
 *   - Built pd-cli (packages/pd-cli/dist/index.js must exist)
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Production workspace detection (PRI-334) ───────────────────────────────────

const PRODUCTION_WORKSPACE_PATHS = [
  path.resolve('D:\\.openclaw\\workspace'),
  path.resolve('C:\\.openclaw\\workspace'),
  path.resolve('C:\\Users\\Administrator\\.openclaw\\workspace'),
  path.resolve('C:\\Users\\Admin\\.openclaw\\workspace'),
  path.resolve(path.join(os.homedir(), '.openclaw', 'workspace')),
];

function isProductionWorkspace(resolvedPath) {
  const normalized = resolvedPath.toLowerCase();
  for (const prodPath of PRODUCTION_WORKSPACE_PATHS) {
    const normalizedProd = prodPath.toLowerCase();
    if (normalized === normalizedProd || normalized.startsWith(normalizedProd + path.sep)) {
      return true;
    }
  }
  return false;
}

function getSafeUatWorkspace() {
  return path.join(os.tmpdir(), 'pd-uat-workspace');
}

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { workspace: '', count: 5, allowProductionWorkspace: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' || argv[i] === '-w') {
      args.workspace = argv[++i] ?? '';
    } else if (argv[i] === '--count') {
      args.count = parseInt(argv[++i] ?? '5', 10);
    } else if (argv[i] === '--allow-production-workspace') {
      args.allowProductionWorkspace = true;
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

// ── Cross-platform pd CLI invocation ──────────────────────────────────────────

function findPdCliPath() {
  // Resolve relative to this script's location: scripts/uat/ → packages/pd-cli/dist/
  // Use import.meta.url (ESM) instead of __filename (CJS)
  const currentFile = fileURLToPath(import.meta.url);
  const scriptDir = path.dirname(currentFile);
  const repoRoot = path.resolve(scriptDir, '..', '..');
  const cliPath = path.join(repoRoot, 'packages', 'pd-cli', 'dist', 'index.js');
  if (!existsSync(cliPath)) {
    throw new Error(`pd CLI not found at ${cliPath} — run: npm run build --workspace=@principles/pd-cli`);
  }
  return cliPath;
}

function pd(args, workspace, timeoutMs = 300_000) {
  // Arguments: subcommand args first, then --workspace and path at the end
  // Correct: pd pain record ... --workspace <path>
  const fullArgs = [...args, '--workspace', workspace];
  const cliPath = findPdCliPath();
  const env = { ...process.env };
  try {
    return execFileSync(process.execPath, [cliPath, ...fullArgs], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env,
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

  // PRI-334: Default to safe temp workspace if none specified
  const workspace = args.workspace ? path.resolve(args.workspace) : getSafeUatWorkspace();
  const count = Math.max(1, Math.min(args.count, 50));

  // PRI-334: Guard against production workspace writes
  if (isProductionWorkspace(workspace) && !args.allowProductionWorkspace) {
    error('');
    error('⛔ UAT PRODUCTION WORKSPACE GUARD TRIGGERED');
    error('');
    error(`This script attempted to write to a production workspace:`);
    error(`  ${workspace}`);
    error('');
    error('This is blocked to prevent UAT/test data from polluting your real PD state.');
    error('');
    error('To fix:');
    error(`  - Remove --workspace flag to use the safe temp workspace: ${getSafeUatWorkspace()}`);
    error(`  - Or provide a non-production workspace path`);
    error(`  - Or use --allow-production-workspace flag (NOT RECOMMENDED - this will pollute your production data)`);
    error('');
    process.exit(1);
  }

  if (isProductionWorkspace(workspace) && args.allowProductionWorkspace) {
    warn('--allow-production-workspace is set. UAT will write to production workspace.');
    warn('This is NOT RECOMMENDED and may pollute your real PD state.');
    warn('');
  }

  log(`Runtime V2 Chain UAT — workspace: ${workspace}, count: ${count}`);
  log('');

  // 1. Check environment
  if (!process.env.MINIMAX_CN_API_KEY) {
    error('MINIMAX_CN_API_KEY environment variable not set');
    process.exit(1);
  }
  log('✓ MINIMAX_CN_API_KEY is set');

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
