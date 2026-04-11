import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  computePainScore,
  painSeverityLabel,
  writePainFlag,
  readPainFlagData,
  buildPainFlag,
  validatePainFlag,
} from '../../src/core/pain';

vi.mock('fs');

describe('Pain Detection Module', () => {
  describe('computePainScore', () => {
    it('should compute score correctly', () => {
      expect(computePainScore(0, false, false, 0)).toBe(0);
      expect(computePainScore(1, false, false, 0)).toBe(70);
      expect(computePainScore(0, true, false, 0)).toBe(40);
      expect(computePainScore(0, false, true, 0)).toBe(30);
      expect(computePainScore(1, true, true, 20)).toBe(100); // capped at 100
    });
  });

  describe('painSeverityLabel', () => {
    it('should return correct severity labels', () => {
      expect(painSeverityLabel(0, true)).toBe('critical');
      expect(painSeverityLabel(80)).toBe('high');
      expect(painSeverityLabel(50)).toBe('medium');
      expect(painSeverityLabel(25)).toBe('low');
      expect(painSeverityLabel(10)).toBe('info');
    });
  });

  describe('buildPainFlag', () => {
    it('should construct valid pain flag data', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '70',
        reason: 'Test error',
        session_id: 'sess1',
        agent_id: 'main',
      });

      expect(data.source).toBe('tool_failure');
      expect(data.score).toBe('70');
      expect(data.reason).toBe('Test error');
      expect(data.session_id).toBe('sess1');
      expect(data.agent_id).toBe('main');
      expect(data.is_risky).toBe('false');
      expect(data.trace_id).toBe('');
      expect(data.time).toBeDefined();
    });

    it('should use defaults for optional fields', () => {
      const data = buildPainFlag({
        source: 'human_intervention',
        score: '80',
        reason: 'User feedback',
      });

      expect(data.session_id).toBe('');
      expect(data.agent_id).toBe('');
      expect(data.is_risky).toBe('false');
      expect(data.trace_id).toBe('');
      expect(data.trigger_text_preview).toBe('');
      expect(data.time).toBeDefined();
    });

    it('should set is_risky to true when flagged', () => {
      const data = buildPainFlag({
        source: 'intercept',
        score: '100',
        reason: 'Fatal intercept',
        is_risky: true,
      });

      expect(data.is_risky).toBe('true');
    });
  });

  describe('validatePainFlag', () => {
    it('should return empty array for valid pain flag', () => {
      const data = buildPainFlag({
        source: 'tool_failure',
        score: '70',
        reason: 'Test',
        session_id: 'sess1',
        agent_id: 'main',
      });

      const record: Record<string, string> = {
        source: data.source,
        score: data.score,
        time: data.time,
        reason: data.reason,
        session_id: data.session_id,
        agent_id: data.agent_id,
        is_risky: data.is_risky,
      };

      expect(validatePainFlag(record)).toEqual([]);
    });

    it('should report missing required fields', () => {
      const missing = validatePainFlag({
        source: 'tool_failure',
        score: '70',
        // missing time, reason (session_id/agent_id are optional)
      });

      expect(missing).toContain('time');
      expect(missing).toContain('reason');
      expect(missing).not.toContain('session_id');
      expect(missing).not.toContain('agent_id');
    });

    it('should report empty string fields as missing', () => {
      const missing = validatePainFlag({
        source: 'tool_failure',
        score: '70',
        time: '2026-04-06T00:00:00Z',
        reason: 'Test',
        session_id: '',
        agent_id: 'main',
      });

      // session_id/agent_id are optional — empty values are acceptable
      expect(missing).toEqual([]);
    });
  });
});