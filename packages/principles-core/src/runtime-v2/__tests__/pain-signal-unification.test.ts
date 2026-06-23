/**
 * PRI-443: Pain signal unification tests.
 *
 * Verifies that the top-level pain-signal.ts re-exports from
 * runtime-v2/types/pain-signal.ts and that the unified schema
 * includes the stricter validations from both versions:
 * - ISO 8601 timestamp format check (from top-level)
 * - Context size limit (from top-level)
 * - version field (from top-level)
 * - isStringRecord type guard instead of `as` (from runtime-v2)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Import from top-level (should re-export from runtime-v2)
import type {
  PainSeverity} from '../../pain-signal.js';
import {
  validatePainSignal,
  deriveSeverity,
  PainSignalSchema
} from '../../pain-signal.js';

// Import from runtime-v2 (the canonical source)
import {
  validatePainSignal as validatePainSignalV2,
  PainSignalSchema as PainSignalSchemaV2,
} from '../types/pain-signal.js';

describe('PRI-443: pain-signal.ts unification', () => {
  it('top-level pain-signal.ts re-exports from runtime-v2 (no duplicate code)', () => {
    const src = readFileSync(
      resolve(__dirname, '..', '..', '..', 'src', 'pain-signal.ts'),
      'utf-8',
    );
    // Should NOT contain schema definition — only re-export
    expect(src).not.toMatch(/export\s+const\s+PainSignalSchema\s*=/);
    expect(src).not.toMatch(/export\s+function\s+validatePainSignal\s*\(/);
    // Should contain re-export
    expect(src).toMatch(/from\s+['"]\.\/runtime-v2\/types\/pain-signal\.js['"]/);
  });

  it('top-level and runtime-v2 validatePainSignal are the same function', () => {
    expect(validatePainSignal).toBe(validatePainSignalV2);
  });

  it('top-level and runtime-v2 PainSignalSchema are the same object', () => {
    expect(PainSignalSchema).toBe(PainSignalSchemaV2);
  });

  it('rejects invalid ISO 8601 timestamp', () => {
    const signal = {
      source: 'tool_failure',
      score: 75,
      timestamp: 'not-a-date',
      reason: 'Test',
      sessionId: 'sess-123',
      agentId: 'main',
      traceId: 'trace-abc',
      triggerTextPreview: 'test',
      domain: 'coding',
      severity: 'high',
      context: {},
    };
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('timestamp'))).toBe(true);
  });

  it('rejects context exceeding 10KB size limit', () => {
    const largeContext: Record<string, unknown> = {};
    const bigString = 'x'.repeat(11_000);
    largeContext.big = bigString;
    const signal = {
      source: 'tool_failure',
      score: 75,
      timestamp: '2026-01-01T00:00:00Z',
      reason: 'Test',
      sessionId: 'sess-123',
      agentId: 'main',
      traceId: 'trace-abc',
      triggerTextPreview: 'test',
      domain: 'coding',
      severity: 'high',
      context: largeContext,
    };
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('Context'))).toBe(true);
  });

  it('rejects context with circular references without crashing (PR review fix)', () => {
    const circularContext: Record<string, unknown> = {};
    circularContext.self = circularContext;
    const signal = {
      source: 'tool_failure',
      score: 75,
      timestamp: '2026-01-01T00:00:00Z',
      reason: 'Test',
      sessionId: 'sess-123',
      agentId: 'main',
      traceId: 'trace-abc',
      triggerTextPreview: 'test',
      domain: 'coding',
      severity: 'high',
      context: circularContext,
    };
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('JSON-serializable'))).toBe(true);
  });

  it('rejects context with BigInt values without crashing (PR review fix)', () => {
    const signal = {
      source: 'tool_failure',
      score: 75,
      timestamp: '2026-01-01T00:00:00Z',
      reason: 'Test',
      sessionId: 'sess-123',
      agentId: 'main',
      traceId: 'trace-abc',
      triggerTextPreview: 'test',
      domain: 'coding',
      severity: 'high',
      context: { bigNum: BigInt(123) },
    };
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes('JSON-serializable'))).toBe(true);
  });

  it('accepts signal with optional sessionId/agentId/traceId missing', () => {
    const signal = {
      source: 'tool_failure',
      score: 75,
      timestamp: '2026-01-01T00:00:00Z',
      reason: 'Test',
      triggerTextPreview: 'test',
      domain: 'coding',
      severity: 'high',
      context: {},
    };
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(true);
  });

  it('includes version field in validated signal', () => {
    const signal = {
      source: 'tool_failure',
      score: 75,
      timestamp: '2026-01-01T00:00:00Z',
      reason: 'Test',
      sessionId: 'sess-123',
      agentId: 'main',
      traceId: 'trace-abc',
      triggerTextPreview: 'test',
      domain: 'coding',
      severity: 'high',
      context: {},
    };
    const result = validatePainSignal(signal);
    expect(result.valid).toBe(true);
    expect(result.signal?.version).toBe('0.1.0');
  });

  it('PainSeverity type is exported', () => {
    const s: PainSeverity = 'low';
    expect(s).toBe('low');
  });

  it('deriveSeverity is exported and works', () => {
    expect(deriveSeverity(95)).toBe('critical');
  });
});
