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
// CORR-11: Detection semantics
// ═══════════════════════════════════════════════════════════════════════════════
//
// PRI-812: CorrectionCueLearner.match() removed (ghost second detector, zero
// production callers). Canonical detection is the shared keyword store →
// collectSync path; its behavior is covered by the @principles/core
// signal-collector tests, the host-runtime governance-signal-admission tests,
// and the plugin's signal-collector-host / signal-keyword-store tests.

describe('CORR-11: Store limits contract', () => {
  it('should export MAX_CORRECTION_KEYWORDS = 200', () => {
    expect(MAX_CORRECTION_KEYWORDS).toBe(200);
  });
});
