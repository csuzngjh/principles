/**
 * Live Signal Keyword Store — Learn→Detect 反馈闭环的检测侧接线
 * (MVP_CORE_LOOP_CONTRACT INV-01 §3 / P0-B)。
 *
 * 审计背景 (ISSUE-003): 修复前检测用 buildDefaultKeywordStore() 硬编码 6 词,
 * 与 CorrectionCueLearner/KeywordOptimizationService 写入的
 * <stateDir>/correction_keywords.json 完全脱钩——optimizer 学到的词永不回流检测。
 *
 * 本模块把 learner store (canonical mutable correction cue source) 投影成
 * UnifiedKeywordStore,并在每次检测时按 mtime 检查刷新:
 *   - optimizer 写入 correction_keywords.json 后,无需重启 OpenClaw,
 *     下一次 detectSync 即消费新词 (cache invalidation via stat mtime)。
 *   - empathy cue 不在 learner store 中(learner 是 correction-only),
 *     以 seed overlay 保留,行为不变。
 *   - 3 个已证实的高精度纠正短语(不在 learner seed 集内)以 seed overlay
 *     保留,高精度 deterministic path 不回退。
 *   - learned 词 weight ≥ HIGH_PRECISION_LEARNED_WEIGHT → precision 'high'
 *     (可确定性触发 STRONG);FP 权重衰减(×0.8)是自然降级机制。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { UnifiedKeywordStore } from '@principles/core/runtime-v2';
import { CORRECTION_SEED_KEYWORDS } from '@principles/core/runtime-v2';
import { SystemLogger } from './system-logger.js';
import type { WorkspaceContext } from './workspace-context.js';

const KEYWORD_STORE_FILE = 'correction_keywords.json';

/** learned 词进入高精度 deterministic path 的权重阈值 */
export const HIGH_PRECISION_LEARNED_WEIGHT = 0.7;

/** 高精度纠正短语 overlay(已验证的确定性 STRONG 路径,不属于 learner seed 集) */
export const HIGH_PRECISION_CORRECTION_OVERLAY: ReadonlyArray<readonly [string, number]> = [
  ['这是错的', 0.9],
  ['不要自作主张', 0.9],
  ['不应该这么做', 0.9],
];

/** empathy seed overlay(检测行为不变) */
export const EMPATHY_SEED_OVERLAY: ReadonlyArray<readonly [string, number]> = [
  ['搞什么', 0.5],
];

interface LearnedKeywordShape {
  term: string;
  weight: number;
  source: string;
}

/** rc-1/rc-4: 逐元素校验未知数组,拒绝畸形条目 */
function isValidLearnedKeyword(v: unknown): v is LearnedKeywordShape {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Record<string, unknown>;
  if (typeof k.term !== 'string' || k.term.length === 0) return false;
  if (typeof k.weight !== 'number' || !Number.isFinite(k.weight)) return false;
  return k.source === 'seed' || k.source === 'llm' || k.source === 'user';
}

function mapLearnedSource(source: string): UnifiedKeywordStore['terms'][string]['source'] {
  if (source === 'llm') return 'llm_learned';
  if (source === 'user') return 'owner_promoted';
  return 'seed';
}

/**
 * 把 learner store JSON(unknown)投影为 correction terms。
 * 返回 null 表示文件内容不可用(missing/invalid),调用方走 seed-only。
 */
function projectLearnedStore(raw: unknown): { terms: UnifiedKeywordStore['terms']; learnedCount: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const keywords: unknown = (raw as Record<string, unknown>).keywords;
  if (!Array.isArray(keywords)) return null;

  const terms: UnifiedKeywordStore['terms'] = {};
  let learnedCount = 0;
  for (const kw of keywords) {
    if (!isValidLearnedKeyword(kw)) continue;
    const term = kw.term.trim().toLowerCase();
    if (!term || Object.hasOwn(terms, term)) continue;  // rc-5
    const weight = Math.max(0, Math.min(1, kw.weight));
    terms[term] = {
      term,
      category: 'correction',
      weight,
      precision: weight >= HIGH_PRECISION_LEARNED_WEIGHT ? 'high' : 'ambiguous',
      source: mapLearnedSource(kw.source),
    };
    if (kw.source === 'llm') learnedCount += 1;
  }
  return { terms, learnedCount };
}

function buildSeedOnlyStore(): UnifiedKeywordStore {
  const terms: UnifiedKeywordStore['terms'] = {};
  for (const [term, weight] of HIGH_PRECISION_CORRECTION_OVERLAY) {
    terms[term] = { term, category: 'correction', weight, precision: 'high', source: 'seed' };
  }
  for (const [term, weight] of EMPATHY_SEED_OVERLAY) {
    terms[term] = { term, category: 'empathy', weight, precision: 'ambiguous', source: 'seed' };
  }
  for (const kw of CORRECTION_SEED_KEYWORDS) {
    if (Object.hasOwn(terms, kw.term)) continue;
    terms[kw.term] = {
      term: kw.term,
      category: 'correction',
      weight: kw.weight,
      precision: kw.weight >= HIGH_PRECISION_LEARNED_WEIGHT ? 'high' : 'ambiguous',
      source: 'seed',
    };
  }
  return { version: 2, terms };
}

export interface LiveKeywordStore {
  /** 每次检测调用:mtime 未变返回缓存,变了重载并返回新快照 */
  resolve(): UnifiedKeywordStore;
  /** 当前快照的观测元数据(测试/诊断用) */
  stats(): { totalTerms: number; learnedTerms: number; lastReloadedAt: string | null };
}

export function createLiveSignalKeywordStore(wctx: WorkspaceContext, logger?: { debug?: (msg: string) => void }): LiveKeywordStore {
  // 路径边界守卫: store 文件必须位于 stateDir 直下且文件名为常量
  // (stateDir 来自插件内部 WorkspaceContext,仍按防御性边界校验)。
  const stateDirResolved = path.resolve(wctx.stateDir);
  const filePath = path.join(stateDirResolved, KEYWORD_STORE_FILE);
  if (!filePath.startsWith(stateDirResolved + path.sep) || path.basename(filePath) !== KEYWORD_STORE_FILE) {
    SystemLogger.log(wctx.workspaceDir, 'SIGNAL_KEYWORD_STORE_INVALID',
      `resolved store path escapes stateDir; refusing to load (path=${boundPreview(filePath)})`);
    const frozen: LiveKeywordStore = {
      resolve: () => buildSeedOnlyStore(),
      stats: () => ({ totalTerms: 0, learnedTerms: 0, lastReloadedAt: null }),
    };
    return frozen;
  }

  let cached: UnifiedKeywordStore | null = null;
  let cachedMtimeMs: number | null = null;
  let learnedCount = 0;
  let lastReloadedAt: string | null = null;

  const reload = (): void => {
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    } catch {
      // 文件缺失/损坏 → seed-only + 显式降级日志 (rc-9,不静默)
      SystemLogger.log(wctx.workspaceDir, 'SIGNAL_KEYWORD_STORE_INVALID',
        `cannot read ${KEYWORD_STORE_FILE}; using seed-only store (first run before observer writes is normal)`);
      cached = buildSeedOnlyStore();
      learnedCount = 0;
      lastReloadedAt = new Date().toISOString();
      return;
    }
    const projected = projectLearnedStore(raw);
    if (!projected) {
      SystemLogger.log(wctx.workspaceDir, 'SIGNAL_KEYWORD_STORE_INVALID',
        `${KEYWORD_STORE_FILE} malformed (keywords[] missing/invalid); using seed-only store`);
      cached = buildSeedOnlyStore();
      learnedCount = 0;
      lastReloadedAt = new Date().toISOString();
      return;
    }
    // overlays: 高精度短语 + empathy seed 不在 learner store 内,恒保留
    const store = buildSeedOnlyStore();
    for (const [term, entry] of Object.entries(projected.terms)) {
      store.terms[term] = entry;
    }
    cached = store;
    learnedCount = projected.learnedCount;
    lastReloadedAt = new Date().toISOString();
    SystemLogger.log(wctx.workspaceDir, 'SIGNAL_KEYWORD_STORE_RELOADED',
      `correction cue store reloaded: terms=${Object.keys(store.terms).length} learned=${learnedCount}`);
    logger?.debug?.(`[PD:Signal] keyword store reloaded: ${Object.keys(store.terms).length} terms (${learnedCount} learned)`);
  };

  return {
    resolve(): UnifiedKeywordStore {
      let mtimeMs: number | null = null;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      if (!cached || mtimeMs !== cachedMtimeMs) {
        reload();
        cachedMtimeMs = mtimeMs;
      }
      return cached ?? buildSeedOnlyStore();
    },
    stats() {
      return {
        totalTerms: cached ? Object.keys(cached.terms).length : 0,
        learnedTerms: learnedCount,
        lastReloadedAt,
      };
    },
  };
}

/** 有界预览(rc-8) */
function boundPreview(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}
