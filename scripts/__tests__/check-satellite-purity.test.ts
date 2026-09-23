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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectSatelliteViolations,
  assertSatellitePurity,
} from '../build/check-satellite-purity.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'build', 'check-satellite-purity.mjs');
const ESBUILD_CONFIG = path.join(REPO_ROOT, 'packages', 'openclaw-plugin', 'esbuild.config.js');

function metafileWith(outputInputs: Record<string, string[]>) {
  const outputs: Record<string, { inputs: Record<string, { bytes: number }> }> = {};
  for (const [output, inputs] of Object.entries(outputInputs)) {
    outputs[output] = {
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
    '../principles-core/dist/runtime-v2/index.js',
    '../../node_modules/@earendil-works/pi-ai/dist/providers/json',
    '../../node_modules/@anthropic-ai/sdk/index.mjs',
    '../../node_modules/openai/index.mjs',
    '../../node_modules/@google/genai/node_modules/undici/index.js',
    '../../node_modules/undici/lib/core/request.js',
  ],
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
    });
    expect(collectSatelliteViolations(src)).toEqual([]);
  });

  it('fails loud on a malformed metafile (rc-3)', () => {
    expect(() => collectSatelliteViolations({})).toThrow(/metafile/);
    expect(() => collectSatelliteViolations(null)).toThrow(/metafile/);
  });
});

describe('assertSatellitePurity', () => {
  it('passes silently on the clean metafile', () => {
    expect(() => assertSatellitePurity(CLEAN)).not.toThrow();
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

describe('CLI contract', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-satpurity-'));
  });
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (file: string) => {
    try {
      const stdout = execFileSync('node', [GUARD, '--metafile', file], { encoding: 'utf8' });
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

    const bad = run(badFile);
    expect(bad.code).toBe(1);
    expect(bad.output).toContain('[satellite-purity] FAIL');
  });

  it('rejects a missing --metafile argument with usage (cli-6)', () => {
    const noArg = run('');
    expect(noArg.code).toBe(2);
    expect(noArg.output).toContain('Usage');
  });
});

describe('production wiring', () => {
  it('the official plugin build calls the guard on the main bundle result', () => {
    const config = fs.readFileSync(ESBUILD_CONFIG, 'utf8');
    expect(config).toContain("from '../../scripts/build/check-satellite-purity.mjs'");
    expect(config).toContain('const mainResult = await build(');
    expect(config).toContain('assertSatellitePurity(mainResult.metafile)');
  });
});
