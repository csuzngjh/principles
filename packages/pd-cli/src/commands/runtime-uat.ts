/**
 * pd runtime uat command — Runtime V2 chain UAT baseline runner.
 *
 * Usage:
 *   pd runtime uat --workspace <path> --count <N> [--min-success-rate <rate>] [--json]
 *
 * Runs N consecutive pd pain record iterations and verifies:
 *   - Every run produces painId, taskId, runId, artifactId, candidateIds, ledgerEntryIds
 *   - Candidate audit returns "ok" after each run
 *   - Consistency and latency statistics with threshold-based exit
 *
 * Requirements:
 *   - MINIMAX_CN_API_KEY environment variable
 *   - Built pd-cli (node packages/pd-cli/dist/index.js must be resolvable)
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'path';
import * as fs from 'fs';
import {
  guardUatWorkspace,
  formatGuardRefusal,
  type GuardResult,
  type GuardRefusal,
} from '../utils/production-workspace-guard.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface UatOptions {
  workspace?: string;
  count?: number;
  minSuccessRate?: number;
  json?: boolean;
  allowProductionWorkspaceForUat?: boolean;
}

interface PainRecordResult {
  iteration: number;
  painId?: string;
  taskId?: string;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  status: string;
  failureCategory?: string;
  latencyMs?: number;
  wallTimeMs: number;
  auditStatus: string;
  error?: string;
  rawOutput?: string;
}

interface UatSummary {
  generatedAt: string;
  workspace: string;
  totalRuns: number;
  successful: number;
  failed: number;
  successRate: number;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  failuresByCategory: Record<string, number>;
  ledgerConsistencyOk: boolean;
  allHaveCandidates: boolean;
  allHaveLedger: boolean;
  perRun: PainRecordResult[];
}

// ── Argument parsing ─────────────────────────────────────────────────────────

export function parseUatArgs(argv: string[]): UatOptions {
  const args: UatOptions = { count: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace' || argv[i] === '-w') {
      args.workspace = argv[++i] ?? '';
    } else if (argv[i] === '--count') {
      const n = parseInt(argv[++i] ?? '5', 10);
      args.count = isNaN(n) ? 5 : n;
    } else if (argv[i] === '--min-success-rate') {
      const rate = parseFloat(argv[++i] ?? '1.0');
      args.minSuccessRate = isNaN(rate) ? 1.0 : rate;
    } else if (argv[i] === '--allow-production-workspace-for-uat') {
      args.allowProductionWorkspaceForUat = true;
    }
  }
  return args;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output.trim());
  } catch {
    // Find the last line that looks like a JSON object
    const lines = output.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const rawLine = lines[i];
      if (!rawLine) continue;
      const line = rawLine.trim();
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
}

export function percentile(arr: number[], p: number): number | undefined {
  if (arr.length === 0) return undefined;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Cross-platform pd CLI invocation ─────────────────────────────────────────

function findPdCliPath(): string {
  // Resolve path relative to this file's location in dist/commands/
  // dist/commands/runtime-uat.js → dist/index.js
  // Use import.meta.url (ESM) instead of __filename (CJS)
  const currentFile = fileURLToPath(import.meta.url);
  const distDir = path.dirname(currentFile);
  const cliPath = path.resolve(distDir, '..', 'index.js');
  if (fs.existsSync(cliPath)) return cliPath;
  throw new Error(`pd CLI not found at ${cliPath} — run: npm run build --workspace=@principles/pd-cli`);
}

function pd(args: string[], workspace: string, timeoutMs = 300_000): string {
  // Arguments: subcommand args first, then --workspace and path at the end
  // Correct: node pd pain record ... --workspace <path>
  const fullArgs = [...args, '--workspace', workspace];
  const cliPath = findPdCliPath();
  try {
    return execFileSync(process.execPath, [cliPath, ...fullArgs], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    if (err instanceof Error && // eslint-disable-next-line no-restricted-syntax -- 'in' required for Error subtype narrowing (err.code access)
    'code' in err && (err as { code: string }).code === 'ENOENT') {
      throw new Error(`pd CLI not found at ${cliPath} — run: npm run build --workspace=@principles/pd-cli`, { cause: err });
    }
    if (err && typeof err === 'object' && Object.hasOwn(err, 'stdout')) {
      return String((err as { stdout: unknown }).stdout);
    }
    throw err;
  }
}

interface IterationConfig {
  iteration: number;
  reason: string;
  workspace: string;
  timeoutMs?: number;
}

export function runUatIteration(config: IterationConfig): PainRecordResult {
  const { iteration, reason, workspace, timeoutMs = 300_000 } = config;
  const iterStart = Date.now();
  let recordOutput: string;
  try {
    recordOutput = pd(['pain', 'record', '--reason', reason, '--score', '85', '--source', 'manual', '--json'], workspace, timeoutMs);
  } catch (err: unknown) {
    const cause = err instanceof Error ? err.message : String(err);
    return {
      iteration,
      status: 'script_error',
      failureCategory: 'runtime_unavailable',
      error: cause,
      wallTimeMs: Date.now() - iterStart,
      auditStatus: 'unknown',
      candidateIds: [],
      ledgerEntryIds: [],
    };
  }

  const wallTimeMs = Date.now() - iterStart;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonOutput(recordOutput) as Record<string, unknown>;
  } catch {
    return {
      iteration,
      status: 'parse_error',
      failureCategory: 'output_invalid',
      rawOutput: recordOutput.slice(0, 500),
      wallTimeMs,
      auditStatus: 'unknown',
      candidateIds: [],
      ledgerEntryIds: [],
    };
  }

  let auditStatus: string;
  try {
    const auditOut = pd(['candidate', 'audit', '--json'], workspace, 30_000);
    const audit = parseJsonOutput(auditOut) as { status?: string };
    auditStatus = audit.status ?? 'unknown';
  } catch {
    auditStatus = 'audit_error';
  }

  return {
    iteration,
    painId: parsed.painId as string | undefined,
    taskId: parsed.taskId as string | undefined,
    runId: parsed.runId as string | undefined,
    artifactId: parsed.artifactId as string | undefined,
    candidateIds: (parsed.candidateIds as string[]) ?? [],
    ledgerEntryIds: (parsed.ledgerEntryIds as string[]) ?? [],
    status: parsed.status as string ?? 'unknown',
    failureCategory: parsed.failureCategory as string | undefined,
    latencyMs: parsed.latencyMs as number | undefined,
    wallTimeMs,
    auditStatus,
  };
}

export function computeUatSummary(results: PainRecordResult[], workspace: string): UatSummary {
  const succeeded = results.filter(r => r.status === 'succeeded');
  const failed = results.filter(r => r.status === 'failed' || r.status === 'script_error' || r.status === 'parse_error');
  const successRate = results.length > 0 ? succeeded.length / results.length : 0;

  const latencies = results
    .map(r => r.wallTimeMs)
    .filter(ms => typeof ms === 'number' && ms > 0);

  const failuresByCategory: Record<string, number> = {};
  for (const r of results) {
    const cat = r.failureCategory ?? (r.status !== 'succeeded' ? 'unknown' : null);
    if (cat) {
      failuresByCategory[cat] = (failuresByCategory[cat] ?? 0) + 1;
    }
  }

  const auditsOk = results.filter(r => r.auditStatus === 'ok').length;
  const ledgerConsistencyOk = auditsOk === results.length;
  const allHaveCandidates = results.every(r => r.candidateIds && r.candidateIds.length > 0);
  const allHaveLedger = results.every(r => r.ledgerEntryIds && r.ledgerEntryIds.length > 0);

  return {
    generatedAt: new Date().toISOString(),
    workspace,
    totalRuns: results.length,
    successful: succeeded.length,
    failed: failed.length,
    successRate: Number(successRate.toFixed(2)),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    failuresByCategory,
    ledgerConsistencyOk,
    allHaveCandidates,
    allHaveLedger,
    perRun: results,
  };
}

export function shouldExitWithError(summary: UatSummary, minSuccessRate = 1.0): boolean {
  if (summary.successRate < minSuccessRate) return true;
  if (!summary.ledgerConsistencyOk) return true;
  if (!summary.allHaveCandidates) return true;
  if (!summary.allHaveLedger) return true;
  return false;
}

// ── CLI handler ───────────────────────────────────────────────────────────────

export async function handleRuntimeUat(opts: UatOptions): Promise<void> {
  const workspace = opts.workspace
    ? path.resolve(opts.workspace)
    : '';

  const count = Math.max(1, Math.min(opts.count ?? 5, 50));
  const minSuccessRate = opts.minSuccessRate ?? 1.0;

  if (!workspace) {
    console.error('Error: --workspace <path> is required');
    process.exit(1);
    return;
  }

  // PRI-334: Guard against writing to production workspace
  const guardResult: GuardResult = guardUatWorkspace(workspace, 'pd runtime uat');

  if (guardResult.refused && !opts.allowProductionWorkspaceForUat) {
    // Fail loud with structured reason and nextAction (EP-03/EP-04)
    const refused: GuardRefusal = guardResult;
    const refusalOutput = formatGuardRefusal(
      refused,
      'pd runtime uat',
      !!opts.json
    );

    if (opts.json) {
      console.log(refusalOutput);
    } else {
      console.error(refusalOutput);
    }

    process.exit(1);
    return;
  }

  if (guardResult.refused && opts.allowProductionWorkspaceForUat) {
    // Escape hatch used: warn but allow
    console.error('[pd-cli] WARNING: --allow-production-workspace-for-uat is set.');
    console.error('  Test/synthetic data will be written to your production workspace.');
    console.error('  This is not recommended and may pollute your real PD state.');
    console.error('');
  }

  console.error(`[${new Date().toISOString()}] Runtime V2 Chain UAT — workspace: ${workspace}, count: ${count}`);

  // Check MINIMAX_CN_API_KEY
  if (!process.env.MINIMAX_CN_API_KEY) {
    console.error('Error: MINIMAX_CN_API_KEY environment variable not set');
    process.exit(1);
    return;
  }

  const results: PainRecordResult[] = [];

  for (let i = 0; i < count; i++) {
    const reason = `UAT chain test ${i + 1}/${count} — ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = runUatIteration({ iteration: i + 1, reason, workspace });
    results.push(result);

    const icon = result.status === 'succeeded' ? '✓' : '✗';
    console.error(
      `  ${icon} iter=${result.iteration} status=${result.status} ` +
      `candidates=${result.candidateIds.length} ` +
      `ledger=${result.ledgerEntryIds.length} ` +
      `wallTime=${result.wallTimeMs}ms` +
      (result.failureCategory ? ` category=${result.failureCategory}` : '')
    );
  }

  const summary = computeUatSummary(results, workspace);

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error('');
    console.error('═'.repeat(60));
    console.error('UAT SUMMARY');
    console.error('═'.repeat(60));
    console.error(`  totalRuns:          ${summary.totalRuns}`);
    console.error(`  successful:         ${summary.successful}`);
    console.error(`  failed:             ${summary.failed}`);
    console.error(`  successRate:        ${summary.successRate}`);
    if (summary.p50LatencyMs !== undefined) console.error(`  p50LatencyMs:       ${summary.p50LatencyMs}`);
    if (summary.p95LatencyMs !== undefined) console.error(`  p95LatencyMs:       ${summary.p95LatencyMs}`);
    console.error(`  ledgerConsistencyOk:${summary.ledgerConsistencyOk}`);
    console.error(`  allHaveCandidates:  ${summary.allHaveCandidates}`);
    console.error(`  allHaveLedger:      ${summary.allHaveLedger}`);
    const cats = Object.entries(summary.failuresByCategory);
    if (cats.length > 0) {
      console.error(`  failuresByCategory: ${JSON.stringify(summary.failuresByCategory)}`);
    }
  }

  if (shouldExitWithError(summary, minSuccessRate)) {
    console.error('');
    console.error(`FAIL: successRate=${summary.successRate} (threshold: ${minSuccessRate}) ` +
      `ledger=${summary.ledgerConsistencyOk} candidates=${summary.allHaveCandidates} ledger=${summary.allHaveLedger}`);
    process.exit(1);
    return;
  }

  console.error('');
  console.error('✓ ALL CHECKS PASSED');
}