#!/usr/bin/env node
/**
 * PRI-1104 Stage 0 — naming policy OBSERVER (not a merge gate yet).
 *
 * PR-1: warn-only, NOT wired into any CI workflow, npm script or hook.
 * `--strict` is a preview of the PR-3 gate, not a gate today. Before PR-3
 * turns it on, the scan surface must be redesigned (it currently covers
 * packages/* source files only; the full consumer list is in
 * docs/audit/PRI-1104-single-version-convergence-plan.md §8) and the script
 * must be wired into the merge path explicitly.
 *
 * Exit contract, regression-pinned by
 * scripts/__tests__/check-naming-policy.test.mjs (PR #2367 review):
 *   - `--strict` fails on gated violations OR scan I/O errors in EVERY output
 *     mode. `--json` must never bypass the verdict.
 *   - without `--strict`: report only; scan errors are printed as warnings.
 *   - a missing/malformed registry is a hard error in every mode.
 *
 * `api-v1-route` is INVENTORY ONLY: the deprecated `/api/v1` alias is a
 * frozen wire literal that PR-6 deliberately keeps. It is counted, never
 * treated as a violation.
 *
 * Usage:
 *   node scripts/check-naming-policy.mjs            # warn-only report
 *   node scripts/check-naming-policy.mjs --strict   # exit 1 on gated findings
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
const exemptFiles = new Set((policy.exemptFiles ?? []).map((p) => p.replace(/\\/g, '/')));
const frozenLiterals = (policy.frozenWireLiterals ?? []).filter((p) => typeof p === 'string' && p.length > 0);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '__tests__', 'tests', '.pd-test-temp']);
const scanErrors = [];

function productionFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    scanErrors.push({ path: dir, error: String((err && err.message) || err) });
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionFiles(full, out);
    else if (
      entry.isFile() &&
      SCANNABLE.test(entry.name) &&
      !/\.test\.[cm]?[jt]s$/.test(entry.name) &&
      !/^vitest\.config\./.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function isExempt(rel) {
  if (exemptFiles.has(rel)) return true;
  // Align with eslint.config.js ignores for packages/*/scripts/**.
  return /^packages\/[^/]+\/scripts\//.test(rel);
}

const RULES = [
  {
    id: 'runtime-v2-import',
    why: '代际目录名 / 包子路径（PR-3 收敛为 runtime）',
    re: /@principles\/core\/runtime-v2(?![A-Za-z0-9_-])|['"`][^'"`]*\/runtime-v2\//g,
    gated: true,
    frozenExempt: true,
  },
  {
    id: 'versioned-output-ref',
    why: '带 -vN 的 outputSchemaRef 写入（PR-6 去版本语义）',
    re: /outputSchemaRef:\s*['"`][^'"`]*-v[12]['"`]/g,
    gated: true,
    frozenExempt: false,
  },
  {
    id: 'api-v1-route',
    why: '/api/v1 旧 alias 是冻结字面量，PR-6 保留 —— 仅统计，不作违规',
    re: /['"`]\/api\/v1\//g,
    gated: false,
    frozenExempt: false,
  },
];

const inventory = Object.fromEntries(RULES.map((rule) => [rule.id, 0]));
const findings = [];

for (const file of productionFiles(PACKAGES_DIR)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (isExempt(rel)) continue;
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    scanErrors.push({ path: rel, error: String((err && err.message) || err) });
    continue;
  }

  const perFile = new Map();
  for (const line of source.split('\n')) {
    for (const rule of RULES) {
      if (rule.frozenExempt && frozenLiterals.some((lit) => line.includes(lit))) continue;
      const count = [...line.matchAll(rule.re)].length;
      if (count === 0) continue;
      inventory[rule.id] += count;
      if (rule.gated) perFile.set(rule.id, (perFile.get(rule.id) ?? 0) + count);
    }
  }
  for (const [rule, count] of perFile) findings.push({ rule, file: rel, count, why: RULES.find((r) => r.id === rule).why });
}

// Verdict is computed BEFORE choosing the output format. A machine-readable
// mode must never be able to bypass --strict (PR #2367 review finding M1).
const failed = strict && (findings.length > 0 || scanErrors.length > 0);
const result = {
  mode: strict ? 'strict' : 'warn',
  inventory,
  gatedFindings: findings.length,
  scanErrors,
  findings,
};

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write(`[check:naming-policy] mode=${result.mode} (PRI-1104 observer, NOT wired into any gate)\n`);
  process.stdout.write(`[check:naming-policy] inventory: ${JSON.stringify(inventory)}\n`);
  const top = [...findings].sort((a, b) => b.count - a.count).slice(0, 8);
  for (const f of top) process.stdout.write(`  ${f.rule} ${f.count}x ${f.file}\n`);
  process.stdout.write(`[check:naming-policy] ${findings.length} file(s) with gated findings; api-v1-route is inventory-only\n`);
  for (const err of scanErrors) process.stdout.write(`[check:naming-policy] WARN scan error: ${err.path}: ${err.error}\n`);
  if (!strict) process.stdout.write('[check:naming-policy] warn-only: no gate failure in PR-1\n');
}

if (failed) {
  process.stderr.write(
    `[check:naming-policy] FAIL: ${findings.length} gated finding(s), ${scanErrors.length} scan error(s)\n`,
  );
  process.exitCode = 1;
}
