import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import {
  CorrectionCueLearner,
  loadCorrectionKeywordStore,
  saveCorrectionKeywordStore,
  _resetCorrectionCueCache,
  _resetCorrectionCueLearnerInstance,
} from '../../src/core/correction-cue-learner.js';
import {
  CORRECTION_SEED_KEYWORDS,
  MAX_CORRECTION_KEYWORDS,
} from '../../src/core/correction-types.js';

// ── Mock fs (hoisted — vi.mock runs before imports) ──────────────────────────

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return path.join(os.tmpdir(), `correction-cue-test-${Date.now()}-${Math.random()}`);
}

// ── Test setup: reset module-level cache and singleton between tests ─────────

beforeEach(() => {
  vi.clearAllMocks();
  _resetCorrectionCueCache();
  _resetCorrectionCueLearnerInstance();
});

// ═══════════════════════════════════════════════════════════════════════════════
// CORR-01: Seed keywords
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-01: Seed keywords', () => {
  it('should create store with 16 seed keywords on first load', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const dir = tempDir();
    const store = loadCorrectionKeywordStore(dir);
    expect(store.keywords).toHaveLength(16);
    expect(store.version).toBe(1);
  });

  it('should set source=seed and non-empty addedAt for all seed keywords', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const dir = tempDir();
    const store = loadCorrectionKeywordStore(dir);
    for (const kw of store.keywords) {
      expect(kw.source).toBe('seed');
      expect(kw.addedAt).not.toBe('');
      expect(kw.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('should have all 16 exact terms from CORRECTION_SEED_KEYWORDS', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const dir = tempDir();
    const store = loadCorrectionKeywordStore(dir);
    const terms = store.keywords.map((k) => k.term);
    for (const seed of CORRECTION_SEED_KEYWORDS) {
      expect(terms).toContain(seed.term);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CORR-03: Atomic write
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-03: Atomic write', () => {
  it('should write to .tmp file before rename', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ keywords: CORRECTION_SEED_KEYWORDS.map((k) => ({ ...k, addedAt: '2026-01-01T00:00:00Z' })), version: 1 })
    );

    const dir = tempDir();
    const store = {
      keywords: CORRECTION_SEED_KEYWORDS.map((k) => ({ ...k, addedAt: '2026-01-01T00:00:00Z' })),
      version: 1,
      lastOptimizedAt: '2026-01-01T00:00:00Z',
    };
    saveCorrectionKeywordStore(dir, store);

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const tmpPath = writeCall[0] as string;
    expect(tmpPath).toMatch(/\.tmp$/);
  });

  it('should rename from tmp path to final path after write', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ keywords: CORRECTION_SEED_KEYWORDS.map((k) => ({ ...k, addedAt: '2026-01-01T00:00:00Z' })), version: 1 })
    );

    const dir = tempDir();
    const store = {
      keywords: CORRECTION_SEED_KEYWORDS.map((k) => ({ ...k, addedAt: '2026-01-01T00:00:00Z' })),
      version: 1,
      lastOptimizedAt: '2026-01-01T00:00:00Z',
    };
    saveCorrectionKeywordStore(dir, store);

    const renameCalls = vi.mocked(fs.renameSync).mock.calls;
    expect(renameCalls).toHaveLength(1);
    const [from, to] = renameCalls[0];
    expect(from).toMatch(/\.tmp$/);
    expect(to).not.toMatch(/\.tmp$/);
  });

  it('should call mkdirSync with recursive:true before writing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ keywords: CORRECTION_SEED_KEYWORDS.map((k) => ({ ...k, addedAt: '2026-01-01T00:00:00Z' })), version: 1 })
    );

    const dir = tempDir();
    const store = {
      keywords: CORRECTION_SEED_KEYWORDS.map((k) => ({ ...k, addedAt: '2026-01-01T00:00:00Z' })),
      version: 1,
      lastOptimizedAt: '2026-01-01T00:00:00Z',
    };
    saveCorrectionKeywordStore(dir, store);

    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(dir, { recursive: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CORR-04: Cache invalidation
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-04: Cache invalidation', () => {
  it('should invalidate cache after save so next load re-reads from disk', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        keywords: CORRECTION_SEED_KEYWORDS.map((k) => ({ ...k, addedAt: '2026-01-01T00:00:00Z' })),
        version: 1,
      })
    );

    const dir = tempDir();
    loadCorrectionKeywordStore(dir);
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalled();

    const store = loadCorrectionKeywordStore(dir);
    saveCorrectionKeywordStore(dir, store);

    // After save, cache is null — next load must re-read. Verify by changing
    // the mock return and confirming the new data is picked up.
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ keywords: [], version: 1 }));

    const store2 = loadCorrectionKeywordStore(dir);
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalled();
    expect(store2.keywords).toHaveLength(0); // proves re-read happened
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CORR-05: 200-term limit
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-05: 200-term limit', () => {
  it('should throw when adding keyword beyond 200 terms', () => {
    const keywords = Array.from({ length: 200 }, (_, i) => ({
      term: `keyword-${i}`,
      weight: 0.5,
      source: 'seed' as const,
      addedAt: '2026-01-01T00:00:00Z',
    }));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ keywords, version: 1 }));

    const dir = tempDir();
    const learner = new CorrectionCueLearner(dir);
    expect(learner.getStore().keywords).toHaveLength(200);

    expect(() => learner.add({ term: 'new-keyword', weight: 0.5, source: 'user' })).toThrow(
      'Correction keyword store limit reached (200 terms)'
    );
  });

  it('should allow add when at 199 terms', () => {
    const keywords = Array.from({ length: 199 }, (_, i) => ({
      term: `keyword-${i}`,
      weight: 0.5,
      source: 'seed' as const,
      addedAt: '2026-01-01T00:00:00Z',
    }));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ keywords, version: 1 }));

    const dir = tempDir();
    const learner = new CorrectionCueLearner(dir);
    expect(learner.getStore().keywords).toHaveLength(199);

    expect(() => learner.add({ term: 'new-keyword', weight: 0.5, source: 'user' })).not.toThrow();
  });

  it('should not modify store when add fails due to limit', () => {
    const keywords = Array.from({ length: 200 }, (_, i) => ({
      term: `keyword-${i}`,
      weight: 0.5,
      source: 'seed' as const,
      addedAt: '2026-01-01T00:00:00Z',
    }));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ keywords, version: 1 }));

    const dir = tempDir();
    const learner = new CorrectionCueLearner(dir);
    try {
      learner.add({ term: 'new-keyword', weight: 0.5, source: 'user' });
    } catch {
      // expected
    }

    expect(learner.getStore().keywords).toHaveLength(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CORR-11: Equivalence to detectCorrectionCue
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-11: Equivalence to detectCorrectionCue', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  /**
   * Reference implementation using find() — first match wins (same as detectCorrectionCue).
   */
  function detectCorrectionCueLegacy(text: string): string | null {
    const normalized = text.trim().toLowerCase().replace(/[.,!?;:，。！？；：]/g, '');
    const cues = CORRECTION_SEED_KEYWORDS.map((k) => k.term);
    return cues.find((cue) => normalized.includes(cue)) ?? null;
  }

  /**
   * Tests using first-match semantics: find() returns the FIRST keyword in the
   * array whose term appears in the normalized text, not the longest match.
   *
   * Order of CORRECTION_SEED_KEYWORDS array (first 8 Chinese):
   *   '不是这个', '不对', '错了', '搞错了', '理解错了', '你理解错了', '重新来', '再试一次'
   *
   * So "我搞错了" → "错了" is found first (index 2) before "搞错了" (index 3).
   * "你理解错了" → "错了" is found first (index 2) before "理解错了" (index 4) and "你理解错了" (index 5).
   */
  it.each([
    // Chinese cases — note: first match wins
    ['不是这个', '不是这个'],       // exact match
    ['你不对啊', '不对'],          // first match is '不对' (index 1)
    ['错了！', '错了'],            // exact match (index 2)
    ['我搞错了', '错了'],          // '错了' appears first in array (index 2 < index 3)
    ['你理解错了', '错了'],         // '错了' appears first in array (index 2 < index 4)
    ['重新来一遍', '重新来'],       // exact match
    ['再试一次行不行', '再试一次'],  // exact match
    // English cases
    ['you are wrong', 'you are wrong'],  // exact match
    ['wrong file', 'wrong file'],        // exact match
    ['not this one', 'not this'],        // exact match
    ['redo it', 'redo'],                 // exact match (index 11)
    ['try again', 'try again'],           // exact match (index 12)
    ['do it again', 'again'],             // 'again' is index 13
    ['please redo', 'redo'],              // 'redo' found first (index 11 < index 14)
    ['please try again', 'try again'],    // 'try again' found first (index 12 < index 15)
  ])('should match "%s" → "%s"', (text, expected) => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const dir = tempDir();
    const learner = new CorrectionCueLearner(dir);
    const result = learner.match(text);
    expect(result.matched).toBe(true);
    expect(result.matchedTerms).toContain(expected);
    expect(result.score).toBeGreaterThan(0);
  });

  it('should produce same result as legacy detectCorrectionCue for varied inputs', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const dir = tempDir();
    const learner = new CorrectionCueLearner(dir);

    const cases = [
      '这个可以，没问题',
      '不对，应该是这样',
      '你再试试这个方法',
      'nothing wrong here',
      'please be careful',
      'can you try again?',
      'I think you are wrong about this',
    ];

    for (const text of cases) {
      const legacyResult = detectCorrectionCueLegacy(text);
      const learnerResult = learner.match(text);

      if (legacyResult !== null) {
        expect(learnerResult.matched).toBe(true);
        expect(learnerResult.matchedTerms).toContain(legacyResult);
        expect(learnerResult.score).toBeGreaterThan(0);
      } else {
        expect(learnerResult.matched).toBe(false);
        expect(learnerResult.matchedTerms).toEqual([]);
      }
    }
  });

  it('should match regardless of surrounding punctuation', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const dir = tempDir();
    const learner = new CorrectionCueLearner(dir);

    const variations = ['不对', '不对!', '不对?', '。不对', '不对。', '  不对  ', '不对啊'];
    for (const text of variations) {
      const result = learner.match(text);
      expect(result.matched).toBe(true);
      expect(result.matchedTerms).toContain('不对');
    }
  });

  it('should return positive score when matched, 0 when not matched', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const dir = tempDir();
    const learner = new CorrectionCueLearner(dir);
    expect(learner.match('不是这个').score).toBeGreaterThan(0);
    expect(learner.match('这个可以').score).toBe(0);
  });

  it('should export MAX_CORRECTION_KEYWORDS = 200', () => {
    expect(MAX_CORRECTION_KEYWORDS).toBe(200);
  });
});
