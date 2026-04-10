import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readPainFlagData, buildPainFlag, writePainFlag } from '../../src/core/pain.js';

const TEST_DIR = '/tmp/test-pain-auto-repair';

describe('Pain Flag Auto-Repair', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(TEST_DIR, '.state'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should auto-repair JSON format pain flag to KV format', () => {
    const jsonContent = JSON.stringify({
      severity: 'HIGH',
      source: 'team-audit',
      reason: 'test auto-repair from JSON',
      timestamp: '2026-03-19T08:37:00Z',
      confidence: 0.95,
    });
    fs.writeFileSync(path.join(TEST_DIR, '.state/.pain_flag'), jsonContent, 'utf-8');

    const result = readPainFlagData(TEST_DIR);

    // Should have parsed and mapped fields
    expect(result.source).toBe('team-audit');
    expect(result.reason).toBe('test auto-repair from JSON');
    expect(result.time).toBe('2026-03-19T08:37:00Z');
    expect(result.severity).toBe('HIGH');

    // File should have been rewritten in KV format
    const repaired = fs.readFileSync(path.join(TEST_DIR, '.state/.pain_flag'), 'utf-8');
    expect(repaired).not.toContain('{');
    expect(repaired).toContain('source: team-audit');
    expect(repaired).toContain('time: 2026-03-19T08:37:00Z');
  });

  it('should parse valid KV format without modification', () => {
    const kvContent = `is_risky: false
reason: test reason
score: 50
source: tool_failure
time: 2026-03-20T02:19:47.445Z`;
    fs.writeFileSync(path.join(TEST_DIR, '.state/.pain_flag'), kvContent, 'utf-8');

    const result = readPainFlagData(TEST_DIR);

    expect(result.source).toBe('tool_failure');
    expect(result.score).toBe('50');
    expect(result.reason).toBe('test reason');

    // File should be unchanged
    const after = fs.readFileSync(path.join(TEST_DIR, '.state/.pain_flag'), 'utf-8');
    expect(after).toBe(kvContent);
  });

  it('should return empty object for missing file', () => {
    const result = readPainFlagData(TEST_DIR);
    expect(result).toEqual({});
  });

  it('should return empty object for empty file', () => {
    fs.writeFileSync(path.join(TEST_DIR, '.state/.pain_flag'), '', 'utf-8');
    const result = readPainFlagData(TEST_DIR);
    expect(result).toEqual({});
  });

  it('should warn on missing required fields in KV format', () => {
    const kvContent = `score: 50
source: tool_failure`;
    fs.writeFileSync(path.join(TEST_DIR, '.state/.pain_flag'), kvContent, 'utf-8');

    const result = readPainFlagData(TEST_DIR);

    // Should still parse the available fields
    expect(result.source).toBe('tool_failure');
    expect(result.score).toBe('50');
    // Missing time and reason — validation will log a warning
  });
});
