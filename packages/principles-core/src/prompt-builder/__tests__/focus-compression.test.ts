import { describe, it, expect } from 'vitest';
import { extractVersion, extractDate } from '../focus-compression.js';

/**
 * Principle Context (SPEC v1.1 §8.3): only the two display helpers survive the
 * Batch 1 retirement; the retired working-memory/compression functions were
 * deleted with their production consumers and their tests were removed with
 * them (no deleted-surface coverage).
 */

describe('extractVersion (Principle Context display helper)', () => {
  it('extracts the version label', () => {
    expect(extractVersion('**版本**: v3 | **状态**: EXECUTING')).toBe('3');
  });

  it('extracts a decimal version', () => {
    expect(extractVersion('**版本**: v1.42')).toBe('1.42');
  });

  it('defaults to "1" when absent', () => {
    expect(extractVersion('# CURRENT_FOCUS\n\nno version here')).toBe('1');
    expect(extractVersion('**版本**: v')).toBe('1');
  });
});

describe('extractDate (Principle Context display helper)', () => {
  it('extracts the update date', () => {
    expect(extractDate('**更新**: 2026-11-18')).toBe('2026-11-18');
  });

  it('falls back to today when absent (display-only default)', () => {
    const fallback = extractDate('no date');
    expect(fallback).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Batch 1 retirement: the module surface is display-only', () => {
  it('exports only extractVersion and extractDate', async () => {
    const module = await import('../focus-compression.js');
    expect(Object.keys(module).sort()).toEqual(['extractDate', 'extractVersion']);
  });
});
