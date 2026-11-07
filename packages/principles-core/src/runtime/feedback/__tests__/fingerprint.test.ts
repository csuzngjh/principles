/**
 * Fingerprint Tests — Feedback deduplication / clustering deterministic hash.
 *
 * Covers the pure functions in feedback/fingerprint.ts (Slice 1, PRI-543):
 *   - normalizeFeedbackTitle: lowercase → strip punctuation → collapse
 *     whitespace → trim → truncate to FEEDBACK_FINGERPRINT_TITLE_LIMIT
 *   - computeFeedbackFingerprint: sha256hex(`${type}|${area ?? general}|${normalize(title)}`)
 *
 * The shared cross-implementation test vectors below (CORE_VECTORS) are also
 * consumed by the relay side (Workers WebCrypto subtle.digest, Slice 4) so that
 * core node:crypto and relay WebCrypto agree on the exact same fingerprint.
 * Do not change these inputs/outputs without updating the relay fixture too.
 *
 * ERR checklist:
 * - EP-01 / ERR-001: inputs are plain strings; no untrusted-object traversal.
 * - ERR-014: output length is bounded (sha256 → 64 hex chars).
 * - ERR-007/009: empty / missing fields fail down deterministically, not by
 *   throwing; area defaults to FEEDBACK_FINGERPRINT_DEFAULT_AREA.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeFeedbackFingerprint,
  normalizeFeedbackTitle,
  FEEDBACK_FINGERPRINT_DEFAULT_AREA,
  FEEDBACK_FINGERPRINT_TITLE_LIMIT,
} from '../fingerprint.js';

/**
 * Shared cross-implementation vectors (also mirrored on the relay side).
 * Each vector is a deterministic (type, area, title) → expected sha256 hex.
 * These MUST stay in sync with the relay fixture (Slice 4) to prevent
 * normalization drift between core node:crypto and Workers WebCrypto.
 */
const CORE_VECTORS: { type: string; area: string | undefined; title: string; expected: string }[] = [
  {
    type: 'bug',
    area: 'failed_tasks',
    title: 'Peers never finish',
    expected: createHash('sha256').update('bug|failed_tasks|peers never finish').digest('hex'),
  },
  {
    type: 'confusing',
    area: undefined,
    title: 'What does "ok" mean?',
    expected: createHash('sha256').update('confusing|general|what does ok mean').digest('hex'),
  },
  {
    type: 'feature_request',
    area: 'principles',
    title: '设置里无法保存 环境变量',
    expected: createHash('sha256').update('feature_request|principles|设置里无法保存 环境变量').digest('hex'),
  },
];

describe('normalizeFeedbackTitle', () => {
  it('lowercases the title', () => {
    expect(normalizeFeedbackTitle('HELLO World')).toBe('hello world');
  });

  it('strips punctuation', () => {
    expect(normalizeFeedbackTitle('Hello, World!!!')).toBe('hello world');
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeFeedbackTitle('  hello    world  ')).toBe('hello world');
  });

  it('keeps CJK ideographs intact', () => {
    expect(normalizeFeedbackTitle('设置里无法保存')).toBe('设置里无法保存');
  });

  it('keeps CJK amid punctuation (title: "设置, 保存!")', () => {
    expect(normalizeFeedbackTitle('设置, 保存!')).toBe('设置 保存');
  });

  it('keeps digits and underscores (\\w covers `_`)', () => {
    expect(normalizeFeedbackTitle('Step_1: retry 3x')).toBe('step_1 retry 3x');
  });

  it('replaces windows/path punctuation with spaces', () => {
    expect(normalizeFeedbackTitle('Bug at C:\\Users\\alice')).toBe('bug at c users alice');
  });

  it('truncates to the title limit', () => {
    const long = 'x'.repeat(FEEDBACK_FINGERPRINT_TITLE_LIMIT + 50);
    const norm = normalizeFeedbackTitle(long);
    expect(norm.length).toBe(FEEDBACK_FINGERPRINT_TITLE_LIMIT);
    expect(norm).toBe('x'.repeat(FEEDBACK_FINGERPRINT_TITLE_LIMIT));
  });

  it('returns empty string for empty/whitespace-only input', () => {
    expect(normalizeFeedbackTitle('')).toBe('');
    expect(normalizeFeedbackTitle('   ')).toBe('');
  });
});

describe('computeFeedbackFingerprint', () => {
  it('is deterministic for identical input', () => {
    const a = computeFeedbackFingerprint({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
    const b = computeFeedbackFingerprint({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
    expect(a).toBe(b);
  });

  it('is case-insensitive on type and title', () => {
    const upper = computeFeedbackFingerprint({ type: 'BUG', title: 'PEERS NEVER FINISH', area: 'failed_tasks' });
    const lower = computeFeedbackFingerprint({ type: 'bug', title: 'Peers never finish', area: 'failed_tasks' });
    expect(upper).toBe(lower);
  });

  it('collapses title case differences (same area, title case-insensitive)', () => {
    const a = computeFeedbackFingerprint({ type: 'bug', title: 'Title', area: 'failed_tasks' });
    const b = computeFeedbackFingerprint({ type: 'bug', title: 'title', area: 'failed_tasks' });
    expect(a).toBe(b);
  });

  it('defaults area to FEEDBACK_FINGERPRINT_DEFAULT_AREA when absent', () => {
    const withArea = computeFeedbackFingerprint({ type: 'confusing', title: 'What does "ok" mean?', area: undefined });
    const manual = createHash('sha256').update(`confusing|${FEEDBACK_FINGERPRINT_DEFAULT_AREA}|what does ok mean`).digest('hex');
    expect(withArea).toBe(manual);
  });

  it('normalizes two differently-punctuated equivalent titles to the same fingerprint', () => {
    const a = computeFeedbackFingerprint({ type: 'bug', title: 'Login fails: token expired!' });
    const b = computeFeedbackFingerprint({ type: 'bug', title: 'login fails token expired' });
    expect(a).toBe(b);
  });

  it('produces a 64-char lower-hex string', () => {
    const fp = computeFeedbackFingerprint({ type: 'other', title: 'anything' });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes different types / areas / titles', () => {
    const base = computeFeedbackFingerprint({ type: 'bug', area: 'a', title: 'same title' });
    const diffType = computeFeedbackFingerprint({ type: 'confusing', area: 'a', title: 'same title' });
    const diffArea = computeFeedbackFingerprint({ type: 'bug', area: 'b', title: 'same title' });
    const diffTitle = computeFeedbackFingerprint({ type: 'bug', area: 'a', title: 'different title' });
    expect(new Set([base, diffType, diffArea, diffTitle]).size).toBe(4);
  });

  it('round-trips all shared core vectors exactly (cross-implementation contract)', () => {
    for (const v of CORE_VECTORS) {
      const fp = computeFeedbackFingerprint({ type: v.type, area: v.area, title: v.title });
      expect(fp).toBe(v.expected);
    }
  });
});