/**
 * Pain Recall architecture guards G-1/G-2/G-3 — SPEC-PD-AGENT-CAPABILITY-API-001
 * v0.5 §5.3 (R4/R5/R6) + §11 E; READINESS §8.
 *
 * G-1 — Read Model reference whitelist with COMPLETE and MUTUALLY EXCLUSIVE
 *        production/test domain partitioning. The scan covers every .ts file
 *        under core src; a file is TEST-domain when its path contains a
 *        `__tests__` segment OR its basename matches *.test.ts/*.spec.ts
 *        (wherever it lives — the historical blind spot was a *.test.ts
 *        outside __tests__ escaping BOTH the production scan and a
 *        __tests__-only test scan). Everything else is PRODUCTION-domain.
 *        Every scanned file lands in exactly one domain; counts are asserted.
 *        Production rule: only pain-recall-capability.ts may reference the
 *        read model. Test rule: only the three authorized test files may.
 *        Reference detection covers static import, side-effect import,
 *        export-from re-export, dynamic import(), and require().
 *
 * G-2 — Export-face snapshots: the two subpath modules' runtime export sets
 *        are pinned exactly, `painRecallSnapshotTestHooks` appears in NEITHER
 *        (nor in any package.json exports target), and the package exports
 *        map carries exactly the two dedicated subpath keys.
 *
 * G-3 — pd-cli reference face: zero capability-subpath references in pd-cli,
 *        the read-model subpath referenced only by the command shell, and
 *        zero remnants of the old service path.
 */
import { describe, it, expect } from 'vitest';
import * as fsSync from 'fs';
import * as pathSync from 'path';

const CORE_SRC_ROOT = pathSync.resolve(__dirname, '..', '..'); // packages/principles-core/src
const READ_MODEL_REL = 'runtime-v2/pain-recall-read-model.ts';

// ── Domain partitioning (pure, unit-tested below) ────────────────────────────

export type ScanDomain = 'production' | 'test' | 'excluded';

/**
 * Classification rule (task book §7.5):
 *   1. any `__tests__` path segment        → test domain
 *   2. any *.test.ts / *.spec.ts basename  → test domain (location-independent)
 *   3. *.d.ts declaration files            → excluded (declarations carry no
 *      executable references; the exclusion is narrow and auditable)
 *   4. everything else                     → production domain
 */
export function classifyFile(relPath: string): ScanDomain {
  const segments = relPath.split('/');
  if (segments.includes('__tests__')) return 'test';
  const base = segments[segments.length - 1] ?? '';
  if (base.endsWith('.test.ts') || base.endsWith('.spec.ts')) return 'test';
  if (base.endsWith('.d.ts')) return 'excluded';
  return 'production';
}

function collectTsFiles(dir: string, acc: string[]): void {
  for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = pathSync.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(fullPath, acc);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      acc.push(fullPath);
    }
  }
}

/** All module specifiers a source text routes to the read model — static
 * imports (named/default/namespace), side-effect imports, export-from
 * re-exports, dynamic import(), and require(). */
export function readModelReferencesIn(source: string): string[] {
  const specifiers: string[] = [];
  // import … from 'mod' / export … from 'mod' (multiline-safe, house pattern)
  for (const m of source.matchAll(/(?:import|export)\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
    if (m[1] != null) specifiers.push(m[1]);
  }
  // side-effect import 'mod'
  for (const m of source.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
    if (m[1] != null && !specifiers.includes(m[1])) specifiers.push(m[1]);
  }
  // dynamic import('mod')
  for (const m of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1] != null && !specifiers.includes(m[1])) specifiers.push(m[1]);
  }
  // require('mod')
  for (const m of source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (m[1] != null && !specifiers.includes(m[1])) specifiers.push(m[1]);
  }
  return specifiers.filter((spec) => {
    if (!spec.endsWith('pain-recall-read-model.js')) return false;
    return spec === './pain-recall-read-model.js' || spec === '../pain-recall-read-model.js'
      || spec.endsWith('/pain-recall-read-model.js');
  });
}

/** Resolve which domain a referencing file belongs to and whether that
 * reference is authorized. Returns violation messages for the rule set. */
export function evaluateReferenceRule(entries: readonly { relPath: string; source: string }[]): string[] {
  const violations: string[] = [];
  for (const { relPath, source } of entries) {
    const refs = readModelReferencesIn(source);
    if (refs.length === 0) continue;
    const domain = classifyFile(relPath);
    if (domain === 'production') {
      if (relPath !== 'runtime-v2/pain-recall-capability.ts') {
        violations.push(`production file not authorized to reference the read model: ${relPath} (${refs.length} ref)`);
      }
    } else if (domain === 'test') {
      const authorized = relPath.endsWith('/__tests__/pain-recall-readonly.test.ts')
        || relPath.endsWith('/__tests__/pain-recall-service.test.ts')
        || relPath.endsWith('/__tests__/pain-recall-capability.test.ts');
      if (!authorized) {
        violations.push(`test file not authorized to reference the read model: ${relPath} (${refs.length} ref)`);
      }
    }
    // domain === 'excluded': .d.ts carries no executable reference; a hit
    // there is still surfaced by the completeness assertions below.
  }
  return violations;
}

// ── G-1: real-tree scan ──────────────────────────────────────────────────────

describe('G-1: Read Model reference whitelist (domain-partitioned scan)', () => {
  // Synchronous collection-time scan of the real tree (same style as the
  // IO-seam guard in architecture-regression.test.ts).
  const allFiles: string[] = [];
  const allEntries: { relPath: string; source: string }[] = [];
  const domainCounts = { production: 0, test: 0, excluded: 0 };
  {
    collectTsFiles(CORE_SRC_ROOT, allFiles);
    for (const filePath of allFiles) {
      const relPath = pathSync.relative(CORE_SRC_ROOT, filePath).replace(/\\/g, '/');
      domainCounts[classifyFile(relPath)] += 1;
      allEntries.push({ relPath, source: fsSync.readFileSync(filePath, 'utf-8') });
    }
  }

  it('scan is complete: every scanned file is classified into exactly one domain (no overlap, no gap)', () => {
    expect(allFiles.length).toBeGreaterThan(0);
    expect(domainCounts.production + domainCounts.test + domainCounts.excluded).toBe(allFiles.length);
    // The historical blind spot: a *.test.ts OUTSIDE __tests__ must land in
    // the test domain, not fall through both scans.
    expect(domainCounts.test).toBeGreaterThan(0);
    expect(domainCounts.production).toBeGreaterThan(0);
  });

  it('production domain: only pain-recall-capability.ts references the read model', () => {
    const productionRefs = allEntries.filter(
      (e) => classifyFile(e.relPath) === 'production' && readModelReferencesIn(e.source).length > 0,
    );
    expect(
      productionRefs.map((e) => e.relPath),
      `unexpected production read-model referencers: ${productionRefs.map((e) => e.relPath).join(', ')}`,
    ).toEqual(['runtime-v2/pain-recall-capability.ts']);
  });

  it('test domain: only the three authorized test files reference the read model', () => {
    // This guard file itself is EXCLUDED from the reference enumeration by an
    // explicit, single-file carve-out: its detector self-tests embed
    // read-model specifiers as DATA fixtures, which the raw-text detector
    // cannot distinguish from real references. The carve-out removes ONLY
    // this enumeration; the file still counts in the test-domain totals of
    // the completeness assertion above (no scan gap is introduced).
    const GUARD_SELF = 'runtime-v2/__tests__/pain-recall-architecture-guards.test.ts';
    const testRefs = allEntries
      .filter((e) => e.relPath !== GUARD_SELF)
      .filter((e) => classifyFile(e.relPath) === 'test' && readModelReferencesIn(e.source).length > 0)
      .map((e) => e.relPath)
      .sort();
    expect(
      testRefs,
      `unexpected test read-model referencers: ${testRefs.join(', ')}`,
    ).toEqual([
      'runtime-v2/__tests__/pain-recall-capability.test.ts',
      'runtime-v2/__tests__/pain-recall-readonly.test.ts',
      'runtime-v2/__tests__/pain-recall-service.test.ts',
    ]);
  });

  it('the pain-recall trio contains no reverse dependency on pd-cli or host-runtime (repo-wide DAG has its own guard)', () => {
    // Scoped to this migration's files: runtime-v2/index.ts and
    // pain-ingress-payload.ts mention those specifiers in COMMENTS only
    // (pre-existing, covered by the repo-wide DAG guard).
    for (const relPath of [READ_MODEL_REL, 'runtime-v2/pain-recall-snapshot-hooks.ts', 'runtime-v2/pain-recall-capability.ts']) {
      const entry = allEntries.find((e) => e.relPath === relPath);
      if (entry === undefined) throw new Error(`G-1 scan missing expected file: ${relPath}`);
      const specifiers = [...entry.source.matchAll(/['"](@principles\/[a-z-]+)['"]/g)].map((m) => m[1]);
      expect(specifiers.filter((s) => s === '@principles/pd-cli' || s === '@principles/host-runtime'), relPath).toEqual([]);
    }
  });

  // ── Positive/negative self-tests (guard cannot pass vacuously) ──────────

  it('rule evaluator: legal facade production reference passes (self-test 1)', () => {
    expect(evaluateReferenceRule([
      { relPath: 'runtime-v2/pain-recall-capability.ts', source: `import { recallPains } from './pain-recall-read-model.js';` },
    ])).toEqual([]);
  });

  it('rule evaluator: authorized test references pass (self-test 2)', () => {
    for (const relPath of [
      'runtime-v2/__tests__/pain-recall-readonly.test.ts',
      'runtime-v2/__tests__/pain-recall-service.test.ts',
      'runtime-v2/__tests__/pain-recall-capability.test.ts',
    ]) {
      expect(evaluateReferenceRule([
        { relPath, source: `import { recallPains } from '../pain-recall-read-model.js';` },
      ])).toEqual([]);
    }
  });

  it('rule evaluator: non-authorized PRODUCTION reference fails (self-test 3)', () => {
    const violations = evaluateReferenceRule([
      { relPath: 'runtime-v2/some-other-service.ts', source: `import { recallPains } from './pain-recall-read-model.js';` },
      { relPath: 'some-root-module.ts', source: `import x from './runtime-v2/pain-recall-read-model.js';` },
    ]);
    expect(violations).toHaveLength(2);
  });

  it('rule evaluator: non-authorized TEST reference fails — including a *.test.ts OUTSIDE __tests__ (self-test 4, blind-spot regression)', () => {
    const violations = evaluateReferenceRule([
      { relPath: 'runtime-v2/__tests__/unrelated.test.ts', source: `import { recallPains } from '../pain-recall-read-model.js';` },
      // The old blind spot: a *.test.ts outside __tests__ used to escape both
      // the production scan and a __tests__-scoped test scan. It MUST be
      // classified as test-domain AND flagged as unauthorized here.
      { relPath: 'runtime-v2/some-dir/stray-golden.test.ts', source: `import { recallPains } from '../pain-recall-read-model.js';` },
    ]);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.includes('not authorized'))).toBe(true);
  });

  it('detector: static import, side-effect import, re-export, dynamic import, and require are all recognized (self-test 5)', () => {
    const forms = [
      `import { recallPains } from './pain-recall-read-model.js';`,
      `import './pain-recall-read-model.js';`,
      `export { recallPains } from './pain-recall-read-model.js';`,
      `const m = await import('./pain-recall-read-model.js');`,
      `const m = require('./pain-recall-read-model.js');`,
    ];
    for (const form of forms) {
      expect(readModelReferencesIn(form), `form not detected: ${form}`).toHaveLength(1);
    }
    // A sibling module with a similar name must NOT match.
    expect(readModelReferencesIn(`import { x } from './pain-chain-read-model.js';`)).toEqual([]);
    expect(readModelReferencesIn(`import { x } from './pain-recall-capability.js';`)).toEqual([]);
  });

  it('domain partition: exhaustive and mutually exclusive over synthetic paths (self-test 6)', () => {
    const cases: readonly [string, ScanDomain][] = [
      ['runtime-v2/pain-recall-capability.ts', 'production'],
      ['runtime-v2/pain-recall-read-model.ts', 'production'],
      ['runtime-v2/__tests__/pain-recall-service.test.ts', 'test'], // matches BOTH rules → test wins, single domain
      ['runtime-v2/deep/dir/stray.test.ts', 'test'], // outside __tests__ — the closed blind spot
      ['runtime-v2/deep/dir/stray.spec.ts', 'test'],
      ['runtime-v2/some.d.ts', 'excluded'],
      ['principle-tree-ledger.ts', 'production'],
    ];
    for (const [p, expected] of cases) {
      expect(classifyFile(p), p).toBe(expected);
    }
  });
});

// ── G-2: export-face snapshots ───────────────────────────────────────────────

/** Export-name extraction over source text — the same technique as the
 * frozen barrel surface guard in architecture-regression.test.ts. Used here
 * so this guard file itself never imports the read model (which would make
 * it a G-1 referencer). The RUNTIME export sets are additionally pinned by
 * the two authorized test files (service + capability). */
function extractExportNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/g)) {
    if (m[1] != null) names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) { // eslint-disable-line @typescript-eslint/no-non-null-assertion -- group 1 always present in this literal pattern
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name != null && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  // `export interface` / `export type` are erased at runtime — deliberately
  // NOT collected; the runtime key set is what the subpath exposes.
  return [...names].sort();
}

describe('G-2: subpath export faces (runtime export sets pinned exactly)', () => {
  const readModelSource = fsSync.readFileSync(pathSync.resolve(__dirname, '..', 'pain-recall-read-model.ts'), 'utf-8');
  const capabilitySource = fsSync.readFileSync(pathSync.resolve(__dirname, '..', 'pain-recall-capability.ts'), 'utf-8');
  const hooksSource = fsSync.readFileSync(pathSync.resolve(__dirname, '..', 'pain-recall-snapshot-hooks.ts'), 'utf-8');

  it('read-model subpath exports exactly the contract surface (no snapshot hooks)', () => {
    expect(extractExportNames(readModelSource)).toEqual([
      'PAIN_RECALL_DEFAULT_LIMIT',
      'PAIN_RECALL_MAX_LIMIT',
      'PAIN_RECALL_MIN_LIMIT',
      'PAIN_RECALL_SCHEMA_VERSION',
      'recallPains',
    ]);
    expect(readModelSource.includes('painRecallSnapshotTestHooks')).toBe(true); // consumed via the internal hooks module
    expect(/export\s+(?:const|function|\{[^}]*)\s*\S*painRecallSnapshotTestHooks/.test(readModelSource)).toBe(false); // but never re-exported
  });

  it('capability subpath exports exactly the facade surface', () => {
    expect(extractExportNames(capabilitySource)).toEqual([
      'CAPABILITY_SCHEMA_VERSION',
      'OD_A_DISCLOSURE_PROFILE',
      'RECALL_PAIN_CAPABILITY_ID',
      'recallPrinciplePainsCapability',
    ]);
    expect(capabilitySource.includes('painRecallSnapshotTestHooks')).toBe(false);
  });

  it('snapshot-hooks module declares the seam but stays out of both subpaths and every exports key', () => {
    // SnapshotStatsLike is an `export interface` — erased at runtime, so the
    // runtime surface is exactly the hooks object.
    expect(extractExportNames(hooksSource)).toEqual(['painRecallSnapshotTestHooks']);
    const pkgRaw: unknown = JSON.parse(
      fsSync.readFileSync(pathSync.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf-8'),
    );
    const pkg = pkgRaw as { exports?: Record<string, unknown> };
    if (pkg.exports === undefined) throw new Error('core package.json has no exports map');
    const exportsMap = pkg.exports;
    const serialized = JSON.stringify(exportsMap);
    expect(serialized.includes('pain-recall-snapshot-hooks')).toBe(false);
    expect(Object.hasOwn(exportsMap, './runtime-v2/pain-recall')).toBe(true);
    expect(Object.hasOwn(exportsMap, './runtime-v2/pain-recall-capability')).toBe(true);
    const readModelEntry = exportsMap['./runtime-v2/pain-recall'] as { types?: string; default?: string };
    const capabilityEntry = exportsMap['./runtime-v2/pain-recall-capability'] as { types?: string; default?: string };
    expect(readModelEntry.types).toBe('./dist/runtime-v2/pain-recall-read-model.d.ts');
    expect(readModelEntry.default).toBe('./dist/runtime-v2/pain-recall-read-model.js');
    expect(capabilityEntry.types).toBe('./dist/runtime-v2/pain-recall-capability.d.ts');
    expect(capabilityEntry.default).toBe('./dist/runtime-v2/pain-recall-capability.js');
  });

  it('barrels do not re-export the new modules (R3: frozen barrel surfaces untouched)', () => {
    const runtimeBarrel = fsSync.readFileSync(pathSync.resolve(__dirname, '..', 'index.ts'), 'utf-8');
    const coreBarrel = fsSync.readFileSync(pathSync.resolve(__dirname, '..', '..', 'index.ts'), 'utf-8');
    expect(runtimeBarrel.includes('pain-recall')).toBe(false);
    expect(coreBarrel.includes('pain-recall')).toBe(false);
  });
});

// ── G-3: pd-cli reference face ───────────────────────────────────────────────

describe('G-3: pd-cli reference face (R6: read-model subpath only, zero capability references)', () => {
  // __tests__ → runtime-v2 → src → principles-core → packages → pd-cli/src
  const PD_CLI_SRC = pathSync.resolve(__dirname, '..', '..', '..', '..', 'pd-cli', 'src');

  function collectFiles(dir: string, acc: string[]): void {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = pathSync.join(dir, entry.name);
      if (entry.isDirectory()) collectFiles(fullPath, acc);
      else if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(fullPath);
    }
  }

  const files: string[] = [];
  collectFiles(PD_CLI_SRC, files);
  const sources = files.map((f) => ({
    relPath: pathSync.relative(PD_CLI_SRC, f).replace(/\\/g, '/'),
    source: fsSync.readFileSync(f, 'utf-8'),
  }));

  it('pd-cli src has zero references to the capability subpath', () => {
    const offenders = sources.filter((s) => s.source.includes('pain-recall-capability'));
    expect(offenders.map((s) => s.relPath), 'capability subpath leaked into pd-cli').toEqual([]);
  });

  it('pd-cli src references the read-model subpath ONLY from the command shell (single import)', () => {
    const referring = sources.filter((s) => s.source.includes('@principles/core/runtime-v2/pain-recall'));
    expect(referring.map((s) => s.relPath)).toEqual(['commands/pain-recall.ts']);
    const occurrences = referring[0]?.source.match(/@principles\/core\/runtime-v2\/pain-recall/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it('the old service path is gone everywhere in pd-cli src (no dual implementation)', () => {
    const offenders = sources.filter((s) => s.source.includes('services/pain-recall'));
    expect(offenders.map((s) => s.relPath), 'stale service-path import').toEqual([]);
  });
});
