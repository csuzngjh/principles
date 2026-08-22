/**
 * Unit tests for the shared date formatter.
 *
 * PD is bilingual: dates must follow the UI language (i18n.language), never
 * the browser/OS locale. Invalid input must return the raw string instead of
 * "Invalid Date".
 */

import { describe, it, expect } from 'vitest';
import { formatDate } from '../../src/ui/utils/format-date.js';

// Local-time noon avoids date-component shifts across CI timezones.
const ISO = '2026-08-22T12:00:00';

describe('formatDate', () => {
  it('follows the given UI language (zh-CN)', () => {
    expect(formatDate(ISO, 'zh-CN')).toMatch(/2026/);
    expect(formatDate(ISO, 'zh-CN')).toMatch(/8[/月]/);
  });

  it('follows the given UI language (en-US)', () => {
    expect(formatDate(ISO, 'en-US')).toMatch(/8\/22\/2026|Aug\s*22,\s*2026/);
  });

  it('passes Intl options through (date + time components)', () => {
    const out = formatDate(ISO, 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(out).toMatch(/Aug/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it('returns the raw input for invalid dates instead of "Invalid Date"', () => {
    expect(formatDate('not-a-date', 'zh-CN')).toBe('not-a-date');
    expect(formatDate('', 'zh-CN')).toBe('');
  });

  it('falls back to the environment locale when language is absent/unknown', () => {
    expect(formatDate(ISO)).toMatch(/2026/);
    expect(formatDate(ISO, 'unknown')).toMatch(/2026/);
  });
});
