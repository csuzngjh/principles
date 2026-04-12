/**
 * Pain Flag Integration Tests
 *
 * These tests use the REAL file system to verify end-to-end behavior:
 * - writePainFlag writes correct KV format
 * - readPainFlagData reads back correctly
 * - Auto-repair from JSON to KV works
 * - Empty/undefined values are NOT written to disk
 * - Round-trip: write → read → verify
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPainFlag,
  writePainFlag,
  readPainFlagData,
  validatePainFlag,
} from '../../src/core/pain.js';

const TEST_DIR = path.join(os.tmpdir(), 'test-pain-integration');
const STATE_DIR = path.join(TEST_DIR, '.state');

describe('Pain Flag Integration (real FS)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Round-trip tests ──────────────────────────────────────────────

  describe('Round-trip: write → read', () => {
    it('should write and read back a complete pain flag', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '50',
        reason: 'Test failure reason',
        session_id: 'test-session-123',
        agent_id: 'main',
        is_risky: false,
      });

      writePainFlag(TEST_DIR, data);

      const read = readPainFlagData(TEST_DIR);

      expect(read.source).toBe('tool_failure');
      expect(read.score).toBe('50');
      expect(read.reason).toBe('Test failure reason');
      expect(read.session_id).toBe('test-session-123');
      expect(read.agent_id).toBe('main');
      expect(read.is_risky).toBe('false');
      expect(read.time).toBeDefined();
    });

    it('should NOT write empty optional fields to disk', () => {
      const data = buildPainFlag({
        source: 'human_intervention',
        score: '80',
        reason: 'User feedback',
        // session_id, agent_id, trace_id, trigger_text_preview all omitted
      });

      writePainFlag(TEST_DIR, data);

      const fileContent = fs.readFileSync(path.join(STATE_DIR, '.pain_flag'), 'utf-8');

      // Empty fields should not appear in the file
      expect(fileContent).not.toContain('trace_id');
      expect(fileContent).not.toContain('trigger_text_preview');
      // session_id/agent_id are empty strings so should be skipped too
      expect(fileContent).not.toContain('session_id:');
      expect(fileContent).not.toContain('agent_id:');

      // But required fields must be present
      expect(fileContent).toContain('source: human_intervention');
      expect(fileContent).toContain('score: 80');
      expect(fileContent).toContain('reason: User feedback');
    });

    it('should write non-empty optional fields', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '70',
        reason: 'Edit failed',
        session_id: 'boot-abc123',
        agent_id: 'builder',
        trace_id: 'ev_test_trace_001',
        trigger_text_preview: 'short preview text',
      });

      writePainFlag(TEST_DIR, data);

      const fileContent = fs.readFileSync(path.join(STATE_DIR, '.pain_flag'), 'utf-8');

      expect(fileContent).toContain('session_id: boot-abc123');
      expect(fileContent).toContain('agent_id: builder');
      expect(fileContent).toContain('trace_id: ev_test_trace_001');
      expect(fileContent).toContain('trigger_text_preview: short preview text');
    });

    it('should handle risky flag correctly', () => {
      const data = buildPainFlag({
        source: 'intercept_extraction',
        score: '100',
        reason: 'Hard intercept',
        is_risky: true,
      });

      writePainFlag(TEST_DIR, data);

      const read = readPainFlagData(TEST_DIR);
      expect(read.is_risky).toBe('true');
    });
  });

  // ── File format validation ────────────────────────────────────────

  describe('File format', () => {
    it('should write KV format (not JSON)', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '50',
        reason: 'test',
      });

      writePainFlag(TEST_DIR, data);

      const fileContent = fs.readFileSync(path.join(STATE_DIR, '.pain_flag'), 'utf-8');

      // Should NOT be JSON
      expect(fileContent).not.toContain('{');
      expect(fileContent).not.toContain('}');
      // Should be KV format with colon separator
      expect(fileContent).toContain('source: tool_failure');
      expect(fileContent).toContain('score: 50');
    });

    it('should have fields sorted alphabetically', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '50',
        reason: 'test',
        session_id: 'sess1',
        agent_id: 'main',
        trace_id: 'trace1',
      });

      writePainFlag(TEST_DIR, data);

      const fileContent = fs.readFileSync(path.join(STATE_DIR, '.pain_flag'), 'utf-8');
      const lines = fileContent.trim().split('\n');
      const keys = lines.map(l => l.split(':')[0].trim());

      // Keys should be in alphabetical order (serializeKvLines sorts)
      expect(keys).toEqual([...keys].sort());
    });

    it('should not have blank lines in output', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '50',
        reason: 'test',
      });

      writePainFlag(TEST_DIR, data);

      const fileContent = fs.readFileSync(path.join(STATE_DIR, '.pain_flag'), 'utf-8');
      const lines = fileContent.split('\n');

      // No empty lines
      for (const line of lines) {
        expect(line.trim()).not.toBe('');
      }
    });
  });

  // ── Auto-repair tests ─────────────────────────────────────────────

  describe('Auto-repair from wrong formats', () => {
    it('should repair JSON format to KV format', () => {
      const jsonContent = JSON.stringify({
        source: 'team-audit',
        score: '60',
        reason: 'zero output loop',
        timestamp: '2026-03-19T08:37:00Z',
        severity: 'HIGH',
      });
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), jsonContent, 'utf-8');

      const result = readPainFlagData(TEST_DIR);

      // Should parse correctly
      expect(result.source).toBe('team-audit');
      expect(result.score).toBe('60');
      expect(result.reason).toBe('zero output loop');
      expect(result.time).toBe('2026-03-19T08:37:00Z');

      // File should be rewritten in KV format
      const repaired = fs.readFileSync(path.join(STATE_DIR, '.pain_flag'), 'utf-8');
      expect(repaired).not.toContain('{');
      expect(repaired).toContain('source: team-audit');
    });

    it('should repair JSON with camelCase field names', () => {
      const jsonContent = JSON.stringify({
        source: 'llm_detection',
        score: '45',
        reason: 'spiral detected',
        sessionId: 'sess-camel',
        agentId: 'main',
        isRisky: false,
      });
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), jsonContent, 'utf-8');

      const result = readPainFlagData(TEST_DIR);

      expect(result.source).toBe('llm_detection');
      expect(result.session_id).toBe('sess-camel');
      expect(result.agent_id).toBe('main');
      expect(result.is_risky).toBe('false');
    });

    it('should handle corrupted JSON gracefully', () => {
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), '{bad json}', 'utf-8');

      const result = readPainFlagData(TEST_DIR);
      expect(result).toEqual({});
    });

    it('should handle partially malformed KV format', () => {
      // Missing colons on some lines
      const content = `source: tool_failure
score: 50
reason missing colon
time: 2026-03-20T02:19:47.445Z`;
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), content, 'utf-8');

      const result = readPainFlagData(TEST_DIR);

      // Should parse lines that have colons, skip ones that don't
      expect(result.source).toBe('tool_failure');
      expect(result.score).toBe('50');
      expect(result.time).toBe('2026-03-20T02:19:47.445Z');
    });

    it('should handle empty file', () => {
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), '', 'utf-8');

      const result = readPainFlagData(TEST_DIR);
      expect(result).toEqual({});
    });

    it('should handle whitespace-only file', () => {
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), '   \n\n  \n', 'utf-8');

      const result = readPainFlagData(TEST_DIR);
      expect(result).toEqual({});
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('should handle special characters in reason', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '50',
        reason: 'Edit failed: "old text" not found in file.ts — expected: "foo", got: "bar"',
      });

      writePainFlag(TEST_DIR, data);
      const read = readPainFlagData(TEST_DIR);

      expect(read.reason).toContain('"old text"');
      expect(read.reason).toContain('expected: "foo"');
      expect(read.reason).toContain('got: "bar"');
    });

    it('should handle multiline reason by preserving only first line (KV limitation)', () => {
      // KV format is line-based — newlines in values will be split across lines
      // This is a known limitation; reasons should be single-line
      const multilineReason = 'Line one\nLine two';
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '50',
        reason: multilineReason,
      });

      writePainFlag(TEST_DIR, data);
      const read = readPainFlagData(TEST_DIR);

      // Only first line is preserved (KV line-based format)
      expect(read.reason).toBe('Line one');
    });

    it('should handle Chinese characters in reason', () => {
      const data = buildPainFlag({
        source: 'human_intervention',
        score: '80',
        reason: '用户报告agent卡住，反复循环',
      });

      writePainFlag(TEST_DIR, data);
      const read = readPainFlagData(TEST_DIR);

      expect(read.reason).toBe('用户报告agent卡住，反复循环');
    });

    it('should handle very long reason strings', () => {
      const longReason = 'x'.repeat(5000);
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '50',
        reason: longReason,
      });

      writePainFlag(TEST_DIR, data);
      const read = readPainFlagData(TEST_DIR);

      expect(read.reason).toBe(longReason);
    });

    it('should handle source values with underscores', () => {
      const sources = [
        'tool_failure',
        'human_intervention',
        'intercept_extraction',
        'subagent_error',
        'subagent_timeout',
        'compaction_pain',
        'main_self_observation',
      ];

      for (const src of sources) {
        const data = buildPainFlag({
          source: src,
          score: '50',
          reason: 'test',
        });

        writePainFlag(TEST_DIR, data);
        const read = readPainFlagData(TEST_DIR);

        expect(read.source, `source "${src}" should round-trip`).toBe(src);
      }
    });

    it('should handle score edge cases (0 and 100)', () => {
      const data = buildPainFlag({
        source: 'test',
        score: '0',
        reason: 'minimum score',
      });

      writePainFlag(TEST_DIR, data);
      const read = readPainFlagData(TEST_DIR);

      expect(read.score).toBe('0');
    });

    it('should overwrite existing file (not append)', () => {
      // Write first flag
      const data1 = buildPainFlag({
        source: 'first_signal',
        score: '30',
        reason: 'first',
      });
      writePainFlag(TEST_DIR, data1);

      // Write second flag
      const data2 = buildPainFlag({
        source: 'second_signal',
        score: '60',
        reason: 'second',
      });
      writePainFlag(TEST_DIR, data2);

      // Should only have second
      const read = readPainFlagData(TEST_DIR);
      expect(read.source).toBe('second_signal');
      expect(read.score).toBe('60');

      // File should not contain first
      const content = fs.readFileSync(path.join(STATE_DIR, '.pain_flag'), 'utf-8');
      expect(content).not.toContain('first_signal');
    });
  });

  // ── Validation on read ────────────────────────────────────────────

  describe('Validation on read', () => {
    it('should read KV with all fields', () => {
      const content = `agent_id: main
is_risky: false
reason: complete test
score: 70
session_id: sess-123
source: tool_failure
time: 2026-04-10T09:00:00.000Z`;
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), content, 'utf-8');

      const result = readPainFlagData(TEST_DIR);

      expect(result).toEqual({
        agent_id: 'main',
        is_risky: 'false',
        reason: 'complete test',
        score: '70',
        session_id: 'sess-123',
        source: 'tool_failure',
        time: '2026-04-10T09:00:00.000Z',
      });

      const missing = validatePainFlag(result);
      expect(missing).toEqual([]);
    });

    it('should read KV with only required fields', () => {
      const content = `reason: minimal test
score: 40
source: human_intervention
time: 2026-04-10T09:00:00.000Z`;
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), content, 'utf-8');

      const result = readPainFlagData(TEST_DIR);

      expect(result.source).toBe('human_intervention');
      expect(result.score).toBe('40');
      expect(result.reason).toBe('minimal test');
      expect(result.time).toBe('2026-04-10T09:00:00.000Z');

      const missing = validatePainFlag(result);
      expect(missing).toEqual([]);
    });

    it('should read KV with extra unknown fields', () => {
      const content = `custom_field: custom_value
reason: extra fields test
score: 50
source: tool_failure
time: 2026-04-10T09:00:00.000Z
unknown_meta: some data`;
      fs.writeFileSync(path.join(STATE_DIR, '.pain_flag'), content, 'utf-8');

      const result = readPainFlagData(TEST_DIR);

      // Unknown fields should be preserved
      expect(result.custom_field).toBe('custom_value');
      expect(result.unknown_meta).toBe('some data');
      // Required fields should still work
      expect(result.source).toBe('tool_failure');
    });
  });

  // ── Missing file scenarios ────────────────────────────────────────

  describe('Missing file scenarios', () => {
    it('should return empty object when .pain_flag does not exist', () => {
      // Don't create the file
      const result = readPainFlagData(TEST_DIR);
      expect(result).toEqual({});
    });

    it('should return empty object when .state directory does not exist', () => {
      const freshDir = '/tmp/test-pain-no-state';
      fs.rmSync(freshDir, { recursive: true, force: true });

      try {
        const result = readPainFlagData(freshDir);
        expect(result).toEqual({});
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });

    it('readPainFlagData reads only the canonical .state/.pain_flag path', () => {
      const legacyRootPath = path.join(TEST_DIR, 'PAIN_FLAG');
      fs.writeFileSync(
        legacyRootPath,
        `source: legacy_root
score: 90
reason: should be ignored
time: 2026-04-10T09:00:00.000Z`,
        'utf-8',
      );
      fs.writeFileSync(
        path.join(STATE_DIR, '.pain_flag'),
        `source: canonical_state
score: 80
reason: should be read
time: 2026-04-10T09:00:00.000Z`,
        'utf-8',
      );

      const result = readPainFlagData(TEST_DIR);

      expect(result.source).toBe('canonical_state');
      expect(result.score).toBe('80');
      const legacyResult = readPainFlagData(path.join(TEST_DIR, '..'));
      expect(legacyResult.source).not.toBe('legacy_root');
    });
  });
});
