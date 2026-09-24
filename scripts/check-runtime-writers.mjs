#!/usr/bin/env node
// PRI-920 (Runtime Topology Invariant Guard, gap G1): runtime-writer boundary.
//
// ADR-0024 §2.1 makes the installer package the ONLY deployment authority for
// the canonical runtime tree (~/.pd/runtime, install.json, active.json). That
// authority currently holds structurally but has no merge-time defense: a
// future PR could add a runtime-path write outside the installer and nothing
// would redden (ERR-137 class — dev builds written into the installed tree).
//
// This gate is a deterministic, whole-tree static scan: a first-party source
// file OUTSIDE the authority that co-references (a) a canonical-runtime path
// token and (b) a filesystem mutation primitive must appear, with a verified
// reason, in ALLOWED_RUNTIME_WRITERS below — the single SSoT allowlist
// (io-seam-registry pattern: the gate derives its exemptions from one list,
// and every list entry is proven to exist; ERR-146).
//
// Scope is production code only (packages/*/src, packages/*/scripts,
// scripts/**). Test files (*test*, __tests__/) are excluded: they exercise
// fake/synthetic homes and are validated by their own suites.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one deployment authority (ADR-0024 §2.1). Files here may mutate. */
export const AUTHORIZED_WRITER_PREFIX = 'packages/create-principles-disciple/src/';

/** Tokens that identify the canonical runtime tree specifically — NOT the
 *  `<workspace>/.pd` state root (I3 keeps those separate; state writes are
 *  normal and not this gate's concern). */
export const RUNTIME_PATH_TOKEN =
  /runtimeDir|getInstallLayoutPaths|resolveInstallLayout|active\.json|install\.json|\.pd[\\/]+runtime|['"]\.pd['"]\s*,\s*['"]runtime['"]/;

/** Synchronous filesystem mutation primitives (static, file-level signal). */
export const WRITE_PRIMITIVE =
  /cpSync|rmSync|writeFileSync|writeFile\(|appendFileSync|renameSync|symlinkSync|mkdirSync|unlinkSync|copyFile\(|copyFileSync/;

/**
 * Every in-scope file that trips the predicate, with its verified reason.
 * Entries are two-way checked: an unlisted trip FAILS (new writer outside
 * authority) and a stale entry FAILS (ERR-146 — the list must not rot).
 */
export const ALLOWED_RUNTIME_WRITERS = [
  {
    file: 'packages/host-runtime/src/product-telemetry/service.ts',
    reason: 'Removes orphaned workspace-scoped export locks beside the workspace state file — never the canonical runtime tree.',
  },
  {
    file: 'packages/openclaw-plugin/scripts/sync-plugin.mjs',
    reason: 'Legacy dev-sync entry, deactivated: refuses unconditionally (PRI-868); refusal contract pinned by tests/sync-plugin-installation-truth.test.js.',
  },
  {
    file: 'packages/pd-companion/scripts/verify-package.mjs',
    reason: 'CI package verifier: rmSync target is its own mkdtemp extraction dir; install.json is read-only.',
  },
  {
    file: 'packages/pd-companion/src/main/main.ts',
    reason: 'Companion writes logs/state under Electron userData only; the runtime tree is read via locate.ts (ADR-0023 §2.7 — Companion is not a runtime owner).',
  },
  {
    file: 'scripts/check-runtime-writers.mjs',
    reason: 'This gate: the pattern match is against its own regex literals; it only reads the repository.',
  },
  {
    file: 'scripts/dev/codex-owner-journey-e2e.mjs',
    reason: 'Dev e2e journey driver: all writes land in an mkdtemp sandbox under the system temp dir.',
  },
  {
    file: 'scripts/dev/codex-r1-installed-gate.mjs',
    reason: 'Dev R1 installed-state gate: sandboxed in mkdtemp; never points HOME at the real install.',
  },
  {
    file: 'scripts/install.mjs',
    reason: 'Legacy dev installer, deactivated: refuses unconditionally (PRI-868); refusal pinned by guard-contract tests.',
  },
  {
    file: 'scripts/telemetry-production-smoke.mjs',
    reason: 'Telemetry smoke: builds a synthetic runtime layout under an explicitly isolated mkdtemp HOME (never the real ~/.pd).',
  },
];

const SOURCE_EXT = /\.(ts|js|mjs|cjs)$/;
const TEST_PATH = /\.test\.|[/\\]__tests__[/\\]|[/\\]tests[/\\]/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

/** First-party production source files in scope, as repo-relative '/' paths. */
export function collectScopeFiles(repoRoot) {
  const files = [];
  const groups = [
    ['packages', /^[^/]+\/(src|scripts)\//],
    ['scripts', /.*/],
  ];
  for (const [dir, pattern] of groups) {
    const root = join(repoRoot, dir);
    if (!existsSync(root)) continue;
    for (const abs of walk(root)) {
      const rel = relative(repoRoot, abs).split(sep).join('/');
      if (!SOURCE_EXT.test(rel)) continue;
      if (TEST_PATH.test(rel)) continue;
      if (!pattern.test(rel.replace(/^packages\//, '').replace(/^scripts\//, ''))) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

/** Files in scope that trip the writer predicate. */
export function scanRuntimeWriters(repoRoot) {
  const scope = collectScopeFiles(repoRoot);
  const flagged = [];
  for (const rel of scope) {
    if (rel.startsWith(AUTHORIZED_WRITER_PREFIX)) continue;
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    if (RUNTIME_PATH_TOKEN.test(text) && WRITE_PRIMITIVE.test(text)) flagged.push(rel);
  }
  return { scanned: scope.length, flagged };
}

/** Compare the scan against the allowlist (both directions). */
export function evaluateRuntimeWriters(repoRoot, allowlist = ALLOWED_RUNTIME_WRITERS) {
  const { scanned, flagged } = scanRuntimeWriters(repoRoot);
  const allowed = new Set(allowlist.map((e) => e.file));
  const flaggedSet = new Set(flagged);
  return {
    scanned,
    flagged,
    unauthorized: flagged.filter((f) => !allowed.has(f)),
    stale: allowlist.filter((e) => !flaggedSet.has(e.file)).map((e) => e.file),
  };
}

const NEXT_ACTION = [
  'nextAction:',
  '  The installer package is the only deployment authority for the canonical runtime',
  '  (ADR-0024 §2.1). Route runtime writes through installer install()/update transactions.',
  '  If this file legitimately never mutates the canonical runtime, add it to',
  '  ALLOWED_RUNTIME_WRITERS in scripts/check-runtime-writers.mjs with a verified reason',
  '  (proven target path + reviewable evidence, per ERR-146).',
].join('\n');

function main() {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const { scanned, flagged, unauthorized, stale } = evaluateRuntimeWriters(repoRoot);
  if (unauthorized.length === 0 && stale.length === 0) {
    console.log('Runtime writer authority PASS');
    console.log(`scanned:\n  ${scanned} first-party production files`);
    console.log(`runtime-writer trips (all allowlisted with reason):\n  ${flagged.length}`);
    return;
  }
  console.error('Runtime writer authority FAIL');
  console.error(`scanned:\n  ${scanned} first-party production files`);
  for (const f of unauthorized) {
    console.error(`\n${f}\n\nreason:\n  mutates the filesystem while referencing the canonical runtime tree,\n  outside the installer authority (ADR-0024 §2.1)\n\n${NEXT_ACTION}`);
  }
  for (const f of stale) {
    console.error(`\n${f}\n\nreason:\n  stale ALLOWED_RUNTIME_WRITERS entry — the file no longer trips the\n  predicate (removed or cleaned up). Delete the entry (ERR-146).\n\nnextAction:\n  Remove the entry from scripts/check-runtime-writers.mjs.`);
  }
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
