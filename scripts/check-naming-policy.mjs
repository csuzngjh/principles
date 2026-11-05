#!/usr/bin/env node
/**
 * PRI-1104 Stage 0 — naming policy observer.
 *
 * WARN ONLY in PR-1 (always exit 0). From PR-3, `--strict` makes violations
 * fail the merge gate. The exemption authority is the `namingPolicy` block of
 * packages/principles-core/io-seam-registry.json — never a shadow list here.
 *
 * This script is an observer, not a second source of truth: it scans the
 * current tree on every run and reports the live inventory. The PR-1 numbers
 * are recorded in docs/audit/PRI-1104-single-version-convergence-plan.md as
 * the pre-convergence baseline; PR-3 drives them to zero for the rename rules.
 *
 * Usage:
 *   node scripts/check-naming-policy.mjs            # warn-only report
 *   node scripts/check-naming-policy.mjs --strict   # exit 1 on violations
 *   node scripts/check-naming-policy.mjs --json     # machine-readable
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'packages/principles-core/io-seam-registry.json');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const SCANNABLE = /\.(?:ts|tsx|mjs|cjs|js)$/;

const argv = new Set(process.argv.slice(2));
const strict = argv.has('--strict');
const asJson = argv.has('--json');

const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const policy = registry.namingPolicy ?? {};
const exemptPaths = (policy.exemptPaths ?? []).map((p) => p.replace(/\\/g, '/'));
const exemptFiles = new Set((policy.exemptFiles ?? []).map((p) => p.replace(/\\/g, '/')));

function isExempt(rel) {
  if (exemptFiles.has(rel)) return true;
  return exemptPaths.some((p) => rel.startsWith(p));
}

function productionFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__' || entry.name === 'tests' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionFiles(full, out);
    else if (entry.isFile() && SCANNABLE.test(entry.name) && !/\.test\.[cm]?[jt]s$/.test(entry.name)) out.push(full);
  }
  return out;
}

const RULES = [
  {
    id: 'runtime-v2-import',
    why: '代际目录名 / 包子路径（PR-3 收敛为 runtime）',
    re: /@principles\/core\/runtime-v2|['"][^'"]*\/runtime-v2\//g,
  },
  {
    id: 'versioned-output-ref',
    why: '带 -vN 的 outputSchemaRef 写入（PR-6 去版本语义）',
    re: /outputSchemaRef:\s*['"][^'"]*-v[12]['"]/g,
  },
  {
    id: 'api-v1-route',
    why: '/api/v1 路由字面量（PR-6 切新路径，旧 alias 保留）',
    re: /['"]\/api\/v1\//g,
  },
];

const findings = [];
for (const file of productionFiles(PACKAGES_DIR)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (isExempt(rel)) continue;
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const rule of RULES) {
    const matches = [...source.matchAll(rule.re)];
    if (matches.length === 0) continue;
    findings.push({ rule: rule.id, file: rel, count: matches.length, why: rule.why });
  }
}

const summary = Object.fromEntries(
  RULES.map((rule) => [
    rule.id,
    findings.filter((f) => f.rule === rule.id).reduce((sum, f) => sum + f.count, 0),
  ]),
);

if (asJson) {
  process.stdout.write(JSON.stringify({ mode: strict ? 'strict' : 'warn', summary, findings }, null, 2) + '\n');
} else {
  process.stdout.write(`[check:naming-policy] mode=${strict ? 'strict' : 'warn'} (PRI-1104)\n`);
  process.stdout.write(`[check:naming-policy] live inventory: ${JSON.stringify(summary)}\n`);
  const top = findings.sort((a, b) => b.count - a.count).slice(0, 8);
  for (const f of top) process.stdout.write(`  ${f.rule} ${f.count}x ${f.file}\n`);
  process.stdout.write(`[check:naming-policy] ${findings.length} file(s) with findings; exemptions derive from io-seam-registry.json namingPolicy\n`);
  if (strict && findings.length > 0) {
    process.stderr.write('[check:naming-policy] FAIL: naming violations present\n');
    process.exit(1);
  }
  if (!strict) {
    process.stdout.write('[check:naming-policy] warn-only: no gate failure in PR-1\n');
  }
}
