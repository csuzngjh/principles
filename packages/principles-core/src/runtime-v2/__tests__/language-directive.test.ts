/**
 * Tests for language directive module (PRI-336).
 *
 * Validates:
 * - resolveOutputLanguage: valid, invalid, missing values
 * - buildLanguageDirective: zh-CN, en, undefined
 * - Technical identifiers not translated instruction
 * - Malformed config produces warning/reason (ERR-002, ERR-009)
 * - No silent fallback (ERR-002)
 */

import { describe, it, expect } from 'vitest';
import {
  resolveOutputLanguage,
  isValidOutputLanguage,
  buildLanguageDirective,
  VALID_OUTPUT_LANGUAGES,
  DEFAULT_OUTPUT_LANGUAGE,
} from '../language-directive.js';

// ── isValidOutputLanguage ─────────────────────────────────────────────────────

describe('isValidOutputLanguage', () => {
  it('returns true for valid languages', () => {
    expect(isValidOutputLanguage('zh-CN')).toBe(true);
    expect(isValidOutputLanguage('en')).toBe(true);
  });

  it('returns false for invalid languages', () => {
    expect(isValidOutputLanguage('zh-TW')).toBe(false);
    expect(isValidOutputLanguage('ja')).toBe(false);
    expect(isValidOutputLanguage('')).toBe(false);
    expect(isValidOutputLanguage(42)).toBe(false);
    expect(isValidOutputLanguage(null)).toBe(false);
    expect(isValidOutputLanguage(undefined)).toBe(false);
    expect(isValidOutputLanguage({})).toBe(false);
  });
});

// ── resolveOutputLanguage ─────────────────────────────────────────────────────

describe('resolveOutputLanguage', () => {
  it('returns default for undefined (legitimate default, no warning)', () => {
    const result = resolveOutputLanguage(undefined);
    expect(result.outputLanguage).toBe(DEFAULT_OUTPUT_LANGUAGE);
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns default for null (legitimate default, no warning)', () => {
    const result = resolveOutputLanguage(null);
    expect(result.outputLanguage).toBe(DEFAULT_OUTPUT_LANGUAGE);
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns zh-CN when configured', () => {
    const result = resolveOutputLanguage('zh-CN');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns en when configured', () => {
    const result = resolveOutputLanguage('en');
    expect(result.outputLanguage).toBe('en');
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns default with structured warning for invalid string (ERR-002, ERR-009)', () => {
    const result = resolveOutputLanguage('fr');
    expect(result.outputLanguage).toBe(DEFAULT_OUTPUT_LANGUAGE);
    expect(result.degradationWarning).toBeDefined();
    expect(result.degradationWarning).toContain('invalid');
    expect(result.degradationWarning).toContain('fr');
    expect(result.degradationWarning).toContain('nextAction');
    expect(result.degradationWarning).toContain(VALID_OUTPUT_LANGUAGES.join(', '));
  });

  it('returns default with structured warning for non-string value (ERR-002, ERR-009)', () => {
    const result = resolveOutputLanguage(42);
    expect(result.outputLanguage).toBe(DEFAULT_OUTPUT_LANGUAGE);
    expect(result.degradationWarning).toBeDefined();
    expect(result.degradationWarning).toContain('invalid');
    expect(result.degradationWarning).toContain('nextAction');
  });

  it('returns default with structured warning for boolean value', () => {
    const result = resolveOutputLanguage(true);
    expect(result.outputLanguage).toBe(DEFAULT_OUTPUT_LANGUAGE);
    expect(result.degradationWarning).toBeDefined();
  });

  it('warning includes reason and nextAction (ERR-009: fail loud)', () => {
    const result = resolveOutputLanguage('invalid-lang');
    expect(result.degradationWarning).toMatch(/nextAction:/);
    expect(result.degradationWarning).toMatch(/Set principles\.outputLanguage/);
  });
});

// ── buildLanguageDirective ────────────────────────────────────────────────────

describe('buildLanguageDirective', () => {
  it('returns empty string for undefined (backward compatible)', () => {
    expect(buildLanguageDirective(undefined)).toBe('');
  });

  it('includes Chinese language name for zh-CN', () => {
    const directive = buildLanguageDirective('zh-CN');
    expect(directive).toContain('Simplified Chinese');
    expect(directive).toContain('简体中文');
  });

  it('includes English language name for en', () => {
    const directive = buildLanguageDirective('en');
    expect(directive).toContain('English');
    expect(directive).toContain('en');
  });

  it('contains instruction to NOT translate technical identifiers', () => {
    const directive = buildLanguageDirective('zh-CN');
    expect(directive).toContain('MUST NOT be translated');
    expect(directive).toContain('taskId');
    expect(directive).toContain('sourcePainId');
    expect(directive).toContain('sourceTaskId');
    expect(directive).toContain('sourceRunIds');
    expect(directive).toContain('file names');
    expect(directive).toContain('function names');
    expect(directive).toContain('error codes');
    expect(directive).toContain('CLI commands');
    expect(directive).toContain('PR numbers');
  });

  it('contains instruction to NOT translate lineage and evidence fields', () => {
    const directive = buildLanguageDirective('en');
    expect(directive).toContain('Lineage and evidence fields MUST NOT be translated');
  });

  it('contains instruction to keep JSON keys in English', () => {
    const directive = buildLanguageDirective('zh-CN');
    expect(directive).toContain('JSON field names (keys) MUST remain in English');
  });

  it('lists human-readable fields that should use target language', () => {
    const directive = buildLanguageDirective('zh-CN');
    expect(directive).toContain('title');
    expect(directive).toContain('statement');
    expect(directive).toContain('rationale');
    expect(directive).toContain('applicability');
    expect(directive).toContain('antiPatterns');
    expect(directive).toContain('description');
  });

  it('includes PRI-336 marker for traceability', () => {
    const directive = buildLanguageDirective('zh-CN');
    expect(directive).toContain('PRI-336');
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('VALID_OUTPUT_LANGUAGES contains zh-CN and en', () => {
    expect(VALID_OUTPUT_LANGUAGES).toContain('zh-CN');
    expect(VALID_OUTPUT_LANGUAGES).toContain('en');
    expect(VALID_OUTPUT_LANGUAGES).toHaveLength(2);
  });

  it('DEFAULT_OUTPUT_LANGUAGE is zh-CN', () => {
    expect(DEFAULT_OUTPUT_LANGUAGE).toBe('zh-CN');
  });
});
