/**
 * OPT-002 follow-through (Owner instruction) — satellite purity guard.
 *
 * The barrel narrowing that cut ~5.6 MB of LLM SDK code out of
 * governance-audit.js / rulehost-evidence.js holds only while nobody puts a
 * VALUE import of `@principles/core/runtime-v2` back on a satellite path.
 * This file pins the build-level assertion that makes such a regression fail
 * the build instead of relying on engineering discipline:
 *   1. the checker judges the real esbuild metafile shape (violations named,
 *      main bundle exempt by design, no false positives on source names);
 *   2. the official plugin build is still wired to call it (deletion here
 *      fails CI — a guard nobody calls is decoration).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectSatelliteViolations,
  collectSizeBudgetViolations,
  assertSatellitePurity,
  SIZE_BUDGETS,
  SATELLITE_OUTPUT_SUFFIXES,
} from '../build/check-satellite-purity.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'build', 'check-satellite-purity.mjs');
const ESBUILD_CONFIG = path.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'esbuild.config.js');

function metafileWith(outputInputs: Record<string, string[]>, bytes = 1000) {
  const outputs: Record<string, { bytes: number; inputs: Record<string, { bytes: number }> }> = {};
  for (const [output, inputs] of Object.entries(outputInputs)) {
    outputs[output] = {
      bytes,
      inputs: Object.fromEntries(inputs.map((i) => [i, { bytes: 100 }])),
    };
  }
  return { inputs: {}, outputs };
}

const CLEAN = metafileWith({
  'dist/bundle.js': [
    '../../node_modules/@earendil-works/pi-ai/dist/index.js',
    '../../src/index.ts',
  ],
  'dist/governance-audit.js': [
    '../../src/governance-audit.ts',
    '../../src/core/event-log.ts',
    '../../../node_modules/@sinclair/typebox/build/esm/type/type.mjs',
  ],
  'dist/rulehost-evidence.js': [
    '../../src/rulehost-evidence.ts',
    '../../node_modules/@sinclair/typebox/build/esm/type/guard/type.mjs',
  ],
});

const POLLUTED = metafileWith({
  'dist/bundle.js': ['../../node_modules/@earendil-works/pi-ai/dist/index.js'],
  'dist/governance-audit.js': [
    '../../src/governance-audit.ts',
    '../../node_modules/@earendil-works/pi-ai/dist/providers/json',
    '../../node_modules/@anthropic-ai/sdk/index.mjs',
    '../../node_modules/openai/index.mjs',
    '../../node_modules/@google/genai/node_modules/undici/index.js',
    '../../node_modules/undici/lib/core/request.js',
  ],
  'dist/rulehost-evidence.js': ['../../src/rulehost-evidence.ts'],
});

describe('collectSatelliteViolations', () => {
  it('returns nothing for a clean satellite graph (LLM allowed in bundle.js only)', () => {
    expect(collectSatelliteViolations(CLEAN)).toEqual([]);
  });

  it('names every forbidden SDK input that re-entered a satellite', () => {
    const violations = collectSatelliteViolations(POLLUTED);
    expect(violations.map((v: { pkg: string }) => v.pkg).sort()).toEqual(
      ['@anthropic-ai', '@earendil-works/pi-ai', '@google/genai', 'openai', 'undici'].sort(),
    );
    for (const v of violations) {
      expect(v.output).toContain('governance-audit.js');
    }
  });

  it('normalizes Windows backslash input paths', () => {
    const win = metafileWith({
      'dist\\governance-audit.js': ['..\\..\\src\\governance-audit.ts'],
      'dist\\rulehost-evidence.js': [
        '..\\..\\node_modules\\@earendil-works\\pi-agent-core\\dist\\index.js',
      ],
    });
    const violations = collectSatelliteViolations(win);
    expect(violations).toHaveLength(1);
    expect(violations[0].pkg).toBe('@earendil-works/pi-agent-core');
  });

  it('does not trip on source-file names that merely contain SDK tokens', () => {
    const src = metafileWith({
      'dist/governance-audit.js': ['../../src/adapters/openai-compat-shim.ts'],
      'dist/rulehost-evidence.js': ['../../src/rulehost-evidence.ts'],
    });
    expect(collectSatelliteViolations(src)).toEqual([]);
  });

  it('matches only at node_modules package boundaries, not nested dirs of other vendors', () => {
    const nested = metafileWith({
      'dist/governance-audit.js': ['../../node_modules/some-tool/vendor/openai/util.js'],
      'dist/rulehost-evidence.js': ['../../node_modules/@sinclair/typebox/build/esm/type/type.mjs'],
    });
    expect(collectSatelliteViolations(nested)).toEqual([]);
  });

  it('fails loud on a malformed metafile (rc-3)', () => {
    expect(() => collectSatelliteViolations({})).toThrow(/metafile/);
    expect(() => collectSatelliteViolations(null)).toThrow(/metafile/);
  });

  it('fails loud when an expected satellite output is missing (rc-3, no vacuous pass)', () => {
    const partial = metafileWith({
      'dist/bundle.js': ['../../src/index.ts'],
      'dist/governance-audit.js': ['../../src/governance-audit.ts'],
    });
    expect(() => collectSatelliteViolations(partial)).toThrow(/rulehost-evidence\.js.*missing/s);
  });

  it('fails loud when a satellite output has no readable inputs map', () => {
    const malformed = {
      inputs: {},
      outputs: {
        'dist/governance-audit.js': { bytes: 10 },
        'dist/rulehost-evidence.js': { inputs: {} },
      },
    };
    expect(() => collectSatelliteViolations(malformed)).toThrow(/inputs map/);
  });
});

describe('assertSatellitePurity', () => {
  it('does not throw on the clean metafile', () => {
    expect(() => assertSatellitePurity(CLEAN)).not.toThrow();
  });

  it('logs the positive evidence line and returns zeroed per-satellite counts (OPT-003)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = assertSatellitePurity(CLEAN);
      expect(result).toEqual({
        total: 0,
        perSatellite: { 'governance-audit.js': 0, 'rulehost-evidence.js': 0 },
      });
      const line = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toContain('Forbidden dependency count: 0');
      expect(line).toContain('governance-audit.js: 0');
      expect(line).toContain('rulehost-evidence.js: 0');
    } finally {
      log.mockRestore();
    }
  });

  it('throws with structured reason, bounded examples and the fix pointer (rc-9)', () => {
    let message = '';
    try {
      assertSatellitePurity(POLLUTED);
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('[satellite-purity] FAIL');
    expect(message).toContain('governance-audit.js');
    expect(message).toContain('@earendil-works/pi-ai');
    expect(message).toContain('runtime-v2');
    // bounded output: <=3 example lines per package
    const examples = message.split('\n').filter((l) => l.trimStart().startsWith('e.g.'));
    expect(examples.length).toBeLessThanOrEqual(3 * 5);
  });
});

// PRI-919 size leg: per-output metafile bytes with per-input bytesInOutput
// (the attribution source for the FAIL message's "introduced by" lines).
function sizeMetafile(
  sizes: Record<string, { bytes?: number; inputs?: Record<string, number> }>,
) {
  const outputs: Record<string, unknown> = {};
  for (const [out, { bytes, inputs = {} }] of Object.entries(sizes)) {
    outputs[out] = {
      ...(bytes === undefined ? {} : { bytes }),
      inputs: Object.fromEntries(Object.entries(inputs).map(([i, b]) => [i, { bytesInOutput: b }])),
    };
  }
  return { inputs: {}, outputs };
}

// Real 2026-09-24 production baselines (docs/release/bundle-budget-audit.md §2).
const PROD_BASELINE = sizeMetafile({
  'dist/bundle.js': { bytes: 5_630_000, inputs: { '../../node_modules/@earendil-works/pi-ai/dist/index.js': 2_700_000 } },
  'dist/governance-audit.js': { bytes: 70786, inputs: { '../../src/governance-audit.ts': 22000 } },
  'dist/rulehost-evidence.js': { bytes: 60244, inputs: { '../../src/rulehost-evidence.ts': 18000 } },
});

describe('collectSizeBudgetViolations (PRI-919)', () => {
  it('roster and budget table stay in lockstep (EP-09: no unmeasured satellite)', () => {
    expect(Object.keys(SIZE_BUDGETS).sort()).toEqual([...SATELLITE_OUTPUT_SUFFIXES].sort());
    for (const suffix of SATELLITE_OUTPUT_SUFFIXES) {
      for (const mode of ['production', 'development'] as const) {
        const b = SIZE_BUDGETS[suffix][mode];
        expect(Number.isFinite(b.baseline)).toBe(true);
        expect(b.max).toBeGreaterThan(b.baseline);
      }
    }
  });

  it('mission Case 1: production bundle at baseline passes both legs', () => {
    expect(collectSizeBudgetViolations(PROD_BASELINE, { isProduction: true })).toEqual([]);
  });

  it('mission Case 3: a satellite over its production ceiling is reported with attribution', () => {
    const polluted = sizeMetafile({
      'dist/bundle.js': { bytes: 5_630_000 },
      'dist/governance-audit.js': {
        bytes: 212358, // 3x baseline — the OPT-002 pollution class
        inputs: {
          '../../src/governance-audit.ts': 22000,
          '../../node_modules/@earendil-works/pi-ai/dist/index.js': 140000,
        },
      },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    const violations = collectSizeBudgetViolations(polluted, { isProduction: true });
    expect(violations).toHaveLength(1);
    const v = violations[0];
    expect(v.suffix).toBe('governance-audit.js');
    expect(v.mode).toBe('production');
    expect(v.baseline).toBe(70786);
    expect(v.bytes).toBe(212358);
    // top contributor first — that is the "introduced by" evidence
    expect(v.topInputs[0].input).toContain('pi-ai');
  });

  it('mode-aware: the same bytes that pass the dev ceiling fail production', () => {
    // 80 000 > production max 77 865 but far under development max 866 390
    const meta = sizeMetafile({
      'dist/governance-audit.js': { bytes: 80000 },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    expect(collectSizeBudgetViolations(meta, { isProduction: true })).toHaveLength(1);
    expect(collectSizeBudgetViolations(meta, { isProduction: false })).toEqual([]);
  });

  it('boundary is exclusive: bytes === max passes, max + 1 fails', () => {
    const atMax = sizeMetafile({
      'dist/governance-audit.js': { bytes: SIZE_BUDGETS['governance-audit.js'].production.max },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    expect(collectSizeBudgetViolations(atMax, { isProduction: true })).toEqual([]);
    const overMax = sizeMetafile({
      'dist/governance-audit.js': { bytes: SIZE_BUDGETS['governance-audit.js'].production.max + 1 },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    expect(collectSizeBudgetViolations(overMax, { isProduction: true })).toHaveLength(1);
  });

  it('mission Case 4: bundle.js size is never judged (rules constrain satellites only)', () => {
    const heavy = sizeMetafile({
      'dist/bundle.js': { bytes: 20_000_000, inputs: { '../../node_modules/@earendil-works/pi-ai/dist/index.js': 5_000_000 } },
      'dist/governance-audit.js': { bytes: 70786 },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    expect(collectSizeBudgetViolations(heavy, { isProduction: true })).toEqual([]);
    expect(() => assertSatellitePurity(heavy, { isProduction: true })).not.toThrow();
  });

  it('fails loud on a missing satellite output (rc-3, no vacuous pass)', () => {
    const partial = sizeMetafile({ 'dist/governance-audit.js': { bytes: 70786 } });
    expect(() => collectSizeBudgetViolations(partial, { isProduction: true })).toThrow(
      /rulehost-evidence\.js.*missing/s,
    );
  });

  it('fails loud on a missing or non-numeric bytes field (rc-3)', () => {
    const noBytes = sizeMetafile({
      'dist/governance-audit.js': { inputs: { '../../src/governance-audit.ts': 1 } },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    expect(() => collectSizeBudgetViolations(noBytes, { isProduction: true })).toThrow(/bytes/);
    const nan = sizeMetafile({
      'dist/governance-audit.js': { bytes: Number.NaN },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    expect(() => collectSizeBudgetViolations(nan, { isProduction: true })).toThrow(/bytes/);
  });

  it('fails loud on a malformed metafile (rc-1/rc-3)', () => {
    expect(() => collectSizeBudgetViolations({}, { isProduction: true })).toThrow(/metafile/);
    expect(() => collectSizeBudgetViolations(null, { isProduction: true })).toThrow(/metafile/);
  });
});

describe('assertSatellitePurity — size leg integration', () => {
  it('logs the mission PASS block with per-satellite size and budget', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(assertSatellitePurity(PROD_BASELINE, { isProduction: true })).toEqual({
        total: 0,
        perSatellite: { 'governance-audit.js': 0, 'rulehost-evidence.js': 0 },
      });
      const out = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('Bundle dependency budget PASS (production)');
      expect(out).toContain('artifact:');
      expect(out).toContain('governance-audit.js');
      expect(out).toContain('70786 (budget max 77865, baseline 70786)');
      expect(out).toContain('forbidden dependencies:');
    } finally {
      log.mockRestore();
    }
  });

  it('size FAIL names bundle, rule, baseline, current, delta and introduced-by (rc-9)', () => {
    const polluted = sizeMetafile({
      'dist/bundle.js': { bytes: 5_630_000 },
      'dist/governance-audit.js': {
        bytes: 212358,
        inputs: { '../../node_modules/@earendil-works/pi-ai/dist/index.js': 140000 },
      },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    let message = '';
    try {
      assertSatellitePurity(polluted, { isProduction: true });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('[satellite-purity] FAIL');
    expect(message).toContain('SIZE_BUDGET_EXCEEDED');
    expect(message).toContain('baseline:');
    expect(message).toContain('current:');
    expect(message).toContain('size delta:');
    expect(message).toContain('introduced by');
    expect(message).toContain('pi-ai');
    expect(message).toContain('rebaseline');
  });

  it('dependency and size violations are reported together in one failure', () => {
    const both = sizeMetafile({
      'dist/bundle.js': { bytes: 5_630_000 },
      'dist/governance-audit.js': {
        bytes: 2_100_000,
        inputs: { '../../node_modules/openai/index.mjs': 900000 },
      },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    });
    let message = '';
    try {
      assertSatellitePurity(both, { isProduction: true });
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain('LLM SDK dependencies found inside satellite bundles');
    expect(message).toContain('SIZE_BUDGET_EXCEEDED');
  });
});

describe('CLI contract', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-satpurity-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (file: string, extraArgs: string[] = []) => {
    try {
      const stdout = execFileSync('node', [GUARD, '--metafile', file, ...extraArgs], { encoding: 'utf8' });
      return { code: 0, output: stdout };
    } catch (err) {
      const e = err as { status?: number; stderr?: string; message?: string };
      return { code: e.status ?? -1, output: e.stderr ?? e.message ?? '' };
    }
  };

  it('exits 0 on a clean metafile and 1 naming the violations', () => {
    const cleanFile = path.join(tmp, 'clean.json');
    const badFile = path.join(tmp, 'bad.json');
    fs.writeFileSync(cleanFile, JSON.stringify(CLEAN));
    fs.writeFileSync(badFile, JSON.stringify(POLLUTED));

    const ok = run(cleanFile);
    expect(ok.code).toBe(0);
    expect(ok.output).toContain('OK');
    expect(ok.output).toContain('Forbidden dependency count: 0');

    const bad = run(badFile);
    expect(bad.code).toBe(1);
    expect(bad.output).toContain('[satellite-purity] FAIL');
  });

  it('rejects a missing --metafile argument with usage (cli-6)', () => {
    const noArg = run('');
    expect(noArg.code).toBe(2);
    expect(noArg.output).toContain('Usage');
  });

  it('--production selects the production budget block (PRI-919)', () => {
    const prodFile = path.join(tmp, 'prod-baseline.json');
    fs.writeFileSync(prodFile, JSON.stringify(PROD_BASELINE));

    const prod = run(prodFile, ['--production']);
    expect(prod.code).toBe(0);
    expect(prod.output).toContain('Bundle dependency budget PASS (production)');

    // same metafile under the development ceiling also passes (dev budgets are
    // looser) — the flag, not the fixture, decides the judged band
    const dev = run(prodFile);
    expect(dev.code).toBe(0);
    expect(dev.output).toContain('Bundle dependency budget PASS (development)');
  });

  it('exits 1 naming the size violation under the production budget', () => {
    const overFile = path.join(tmp, 'prod-over.json');
    fs.writeFileSync(overFile, JSON.stringify(sizeMetafile({
      'dist/bundle.js': { bytes: 5_630_000 },
      'dist/governance-audit.js': { bytes: 212358, inputs: { '../../node_modules/openai/index.mjs': 120000 } },
      'dist/rulehost-evidence.js': { bytes: 60244 },
    })));
    const over = run(overFile, ['--production']);
    expect(over.code).toBe(1);
    expect(over.output).toContain('SIZE_BUDGET_EXCEEDED');
  });
});

describe('production wiring', () => {
  it('the official plugin build calls the guard on the main bundle result', () => {
    const config = fs.readFileSync(ESBUILD_CONFIG, 'utf8');
    expect(config).toContain("from '../../scripts/build/check-satellite-purity.mjs'");
    expect(config).toContain('const mainResult = await build(');
    expect(config).toContain('assertSatellitePurity(mainResult.metafile)');
  });

  it('root package.json exposes check-satellite-bundle-deps and verify:merge ends with it (OPT-003)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['check-satellite-bundle-deps']).toBe(
      'npm run build:bundle --workspace=principles-disciple',
    );
    expect(String(pkg.scripts['verify:merge']).trim().endsWith('npm run check-satellite-bundle-deps')).toBe(true);
  });
});
