/**
 * Tests for quality-report.mjs
 *
 * Runtime Contract: test fixtures are treated as known-shape data (not untrusted),
 * so direct property access is acceptable here. The production script itself
 * treats all parsed JSON as `unknown` with runtime validation.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { parseErrStats, generateReport, readCoverage, readGraphStats } from '../quality-report.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writePatternRecord, writeOccurrenceRecord } from '../error-records.cjs';

const TMP = mkdtempSync(join(tmpdir(), 'quality-report-test-'));

describe('parseErrStats', () => {
  it('counts active pattern records and patterns with at least one recurrence (records authority)', () => {
    // ERR data comes from the structured records tree since PRI-799 Phase C.
    const root = mkdtempSync(join(tmpdir(), 'quality-report-records-'));
    try {
      writePatternRecord(
        root,
        {
          schemaVersion: 1,
          recordType: 'pattern',
          recordId: 'P-ERR-001',
          displayId: 'ERR-001',
          title: 'First error',
          status: 'active',
          category: 'Process & Workflow',
          ep: 'EP-02',
          createdAt: '2026-01-01',
          source: 'PRI-100',
        },
        '**Recurrence**: Yes',
      );
      writePatternRecord(
        root,
        {
          schemaVersion: 1,
          recordType: 'pattern',
          recordId: 'P-ERR-002',
          displayId: 'ERR-002',
          title: 'Second error',
          status: 'active',
          category: null,
          ep: null,
          createdAt: '2026-01-02',
          source: 'PRI-101',
        },
        '',
      );
      writePatternRecord(
        root,
        {
          schemaVersion: 1,
          recordType: 'pattern',
          recordId: 'P-ERR-003',
          displayId: 'ERR-003',
          title: 'Archived error',
          status: 'archived',
          category: null,
          ep: null,
          createdAt: '2026-01-03',
          source: 'PRI-102',
        },
        '',
      );
      writeOccurrenceRecord(
        root,
        {
          schemaVersion: 1,
          recordType: 'occurrence',
          occurrenceId: 'OCC-2026-02-01-err-001-r0',
          patternRecordId: 'P-ERR-001',
          displayId: 'ERR-001',
          observedAt: '2026-02-01',
          source: 'PRI-101',
        },
        'first recorded instance',
      );
      writeOccurrenceRecord(
        root,
        {
          schemaVersion: 1,
          recordType: 'occurrence',
          occurrenceId: 'OCC-2026-03-01-err-001-r1',
          patternRecordId: 'P-ERR-001',
          displayId: 'ERR-001',
          observedAt: '2026-03-01',
          source: 'PRI-103',
        },
        'recurrence',
      );
      const stats = parseErrStats(root);
      expect(stats.total).toBe(2); // active patterns only
      expect(stats.recurring).toBe(1); // ERR-001 has a recurrence (2 occurrences)
      expect(stats.recurrenceRate).toBe(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns zero stats with a warning when no valid records exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-report-empty-'));
    try {
      const stats = parseErrStats(root);
      expect(stats.total).toBe(0);
      expect(stats.recurring).toBe(0);
      expect(stats.warning).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
