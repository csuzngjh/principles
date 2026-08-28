#!/usr/bin/env node

/**
 * Quality Report Generator
 *
 * Aggregates quality metrics from multiple sources and outputs a Markdown
 * monthly report to the private docs repo (PD_PRIVATE_DOCS_DIR or
 * ~/principles-private/docs/quality-reports/YYYY-MM.md).
 *
 * Data sources:
 *   1. ERR data:        docs/process/error-management/ERROR_EXPERIENCE_HANDBOOK.md
 *   2. Test data:        packages/[pkg]/tests/ + src/[pkg]/__tests__ (.test.ts files)
 *   3. Coverage data:    packages/[pkg]/coverage/coverage-final.json
 *   4. Coupling data:    graphify-out/graph.json
 *
 * Usage:
 *   node scripts/quality-report.mjs
 *   node scripts/quality-report.mjs --month 2026-06
 *   node scripts/quality-report.mjs --output custom-path.md
 *
 * Runtime Contract compliance:
 *   - All JSON parsed as `unknown`, validated with typeof/Array.isArray/Object.hasOwn
 *   - No `as` bypass, no `any`
 *   - Graceful degradation with reasons (Rule 9)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * Resolves the graphify cache directory path.
 * If .git is a directory, returns .git/graphify.
 * If .git is a file (e.g. in a worktree), reads the gitdir path and returns <gitdir>/graphify.
 * Fallback to .git-fallback-graphify in case .git is not found.
 */
function getGraphifyDir(rootDir) {
  const gitPath = join(rootDir, '.git');
  if (existsSync(gitPath)) {
    try {
      const stats = statSync(gitPath);
      if (stats.isDirectory()) {
        return join(gitPath, 'graphify');
      } else if (stats.isFile()) {
        const content = readFileSync(gitPath, 'utf8').trim();
        const match = /^gitdir:\s*(.+)$/.exec(content);
        if (match) {
          let gitDir = match[1].trim();
          if (!isAbsolute(gitDir)) {
            gitDir = resolve(rootDir, gitDir);
          }
          return join(gitDir, 'graphify');
        }
      }
    } catch {
      // ignore and fallback
    }
  }
  return join(rootDir, '.git-fallback-graphify');
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { month: null, output: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--month') args.month = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (!args.month) {
    const now = new Date();
    args.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/quality-report.mjs [options]

Options:
  --month YYYY-MM   Report month (default: current month)
  --output <path>   Custom output path (default: $PD_PRIVATE_DOCS_DIR/quality-reports/YYYY-MM.md, or ~/principles-private/docs/quality-reports/YYYY-MM.md)
  --help, -h        Show this help
`);
}

// ---------------------------------------------------------------------------
// ERR data: parse ERROR_EXPERIENCE_HANDBOOK.md
// ---------------------------------------------------------------------------

/**
 * Parse the error handbook markdown and return ERR statistics.
 * @param {string} handbookPath
 * @returns {{ total: number, recurring: number, recurrenceRate: number }}
 */
export function parseErrStats(handbookPath) {
  if (!existsSync(handbookPath)) {
    return { total: 0, recurring: 0, recurrenceRate: 0, warning: 'Handbook file not found' };
  }
  const content = readFileSync(handbookPath, 'utf8');
  // Count ERR entries: lines starting with **[ERR-XXX]**
  const totalMatches = content.match(/\*\*\[ERR-\d+\]\*\*/g) || [];
  const total = totalMatches.length;
  // Count recurring entries: only entries with **Recurrence**: Yes (not None/First occurrence)
  const recurringMatches = content.match(/\*\*Recurrence\*\*:\s*Yes/g) || [];
  const recurring = recurringMatches.length;
  const recurrenceRate = total > 0 ? Math.round((recurring / total) * 1000) / 10 : 0;
  return { total, recurring, recurrenceRate };
}

// ---------------------------------------------------------------------------
// Test data: count test files per package
// ---------------------------------------------------------------------------

/**
 * Count test files per package using glob patterns.
 * @returns {Array<{ package: string, testFiles: number }>}
 */
export function countTestFiles() {
  const packages = ['principles-core', 'openclaw-plugin', 'pd-cli', 'pd-console', 'create-principles-disciple'];
  const results = [];
  for (const pkg of packages) {
    const pkgDir = join(ROOT, 'packages', pkg);
    if (!existsSync(pkgDir)) {
      results.push({ package: pkg, testFiles: 0, warning: 'Package directory not found' });
      continue;
    }
    // Count test files in tests/ and src/**/__tests__/
    let count = 0;
    try {
      // Use a simple recursive walk instead of glob to avoid dependency
      count = countFilesRecursive(pkgDir, (filePath) => {
        return filePath.endsWith('.test.ts') && !filePath.includes('node_modules') && !filePath.includes('dist');
      });
    } catch (err) {
      results.push({ package: pkg, testFiles: 0, warning: `Error counting: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    results.push({ package: pkg, testFiles: count });
  }
  return results;
}

/**
 * Recursively count files matching a predicate.
 * @param {string} dir
 * @param {(path: string) => boolean} predicate
 * @returns {number}
 */
function countFilesRecursive(dir, predicate) {
  let count = 0;
  const entries = readDirSafe(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSafe(fullPath);
    if (!stat) continue;
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
      count += countFilesRecursive(fullPath, predicate);
    } else if (stat.isFile() && predicate(fullPath)) {
      count++;
    }
  }
  return count;
}

function readDirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch (_e) {
    return [];
  }
}

function statSafe(path) {
  try {
    return statSync(path);
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Coverage data: read coverage-final.json
// ---------------------------------------------------------------------------

/**
 * Read coverage summary from a coverage-final.json file.
 * @param {string} coveragePath
 * @returns {{ lines: number, functions: number, branches: number, statements: number } | null}
 */
export function readCoverage(coveragePath) {
  if (!existsSync(coveragePath)) {
    return null;
  }
  try {
    const raw = readFileSync(coveragePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // coverage-final.json is keyed by file path; compute aggregate
    const data = /** @type {Record<string, unknown>} */ (parsed);
    let totalStatements = 0, coveredStatements = 0;
    let totalFunctions = 0, coveredFunctions = 0;
    let totalBranches = 0, coveredBranches = 0;
    let totalLines = 0, coveredLines = 0;
    for (const key of Object.keys(data)) {
      const fileData = data[key];
      if (typeof fileData !== 'object' || fileData === null) continue;
      const s = getObjectField(fileData, 's');
      const f = getObjectField(fileData, 'f');
      const b = getObjectField(fileData, 'b');
      const statementMap = getObjectField(fileData, 'statementMap');
      const fnMap = getObjectField(fileData, 'fnMap');
      const branchMap = getObjectField(fileData, 'branchMap');
      if (s && statementMap) {
        const sCounts = Object.values(s).filter((v) => typeof v === 'number');
        totalStatements += Object.keys(statementMap).length;
        coveredStatements += sCounts.filter((v) => v > 0).length;
      }
      if (f && fnMap) {
        const fCounts = Object.values(f).filter((v) => typeof v === 'number');
        totalFunctions += Object.keys(fnMap).length;
        coveredFunctions += fCounts.filter((v) => v > 0).length;
      }
      if (b && branchMap) {
        const bCounts = Object.values(b).flat().filter((v) => typeof v === 'number');
        const branchKeys = Object.keys(branchMap);
        totalBranches += branchKeys.length * 2; // approximate: each branch has ~2 arms
        coveredBranches += bCounts.filter((v) => v > 0).length;
      }
    }
    const pct = (covered, total) => total > 0 ? Math.round((covered / total) * 1000) / 10 : 0;
    return {
      lines: pct(coveredStatements, totalStatements), // v8 coverage doesn't track lines separately; use statements as proxy
      functions: pct(coveredFunctions, totalFunctions),
      branches: pct(coveredBranches, totalBranches),
      statements: pct(coveredStatements, totalStatements),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function getObjectField(obj, field) {
  if (typeof obj !== 'object' || obj === null) return null;
  if (!Object.hasOwn(obj, field)) return null;
  const v = obj[field];
  if (typeof v !== 'object' || v === null) return null;
  return /** @type {Record<string, unknown>} */ (v);
}

// ---------------------------------------------------------------------------
// Coupling data: read graph.json
// ---------------------------------------------------------------------------

/**
 * Read graph statistics from graphify-out/graph.json.
 * @param {string} graphPath
 * @returns {{ nodes: number, edges: number, godNodes: number } | null}
 */
export function readGraphStats(graphPath) {
  if (!existsSync(graphPath)) {
    return null;
  }
  try {
    const raw = readFileSync(graphPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = /** @type {Record<string, unknown>} */ (parsed);
    const nodes = getObjectField(data, 'nodes');
    const edges = getObjectField(data, 'edges');
    const nodeCount = Array.isArray(nodes) ? nodes.length : 0;
    const edgeCount = Array.isArray(edges) ? edges.length : 0;
    // Count god nodes (nodes with high fan-in/fan-out)
    let godNodes = 0;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (typeof node === 'object' && node !== null && Object.hasOwn(node, 'isGodNode') && node.isGodNode === true) {
          godNodes++;
        }
      }
    }
    return { nodes: nodeCount, edges: edgeCount, godNodes };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Generate the Markdown report.
 * @param {{ errStats: object, testStats: Array, coverageStats: Array, graphStats: object|null, month: string }} input
 * @returns {string}
 */
export function generateReport(input) {
  const { errStats, testStats, coverageStats, graphStats, month } = input;
  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);

  const lines = [];
  lines.push(`# 质量报告 - ${month}`);
  lines.push('');
  lines.push(`生成时间：${timestamp} (UTC)`);
  lines.push('');
  lines.push('## 1. 错误经验手册');
  lines.push('');
  lines.push(`- ERR 总数：${errStats.total}`);
  lines.push(`- 复发数：${errStats.recurring}`);
  lines.push(`- 复发率：${errStats.recurrenceRate}%`);
  if (errStats.warning) {
    lines.push(`- ⚠️ ${errStats.warning}`);
  }
  lines.push('');
  lines.push('## 2. 测试覆盖');
  lines.push('');
  lines.push('| 包 | 测试文件数 |');
  lines.push('|----|-----------|');
  for (const t of testStats) {
    lines.push(`| ${t.package} | ${t.testFiles} |`);
  }
  lines.push('');
  lines.push('## 3. 代码覆盖率');
  lines.push('');
  lines.push('| 包 | Lines | Functions | Branches | Statements |');
  lines.push('|----|-------|-----------|----------|------------|');
  for (const c of coverageStats) {
    if (c.coverage === null) {
      lines.push(`| ${c.package} | 无数据 | - | - | - |`);
    } else if (c.coverage.error) {
      lines.push(`| ${c.package} | 错误: ${c.coverage.error} | - | - | - |`);
    } else {
      const cv = c.coverage;
      lines.push(`| ${c.package} | ${cv.lines}% | ${cv.functions}% | ${cv.branches}% | ${cv.statements}% |`);
    }
  }
  lines.push('');
  lines.push('## 4. 模块耦合度');
  lines.push('');
  if (graphStats === null) {
    lines.push('无图谱数据（graphify-out/graph.json 不存在）');
  } else if (graphStats.error) {
    lines.push(`图谱解析错误：${graphStats.error}`);
  } else {
    lines.push(`- 图谱节点数：${graphStats.nodes}`);
    lines.push(`- 图谱边数：${graphStats.edges}`);
    lines.push(`- God nodes：${graphStats.godNodes}`);
  }
  lines.push('');
  lines.push('## 趋势对比');
  lines.push('');
  lines.push('<!-- 首次运行无对比基线，后续运行与上月对比 -->');
  lines.push('（首次运行，无对比基线）');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Collect data
  const handbookPath = join(ROOT, 'docs', 'process', 'error-management', 'ERROR_EXPERIENCE_HANDBOOK.md');
  const errStats = parseErrStats(handbookPath);

  const testStats = countTestFiles();

  const packages = ['principles-core', 'openclaw-plugin', 'pd-cli', 'pd-console', 'create-principles-disciple'];
  const coverageStats = packages.map((pkg) => {
    const coveragePath = join(ROOT, 'packages', pkg, 'coverage', 'coverage-final.json');
    return { package: pkg, coverage: readCoverage(coveragePath) };
  });

  const graphifyDir = getGraphifyDir(ROOT);
  const graphPath = join(graphifyDir, 'graph.json');
  const graphStats = readGraphStats(graphPath);

  // Generate report
  const report = generateReport({
    errStats,
    testStats,
    coverageStats,
    graphStats,
    month: args.month,
  });

  // Write output — default to private docs repo (PD_PRIVATE_DOCS_DIR or ~/principles-private/docs)
  let defaultOutDir;
  if (process.env.PD_PRIVATE_DOCS_DIR && process.env.PD_PRIVATE_DOCS_DIR.length > 0) {
    defaultOutDir = join(process.env.PD_PRIVATE_DOCS_DIR, 'quality-reports');
  } else {
    defaultOutDir = join(os.homedir(), 'principles-private', 'docs', 'quality-reports');
  }
  const outputPath = args.output || join(defaultOutDir, `${args.month}.md`);
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(outputPath, report, 'utf8');
  console.log(`Quality report generated: ${outputPath}`);
}

// Only run main if executed directly (not imported by tests)
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('quality-report.mjs');
if (isMain) {
  main();
}
