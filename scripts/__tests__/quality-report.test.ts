/**
 * Tests for quality-report.mjs
 *
 * Runtime Contract: test fixtures are treated as known-shape data (not untrusted),
 * so direct property access is acceptable here. The production script itself
 * treats all parsed JSON as `unknown` with runtime validation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { parseErrStats, generateReport, readCoverage, readGraphStats } from '../quality-report.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = join(tmpdir(), `quality-report-test-${Date.now()}`);

describe('parseErrStats', () => {
  it('should count ERR entries and recurrence fields', () => {
    // Create a temp handbook file
    mkdirSync(TMP, { recursive: true });
    const handbookPath = join(TMP, 'handbook.md');
    const content = `# Handbook

**[ERR-001]** | First error
- **Recurrence**: Yes (2026-01-01 PRI-100)

**[ERR-002]** | Second error

**[ERR-003]** | Third error
- **Recurrence**: Yes (2026-02-01 PRI-101)

`;
    writeFileSync(handbookPath, content, 'utf8');
    const stats = parseErrStats(handbookPath);
    expect(stats.total).toBe(3);
    expect(stats.recurring).toBe(2);
    expect(stats.recurrenceRate).toBe(66.7);
  });

  it('should return zero stats when file not found', () => {
    const stats = parseErrStats(join(TMP, 'nonexistent.md'));
    expect(stats.total).toBe(0);
    expect(stats.recurring).toBe(0);
    expect(stats.warning).toBeDefined();
  });

  it('should handle empty handbook', () => {
    mkdirSync(TMP, { recursive: true });
    const handbookPath = join(TMP, 'empty.md');
    writeFileSync(handbookPath, '# Empty', 'utf8');
    const stats = parseErrStats(handbookPath);
    expect(stats.total).toBe(0);
    expect(stats.recurring).toBe(0);
    expect(stats.recurrenceRate).toBe(0);
  });
});

describe('generateReport', () => {
  it('should generate valid Markdown with all sections', () => {
    const report = generateReport({
      errStats: { total: 76, recurring: 31, recurrenceRate: 40.8 },
      testStats: [
        { package: 'principles-core', testFiles: 223 },
        { package: 'openclaw-plugin', testFiles: 110 },
      ],
      coverageStats: [
        { package: 'openclaw-plugin', coverage: { lines: 58, functions: 65, branches: 45, statements: 57 } },
        { package: 'principles-core', coverage: null },
      ],
      graphStats: { nodes: 100, edges: 250, godNodes: 3 },
      month: '2026-06',
    });
    expect(report).toContain('# 质量报告 - 2026-06');
    expect(report).toContain('## 1. 错误经验手册');
    expect(report).toContain('ERR 总数：76');
    expect(report).toContain('复发率：40.8%');
    expect(report).toContain('## 2. 测试覆盖');
    expect(report).toContain('principles-core');
    expect(report).toContain('## 3. 代码覆盖率');
    expect(report).toContain('58%');
    expect(report).toContain('无数据');
    expect(report).toContain('## 4. 模块耦合度');
    expect(report).toContain('图谱节点数：100');
    expect(report).toContain('God nodes：3');
    expect(report).toContain('## 趋势对比');
  });

  it('should handle null graphStats', () => {
    const report = generateReport({
      errStats: { total: 0, recurring: 0, recurrenceRate: 0 },
      testStats: [],
      coverageStats: [],
      graphStats: null,
      month: '2026-06',
    });
    expect(report).toContain('无图谱数据');
  });

  it('should handle graphStats with error', () => {
    const report = generateReport({
      errStats: { total: 0, recurring: 0, recurrenceRate: 0 },
      testStats: [],
      coverageStats: [],
      graphStats: { error: 'parse error' },
      month: '2026-06',
    });
    expect(report).toContain('图谱解析错误');
  });
});

describe('readCoverage', () => {
  it('should return null when file not found', () => {
    const result = readCoverage(join(TMP, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('should parse valid coverage JSON', () => {
    mkdirSync(TMP, { recursive: true });
    const coveragePath = join(TMP, 'coverage.json');
    const coverageData = {
      '/path/to/file.ts': {
        s: { 0: 1, 1: 0, 2: 1 },
        f: { 0: 1, 1: 0 },
        b: { 0: [1, 0] },
        statementMap: { 0: {}, 1: {}, 2: {} },
        fnMap: { 0: {}, 1: {} },
        branchMap: { 0: {} },
      },
    };
    writeFileSync(coveragePath, JSON.stringify(coverageData), 'utf8');
    const result = readCoverage(coveragePath);
    expect(result).not.toBeNull();
    expect(result?.statements).toBe(66.7);
    expect(result?.functions).toBe(50);
  });
});

describe('readGraphStats', () => {
  it('should return null when file not found', () => {
    const result = readGraphStats(join(TMP, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('should parse valid graph JSON', () => {
    mkdirSync(TMP, { recursive: true });
    const graphPath = join(TMP, 'graph.json');
    const graphData = {
      nodes: [
        { id: 'a', isGodNode: true },
        { id: 'b', isGodNode: false },
        { id: 'c' },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    };
    writeFileSync(graphPath, JSON.stringify(graphData), 'utf8');
    const result = readGraphStats(graphPath);
    expect(result).not.toBeNull();
    expect(result?.nodes).toBe(3);
    expect(result?.edges).toBe(2);
    expect(result?.godNodes).toBe(1);
  });
});

// Cleanup after all tests
afterAll(() => {
  if (existsSync(TMP)) {
    rmSync(TMP, { recursive: true, force: true });
  }
});
