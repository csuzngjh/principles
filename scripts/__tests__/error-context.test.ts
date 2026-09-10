/**
 * Error Context Router tests — Error Experience v2.
 *
 * ERR-025 / EP-09 discipline: these tests exercise the REAL parser and
 * matching functions (direct import, no string-existence scans), including:
 *   - pattern metadata parsing (valid/malformed/duplicate/heading-mismatch/
 *     invalid enums) against synthetic markdown fixtures;
 *   - routing (path-only, diff-signal, multi-pattern, exact matched signals,
 *     no-match) through routeContext;
 *   - the PR #1472 synthetic regression fixture (must bite: EP-02 + EP-09,
 *     and EP-03 via its diff signals);
 *   - negative controls (docs-only, typo-only) that must NOT produce HIGH
 *     EP-02/03/09 noise;
 *   - CLI arg parsing and run() end-to-end with injected diff/patterns;
 *   - JSON mode machine-readable;
 *   - recurrence metadata parsing and hotspot aggregation via the CJS
 *     helpers (single implementation shared with check:error-handbook).
 */

import { describe, it, expect } from 'vitest';
import {
  parsePatternRouting,
  parseRecurrenceMeta,
  routeContext,
  hunksToInputs,
  renderText,
  renderJson,
  parseArgs,
  run,
  resolveRouterBase,
} from '../error-context.mjs';
import {
  parsePatternRouting as parsePatternRoutingCjs,
  parseRecurrenceMeta as parseRecurrenceMetaCjs,
  aggregateHotspots,
} from '../error-handbook-meta.cjs';
import { parseDiffHunks } from '../runtime-contract-diff.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const realIndex = readFileSync(
  path.join(repoRoot, 'docs', 'process', 'error-management', 'ERROR_PATTERN_INDEX.md'),
  'utf8',
);

// ─── Fixture builders ────────────────────────────────────────────────────

function routingBlock(id, risk = 'high', enforcement = 'semantic', extra = {}) {
  return `<!-- error-pattern-routing
{
  "id": "${id}",
  "risk": "${risk}",
  "pathSignals": ${JSON.stringify(extra.pathSignals ?? ['src/main'])},
  "diffSignals": ${JSON.stringify(extra.diffSignals ?? ['preload'])},
  "requiredEvidence": ${JSON.stringify(extra.requiredEvidence ?? ['Prove production wiring.'])},
  "enforcement": "${enforcement}"
}
-->`;
}

const minimalIndex = (blocks: string[]) =>
  ['# Error Pattern Index', '', '## Pattern Cards', '', ...blocks].join('\n');

function epHeading(id: string, title = 'Card') {
  return `### ${id} ${title}`;
}

// The REAL index, parsed once for router-level tests (single source of truth:
// the shipped metadata is the contract these tests lock).
const realParsed = parsePatternRouting(realIndex);

// ─── Pattern parser ─────────────────────────────────────────────────────

describe('parsePatternRouting — real shipped index', () => {
  it('parses all 13 active EP cards with valid metadata and zero errors', () => {
    expect(realParsed.patterns.map((p) => p.id)).toEqual([
      'EP-01', 'EP-02', 'EP-03', 'EP-04', 'EP-05', 'EP-06', 'EP-07',
      'EP-08', 'EP-09', 'EP-10', 'EP-11', 'EP-12', 'EP-13',
    ]);
    expect(realParsed.errors).toEqual([]);
  });

  it('CJS and ESM parsers agree on the real index (single implementation contract)', () => {
    const cjs = parsePatternRoutingCjs(realIndex);
    expect(cjs.errors).toEqual([]);
    expect(cjs.patterns).toHaveLength(realParsed.patterns.length);
    for (const p of realParsed.patterns) {
      const match = cjs.patterns.find((c) => c.id === p.id);
      expect(match).toBeDefined();
      expect(match.risk).toBe(p.risk);
      expect(match.enforcement).toBe(p.enforcement);
      expect(match.pathSignals).toEqual(p.pathSignals);
      expect(match.diffSignals).toEqual(p.diffSignals);
    }
  });
});

describe('parsePatternRouting — synthetic edge cases', () => {
  it('reports malformed JSON explicitly', () => {
    const md = minimalIndex([
      epHeading('EP-01'),
      '<!-- error-pattern-routing\n{ "id": "EP-01", oops }\n-->',
    ]);
    const r = parsePatternRouting(md);
    expect(r.patterns).toEqual([]);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain('invalid JSON');
  });

  it('reports duplicate EP metadata', () => {
    const md = minimalIndex([
      epHeading('EP-01'),
      routingBlock('EP-01'),
      routingBlock('EP-01'),
    ]);
    const r = parsePatternRouting(md);
    expect(r.patterns).toHaveLength(1);
    expect(r.errors[0]).toContain('duplicate routing metadata for EP-01');
  });

  it('reports heading/metadata ID mismatch', () => {
    const md = minimalIndex([
      epHeading('EP-01'),
      routingBlock('EP-02'),
    ]);
    const r = parsePatternRouting(md);
    expect(r.patterns).toEqual([]);
    expect(r.errors[0]).toContain('EP-02 has no matching pattern card heading');
  });

  it('reports invalid risk/enforcement enums', () => {
    const md = minimalIndex([
      epHeading('EP-01'),
      routingBlock('EP-01', 'extreme' as never, 'optional' as never),
    ]);
    const r = parsePatternRouting(md);
    expect(r.errors[0]).toContain('risk must be one of');
    expect(r.errors[0]).toContain('enforcement must be one of');
  });

  it('reports empty requiredEvidence', () => {
    const md = minimalIndex([
      epHeading('EP-01'),
      routingBlock('EP-01', 'high', 'semantic', { requiredEvidence: [] }),
    ]);
    const r = parsePatternRouting(md);
    expect(r.errors[0]).toContain('requiredEvidence must be a non-empty string array');
  });

  it('ignores unrelated HTML comments (PR template prose etc.)', () => {
    const md = [
      '# Doc',
      '<!--\nPR template policy: agent sections...\n-->',
      epHeading('EP-01'),
      routingBlock('EP-01'),
    ].join('\n');
    const r = parsePatternRouting(md);
    expect(r.errors).toEqual([]);
    expect(r.patterns).toHaveLength(1);
  });
});

// ─── Matching algorithm ─────────────────────────────────────────────────

describe('routeContext', () => {
  it('path-only preliminary routing (plan mode, no signals)', () => {
    const hits = routeContext(realParsed.patterns, ['packages/pd-companion/src/main/main.ts'], []);
    const ep02 = hits.find((h) => h.id === 'EP-02');
    expect(ep02).toBeDefined();
    expect(ep02.confidence).toBe('medium'); // 1 path hit = +2 → MEDIUM
    expect(ep02.matches[0]).toEqual({ kind: 'path', path: 'packages/pd-companion/src/main/main.ts', signal: 'src/main' });
  });

  it('diff signals route without any path hits', () => {
    const hits = routeContext(realParsed.patterns, ['some/unrelated/dir/x.txt'], ['JSON.parse(x) as Foo']);
    const ep01 = hits.find((h) => h.id === 'EP-01');
    expect(ep01).toBeDefined();
    expect(ep01.matches.map((m) => m.signal)).toContain('JSON.parse');
    expect(ep01.matches.map((m) => m.signal)).toContain(' as unknown as'.length > 0 ? 'JSON.parse' : '');
  });

  it('routes multiple patterns from mixed inputs', () => {
    const hits = routeContext(
      realParsed.patterns,
      ['packages/pd-cli/src/commands/foo.ts'],
      ['process.exit(1)', '--json output'],
    );
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('EP-04');
    expect(ids).toContain('EP-02');
  });

  it('no-match returns empty (caller must render the manual-review notice)', () => {
    const hits = routeContext(realParsed.patterns, ['README.md'], []);
    expect(hits).toEqual([]);
    expect(renderText(hits, 'x')).toContain(
      'No automatic routing match; manual Pattern Index review is still required.',
    );
  });

  it('every hit carries its exact matched signal and required evidence', () => {
    const hits = routeContext(realParsed.patterns, ['packages/pd-cli/src/commands/a.ts'], []);
    const ep04 = hits.find((h) => h.id === 'EP-04')!;
    expect(ep04.matches.length).toBeGreaterThan(0);
    expect(ep04.requiredEvidence.length).toBeGreaterThan(0);
    for (const m of ep04.matches) {
      expect(typeof m.signal).toBe('string');
      expect(m.signal.length).toBeGreaterThan(0);
    }
  });
});

// ─── PR #1472 synthetic regression fixture (the router's bite test) ──────

describe('PR #1472 synthetic regression fixture', () => {
  // Minimal synthetic diff expressing the four risk axes of PR #1472:
  // Electron BrowserWindow + preload production wiring; safeStorage /
  // persistence / restart failure semantics; source-substring test changes.
  const fixtureDiff = [
    'diff --git a/packages/pd-companion/src/main/main.ts b/packages/pd-companion/src/main/main.ts',
    '--- a/packages/pd-companion/src/main/main.ts',
    '+++ b/packages/pd-companion/src/main/main.ts',
    '@@ -10,3 +10,9 @@',
    '+import { safeStorage, ipcMain } from "electron";',
    '+  webPreferences: { sandbox: true, preload: path.join(__dirname, "..", "preload.cjs") },',
    '+function saveState(): boolean {',
    '+  const ok = persist();',
    '+  return ok;',
    '+}',
    '+function restartFromTray(): boolean {',
    '+  stopServer();',
    '+  return true;',
    '+}',
    'diff --git a/packages/pd-companion/src/preload.cts b/packages/pd-companion/src/preload.cts',
    '--- a/packages/pd-companion/src/preload.cts',
    '+++ b/packages/pd-companion/src/preload.cts',
    '@@ -0,0 +1,4 @@',
    '+import { contextBridge, ipcRenderer } from "electron";',
    '+contextBridge.exposeInMainWorld("pdCompanion", {',
    '+  configureConsoleToken: (t: string) => ipcRenderer.invoke("pd-companion:configure-console-token", t),',
    '+});',
    'diff --git a/packages/pd-companion/tests/main/coexistence.test.ts b/packages/pd-companion/tests/main/coexistence.test.ts',
    '--- a/packages/pd-companion/tests/main/coexistence.test.ts',
    '+++ b/packages/pd-companion/tests/main/coexistence.test.ts',
    '@@ -45,0 +46,10 @@',
    "+  it('token encrypted via safeStorage', () => {",
    "+    const source = src();",
    "+    expect(source).toContain('safeStorage.encryptString');",
    "+    expect(source).toContain('path.join(__dirname, .., preload.cjs)');",
    "+  });",
  ].join('\n');

  it('parses into per-file hunks via the REAL parseDiffHunks', () => {
    const hunks = parseDiffHunks(fixtureDiff);
    expect(hunks.map((h) => h.file)).toEqual([
      'packages/pd-companion/src/main/main.ts',
      'packages/pd-companion/src/preload.cts',
      'packages/pd-companion/tests/main/coexistence.test.ts',
    ]);
  });

  it('bites: routes EP-02 AND EP-09 at HIGH confidence (the wiring + test-reality axes)', () => {
    const hunks = parseDiffHunks(fixtureDiff);
    const { files, texts } = hunksToInputs(hunks);
    const hits = routeContext(realParsed.patterns, files, texts);
    const ids = new Map(hits.map((h) => [h.id, h]));

    // EP-02: preload + src/main path signals + BrowserWindow-class diff signals
    expect(ids.get('EP-02')).toBeDefined();
    expect(ids.get('EP-02').confidence).toBe('high');
    // EP-09: tests/ path signals + toContain/readFileSync source-scan signals
    expect(ids.get('EP-09')).toBeDefined();
    expect(ids.get('EP-09').confidence).toBe('high');
    // EP-03: safeStorage / saveState / restart diff signals (may be MEDIUM or HIGH)
    expect(ids.get('EP-03')).toBeDefined();
    expect(['medium', 'high']).toContain(ids.get('EP-03').confidence);
  });

  it('plan mode with the same survey inputs routes the same way (Pass 1 ≡ Pass 2 for #1472)', () => {
    const hits = routeContext(realParsed.patterns,
      ['packages/pd-companion/src/main/main.ts', 'packages/pd-companion/src/preload.cts'],
      ['preload', 'safeStorage', 'BrowserWindow']);
    const ids = new Map(hits.map((h) => [h.id, h]));
    expect(ids.get('EP-02').confidence).toBe('high');
    expect(ids.get('EP-03')).toBeDefined();
  });
});

// ─── Negative controls (noise floor) ─────────────────────────────────────

describe('negative controls', () => {
  it('docs-only change produces no HIGH EP-02/03/09 hits', () => {
    const docsDiff = [
      'diff --git a/docs/product/PRODUCT_IDENTITY.md b/docs/product/PRODUCT_IDENTITY.md',
      '--- a/docs/product/PRODUCT_IDENTITY.md',
      '+++ b/docs/product/PRODUCT_IDENTITY.md',
      '@@ -1,2 +1,3 @@',
      '+PD owns Owner-relevant behavioral evidence.',
      '+It does not own general task execution.',
    ].join('\n');
    const { files, texts } = hunksToInputs(parseDiffHunks(docsDiff));
    const hits = routeContext(realParsed.patterns, files, texts);
    const highNoise = hits.filter(
      (h) => h.confidence === 'high' && ['EP-02', 'EP-03', 'EP-09'].includes(h.id),
    );
    expect(highNoise).toEqual([]);
  });

  it('typo-only test tweak does not produce a flood of HIGH findings', () => {
    const typoDiff = [
      'diff --git a/packages/pd-cli/tests/units/a.test.ts b/packages/pd-cli/tests/units/a.test.ts',
      '--- a/packages/pd-cli/tests/units/a.test.ts',
      '+++ b/packages/pd-cli/tests/units/a.test.ts',
      '@@ -12,1 +12,1 @@',
      '+    expect(reuslt).toBe(true); // fix typo',
    ].join('\n');
    const { files, texts } = hunksToInputs(parseDiffHunks(typoDiff));
    const hits = routeContext(realParsed.patterns, files, texts);
    const highCount = hits.filter((h) => h.confidence === 'high').length;
    expect(highCount).toBeLessThanOrEqual(1);
  });
});

// ─── CLI: parseArgs + run() end-to-end (injected) ────────────────────────

describe('parseArgs', () => {
  it('plan mode: --paths + --signals', () => {
    const r = parseArgs(['--paths', 'a/b.ts,c/d.ts', '--signals', 'preload, ipcMain']);
    expect(r).toEqual({
      ok: true, mode: 'plan',
      paths: ['a/b.ts', 'c/d.ts'],
      signals: ['preload', 'ipcMain'],
      base: '', json: false,
    });
  });

  it('diff mode defaults to origin/main when no mode flag given', () => {
    const r = parseArgs([]);
    expect(r.ok && r.mode).toBe('diff');
    expect(r.ok && r.base).toBe('origin/main');
  });

  it('rejects --paths together with --base (mode conflict)', () => {
    const r = parseArgs(['--paths', 'a', '--base', 'origin/main']);
    expect(!r.ok && r.error).toContain('mutually exclusive');
  });

  it('rejects unknown arguments with nextAction', () => {
    const r = parseArgs(['--frobnicate']);
    expect(!r.ok).toBe(true);
    expect(!r.ok && r.nextAction).toContain('Usage');
  });

  it('rejects empty --paths value', () => {
    const r = parseArgs(['--paths']);
    expect(!r.ok && r.error).toContain('requires a comma-separated list');
  });
});

describe('run() end-to-end with injected dependencies', () => {
  const fixedPatterns = realParsed.patterns;

  it('diff mode: routes an injected #1472-shaped diff and exits 0', () => {
    const fixtureDiff = readFileSync(
      path.join(repoRoot, 'scripts', '__tests__', 'fixtures', 'pr1472-synthetic.diff'),
      'utf8',
    );
    const result = run({
      argv: ['--base', 'origin/main'],
      resolveBase: () => ({ ref: 'origin/main..HEAD', kind: 'origin/main' }),
      getDiff: () => ({ ok: true, hunks: parseDiffHunks(fixtureDiff) }),
      loadPatterns: () => realParsed,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('EP-02 — HIGH');
    expect(result.stdout).toContain('EP-09 — HIGH');
  });

  it('base unavailable → non-zero exit with reason + nextAction (rc-9)', () => {
    const result = run({
      argv: ['--base', 'origin/nonexistent'],
      resolveBase: () => ({
        ref: '', kind: 'none',
        note: 'no base ref available',
      }),
      loadPatterns: () => realParsed,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('FAILED');
    expect(result.stdout).toContain('Next action');
  });

  it('git diff failure → non-zero exit with reason + nextAction', () => {
    const result = run({
      argv: ['--base', 'origin/main'],
      resolveBase: () => ({ ref: 'origin/main..HEAD', kind: 'origin/main' }),
      getDiff: () => ({
        ok: false,
        reason: 'git diff against origin/main..HEAD failed',
        nextAction: 'Run git fetch origin.',
      }),
      loadPatterns: () => realParsed,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('git diff against origin/main..HEAD failed');
    expect(result.stdout).toContain('git fetch origin');
  });

  it('JSON mode is machine-readable (single parseable object, same semantics)', () => {
    const fixtureDiff = readFileSync(
      path.join(repoRoot, 'scripts', '__tests__', 'fixtures', 'pr1472-synthetic.diff'),
      'utf8',
    );
    const result = run({
      argv: ['--base', 'origin/main', '--json'],
      resolveBase: () => ({ ref: 'origin/main..HEAD', kind: 'origin/main' }),
      getDiff: () => ({ ok: true, hunks: parseDiffHunks(fixtureDiff) }),
      loadPatterns: () => realParsed,
    });
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed.patterns)).toBe(true);
    const ids = parsed.patterns.map((p: { id: string }) => p.id);
    expect(ids).toContain('EP-02');
    expect(ids).toContain('EP-09');
    for (const p of parsed.patterns) {
      expect(Array.isArray(p.matches)).toBe(true);
      expect(Array.isArray(p.requiredEvidence)).toBe(true);
      expect(['high', 'medium', 'low']).toContain(p.confidence);
    }
  });

  it('unparseable pattern metadata → non-zero exit, never silent pass', () => {
    const result = run({
      argv: ['--paths', 'a.ts'],
      loadPatterns: () => ({ patterns: [], errors: ['routing metadata invalid JSON: boom'] }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('routing metadata could not be parsed');
  });

  it('plan mode routes through the same path/diff signal machinery', () => {
    const result = run({
      argv: ['--paths', 'packages/pd-companion/src/main/main.ts,packages/pd-companion/src/preload.cts', '--signals', 'preload,BrowserWindow'],
      loadPatterns: () => realParsed,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('EP-02 — HIGH');
  });
});

// ─── resolveRouterBase — two-dot working-tree semantics ──────────────────

describe('resolveRouterBase', () => {
  it('reuses the candidate probing but returns a two-dot working-tree ref', () => {
    const base = resolveRouterBase(['origin/main'], (ref: string) => ref === 'origin/main');
    expect(base.kind).toBe('origin/main');
    expect(base.ref).toBe('origin/main..HEAD');
  });

  it('propagates the none-kind with note when no candidate verifies', () => {
    const base = resolveRouterBase(['x', 'y'], () => false);
    expect(base.kind).toBe('none');
    expect(base.ref).toBe('');
  });
});

// ─── Recurrence metadata + hotspots (CJS helpers) ────────────────────────

describe('parseRecurrenceMeta', () => {
  const recBlock = (over: Record<string, unknown>) => `<!-- recurrence-meta
${JSON.stringify({
  date: '2026-09-10',
  pattern: 'EP-09',
  invariant: 'test-asserts-source-substring-not-wiring',
  severity: 'P2',
  escaped: 'verify-merge',
  caughtBy: 'pr-review',
  guard: 'none',
  ...over,
})}
-->`;

  it('parses a valid recurrence block', () => {
    const r = parseRecurrenceMetaCjs(`# H\n- 2026-09-10 PR #1600: narrative.\n${recBlock({})}`);
    expect(r.errors).toEqual([]);
    expect(r.recurrences).toHaveLength(1);
    expect(r.recurrences[0].pattern).toBe('EP-09');
  });

  it('ESM and CJS recurrence parsers agree', () => {
    const md = `# H\n${recBlock({})}`;
    expect(parseRecurrenceMeta(md)).toEqual(parseRecurrenceMetaCjs(md));
  });

  it('reports malformed recurrence metadata', () => {
    const r = parseRecurrenceMetaCjs('# H\n<!-- recurrence-meta\n{oops}\n-->');
    expect(r.errors[0]).toContain('invalid JSON');
  });

  it('reports unknown EP pattern, bad date, missing invariant, bad severity, bad caughtBy', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      // 'unknown EP pattern' (valid shape, nonexistent card) is a checker-level
      // cross-reference (routingIds), covered by the real-handbook test below.
      [{ pattern: 'EP-9' }, 'pattern must match EP-NN'],
      [{ date: '2026-13-45' }, 'date must be a valid'],
      [{ date: 'not-a-date' }, 'date must be a valid'],
      [{ invariant: '' }, 'invariant must be a non-empty string'],
      [{ severity: 'P9' }, 'severity must be P0..P3'],
      [{ caughtBy: 'divine-intervention' }, 'caughtBy must be one of'],
      [{ guard: '' }, 'guard must be a non-empty string'],
    ];
    for (const [over, expected] of cases) {
      const r = parseRecurrenceMetaCjs(`# H\n${recBlock(over)}`);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors[0]).toContain(expected);
    }
  });

  it('real handbook has exactly the one shipped structured recurrence (PR #1472)', () => {
    const handbook = readFileSync(
      path.join(repoRoot, 'docs', 'process', 'error-management', 'ERROR_EXPERIENCE_HANDBOOK.md'),
      'utf8',
    );
    const r = parseRecurrenceMetaCjs(handbook);
    expect(r.errors).toEqual([]);
    expect(r.recurrences).toHaveLength(1);
    expect(r.recurrences[0].invariant).toBe('test-asserts-source-substring-not-wiring');
  });
});

describe('aggregateHotspots', () => {
  const NOW = new Date('2026-09-10T00:00:00Z');
  const rec = (pattern: string, invariant: string, date: string, guard = 'none', escaped = 'verify-merge') => ({
    date, pattern, invariant, severity: 'P2', escaped, caughtBy: 'pr-review', guard,
  });

  it('single recurrence → normal, no decision required', () => {
    const { hotspots, decisionRequired } = aggregateHotspots(
      [rec('EP-09', 'inv-a', '2026-09-01')], [], NOW,
    );
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0].total).toBe(1);
    expect(decisionRequired).toEqual([]);
  });

  it('2 recent same-invariant recurrences + guard none → ENFORCEMENT DECISION REQUIRED', () => {
    const { decisionRequired } = aggregateHotspots(
      [rec('EP-09', 'inv-a', '2026-08-20'), rec('EP-09', 'inv-a', '2026-09-05')], [], NOW,
    );
    expect(decisionRequired).toHaveLength(1);
    expect(decisionRequired[0].pattern).toBe('EP-09');
    expect(decisionRequired[0].invariant).toBe('inv-a');
  });

  it('guard present → no missing-enforcement warning', () => {
    const { decisionRequired } = aggregateHotspots(
      [rec('EP-09', 'inv-a', '2026-08-20', 'check:runtime-contract'), rec('EP-09', 'inv-a', '2026-09-05', 'check:runtime-contract')], [], NOW,
    );
    expect(decisionRequired).toEqual([]);
  });

  it('different invariants under the same pattern are NOT aggregated together', () => {
    const { hotspots, decisionRequired } = aggregateHotspots(
      [rec('EP-09', 'inv-a', '2026-09-01'), rec('EP-09', 'inv-b', '2026-09-02')], [], NOW,
    );
    expect(hotspots).toHaveLength(2);
    expect(decisionRequired).toEqual([]);
  });

  it('old recurrences outside the 90-day window do not trigger escalation', () => {
    const { decisionRequired } = aggregateHotspots(
      [rec('EP-09', 'inv-a', '2026-05-01'), rec('EP-09', 'inv-a', '2026-05-15')], [], NOW,
    );
    expect(decisionRequired).toEqual([]);
  });
});
