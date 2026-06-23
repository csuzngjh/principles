#!/usr/bin/env node

/**
 * Benchmark Comparison Script
 *
 * Compares two vitest bench-results.json files and reports p99 latency
 * regression. Exits with code 1 if any benchmark regresses beyond threshold.
 *
 * Usage:
 *   node scripts/compare-benchmarks.mjs --baseline <path> --current <path> [--threshold 0.2]
 *
 * Runtime Contract compliance:
 *   - Parsed JSON treated as `unknown`, validated with typeof/Array.isArray/Object.hasOwn
 *   - No `as` bypass, no `any`
 *   - Graceful degradation with warnings when fields missing (Rule 9)
 */

import { readFileSync, existsSync } from 'node:fs';
import { exit } from 'node:process';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const args = { baseline: null, current: null, threshold: 0.2, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--current') args.current = argv[++i];
    else if (a === '--threshold') args.threshold = parseFloat(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/compare-benchmarks.mjs --baseline <path> --current <path> [options]

Options:
  --baseline <path>   Path to baseline bench-results.json (main branch)
  --current <path>    Path to current bench-results.json
  --threshold <num>   Regression threshold (default: 0.2 = 20%)
  --help, -h          Show this help
`);
}

// ---------------------------------------------------------------------------
// JSON parsing with Runtime Contract validation
// ---------------------------------------------------------------------------

/**
 * Safely parse and validate a bench-results.json file.
 * @param {string} filePath
 * @returns {{ results: Array<{ name: string, p99: number | null }>, warnings: string[] }}
 */
export function extractBenchResults(filePath) {
  const warnings = [];
  if (!existsSync(filePath)) {
    return { results: [], warnings: [`File not found: ${filePath}`] };
  }
  let parsed;
  try {
    const raw = readFileSync(filePath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return { results: [], warnings: [`JSON parse error: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { results: [], warnings: ['Root is not an object'] };
  }
  const root = /** @type {Record<string, unknown>} */ (parsed);
  if (!Object.hasOwn(root, 'files') || !Array.isArray(root.files)) {
    return { results: [], warnings: ['Missing or invalid "files" array'] };
  }
  const results = [];
  for (const file of root.files) {
    if (typeof file !== 'object' || file === null) continue;
    const fileObj = /** @type {Record<string, unknown>} */ (file);
    if (!Object.hasOwn(fileObj, 'groups') || !Array.isArray(fileObj.groups)) continue;
    for (const group of fileObj.groups) {
      if (typeof group !== 'object' || group === null) continue;
      const groupObj = /** @type {Record<string, unknown>} */ (group);
      if (!Object.hasOwn(groupObj, 'benchs') || !Array.isArray(groupObj.benchs)) continue;
      for (const bench of groupObj.benchs) {
        if (typeof bench !== 'object' || bench === null) continue;
        const benchObj = /** @type {Record<string, unknown>} */ (bench);
        const name = Object.hasOwn(benchObj, 'name') && typeof benchObj.name === 'string' ? benchObj.name : 'unknown';
        let p99 = null;
        if (Object.hasOwn(benchObj, 'stats') && typeof benchObj.stats === 'object' && benchObj.stats !== null) {
          const stats = /** @type {Record<string, unknown>} */ (benchObj.stats);
          if (Object.hasOwn(stats, 'p99') && typeof stats.p99 === 'number') {
            p99 = stats.p99;
          } else {
            warnings.push(`Bench "${name}" missing p99 in stats`);
          }
        } else {
          warnings.push(`Bench "${name}" missing stats object`);
        }
        results.push({ name, p99 });
      }
    }
  }
  return { results, warnings };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Compare baseline and current benchmark results.
 * @param {Array<{ name: string, p99: number | null }>} baseline
 * @param {Array<{ name: string, p99: number | null }>} current
 * @param {number} threshold  Regression threshold (e.g., 0.2 = 20%)
 * @returns {{ hasRegression: boolean, rows: Array, warnings: string[] }}
 */
export function compareBenchmarks(baseline, current, threshold) {
  const warnings = [];
  const rows = [];
  let hasRegression = false;
  const baselineMap = new Map();
  for (const b of baseline) {
    baselineMap.set(b.name, b.p99);
  }
  for (const c of current) {
    const baseP99 = baselineMap.get(c.name);
    if (baseP99 === undefined) {
      warnings.push(`Bench "${c.name}" not found in baseline, skipping`);
      continue;
    }
    if (baseP99 === null || c.p99 === null) {
      rows.push({ name: c.name, baseline: baseP99, current: c.p99, deltaPct: null, status: 'SKIP' });
      continue;
    }
    const deltaPct = baseP99 > 0 ? Math.round(((c.p99 - baseP99) / baseP99) * 1000) / 10 : 0;
    const status = deltaPct > threshold * 100 ? 'REGRESSION' : (deltaPct < 0 ? 'IMPROVED' : 'OK');
    if (status === 'REGRESSION') hasRegression = true;
    rows.push({ name: c.name, baseline: baseP99, current: c.p99, deltaPct, status });
  }
  return { hasRegression, rows, warnings };
}

/**
 * Check if comparison indicates regression.
 * @param {{ hasRegression: boolean }} result
 * @returns {boolean}
 */
export function hasRegression(result) {
  return result.hasRegression;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTable(rows, warnings) {
  const lines = [];
  lines.push('| Benchmark | Baseline p99 | Current p99 | Delta | Status |');
  lines.push('|-----------|-------------|------------|-------|--------|');
  for (const r of rows) {
    const base = r.baseline === null ? 'N/A' : r.baseline.toFixed(3);
    const curr = r.current === null ? 'N/A' : r.current.toFixed(3);
    const delta = r.deltaPct === null ? 'N/A' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct}%`;
    lines.push(`| ${r.name} | ${base} | ${curr} | ${delta} | ${r.status} |`);
  }
  if (warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// File-level comparison (for CLI and tests)
// ---------------------------------------------------------------------------

/**
 * Compare two bench-results.json files.
 * @param {string} baselinePath
 * @param {string} currentPath
 * @param {number} threshold
 * @returns {{ exitCode: number, output: string }}
 */
export function compareBenchFiles(baselinePath, currentPath, threshold) {
  const baseline = extractBenchResults(baselinePath);
  const current = extractBenchResults(currentPath);
  const allWarnings = [...baseline.warnings, ...current.warnings];
  const { hasRegression: regressed, rows, warnings } = compareBenchmarks(baseline.results, current.results, threshold);
  allWarnings.push(...warnings);
  const output = formatTable(rows, allWarnings);
  return { exitCode: regressed ? 1 : 0, output };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    exit(0);
  }
  if (!args.baseline || !args.current) {
    console.error('Error: --baseline and --current are required');
    printHelp();
    exit(2);
  }
  const { exitCode, output } = compareBenchFiles(args.baseline, args.current, args.threshold);
  console.log(output);
  if (exitCode === 1) {
    console.log('\nREGRESSION detected — p99 latency exceeded threshold');
  } else {
    console.log('\nOK — no regression detected');
  }
  exit(exitCode);
}

const isMain = process.argv[1]?.endsWith('compare-benchmarks.mjs');
if (isMain) {
  main();
}
