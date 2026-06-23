/**
 * Tests for compare-benchmarks.mjs
 *
 * Runtime Contract: test fixtures are treated as known-shape data (not untrusted),
 * so direct property access is acceptable here. The production script itself
 * treats all parsed JSON as `unknown` with runtime validation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { parseArgs, extractBenchResults, compareBenchmarks, hasRegression, compareBenchFiles, formatTable } from '../compare-benchmarks.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = join(tmpdir(), `compare-bench-test-${Date.now()}`);

function makeBenchJson(benchs) {
  return {
    files: [
      {
        name: 'test.bench.ts',
        groups: [
          {
            name: 'group1',
            benchs: benchs.map((b) => ({
              name: b.name,
              stats: { mean: b.mean ?? 1.0, p99: b.p99, min: 0.5, max: 3.0 },
            })),
          },
        ],
      },
    ],
  };
}

describe('parseArgs', () => {
  it('should parse all arguments', () => {
    const args = parseArgs(['--baseline', 'a.json', '--current', 'b.json', '--threshold', '0.3']);
    expect(args.baseline).toBe('a.json');
    expect(args.current).toBe('b.json');
    expect(args.threshold).toBe(0.3);
  });

  it('should use default threshold', () => {
    const args = parseArgs(['--baseline', 'a.json', '--current', 'b.json']);
    expect(args.threshold).toBe(0.2);
  });

  it('should detect help flag', () => {
    const args = parseArgs(['--help']);
    expect(args.help).toBe(true);
  });
});

describe('extractBenchResults', () => {
  it('should return empty results with warning when file not found', () => {
    const { results, warnings } = extractBenchResults(join(TMP, 'nonexistent.json'));
    expect(results).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('should extract bench results from valid JSON', () => {
    mkdirSync(TMP, { recursive: true });
    const filePath = join(TMP, 'bench.json');
    writeFileSync(filePath, JSON.stringify(makeBenchJson([
      { name: 'bench1', p99: 2.0 },
      { name: 'bench2', p99: 3.5 },
    ])), 'utf8');
    const { results, warnings } = extractBenchResults(filePath);
    expect(results.length).toBe(2);
    expect(results[0].name).toBe('bench1');
    expect(results[0].p99).toBe(2.0);
    expect(warnings.length).toBe(0);
  });

  it('should warn when p99 field missing', () => {
    mkdirSync(TMP, { recursive: true });
    const filePath = join(TMP, 'no-p99.json');
    const data = {
      files: [{
        name: 'test.bench.ts',
        groups: [{
          name: 'g1',
          benchs: [{ name: 'bench1', stats: { mean: 1.0 } }],
        }],
      }],
    };
    writeFileSync(filePath, JSON.stringify(data), 'utf8');
    const { results, warnings } = extractBenchResults(filePath);
    expect(results.length).toBe(1);
    expect(results[0].p99).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('compareBenchmarks', () => {
  it('should detect no regression when delta within threshold', () => {
    const baseline = [{ name: 'bench1', p99: 2.0 }];
    const current = [{ name: 'bench1', p99: 2.2 }]; // 10% < 20%
    const result = compareBenchmarks(baseline, current, 0.2);
    expect(result.hasRegression).toBe(false);
    expect(result.rows[0].status).toBe('OK');
  });

  it('should detect regression when delta exceeds threshold', () => {
    const baseline = [{ name: 'bench1', p99: 2.0 }];
    const current = [{ name: 'bench1', p99: 2.5 }]; // 25% > 20%
    const result = compareBenchmarks(baseline, current, 0.2);
    expect(result.hasRegression).toBe(true);
    expect(result.rows[0].status).toBe('REGRESSION');
  });

  it('should detect improvement (negative delta)', () => {
    const baseline = [{ name: 'bench1', p99: 2.0 }];
    const current = [{ name: 'bench1', p99: 1.5 }]; // -25%
    const result = compareBenchmarks(baseline, current, 0.2);
    expect(result.hasRegression).toBe(false);
    expect(result.rows[0].status).toBe('IMPROVED');
  });

  it('should skip when p99 is null', () => {
    const baseline = [{ name: 'bench1', p99: null }];
    const current = [{ name: 'bench1', p99: 2.0 }];
    const result = compareBenchmarks(baseline, current, 0.2);
    expect(result.hasRegression).toBe(false);
    expect(result.rows[0].status).toBe('SKIP');
  });

  it('should warn when bench not in baseline', () => {
    const baseline = [{ name: 'bench1', p99: 2.0 }];
    const current = [{ name: 'bench2', p99: 2.0 }];
    const result = compareBenchmarks(baseline, current, 0.2);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.rows.length).toBe(0);
  });

  it('should handle empty benchs array', () => {
    const result = compareBenchmarks([], [], 0.2);
    expect(result.hasRegression).toBe(false);
    expect(result.rows.length).toBe(0);
    expect(result.warnings.length).toBe(0);
  });
});

describe('hasRegression', () => {
  it('should return true when regression present', () => {
    expect(hasRegression({ hasRegression: true })).toBe(true);
  });
  it('should return false when no regression', () => {
    expect(hasRegression({ hasRegression: false })).toBe(false);
  });
});

describe('compareBenchFiles', () => {
  it('should return exit code 0 when no regression', () => {
    mkdirSync(TMP, { recursive: true });
    const basePath = join(TMP, 'base.json');
    const currPath = join(TMP, 'curr.json');
    writeFileSync(basePath, JSON.stringify(makeBenchJson([{ name: 'b1', p99: 2.0 }])), 'utf8');
    writeFileSync(currPath, JSON.stringify(makeBenchJson([{ name: 'b1', p99: 2.2 }])), 'utf8');
    const { exitCode } = compareBenchFiles(basePath, currPath, 0.2);
    expect(exitCode).toBe(0);
  });

  it('should return exit code 1 when regression', () => {
    mkdirSync(TMP, { recursive: true });
    const basePath = join(TMP, 'base.json');
    const currPath = join(TMP, 'curr.json');
    writeFileSync(basePath, JSON.stringify(makeBenchJson([{ name: 'b1', p99: 2.0 }])), 'utf8');
    writeFileSync(currPath, JSON.stringify(makeBenchJson([{ name: 'b1', p99: 2.5 }])), 'utf8');
    const { exitCode } = compareBenchFiles(basePath, currPath, 0.2);
    expect(exitCode).toBe(1);
  });

  it('should return exit code 0 when improvement', () => {
    mkdirSync(TMP, { recursive: true });
    const basePath = join(TMP, 'base.json');
    const currPath = join(TMP, 'curr.json');
    writeFileSync(basePath, JSON.stringify(makeBenchJson([{ name: 'b1', p99: 2.0 }])), 'utf8');
    writeFileSync(currPath, JSON.stringify(makeBenchJson([{ name: 'b1', p99: 1.5 }])), 'utf8');
    const { exitCode } = compareBenchFiles(basePath, currPath, 0.2);
    expect(exitCode).toBe(0);
  });
});

// Cleanup
afterAll(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
});
