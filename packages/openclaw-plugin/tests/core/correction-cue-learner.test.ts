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
// PRI-9xx: cap is a budget, not a freeze — least valuable learned term is evicted
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-05b: eviction at the cap keeps learning alive', () => {
  const kw = (over: Partial<{ term: string; weight: number; source: 'seed' | 'llm' | 'user'; addedAt: string; truePositiveCount: number; falsePositiveCount: number }>) => ({
    term: 't',
    weight: 0.5,
    source: 'llm' as const,
    addedAt: '2026-01-01T00:00:00Z',
    ...over,
  });

  function fillStore(entries: ReturnType<typeof kw>[]) {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ keywords: entries, version: 1 }));
  }

  function atCap(extra: number): ReturnType<typeof kw>[] {
    return Array.from({ length: MAX_CORRECTION_KEYWORDS - extra }, (_, i) => kw({ term: `fill-${i}` }));
  }

  it('evicts the least valuable llm term instead of throwing, and reports it', () => {
    fillStore([
      ...atCap(3),
      kw({ term: 'proven-noise', weight: 0.4, falsePositiveCount: 2 }),
      kw({ term: 'never-confirmed', weight: 0.3 }),
      kw({ term: 'proven-useful', weight: 0.2, truePositiveCount: 4 }),
    ]);
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.getStore().keywords).toHaveLength(MAX_CORRECTION_KEYWORDS);

    const evicted = learner.add({ term: 'new-term', weight: 0.6, source: 'llm' });

    // 顺序：先出「有 FP 无 TP」的实证噪声，再出「从未被确认」的，最后才是有效词
    expect(evicted).toEqual(['proven-noise']);
    const terms = learner.getStore().keywords.map(k => k.term);
    expect(terms).not.toContain('proven-noise');
    expect(terms).toContain('proven-useful');
    expect(terms).toContain('new-term');
    expect(learner.getStore().keywords).toHaveLength(MAX_CORRECTION_KEYWORDS);
  });

  it('evicts the never-confirmed term with the lowest weight and oldest addition', () => {
    fillStore([
      ...atCap(2),
      kw({ term: 'cheap-old', weight: 0.2, addedAt: '2026-01-01T00:00:00Z' }),
      kw({ term: 'cheap-new', weight: 0.2, addedAt: '2026-09-01T00:00:00Z' }),
    ]);
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.add({ term: 'x', weight: 0.5, source: 'llm' })).toEqual(['cheap-old']);
  });

  it('never evicts seed or user terms — only learned ones compete', () => {
    fillStore([
      kw({ term: 'seed-term', source: 'seed', weight: 0.1 }),
      kw({ term: 'user-term', source: 'user', weight: 0.1 }),
      ...atCap(2),
    ]);
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.getStore().keywords).toHaveLength(MAX_CORRECTION_KEYWORDS);

    const evicted = learner.add({ term: 'x', weight: 0.5, source: 'llm' });

    const terms = learner.getStore().keywords.map(k => k.term);
    expect(terms).toContain('seed-term');
    expect(terms).toContain('user-term');
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted).not.toContain('seed-term');
    expect(evicted).not.toContain('user-term');
  });

  it('still refuses to grow when the store holds nothing the learning may evict', () => {
    fillStore(Array.from({ length: MAX_CORRECTION_KEYWORDS }, (_, i) => kw({ term: `s-${i}`, source: 'seed' })));
    const learner = new CorrectionCueLearner(tempDir());
    expect(() => learner.add({ term: 'new', weight: 0.5, source: 'llm' })).toThrow(
      'Correction keyword store limit reached (200 terms)',
    );
    expect(learner.getStore().keywords).toHaveLength(MAX_CORRECTION_KEYWORDS);
  });

  // ── PRI-2053: 超额库存的有界渐进收敛 ──────────────────────────────────────
  // 历史遗留的超额库（如 372/200）在旧实现下每次 ADD 只是等量替换（先删一个
  // 再加一个），数量永不下降；一次清空又会无逐词证据地批量删除历史学习成果。
  // 收敛必须是有界的、按同一 tier 排序的、且只动 llm 词。

  it('PRI-2053: an oversized store shrinks on every ADD instead of being replaced one-for-one', () => {
    fillStore(Array.from({ length: 372 }, (_, i) => kw({ term: `over-${i}` })));
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.getStore().keywords).toHaveLength(372);

    let previous = learner.getStore().keywords.length;
    for (let round = 0; round < 5; round++) {
      const evicted = learner.add({ term: `new-${round}`, weight: 0.5, source: 'llm' });
      const now = learner.getStore().keywords.length;
      expect(evicted.length).toBeGreaterThanOrEqual(2); // 腾位 + 至少一步收敛
      expect(now).toBeLessThan(previous);               // 净减少（旧实现恒为 0）
      previous = now;
    }
    expect(previous).toBe(372 - 4 * 5); // 每轮净 -4（淘汰 5、加入 1）
  });

  it('PRI-2053: convergence reaches the cap and stops there', () => {
    fillStore(Array.from({ length: 205 }, (_, i) => kw({ term: `over-${i}` })));
    const learner = new CorrectionCueLearner(tempDir());

    let guard = 0;
    while (learner.getStore().keywords.length > MAX_CORRECTION_KEYWORDS && guard < 100) {
      learner.add({ term: `new-${guard}`, weight: 0.5, source: 'llm' });
      guard += 1;
    }

    expect(learner.getStore().keywords.length).toBe(MAX_CORRECTION_KEYWORDS);
    expect(guard).toBeLessThan(100);
  });

  it('PRI-2053 boundary 199 → ADD evicts nothing', () => {
    fillStore(Array.from({ length: 199 }, (_, i) => kw({ term: `fill-${i}` })));
    const learner = new CorrectionCueLearner(tempDir());

    const evicted = learner.add({ term: 'new', weight: 0.5, source: 'llm' });

    expect(evicted).toEqual([]);
    expect(learner.getStore().keywords).toHaveLength(MAX_CORRECTION_KEYWORDS);
  });

  it('PRI-2053 boundary 200 → ADD evicts exactly one (historical behaviour preserved)', () => {
    fillStore(Array.from({ length: MAX_CORRECTION_KEYWORDS }, (_, i) => kw({ term: `fill-${i}` })));
    const learner = new CorrectionCueLearner(tempDir());

    const evicted = learner.add({ term: 'new', weight: 0.5, source: 'llm' });

    expect(evicted).toHaveLength(1);
    expect(learner.getStore().keywords).toHaveLength(MAX_CORRECTION_KEYWORDS);
  });

  it('PRI-2053 boundary 201 → ADD converges back to the cap', () => {
    fillStore(Array.from({ length: 201 }, (_, i) => kw({ term: `fill-${i}` })));
    const learner = new CorrectionCueLearner(tempDir());

    const evicted = learner.add({ term: 'new', weight: 0.5, source: 'llm' });

    expect(evicted).toHaveLength(2);
    expect(learner.getStore().keywords).toHaveLength(MAX_CORRECTION_KEYWORDS);
  });

  it('PRI-2053: an oversized all-seed store refuses to grow and mutates nothing (atomic failure)', () => {
    fillStore(Array.from({ length: 205 }, (_, i) => kw({ term: `s-${i}`, source: 'seed' })));
    const learner = new CorrectionCueLearner(tempDir());

    expect(() => learner.add({ term: 'new', weight: 0.5, source: 'llm' })).toThrow(
      'Correction keyword store limit reached (200 terms)',
    );
    // 失败不得先删除旧词再留下半成品状态
    expect(learner.getStore().keywords).toHaveLength(205);
  });

  it('PRI-2053: convergence evicts worst-first and never touches seed/user', () => {
    fillStore([
      ...Array.from({ length: 202 }, (_, i) => kw({ term: `fill-${i}` })),
      kw({ term: 'seed-term', source: 'seed' }),
      kw({ term: 'user-term', source: 'user' }),
      kw({ term: 'proven-noise', weight: 0.4, falsePositiveCount: 2 }),
      kw({ term: 'never-confirmed', weight: 0.05 }),
      kw({ term: 'proven-useful', weight: 0.9, truePositiveCount: 3 }),
    ]);
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.getStore().keywords).toHaveLength(207);

    const evicted = learner.add({ term: 'new', weight: 0.5, source: 'llm' });

    // over = 7 → budget = min(8, 5) = 5：完整列表（不是只记最后一个）
    expect(evicted).toHaveLength(5);
    expect(evicted[0]).toBe('proven-noise');    // tier 0：有 FP 无 TP
    expect(evicted[1]).toBe('never-confirmed'); // tier 1：最低权
    expect(evicted).not.toContain('seed-term');
    expect(evicted).not.toContain('user-term');

    const terms = learner.getStore().keywords.map(k => k.term);
    expect(terms).not.toContain('proven-noise');
    expect(terms).toContain('proven-useful');
    expect(terms).toContain('seed-term');
    expect(terms).toContain('user-term');
    expect(learner.getStore().keywords).toHaveLength(203);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-9xx: term identity rule is shared by every mutation (EP-07 rc-7 class)
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-06: one term-identity rule for read and write', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      keywords: [{ term: '搞错了', weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z' }],
      version: 1,
    }));
  });

  it('resolves surrounding whitespace and case, which ADD already trimmed but UPDATE/REMOVE did not', () => {
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.updateWeight('  搞错了 ', 0.8)).toBe(true);
    expect(learner.getStore().keywords[0].weight).toBe(0.8);
    expect(learner.remove('\t搞错了\n')).toBe(true);
    expect(learner.getStore().keywords).toHaveLength(0);
  });

  it('reports a miss as false instead of throwing, so the caller can log a reason', () => {
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.updateWeight('优化来优化去', 0.8)).toBe(false);
    expect(learner.remove('优化来优化去')).toBe(false);
    expect(learner.recordTruePositive('不存在')).toBe(false);
    expect(learner.recordFalsePositive('不存在')).toBe(false);
    expect(learner.find('不存在')).toBeUndefined();
    expect(learner.find('  搞错了 ')).toMatchObject({ term: '搞错了' });
  });

  it('records TP/FP evidence with the same rule', () => {
    const learner = new CorrectionCueLearner(tempDir());
    expect(learner.recordTruePositive('搞错了')).toBe(true);
    expect(learner.getStore().keywords[0].truePositiveCount).toBe(1);
    expect(learner.recordFalsePositive(' 搞错了')).toBe(true);
    expect(learner.getStore().keywords[0].falsePositiveCount).toBe(1);
    expect(learner.getStore().keywords[0].weight).toBeCloseTo(0.4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-9xx: store cache is keyed by stateDir (EP-07 / ERR-092 class)
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-07: per-stateDir cache — one workspace must not flush another store', () => {
  it('loads and keeps distinct stores for distinct stateDirs in one process', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const dir = String(p);
      const term = dir.includes('ws-a') ? 'from-a' : 'from-b';
      return JSON.stringify({ keywords: [{ term, weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z' }], version: 1 });
    });

    const dirA = path.join(os.tmpdir(), 'ws-a-state');
    const dirB = path.join(os.tmpdir(), 'ws-b-state');

    const a = CorrectionCueLearner.get(dirA);
    const b = CorrectionCueLearner.get(dirB);

    expect(a.getStore().keywords[0].term).toBe('from-a');
    // 旧实现的模块级单槽缓存会把 A 的词库交给 B，随后 B 的 flush 覆写 B 的文件
    expect(b.getStore().keywords[0].term).toBe('from-b');
    expect(a).not.toBe(b);
  });

  it('writes each workspace store to its own file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => JSON.stringify({
      keywords: [{ term: String(p).includes('ws-a') ? 'from-a' : 'from-b', weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z' }],
      version: 1,
    }));
    const dirA = path.join(os.tmpdir(), 'ws-a-write');
    const dirB = path.join(os.tmpdir(), 'ws-b-write');

    CorrectionCueLearner.get(dirA).updateWeight('from-a', 0.7);
    CorrectionCueLearner.get(dirB).updateWeight('from-b', 0.7);

    const written = vi.mocked(fs.writeFileSync).mock.calls.map(c => String(c[0]));
    expect(written.some(p => p.startsWith(dirA))).toBe(true);
    expect(written.some(p => p.startsWith(dirB))).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// CORR-08: Read-side validation (rc-1/rc-2) — the file is untrusted JSON
// ═══════════════════════════════════════════════════════════════════════════════

describe('CORR-08: store is validated on read, never blind-cast', () => {
  function readStore(json: string) {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(json);
    return loadCorrectionKeywordStore(tempDir());
  }

  it('drops unusable rows, keeps the rest, and repairs a missing addedAt', () => {
    const store = readStore(
      JSON.stringify({
        keywords: [
          { term: '又错了', weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z' },
          { term: 42, weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z' },
          { term: '瞎写', weight: 0.5, source: 'guess', addedAt: '2026-01-01T00:00:00Z' },
          { term: '漏了时间', weight: 0.5, source: 'llm' },
        ],
        version: 1,
        lastOptimizedAt: '2026-01-01T00:00:00Z',
      }),
    );
    expect(store.keywords.map((k) => k.term)).toEqual(['又错了', '漏了时间']);
    expect(store.keywords[1]?.addedAt).toBe('');
  });

  it('rejects an out-of-range weight, which would otherwise open the high-certainty path', () => {
    // weight drives precisionFor() for seed/user terms in host-runtime; a
    // corrupt 1e9 must not be trusted just because it is a finite number.
    for (const weight of [1e9, -5, '0.5', Number.NaN]) {
      const store = readStore(
        JSON.stringify({
          keywords: [{ term: '又错了', weight, source: 'seed', addedAt: '2026-01-01T00:00:00Z' }],
          version: 1,
          lastOptimizedAt: '2026-01-01T00:00:00Z',
        }),
      );
      expect(store.keywords).toHaveLength(0);
    }
  });

  it('rejects a tampered non-integer TP count instead of trusting it', () => {
    // host-runtime 用 TP>=3 把 llm 词升进 high 确定性路径，3.1 这类值必须出局。
    const store = readStore(
      JSON.stringify({
        keywords: [
          {
            term: '又错了', weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z',
            truePositiveCount: 3.1,
          },
        ],
        version: 1,
        lastOptimizedAt: '2026-01-01T00:00:00Z',
      }),
    );
    expect(store.keywords).toHaveLength(0);
  });

  it('falls back to the seed store when keywords is not an array', () => {
    const store = readStore(JSON.stringify({ keywords: {}, version: 1, lastOptimizedAt: 'x' }));
    expect(store.keywords).toHaveLength(CORRECTION_SEED_KEYWORDS.length);
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBeGreaterThan(0);
  });

  it('keeps the persisted version and lastOptimizedAt instead of inventing them', () => {
    const store = readStore(
      JSON.stringify({
        keywords: [
          { term: '又错了', weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z' },
        ],
        version: 7,
        lastOptimizedAt: '2026-05-01T00:00:00Z',
      }),
    );
    expect(store.version).toBe(7);
    expect(store.lastOptimizedAt).toBe('2026-05-01T00:00:00Z');
  });

  it('replaces an unparseable file with the seed store and says which stage failed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = readStore('{ "keywords": [ ');
    expect(store.keywords).toHaveLength(CORRECTION_SEED_KEYWORDS.length);
    expect(warn.mock.calls.map((c) => String(c[0])).join(' | ')).toContain('cannot parse');
    warn.mockRestore();
  });

  it('exposes the re-stamped optimization time through the instance', () => {
    const dir = tempDir();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const learner = CorrectionCueLearner.get(dir);
    expect(learner.getLastOptimizedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('round-trips a store written by this module', () => {
    const dir = tempDir();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const written = CorrectionCueLearner.get(dir);
    written.add({ term: '又来', weight: 0.5, source: 'llm' });

    const serialized = JSON.parse(String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1]));
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(serialized));
    _resetCorrectionCueCache();
    _resetCorrectionCueLearnerInstance();

    const reloaded = loadCorrectionKeywordStore(dir);
    expect(reloaded.keywords.map((k) => k.term)).toContain('又来');
    expect(reloaded.keywords).toHaveLength(serialized.keywords.length);
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
