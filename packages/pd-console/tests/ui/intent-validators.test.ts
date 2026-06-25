/**
 * PRI-466: Intent Page validator tests.
 *
 * Covers validateIntentWarning, validateIntentSections, validateIntentSummary
 * in utils/validators.ts. These validators protect the UI from untrusted API
 * response data per Runtime Contract Rules (ERR-001/005/009/013).
 *
 * Tests import production validators (ERR-025: tests must cover real product
 * paths, not copy implementation).
 */

import { describe, it, expect } from 'vitest';
import {
  validateIntentWarning,
  validateIntentSections,
  validateIntentSummary,
} from '../../src/ui/utils/validators.js';

// ── validateIntentWarning ────────────────────────────────────────────────────

describe('validateIntentWarning', () => {
  it('accepts a valid warning with code + message', () => {
    const result = validateIntentWarning({ code: 'missing_section', message: 'Section "Why" is missing.' });
    expect(result).not.toBeNull();
    expect(result?.code).toBe('missing_section');
    expect(result?.message).toBe('Section "Why" is missing.');
    expect(result?.section).toBeUndefined();
  });

  it('accepts a valid warning with optional section', () => {
    const result = validateIntentWarning({ code: 'empty_section', message: 'Empty', section: 'Why' });
    expect(result).not.toBeNull();
    expect(result?.section).toBe('Why');
  });

  it('accepts all valid warning codes', () => {
    const codes = ['missing_section', 'empty_section', 'too_vague', 'oversized', 'parse_failed'];
    for (const code of codes) {
      const result = validateIntentWarning({ code, message: 'msg' });
      expect(result).not.toBeNull();
      expect(result?.code).toBe(code);
    }
  });

  it('rejects null', () => {
    expect(validateIntentWarning(null)).toBeNull();
  });

  it('rejects array', () => {
    expect(validateIntentWarning([1, 2, 3])).toBeNull();
  });

  it('rejects primitive', () => {
    expect(validateIntentWarning('missing_section')).toBeNull();
  });

  it('rejects missing code', () => {
    expect(validateIntentWarning({ message: 'msg' })).toBeNull();
  });

  it('rejects non-string code', () => {
    expect(validateIntentWarning({ code: 123, message: 'msg' })).toBeNull();
  });

  it('rejects invalid code value', () => {
    expect(validateIntentWarning({ code: 'unknown_code', message: 'msg' })).toBeNull();
  });

  it('rejects missing message', () => {
    expect(validateIntentWarning({ code: 'missing_section' })).toBeNull();
  });

  it('rejects non-string message', () => {
    expect(validateIntentWarning({ code: 'missing_section', message: 42 })).toBeNull();
  });

  it('rejects non-string section when present (Runtime Contract Rule #3)', () => {
    // Fail loud on wrong-type optional fields, consistent with the file's
    // validate-on-present pattern (CodeRabbit review finding).
    expect(validateIntentWarning({ code: 'missing_section', message: 'msg', section: 123 })).toBeNull();
  });
});

// ── validateIntentSections ───────────────────────────────────────────────────

describe('validateIntentSections', () => {
  it('accepts all five valid section keys', () => {
    const result = validateIntentSections({
      why: 'why text',
      desiredOutcome: 'outcome',
      nonNegotiables: 'non-negot',
      stopEscalation: 'stop',
      currentStrategicFocus: 'focus',
    });
    expect(result).not.toBeNull();
    expect(result?.why).toBe('why text');
    expect(result?.desiredOutcome).toBe('outcome');
    expect(result?.nonNegotiables).toBe('non-negot');
    expect(result?.stopEscalation).toBe('stop');
    expect(result?.currentStrategicFocus).toBe('focus');
  });

  it('accepts partial sections (only some keys present)', () => {
    const result = validateIntentSections({ why: 'why only' });
    expect(result).not.toBeNull();
    expect(result?.why).toBe('why only');
    expect(result?.desiredOutcome).toBeUndefined();
  });

  it('accepts empty object (no sections present)', () => {
    const result = validateIntentSections({});
    expect(result).not.toBeNull();
  });

  it('accepts null values for section keys (treated as absent)', () => {
    const result = validateIntentSections({ why: null, desiredOutcome: 'present' });
    expect(result).not.toBeNull();
    expect(result?.why).toBeUndefined();
    expect(result?.desiredOutcome).toBe('present');
  });

  it('rejects null', () => {
    expect(validateIntentSections(null)).toBeNull();
  });

  it('rejects array', () => {
    expect(validateIntentSections(['why', 'outcome'])).toBeNull();
  });

  it('rejects primitive', () => {
    expect(validateIntentSections('why')).toBeNull();
  });

  it('rejects non-string section value', () => {
    expect(validateIntentSections({ why: 123 })).toBeNull();
  });
});

// ── validateIntentSummary ────────────────────────────────────────────────────

describe('validateIntentSummary', () => {
  const validSummary = {
    ok: true,
    found: true,
    flagEnabled: true,
    warnings: [],
  };

  it('accepts minimal valid summary with required fields only', () => {
    const result = validateIntentSummary(validSummary);
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    expect(result?.found).toBe(true);
    expect(result?.flagEnabled).toBe(true);
    expect(result?.warnings).toEqual([]);
  });

  it('accepts full valid summary with all optional fields', () => {
    const result = validateIntentSummary({
      ...validSummary,
      reason: 'not_found',
      nextAction: 'Create INTENT.md',
      path: '/workspace/.principles/INTENT.md',
      contentHash: 'sha256:abc123',
      lastEditedAt: '2026-06-25T10:00:00Z',
      sections: { why: 'why text' },
      warnings: [{ code: 'missing_section', message: 'Missing', section: 'Why' }],
    });
    expect(result).not.toBeNull();
    expect(result?.reason).toBe('not_found');
    expect(result?.nextAction).toBe('Create INTENT.md');
    expect(result?.path).toBe('/workspace/.principles/INTENT.md');
    expect(result?.contentHash).toBe('sha256:abc123');
    expect(result?.lastEditedAt).toBe('2026-06-25T10:00:00Z');
    expect(result?.sections?.why).toBe('why text');
    expect(result?.warnings.length).toBe(1);
  });

  it('accepts all valid reason values', () => {
    const reasons = ['flag_disabled', 'not_found', 'read_error', 'parse_error', 'oversized'];
    for (const reason of reasons) {
      const result = validateIntentSummary({ ...validSummary, reason });
      expect(result).not.toBeNull();
      expect(result?.reason).toBe(reason);
    }
  });

  it('rejects null', () => {
    expect(validateIntentSummary(null)).toBeNull();
  });

  it('rejects array', () => {
    expect(validateIntentSummary([1, 2, 3])).toBeNull();
  });

  it('rejects primitive', () => {
    expect(validateIntentSummary('ok')).toBeNull();
  });

  it('rejects missing ok field', () => {
    expect(validateIntentSummary({ found: true, flagEnabled: true, warnings: [] })).toBeNull();
  });

  it('rejects non-boolean ok', () => {
    expect(validateIntentSummary({ ok: 'true', found: true, flagEnabled: true, warnings: [] })).toBeNull();
  });

  it('rejects missing found field', () => {
    expect(validateIntentSummary({ ok: true, flagEnabled: true, warnings: [] })).toBeNull();
  });

  it('rejects non-boolean found', () => {
    expect(validateIntentSummary({ ok: true, found: 1, flagEnabled: true, warnings: [] })).toBeNull();
  });

  it('rejects missing flagEnabled field', () => {
    expect(validateIntentSummary({ ok: true, found: true, warnings: [] })).toBeNull();
  });

  it('rejects non-boolean flagEnabled', () => {
    expect(validateIntentSummary({ ok: true, found: true, flagEnabled: 'yes', warnings: [] })).toBeNull();
  });

  it('rejects missing warnings field', () => {
    expect(validateIntentSummary({ ok: true, found: true, flagEnabled: true })).toBeNull();
  });

  it('rejects non-array warnings', () => {
    expect(validateIntentSummary({ ok: true, found: true, flagEnabled: true, warnings: 'none' })).toBeNull();
  });

  it('rejects invalid warning element', () => {
    expect(validateIntentSummary({
      ok: true, found: true, flagEnabled: true,
      warnings: [{ code: 'invalid', message: 'msg' }],
    })).toBeNull();
  });

  it('rejects non-string reason when present', () => {
    expect(validateIntentSummary({ ...validSummary, reason: 123 })).toBeNull();
  });

  it('rejects invalid reason value', () => {
    expect(validateIntentSummary({ ...validSummary, reason: 'unknown_reason' })).toBeNull();
  });

  it('rejects non-string nextAction when present', () => {
    expect(validateIntentSummary({ ...validSummary, nextAction: 42 })).toBeNull();
  });

  it('rejects non-string path when present', () => {
    expect(validateIntentSummary({ ...validSummary, path: 123 })).toBeNull();
  });

  it('rejects non-string contentHash when present', () => {
    expect(validateIntentSummary({ ...validSummary, contentHash: true })).toBeNull();
  });

  it('rejects non-string lastEditedAt when present', () => {
    expect(validateIntentSummary({ ...validSummary, lastEditedAt: {} })).toBeNull();
  });

  it('rejects invalid sections when present', () => {
    expect(validateIntentSummary({ ...validSummary, sections: 'invalid' })).toBeNull();
  });

  it('rejects sections with non-string value', () => {
    expect(validateIntentSummary({ ...validSummary, sections: { why: 123 } })).toBeNull();
  });
});
