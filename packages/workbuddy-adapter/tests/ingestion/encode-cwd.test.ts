/**
 * encodeCwd contract — locked to FORENSIC PAIRS from this machine's real
 * `~/.workbuddy/projects` directory names × the `cwd` fields inside their
 * records (re-verified 2026-11-11). The engine documents no rule; these
 * pairs ARE the contract (tech design §5.1: lock to samples, never to a
 * prose transcription).
 */
import { describe, expect, it } from 'vitest';
import { encodeWorkbuddyCwd } from '../../src/ingestion/encode-cwd.js';

describe('encodeWorkbuddyCwd (forensic baseline)', () => {
  it('maps every real on-disk pair byte-for-byte', () => {
    expect(encodeWorkbuddyCwd('d:\\Code\\principles')).toBe('d-Code-principles');
    expect(encodeWorkbuddyCwd('d:\\Code\\principles-private\\aze')).toBe('d-Code-principles-private-aze');
    expect(encodeWorkbuddyCwd('d:\\Code\\NextMe')).toBe('d-Code-NextMe');
    expect(encodeWorkbuddyCwd('c:\\Users\\Administrator\\Desktop\\车险')).toBe('c-Users-Administrator-Desktop-车险');
    expect(encodeWorkbuddyCwd('c:\\Users\\Administrator\\WorkBuddy\\2026-09-01-23-16-27')).toBe('c-Users-Administrator-WorkBuddy-2026-09-01-23-16-27');
  });

  it('accepts the record-side lowercase-drive form identically (d:\\… and D:\\… collapse to one directory)', () => {
    expect(encodeWorkbuddyCwd('D:\\Code\\principles')).toBe(encodeWorkbuddyCwd('d:\\Code\\principles'));
    expect(encodeWorkbuddyCwd('D:\\Code\\principles')).toBe('d-Code-principles');
  });

  it('folds forward slashes the same as backslashes and never produces a double dash', () => {
    expect(encodeWorkbuddyCwd('D:/Code/principles')).toBe('d-Code-principles');
    expect(encodeWorkbuddyCwd('d:\\Code\\principles')).not.toContain('--');
  });

  it('preserves dashes, dots and underscores verbatim (no escaping observed on disk)', () => {
    expect(encodeWorkbuddyCwd('d:\\my.project_v2\\edge-case')).toBe('d-my.project_v2-edge-case');
  });

  it('degrades on empty input without throwing', () => {
    expect(encodeWorkbuddyCwd('')).toBe('');
  });
});
