#!/usr/bin/env node
/**
 * PRI-1104 naming policy gate.
 *
 * PR-1 shipped this as a warn-only observer. PR-3 (PRI-1136) is the rename
 * contract: `runtime-v2` is gone from the tree, so the rule that forbids it
 * becomes a merge gate. `npm run check:naming-policy` runs in `--strict` and
 * is wired into `verify:merge`.
 *
 * Scan surface (PR-3 redesign — the PR-1 surface covered `packages/*` source
 * only, which was both false-green and needle-thin: the exports map, the
 * io-seam registry and the workflows were outside it):
 *   - source: `packages/<pkg>/src|scripts/**`, root `scripts/**`, and the
 *             shipped `plugins/**` payload
 *   - tests:  `packages/<pkg>/tests/**` and `*.test.ts(x)` — only the
 *             import-path rule applies here (`testsToo`)
 *   - config: all package manifests beneath `packages/` (including nested payload manifests),
 *             `io-seam-registry.json`, and `.github/workflows/*.yml` (rule `runtime-v2-config`)
 * Historical records (docs/, CHANGELOG, `.gitleaksignore` commit
 * fingerprints) are deliberately out of scope: they describe the past and must
 * keep the paths they were written with.
 *
 * Rule gating is explicit config (`namingPolicy.gatedRules`), not "every rule
 * marked gated". `versioned-output-ref` became a gate with PRI-1139 (PR-6):
 * the write side now uses the version-neutral canonical registry keys, so a
 * versioned `outputSchemaRef:` literal in production source is a regression.
 *
 * Exit contract:
 *   - `--strict` fails on gated violations OR scan I/O errors in EVERY output
 *     mode. `--json` must never bypass the verdict.
 *   - without `--strict`: report only; scan errors are printed as warnings.
 *   - a missing/malformed registry is a hard error in every mode.
 *
 * `api-v1-route` is INVENTORY ONLY: the deprecated `/api/v1` alias is a
 * frozen wire literal that PR-6 deliberately keeps. It is counted, never
 * treated as a violation. Exemptions apply to GATED findings only — an
 * exempt file still contributes to the inventory (PR #2367 CodeRabbit #5).
 *
 * `--scan-root <dir>` replaces the SOURCE scan root and scans package manifests
 * nested beneath that root; it disables the repository tests, registry and
 * workflow passes so controlled fixtures stay hermetic. It is never used in production.
 *
 * Usage:
 *   node scripts/check-naming-policy.mjs            # warn-only report
 *   node scripts/check-naming-policy.mjs --strict   # exit 1 on gated findings
 *   node scripts/check-naming-policy.mjs --json     # machine-readable
 *   node scripts/check-naming-policy.mjs --scan-root <dir> --strict
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = path.join(ROOT, 'packages/principles-core/io-seam-registry.json');
const PACKAGES_DIR = path.join(ROOT, 'packages');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
const SCANNABLE = /\.(?:ts|tsx|mjs|cjs|js)$/;

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const strict = args.includes('--strict');
const asJson = args.includes('--json');
const scanRootOverride = flagValue('--scan-root');
const SCAN_DIR = scanRootOverride ? path.resolve(scanRootOverride) : null;

function failHard(reason, details) {
  process.stdout.write(
    JSON.stringify({ mode: strict ? 'strict' : 'warn', ok: false, reason, details }, null, 2) + '\n',
  );
  process.exit(1);
}

let registry;
try {
  registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
} catch (err) {
  failHard('registry_unreadable', { path: REGISTRY_PATH, error: String((err && err.message) || err) });
}

const policy = registry.namingPolicy ?? {};
const exemptFiles = new Set((policy.exemptFiles ?? []).map((p) => p.replace(/\\/g, '/')));
const frozenLiterals = (policy.frozenWireLiterals ?? []).filter((p) => typeof p === 'string' && p.length > 0);
// Exact identifier tokens that must keep the pre-rename spelling, e.g. the
// deprecated public alias in host-runtime. Unlike a line/whole-file exemption,
// this only suppresses the named token; every other identifier in the same
// file (or on the same line) is still checked.
const allowedIdentifiers = new Set(
  (policy.allowedIdentifiers ?? []).filter((value) => typeof value === 'string' && value.length > 0),
);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.pd-test-temp', '.git']);
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
      // PR #2367 CodeRabbit #3: also exclude .test.tsx / .test.jsx.
      !/\.test\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/^vitest\.config\./.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Same walk, but test files are the point. */
function testFiles(dir, out = []) {
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
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === '__tests__') testFiles(full, out);
      else testFiles(full, out);
    } else if (entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function packageDirs() {
  try {
    return fs
      .readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(PACKAGES_DIR, e.name));
  } catch (err) {
    scanErrors.push({ path: PACKAGES_DIR, error: String((err && err.message) || err) });
    return [];
  }
}

/** Source roots for the default (repo) scan. */
function defaultSourceFiles(out = []) {
  for (const dir of packageDirs()) {
    for (const sub of ['src', 'scripts']) {
      const target = path.join(dir, sub);
      if (fs.existsSync(target)) productionFiles(target, out);
    }
  }
  productionFiles(SCRIPTS_DIR, out);
  // The root plugin is shipped payload: its .cjs files run on the Owner's
  // machine and are exactly where a stale subpath would break delivery.
  if (fs.existsSync(PLUGINS_DIR)) productionFiles(PLUGINS_DIR, out);
  return out;
}

function defaultTestFiles(out = []) {
  for (const dir of packageDirs()) {
    for (const sub of ['src', 'tests']) {
      const target = path.join(dir, sub);
      if (fs.existsSync(target)) testFiles(target, out);
    }
  }
  return out;
}

/**
 * Collect every package manifest, including nested payload manifests. Skip
 * generated/dependency trees so the gate checks shipped package contracts,
 * not installed copies or build output.
 */
function packageManifestFiles(dir, out = []) {
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
    if (entry.isDirectory()) packageManifestFiles(full, out);
    else if (entry.isFile() && entry.name === 'package.json') out.push(full);
  }
  return out;
}

/**
 * Structured config pass. The PR-1 surface could not see an export subpath or
 * a registry path at all — those are JSON strings, not source imports.
 */
function configFiles(out = []) {
  packageManifestFiles(PACKAGES_DIR, out);
  if (fs.existsSync(REGISTRY_PATH)) out.push(REGISTRY_PATH);
  let workflows = [];
  try {
    workflows = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  } catch (err) {
    scanErrors.push({ path: WORKFLOWS_DIR, error: String((err && err.message) || err) });
  }
  for (const f of workflows) out.push(path.join(WORKFLOWS_DIR, f));
  return out;
}

/**
 * Structured config pass. The PR-1 surface could not see an export subpath or
 * a registry path at all — those are JSON strings, not source imports.
 *
 * This is field-aware on purpose: a plain text sweep of the registry would
 * flag the policy's own rule ids (`runtime-v2-import`) and description, and
 * excluding the file wholesale would blind the gate to `seams[].files`.
 */
function configHits(rel, raw) {
  const forbidden = (s) => /(?<!pd-)runtime-v2/.test(s);
  if (/package\.json$/.test(rel)) {
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (err) {
      scanErrors.push({ path: rel, error: `unparseable package.json: ${String((err && err.message) || err)}` });
      return 0;
    }
    const strings = [];
    const walk = (value) => {
      if (typeof value === 'string') strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) {
          strings.push(key);
          walk(value[key]);
        }
      }
    };
    walk(manifest.exports ?? {});
    for (const field of ['main', 'module', 'types', 'typesVersions', 'bin', 'files']) {
      if (manifest[field]) walk(manifest[field]);
    }
    return strings.filter(forbidden).length;
  }
  if (/io-seam-registry\.json$/.test(rel)) {
    let registryDoc;
    try {
      registryDoc = JSON.parse(raw);
    } catch (err) {
      scanErrors.push({ path: rel, error: `unparseable registry: ${String((err && err.message) || err)}` });
      return 0;
    }
    const files = (registryDoc.seams ?? []).flatMap((seam) => seam.files ?? []);
    return files.filter(forbidden).length;
  }
  // Workflows are YAML; a textual sweep is the only honest option. The frozen
  // `pd-runtime-v2*` literals are excluded by the same lookbehind.
  return [...raw.matchAll(/(?<!pd-)runtime-v2/g)].length;
}

/** Exemptions suppress GATED findings only; inventory always counts the file. */
function isExempt(rel) {
  return exemptFiles.has(rel);
}

const RULES = [
  {
    id: 'runtime-v2-import',
    why: '代际目录名 / 包子路径（PR-3 已收敛为 runtime；再出现即为回退）',
    // PR #2367 CodeRabbit #4: match directory-entry imports such as
    // './runtime-v2' as well as subpaths ending in '/'.
    re: /@principles\/core\/runtime-v2(?![A-Za-z0-9_-])|['"`][^'"`]*\/runtime-v2(?:\/|['"`])/g,
    gated: true,
    frozenExempt: true,
    multiline: false,
    scopes: ['source', 'tests'],
  },
  {
    id: 'runtime-v2-identifier',
    why: '代际标识符复活（应使用无代际语义的名字；冻结的 wire 字面量不受此规则约束）',
    // Matches the generation-marked identifier spellings the rename removed. Snake-case
    // wire literals such as `runtime_v2_prompt_activations_injected` are not
    // identifiers of this shape and stay frozen by design.
    re: /\b(?:isRuntimeV2[A-Za-z0-9_]*|RuntimeV2[A-Za-z0-9_]*|runtimeV2[A-Za-z0-9_]*|RUNTIME_V2[A-Z0-9_]*)\b/g,
    gated: true,
    frozenExempt: false,
    multiline: false,
    // Only the exact tokens in namingPolicy.allowedIdentifiers are suppressed
    // (the deprecated host-runtime export alias and CLI JSON compatibility alias).
    allowIdentifiers: true,
    scopes: ['source', 'tests'],
  },
  {
    id: 'runtime-v2-config',
    why: '包导出映射 / io-seam 路径 / CI 工作流里残留的代际路径',
    // Evaluated field-aware by configHits(), not by the generic line scan —
    // `scopes: []` keeps it out of scan().
    re: /(?<!pd-)runtime-v2/g,
    gated: true,
    frozenExempt: false,
    multiline: false,
    scopes: [],
  },
  {
    id: 'versioned-output-ref',
    why: '带 -vN 的 outputSchemaRef 写入（PRI-1139 / PR-6 写入侧已切换，再出现即为回退）',
    re: /outputSchemaRef:\s*['"`][^'"`]*-v\d+['"`]/g,
    gated: true,
    frozenExempt: false,
    // PR #2367 CodeRabbit #6: scan the whole file so the property name and
    // its value may live on different lines.
    multiline: true,
    scopes: ['source'],
  },
  {
    id: 'api-v1-route',
    why: '/api/v1 旧 alias 是冻结字面量，PR-6 保留 —— 仅统计，不作违规',
    re: /['"`]\/api\/v1\//g,
    gated: false,
    frozenExempt: false,
    multiline: false,
    scopes: ['source'],
  },
];

const gatedRuleIds = new Set(
  Array.isArray(policy.gatedRules) ? policy.gatedRules : RULES.filter((r) => r.gated).map((r) => r.id),
);

const inventory = Object.fromEntries(RULES.map((rule) => [rule.id, 0]));
const findings = [];
const pendingFindings = [];

function scan(rel, source, scope) {
  const perFile = new Map();
  const perPending = new Map();
  const lines = source.split('\n');
  for (const rule of RULES) {
    if (!rule.scopes.includes(scope)) continue;
    // A multiline rule matches against the whole file (its `\s*` spans \n).
    // Line-scoped rules keep the line-level frozen-literal exemption.
    const chunks = rule.multiline ? [source] : lines;
    for (const chunk of chunks) {
      if (rule.frozenExempt && frozenLiterals.some((lit) => chunk.includes(lit))) continue;
      const matches = [...chunk.matchAll(rule.re)];
      if (matches.length === 0) continue;
      inventory[rule.id] += matches.length;
      const violations = rule.allowIdentifiers
        ? matches.filter((match) => !allowedIdentifiers.has(match[0]))
        : matches;
      if (violations.length === 0) continue;
      if (!rule.gated) continue;
      const bucket = gatedRuleIds.has(rule.id) ? perFile : perPending;
      bucket.set(rule.id, (bucket.get(rule.id) ?? 0) + violations.length);
    }
  }
  const toFindings = (map) =>
    [...map].map(([rule, count]) => ({
      rule,
      file: rel,
      count,
      why: RULES.find((r) => r.id === rule).why,
    }));
  if (perFile.size > 0 && !isExempt(rel)) findings.push(...toFindings(perFile));
  if (perPending.size > 0 && !isExempt(rel)) pendingFindings.push(...toFindings(perPending));
}

const work = [];
if (SCAN_DIR) {
  work.push(...productionFiles(SCAN_DIR).map((f) => [f, 'source']));
  if (fs.existsSync(SCAN_DIR)) {
    work.push(...packageManifestFiles(SCAN_DIR).map((f) => [f, 'config']));
  }
} else {
  work.push(...defaultSourceFiles().map((f) => [f, 'source']));
  work.push(...defaultTestFiles().map((f) => [f, 'tests']));
  work.push(...configFiles().map((f) => [f, 'config']));
}

const seen = new Set();
for (const [file, scope] of work) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (seen.has(rel)) continue;
  seen.add(rel);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    scanErrors.push({ path: rel, error: String((err && err.message) || err) });
    continue;
  }
  if (scope === 'config') {
    const hits = configHits(rel, source);
    if (hits === 0) continue;
    inventory['runtime-v2-config'] += hits;
    if (gatedRuleIds.has('runtime-v2-config') && !isExempt(rel)) {
      findings.push({
        rule: 'runtime-v2-config',
        file: rel,
        count: hits,
        why: RULES.find((r) => r.id === 'runtime-v2-config').why,
      });
    }
    continue;
  }
  scan(rel, source, scope);
}

// Verdict is computed BEFORE choosing the output format. A machine-readable
// mode must never be able to bypass --strict (PR #2367 review finding M1).
const failed = strict && (findings.length > 0 || scanErrors.length > 0);
const result = {
  mode: strict ? 'strict' : 'warn',
  inventory,
  gatedRules: [...gatedRuleIds],
  gatedFindings: findings.length,
  pendingFindings: pendingFindings.length,
  scanErrors,
  findings,
  pending: pendingFindings,
};

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  process.stdout.write(`[check:naming-policy] mode=${result.mode} gatedRules=${result.gatedRules.join(',')}\n`);
  process.stdout.write(`[check:naming-policy] inventory: ${JSON.stringify(inventory)}\n`);
  const top = [...findings].sort((a, b) => b.count - a.count).slice(0, 8);
  for (const f of top) process.stdout.write(`  ${f.rule} ${f.count}x ${f.file}\n`);
  process.stdout.write(
    `[check:naming-policy] ${findings.length} gated finding(s), ${pendingFindings.length} pending rule(s) not gated yet; api-v1-route is inventory-only\n`,
  );
  for (const err of scanErrors) process.stdout.write(`[check:naming-policy] WARN scan error: ${err.path}: ${err.error}\n`);
  if (!strict) process.stdout.write('[check:naming-policy] warn-only: no gate failure\n');
}

if (failed) {
  process.stderr.write(
    `[check:naming-policy] FAIL: ${findings.length} gated finding(s), ${scanErrors.length} scan error(s)\n`,
  );
  process.exitCode = 1;
}
