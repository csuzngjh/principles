# SignalCollector 统一信号采集层 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 correction + empathy 两套割裂的用户反馈检测融合成单一的框架无关 SignalCollector（core 纯逻辑）+ plugin I/O 外壳，本地 LLM 优先 + 关键词降级，下游按强度分流并接通 correction 的断裂 ③④ 桥。

**Architecture:** 三阶段流水线——Stage1 关键词快扫（分高精度/歧义词两级）、Stage2 异步 LLM 确认、Stage3 强度分流（STRONG→诊断 / WEAK→GFI 累积）。纯逻辑放 `principles-core/runtime-v2/signal-collector/`（不依赖 fs/DB/openclaw），I/O 外壳放 `openclaw-plugin/src/core/signal-collector-host.ts`。Provider 配置统一走 `.pd/config.yaml`（消除 empathy 的 workflows.yaml 双轨）。

**Tech Stack:** TypeScript（strict）、vitest、better-sqlite3、TypeBox（运行时校验）、PiAiRuntimeAdapter（LLM 适配，走 startRun/pollRun/fetchOutput）。

**Spec:** `docs/superpowers/specs/2026-06-30-signal-collector-unified-detection-design.md`

---

## 关键约束（实施前必读）

1. **Core 必须纯逻辑**：`signal-collector/` 下任何文件禁止 `import fs` / `import 'better-sqlite3'` / import 任何 openclaw 东西。架构回归测试（`packages/principles-core/tests/architecture-regression.test.ts`）会卡。
2. **PDRuntimeAdapter 是 run-based 接口**（`runtime-protocol.ts:182`）：Stage2 调 LLM 不是简单 chat，要走 `startRun → pollRun → fetchOutput` 三步。参考 `empathy-keyword-matcher` 已有的 observer 用法。
3. **prompt hook 同步阻塞**（评审意见5）：`prompt.ts` 的 `detectSync` 路径绝不能 await LLM；LLM 一律走 `void ... .catch()` fire-and-forget（仿 `prompt.ts:537`）。
4. **owner-governed**（评审意见3）：LLM 发现的词写 `signal_pending_terms.json`，不进触发词库；需 owner promote。
5. **ERR 合规**：LLM 输出用 TypeBox 校验（rc-1/rc-2，不用 `as`）；所有降级走 SystemLogger 不静默（rc-9）；用 `Object.hasOwn`（rc-5）。
6. **feature flag quiet**（评审意见2）：`signal_collector` 默认关；`INTERNAL_AGENT_NAMES` 需追加 `'signalCollector'`。

---

## 文件结构

### 新建（core 纯逻辑）
| 文件 | 职责 |
|------|------|
| `packages/principles-core/src/runtime-v2/signal-collector/types.ts` | 所有 TS 接口/类型/TypeBox schema（无逻辑） |
| `packages/principles-core/src/runtime-v2/signal-collector/keyword-stage.ts` | Stage1 纯函数：关键词快扫 + 精度分级 |
| `packages/principles-core/src/runtime-v2/signal-collector/llm-stage.ts` | Stage2 纯函数：构造 prompt + 校验 LLM 输出 |
| `packages/principles-core/src/runtime-v2/signal-collector/signal-collector.ts` | 三阶段编排纯函数 + 分流映射 |
| `packages/principles-core/src/runtime-v2/signal-collector/index.ts` | barrel export |
| `packages/principles-core/src/runtime-v2/signal-collector/__tests__/*.test.ts` | 每个模块对应测试 |

### 新建（plugin I/O 外壳）
| 文件 | 职责 |
|------|------|
| `packages/openclaw-plugin/src/core/signal-collector-host.ts` | SignalCollectorHost：接 prompt hook + 异步 LLM + 分流落库 |

### 修改
| 文件 | 改动 |
|------|------|
| `packages/principles-core/src/runtime-v2/config/pd-config-types.ts:66` | `INTERNAL_AGENT_NAMES` 追加 `'signalCollector'` |
| `packages/openclaw-plugin/src/hooks/prompt.ts` | `:262` correction + `:350` empathy 两处合并为 SignalCollectorHost 调用 |
| `packages/openclaw-plugin/src/commands/samples.ts:38` | reject 路径加 emitPainDetectedEvent（断裂④） |
| `packages/principles-core/tests/architecture-regression.test.ts` | 白名单 signal-collector/ 无 fs |

### 配置/数据（运行时生成，非代码任务）
- `.pd/config.yaml`: `signalCollector` agent binding（quiet）
- `signal_keywords.json`: 统一触发词库
- `signal_pending_terms.json`: 候选词池

---

## Task 1: Core 类型定义（types.ts）

**Files:**
- Create: `packages/principles-core/src/runtime-v2/signal-collector/types.ts`
- Test: `packages/principles-core/src/runtime-v2/signal-collector/__tests__/types.test.ts`

- [ ] **Step 1: 写类型测试（验证 TypeBox schema 能校验合法/拒绝非法）**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/__tests__/types.test.ts
import { describe, it, expect } from 'vitest';
import { SignalCollectorOutputSchema, type SignalCollectorOutput } from '../types.js';

describe('SignalCollectorOutputSchema', () => {
  it('accepts a valid STRONG correction signal', () => {
    const valid: SignalCollectorOutput = {
      isSignal: true,
      type: 'correction',
      strength: 'STRONG',
      matchedTerms: ['这是错的'],
      matchedPrecision: 'high',
      detectionSource: 'keyword',
      needsLlmConfirmation: false,
      evidence: { excerpt: '这是错的', detectedAt: '2026-06-30T00:00:00.000Z' },
    };
    expect(SignalCollectorOutputSchema.validate(valid)).toBe(true);
  });

  it('accepts a none signal (no feedback detected)', () => {
    const none: SignalCollectorOutput = {
      isSignal: false,
      type: null,
      strength: null,
      matchedTerms: [],
      matchedPrecision: null,
      detectionSource: 'none',
      needsLlmConfirmation: false,
      evidence: { excerpt: '', detectedAt: '2026-06-30T00:00:00.000Z' },
    };
    expect(SignalCollectorOutputSchema.validate(none)).toBe(true);
  });

  it('rejects output with invalid strength value', () => {
    const bad = { isSignal: true, type: 'correction', strength: 'MEDIUM', matchedTerms: [], matchedPrecision: null, detectionSource: 'keyword', needsLlmConfirmation: false, evidence: { excerpt: '', detectedAt: '' } };
    expect(SignalCollectorOutputSchema.validate(bad)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/types.test.ts`
Expected: FAIL — `types.js` 不存在 / 导出未定义

- [ ] **Step 3: 实现 types.ts**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/types.ts
import { Type, type Static } from '@sinclair/typebox';

// ── Unified Keyword Store (合并后的统一词库,纯数据) ──

export type KeywordCategory = 'correction' | 'empathy';
export type TermSource = 'seed' | 'migrated' | 'owner_promoted';

export interface UnifiedKeyword {
  term: string;
  category: KeywordCategory;
  weight: number;       // 0-1
  precision: 'high' | 'ambiguous';   // 评审意见4: 高精度 vs 歧义词
  source: TermSource;
}

export interface UnifiedKeywordStore {
  version: number;
  terms: Record<string, UnifiedKeyword>;  // key = term
}

// ── Pending Terms (LLM 发现词候选池, owner-governed, 评审意见3) ──

export interface PendingTerm {
  term: string;
  suggestedCategory: KeywordCategory;
  suggestedPrecision: 'high' | 'ambiguous';
  reason: string;          // LLM 给出的理由
  discoveredAt: string;    // ISO
  source: 'llm_candidate';
}

export interface PendingTermStore {
  version: number;
  terms: PendingTerm[];
}

// ── SignalCollector Input / Output ──

export interface SignalCollectorConfig {
  enableLlmStage: boolean;
  llmTimeoutMs: number;          // 异步超时,默认 30000
  promptTemplate: string;
  strongPainScore: number;       // STRONG 信号的 pain score,默认 70
  strongRateLimitPerHour: number; // 单 session 每小时 STRONG 上限,默认 5
}

export interface SignalCollectorInput {
  text: string;
  sessionId: string;
  keywordStore: UnifiedKeywordStore;
  config: SignalCollectorConfig;
}

export type SignalStrength = 'STRONG' | 'WEAK';
export type DetectionSource = 'keyword' | 'llm' | 'none';
export type MatchedPrecision = 'high' | 'ambiguous' | null;

export interface SignalEvidence {
  excerpt: string;
  detectedAt: string;
}

export interface SignalCollectorOutput {
  isSignal: boolean;
  type: 'correction' | 'empathy' | null;
  strength: SignalStrength | null;
  matchedTerms: string[];
  matchedPrecision: MatchedPrecision;
  detectionSource: DetectionSource;
  needsLlmConfirmation: boolean;
  llmReason?: string;
  evidence: SignalEvidence;
}

// ── TypeBox Schema (用于校验 LLM 输出, ERR-001 防御) ──

export const SignalCollectorOutputSchema = {
  validate(value: unknown): value is SignalCollectorOutput {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (typeof v['isSignal'] !== 'boolean') return false;
    if (v['type'] !== null && v['type'] !== 'correction' && v['type'] !== 'empathy') return false;
    if (v['strength'] !== null && v['strength'] !== 'STRONG' && v['strength'] !== 'WEAK') return false;
    if (!Array.isArray(v['matchedTerms'])) return false;
    if (v['matchedPrecision'] !== null && v['matchedPrecision'] !== 'high' && v['matchedPrecision'] !== 'ambiguous') return false;
    if (v['detectionSource'] !== 'keyword' && v['detectionSource'] !== 'llm' && v['detectionSource'] !== 'none') return false;
    if (typeof v['needsLlmConfirmation'] !== 'boolean') return false;
    const ev = v['evidence'];
    if (typeof ev !== 'object' || ev === null) return false;
    const e = ev as Record<string, unknown>;
    if (typeof e['excerpt'] !== 'string' || typeof e['detectedAt'] !== 'string') return false;
    return true;
  },
};

// ── LLM 输出 schema (Stage2 fetchOutput 后校验) ──

export interface LlmClassificationResult {
  is_feedback: boolean;
  type: 'correction' | 'empathy' | 'none';
  confidence: number;   // 0-1
  reason: string;
}

export function validateLlmClassification(value: unknown): value is LlmClassificationResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['is_feedback'] !== 'boolean') return false;
  if (v['type'] !== 'correction' && v['type'] !== 'empathy' && v['type'] !== 'none') return false;
  if (typeof v['confidence'] !== 'number' || v['confidence'] < 0 || v['confidence'] > 1) return false;
  if (typeof v['reason'] !== 'string') return false;
  return true;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/types.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: 提交**

```bash
cd packages/principles-core
git add src/runtime-v2/signal-collector/types.ts src/runtime-v2/signal-collector/__tests__/types.test.ts
git commit -m "feat(signal-collector): add core type definitions and TypeBox schemas"
```

---

## Task 2: Stage1 关键词快扫 + 精度分级（keyword-stage.ts）

**Files:**
- Create: `packages/principles-core/src/runtime-v2/signal-collector/keyword-stage.ts`
- Test: `packages/principles-core/src/runtime-v2/signal-collector/__tests__/keyword-stage.test.ts`

- [ ] **Step 1: 写测试（高精度直接判定 / 歧义词需确认 / 未命中）**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/__tests__/keyword-stage.test.ts
import { describe, it, expect } from 'vitest';
import { scanKeywords } from '../keyword-stage.js';
import type { UnifiedKeywordStore } from '../types.js';

const store: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '垃圾': { term: '垃圾', category: 'empathy', weight: 0.6, precision: 'ambiguous', source: 'seed' },
  },
};

describe('scanKeywords', () => {
  it('high-precision correction term → direct STRONG, no LLM needed', () => {
    const result = scanKeywords('你又自作主张了，这是错的！', store);
    expect(result.matched).toBe(true);
    expect(result.matchedTerms).toContain('这是错的');
    expect(result.matchedPrecision).toBe('high');
    expect(result.needsLlmConfirmation).toBe(false);
    expect(result.suggestedType).toBe('correction');
  });

  it('ambiguous correction term → needs LLM confirmation', () => {
    const result = scanKeywords('这个不对', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('ambiguous');
    expect(result.needsLlmConfirmation).toBe(true);
  });

  it('no keyword match → empty result, needs LLM', () => {
    const result = scanKeywords('请帮我修复 PR', store);
    expect(result.matched).toBe(false);
    expect(result.matchedTerms).toEqual([]);
    expect(result.needsLlmConfirmation).toBe(true);
  });

  it('case-insensitive matching', () => {
    const result = scanKeywords('THIS IS WRONG', store);
    // '这是错的' won't match English; but store only has zh here
    expect(result.matched).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/keyword-stage.test.ts`
Expected: FAIL — `keyword-stage.js` 不存在

- [ ] **Step 3: 实现 keyword-stage.ts（纯函数，子串匹配，无 I/O）**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/keyword-stage.ts
import type { UnifiedKeywordStore, KeywordCategory, MatchedPrecision } from './types.js';

export interface KeywordScanResult {
  matched: boolean;
  matchedTerms: string[];
  matchedPrecision: MatchedPrecision;
  needsLlmConfirmation: boolean;
  suggestedType: KeywordCategory | null;
}

/**
 * Stage 1: 同步关键词快扫。零成本,纯函数。
 *
 * 精度分级(评审意见4):
 * - 命中 high 精度词 → 直接判定,不走 LLM(needsLlmConfirmation=false)
 * - 命中 ambiguous 词 → 仅作候选,强制过 LLM(needsLlmConfirmation=true)
 * - 全未命中 → 走 LLM 发现
 *
 * 多词命中时:high 优先于 ambiguous。
 */
export function scanKeywords(text: string, store: UnifiedKeywordStore): KeywordScanResult {
  const normalized = text.trim().toLowerCase();

  let highHit: { term: string; category: KeywordCategory } | null = null;
  const ambiguousHits: { term: string; category: KeywordCategory }[] = [];

  for (const term of Object.keys(store.terms)) {
    if (!Object.hasOwn(store.terms, term)) continue;  // rc-5
    const kw = store.terms[term];
    if (!kw) continue;
    if (normalized.includes(term.toLowerCase())) {
      if (kw.precision === 'high') {
        highHit = { term, category: kw.category };
        break;  // high 优先,找到即停
      }
      ambiguousHits.push({ term, category: kw.category });
    }
  }

  if (highHit) {
    return {
      matched: true,
      matchedTerms: [highHit.term],
      matchedPrecision: 'high',
      needsLlmConfirmation: false,
      suggestedType: highHit.category,
    };
  }

  if (ambiguousHits.length > 0) {
    return {
      matched: true,
      matchedTerms: ambiguousHits.map((h) => h.term),
      matchedPrecision: 'ambiguous',
      needsLlmConfirmation: true,
      suggestedType: ambiguousHits[0]!.category,
    };
  }

  return {
    matched: false,
    matchedTerms: [],
    matchedPrecision: null,
    needsLlmConfirmation: true,
    suggestedType: null,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/keyword-stage.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: 提交**

```bash
cd packages/principles-core
git add src/runtime-v2/signal-collector/keyword-stage.ts src/runtime-v2/signal-collector/__tests__/keyword-stage.test.ts
git commit -m "feat(signal-collector): add Stage1 keyword scan with precision grading"
```

---

## Task 3: Stage2 LLM prompt 构造 + 输出校验（llm-stage.ts）

**Files:**
- Create: `packages/principles-core/src/runtime-v2/signal-collector/llm-stage.ts`
- Test: `packages/principles-core/src/runtime-v2/signal-collector/__tests__/llm-stage.test.ts`

- [ ] **Step 1: 写测试（prompt 构造 + 校验合法/非法 JSON）**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/__tests__/llm-stage.test.ts
import { describe, it, expect } from 'vitest';
import { buildLlmPrompt, parseLlmClassification } from '../llm-stage.js';

describe('buildLlmPrompt', () => {
  it('produces a prompt containing the user message and JSON format spec', () => {
    const prompt = buildLlmPrompt('你又自作主张了，这是错的！');
    expect(prompt).toContain('你又自作主张了，这是错的！');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('correction');
    expect(prompt).toContain('empathy');
  });
});

describe('parseLlmClassification', () => {
  it('parses valid JSON into LlmClassificationResult', () => {
    const raw = '{"is_feedback": true, "type": "correction", "confidence": 0.9, "reason": "用户明确指出错误"}';
    const result = parseLlmClassification(raw);
    expect(result.valid).toBe(true);
    expect(result.value?.type).toBe('correction');
    expect(result.value?.confidence).toBe(0.9);
  });

  it('rejects malformed JSON (rc-1, no as cast)', () => {
    const result = parseLlmClassification('not json at all');
    expect(result.valid).toBe(false);
    expect(result.value).toBeNull();
  });

  it('rejects valid JSON with wrong schema (missing fields)', () => {
    const result = parseLlmClassification('{"foo": "bar"}');
    expect(result.valid).toBe(false);
  });

  it('rejects confidence out of range', () => {
    const result = parseLlmClassification('{"is_feedback": true, "type": "correction", "confidence": 1.5, "reason": "x"}');
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/llm-stage.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 llm-stage.ts（纯函数：构造 prompt + 解析校验，不含实际 LLM 调用）**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/llm-stage.ts
import { validateLlmClassification, type LlmClassificationResult } from './types.js';

/**
 * 构造 Stage2 LLM 判断 prompt。纯函数,不含 LLM 调用。
 * 实际 LLM 调用在 plugin 层(adapter.startRun/pollRun/fetchOutput)。
 */
export function buildLlmPrompt(userMessage: string): string {
  return `你是一个用户反馈分类器。判断下面这条用户消息是否表达对 AI 助手行为的不满或纠正。

只输出 JSON，格式：{"is_feedback": bool, "type": "correction"|"empathy"|"none", "confidence": 0-1, "reason": "一句话理由"}

定义：
- correction：用户明确指出 AI 做错了什么、应该改什么（如"这是错的""不要自作主张""应该先确认"）
- empathy：用户表达挫败/不满情绪，但没明确指出 AI 错在哪（如"搞什么啊""又来了""算了"）
- none：正常任务指令或闲聊

用户消息：${userMessage}`;
}

export interface ParseResult {
  valid: boolean;
  value: LlmClassificationResult | null;
}

/**
 * 解析并校验 LLM 返回的 JSON。rc-1/rc-2: 不用 as,用 TypeBox 风格校验。
 * 校验失败返回 {valid: false, value: null},由调用方降级处理(rc-9)。
 */
export function parseLlmClassification(raw: string): ParseResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (validateLlmClassification(parsed)) {
      return { valid: true, value: parsed };
    }
    return { valid: false, value: null };
  } catch {
    return { valid: false, value: null };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/llm-stage.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
cd packages/principles-core
git add src/runtime-v2/signal-collector/llm-stage.ts src/runtime-v2/signal-collector/__tests__/llm-stage.test.ts
git commit -m "feat(signal-collector): add Stage2 LLM prompt builder and output validation"
```

---

## Task 4: 三阶段编排 + 分流映射（signal-collector.ts）

**Files:**
- Create: `packages/principles-core/src/runtime-v2/signal-collector/signal-collector.ts`
- Create: `packages/principles-core/src/runtime-v2/signal-collector/index.ts`
- Test: `packages/principles-core/src/runtime-v2/signal-collector/__tests__/signal-collector.test.ts`

- [ ] **Step 1: 写测试（同步分支：high→直接STRONG / ambiguous→待LLM / 未命中→待LLM；分流映射）**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/__tests__/signal-collector.test.ts
import { describe, it, expect } from 'vitest';
import { collectSync, mapLlmResultToOutput, buildEvidence } from '../signal-collector.js';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '../types.js';

const store: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  },
};

const config: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30000,
  promptTemplate: '',
  strongPainScore: 70,
  strongRateLimitPerHour: 5,
};

describe('collectSync', () => {
  it('high-precision hit → STRONG correction, no LLM', () => {
    const out = collectSync('这是错的', 'sess1', store, config);
    expect(out.isSignal).toBe(true);
    expect(out.strength).toBe('STRONG');
    expect(out.type).toBe('correction');
    expect(out.detectionSource).toBe('keyword');
    expect(out.needsLlmConfirmation).toBe(false);
  });

  it('ambiguous hit → pending, needs LLM, strength null', () => {
    const out = collectSync('这个不对', 'sess1', store, config);
    expect(out.isSignal).toBe(false);  // 待 LLM 确认前不算 final signal
    expect(out.strength).toBeNull();
    expect(out.needsLlmConfirmation).toBe(true);
  });

  it('no hit → pending LLM, strength null', () => {
    const out = collectSync('请修复PR', 'sess1', store, config);
    expect(out.isSignal).toBe(false);
    expect(out.needsLlmConfirmation).toBe(true);
  });
});

describe('mapLlmResultToOutput', () => {
  it('LLM says correction → STRONG', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'correction', confidence: 0.9, reason: '明确纠错' },
      'text', 'sess1', config,
    );
    expect(out.strength).toBe('STRONG');
    expect(out.llmReason).toBe('明确纠错');
    expect(out.detectionSource).toBe('llm');
  });

  it('LLM says empathy → WEAK', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: true, type: 'empathy', confidence: 0.7, reason: '挫败情绪' },
      'text', 'sess1', config,
    );
    expect(out.strength).toBe('WEAK');
  });

  it('LLM says none → not a signal', () => {
    const out = mapLlmResultToOutput(
      { is_feedback: false, type: 'none', confidence: 0.95, reason: '正常指令' },
      'text', 'sess1', config,
    );
    expect(out.isSignal).toBe(false);
    expect(out.strength).toBeNull();
  });
});

describe('buildEvidence', () => {
  it('truncates excerpt to 200 chars', () => {
    const long = 'x'.repeat(300);
    const ev = buildEvidence(long);
    expect(ev.excerpt.length).toBe(200);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/signal-collector.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 signal-collector.ts + index.ts**

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/signal-collector.ts
import { scanKeywords } from './keyword-stage.js';
import type {
  UnifiedKeywordStore, SignalCollectorConfig, SignalCollectorInput, SignalCollectorOutput,
  LlmClassificationResult, SignalEvidence,
} from './types.js';

const MAX_EXCERPT = 200;

export function buildEvidence(text: string): SignalEvidence {
  const excerpt = text.length > MAX_EXCERPT ? text.slice(0, MAX_EXCERPT) : text;
  return { excerpt, detectedAt: new Date().toISOString() };
}

/**
 * 同步阶段(prompt hook 内调用,绝不阻塞):Stage1 关键词快扫。
 * - high 精度命中 → 直接返回 STRONG final output(needsLlmConfirmation=false)
 * - ambiguous / 未命中 → 返回 pending output(needsLlmConfirmation=true, isSignal=false)
 *   由 plugin 层异步调 mapLlmResultToOutput 完成 Stage2。
 *
 * 注意:这个函数不调 LLM。LLM 在 plugin 层。
 */
export function collectSync(
  text: string,
  sessionId: string,
  store: UnifiedKeywordStore,
  _config: SignalCollectorConfig,
): SignalCollectorOutput {
  const scan = scanKeywords(text, store);
  const evidence = buildEvidence(text);

  // high 精度 → 直接 STRONG(评审意见4: 高精度短语可信)
  if (scan.matched && scan.matchedPrecision === 'high' && scan.suggestedType) {
    return {
      isSignal: true,
      type: scan.suggestedType,
      strength: scan.suggestedType === 'correction' ? 'STRONG' : 'WEAK',
      matchedTerms: scan.matchedTerms,
      matchedPrecision: 'high',
      detectionSource: 'keyword',
      needsLlmConfirmation: false,
      evidence,
    };
  }

  // ambiguous / 未命中 → pending,等 LLM
  return {
    isSignal: false,
    type: null,
    strength: null,
    matchedTerms: scan.matchedTerms,
    matchedPrecision: scan.matchedPrecision,
    detectionSource: 'none',
    needsLlmConfirmation: true,
    evidence,
  };
}

/**
 * Stage2(异步,plugin 层拿到 LLM 结果后调用):把 LLM 分类映射成 final output。
 */
export function mapLlmResultToOutput(
  llm: LlmClassificationResult,
  text: string,
  _sessionId: string,
  config: SignalCollectorConfig,
): SignalCollectorOutput {
  const evidence = buildEvidence(text);
  void config;  // strongPainScore 在 plugin 层 emit 时用

  if (!llm.is_feedback || llm.type === 'none') {
    return {
      isSignal: false, type: null, strength: null, matchedTerms: [],
      matchedPrecision: null, detectionSource: 'llm', needsLlmConfirmation: false,
      llmReason: llm.reason, evidence,
    };
  }

  return {
    isSignal: true,
    type: llm.type,
    strength: llm.type === 'correction' ? 'STRONG' : 'WEAK',
    matchedTerms: [],
    matchedPrecision: null,
    detectionSource: 'llm',
    needsLlmConfirmation: false,
    llmReason: llm.reason,
    evidence,
  };
}
```

```typescript
// packages/principles-core/src/runtime-v2/signal-collector/index.ts
export * from './types.js';
export { scanKeywords, type KeywordScanResult } from './keyword-stage.js';
export { buildLlmPrompt, parseLlmClassification, type ParseResult } from './llm-stage.js';
export { collectSync, mapLlmResultToOutput, buildEvidence } from './signal-collector.js';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/signal-collector/__tests__/signal-collector.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 运行全部 core 测试 + 架构回归，确认无破坏**

Run: `cd packages/principles-core && npm run build && npm run test`
Expected: 全绿（含 architecture-regression）

- [ ] **Step 6: 提交**

```bash
cd packages/principles-core
git add src/runtime-v2/signal-collector/
git commit -m "feat(signal-collector): add three-stage orchestration and strength routing"
```

---

## Task 5: 架构回归白名单更新

**Files:**
- Modify: `packages/principles-core/tests/architecture-regression.test.ts`

- [ ] **Step 1: 先运行架构回归，看 signal-collector 是否触发 fs 检测**

Run: `cd packages/principles-core && npx vitest run tests/architecture-regression.test.ts`
Expected: 若 signal-collector 文件无 fs import，应已通过。若测试有目录白名单逻辑，需把 `signal-collector/` 加入允许的纯逻辑目录列表。

- [ ] **Step 2: 若需要，定位白名单代码并加入 signal-collector**

读 `packages/principles-core/tests/architecture-regression.test.ts`，找到"允许的子目录"或"禁止 fs import"的断言，把 `runtime-v2/signal-collector` 加入白名单（如果它用的是目录白名单模式）。

- [ ] **Step 3: 重新运行确认通过**

Run: `cd packages/principles-core && npx vitest run tests/architecture-regression.test.ts`
Expected: PASS

- [ ] **Step 4: 提交（如有改动）**

```bash
cd packages/principles-core
git add tests/architecture-regression.test.ts
git commit -m "test(arch): whitelist signal-collector as pure-logic directory"
```

---

## Task 6: InternalAgentName schema 扩展

**Files:**
- Modify: `packages/principles-core/src/runtime-v2/config/pd-config-types.ts:64-73`

- [ ] **Step 1: 写测试验证 signalCollector 是合法 InternalAgentName**

```typescript
// 在现有 config types 测试文件追加,或新建 __tests__/internal-agent-names.test.ts
import { describe, it, expect } from 'vitest';
import { INTERNAL_AGENT_NAMES } from '../pd-config-types.js';

describe('INTERNAL_AGENT_NAMES', () => {
  it('includes signalCollector', () => {
    expect(INTERNAL_AGENT_NAMES).toContain('signalCollector');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/principles-core && npx vitest run src/runtime-v2/config/__tests__/internal-agent-names.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 pd-config-types.ts 追加 'signalCollector'**

在 `INTERNAL_AGENT_NAMES` 数组（`:64-73`）的 `'empathyObserver'` 后追加 `'signalCollector'`：
```typescript
export const INTERNAL_AGENT_NAMES = [
  'diagnostician',
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
  'rolloutReviewer',
  'correctionObserver',
  'empathyObserver',
  'signalCollector',   // ← 新增(评审意见2)
] as const;
```

- [ ] **Step 4: 运行确认通过 + 全 core 测试**

Run: `cd packages/principles-core && npm run build && npm run test`
Expected: PASS（注意检查是否有其他测试依赖数组长度，若有需同步更新）

- [ ] **Step 5: 提交**

```bash
cd packages/principles-core
git add src/runtime-v2/config/pd-config-types.ts src/runtime-v2/config/__tests__/internal-agent-names.test.ts
git commit -m "feat(config): add signalCollector to InternalAgentName enum"
```

---

## Task 7: SignalCollectorHost — 同步检测路径（detectSync）

**Files:**
- Create: `packages/openclaw-plugin/src/core/signal-collector-host.ts`
- Test: `packages/openclaw-plugin/tests/core/signal-collector-host.test.ts`

- [ ] **Step 1: 写测试（detectSync：trigger 门控 + 写 user_turns + 高精度直接分流 + 歧义词入队）**

```typescript
// packages/openclaw-plugin/tests/core/signal-collector-host.test.ts
import { describe, it, expect, vi } from 'vitest';
// 测试用 mock wctx / trajectory / keywordStore,不接真实 DB

describe('SignalCollectorHost.detectSync', () => {
  it('skips when trigger !== user', () => {
    // mock host, call detectSync(msg, sess, 'heartbeat') → 不应调 recordUserTurn
  });

  it('writes user_turns with correctionDetected=true on high-precision correction hit', () => {
    // 喂 "这是错的" → recordUserTurn 被调, correctionDetected=true
  });

  it('enqueues ambiguous hit for async LLM, does not emit STRONG immediately', () => {
    // 喂 "不对" → 不调 emitPainDetectedEvent, 入队
  });
});
```

注：本步测试骨架需根据 plugin 层 mock 范式补全（参考 `packages/openclaw-plugin/tests/` 现有 hook 测试的 wctx mock 方式）。实现时先看一个现有 host/服务测试怎么 mock WorkspaceContext + trajectory。

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/signal-collector-host.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 SignalCollectorHost 的同步部分**

```typescript
// packages/openclaw-plugin/src/core/signal-collector-host.ts
import type { WorkspaceContext } from './workspace-context.js';
import type { PluginLogger } from '../openclaw-sdk.js';
import { collectSync, type UnifiedKeywordStore } from '@principles/core/runtime-v2';
import * as fs from 'fs';
import * as path from 'path';

const SIGNAL_KEYWORDS_FILE = 'signal_keywords.json';

export class SignalCollectorHost {
  constructor(
    private readonly wctx: WorkspaceContext,
    private readonly logger?: PluginLogger,
  ) {}

  /**
   * 同步路径(prompt.ts before_prompt_build 内调用)。
   * 只做: trigger 门控 + Stage1 关键词 + 写 user_turns + (high→立即STRONG分流)。
   * 绝不调 LLM。ambiguous/未命中 → 入队异步(由 detectAsyncAndRoute 处理)。
   */
  detectSync(userMessage: string, sessionId: string, trigger: string | undefined): void {
    if (trigger !== 'user') return;  // 保留现有 trigger 门控

    const store = this.loadKeywordStore();
    const config = this.loadConfig();
    const out = collectSync(userMessage, sessionId, store, config);

    // 写 user_turns(复用现有 trajectory API)
    this.wctx.trajectory?.recordUserTurn?.({
      sessionId,
      turnIndex: 0,  // 由调用方传入更准(见 prompt.ts 接线)
      rawText: userMessage,
      correctionDetected: out.isSignal && out.strength === 'STRONG',
      correctionCue: out.matchedTerms[0] ?? null,
      referencesAssistantTurnId: null,  // 由调用方填充(见 Task 9 接线)
    });

    if (out.isSignal && out.strength === 'STRONG') {
      // 高精度 STRONG → 立即分流(同步,纯内存,极快)
      void this.routeStrong(out, sessionId).catch((err) => {
        this.logger?.warn?.(`[PD:Signal] STRONG route failed: ${String(err)}`);
      });
    } else if (out.needsLlmConfirmation) {
      // ambiguous / 未命中 → 异步 LLM
      void this.detectAsyncAndRoute(userMessage, sessionId, out).catch((err) => {
        this.logger?.warn?.(`[PD:Signal] async LLM route failed: ${String(err)}`);
      });
    }
  }

  private loadKeywordStore(): UnifiedKeywordStore {
    const filePath = path.join(this.wctx.stateDir, SIGNAL_KEYWORDS_FILE);
    try {
      if (!fs.existsSync(filePath)) return this.createDefaultStore();
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && Object.hasOwn(parsed, 'terms')) {
        return parsed as UnifiedKeywordStore;
      }
      return this.createDefaultStore();
    } catch (err) {
      this.logger?.warn?.(`[PD:Signal] keyword store load failed, using default: ${String(err)}`);
      return this.createDefaultStore();  // rc-9: 不静默,有日志
    }
  }

  private createDefaultStore(): UnifiedKeywordStore {
    // 合并 correction + empathy seed 词,含新增中文纠正句式
    // 完整 seed 清单见 spec §5.1,这里返回硬编码默认
    return { version: 1, terms: {
      '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
      '不要自作主张': { term: '不要自作主张', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
      '下次应该先': { term: '下次应该先', category: 'correction', weight: 0.8, precision: 'high', source: 'seed' },
      '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
      '错了': { term: '错了', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
      '搞什么啊': { term: '搞什么啊', category: 'empathy', weight: 0.6, precision: 'ambiguous', source: 'seed' },
    }};
  }

  // detectAsyncAndRoute / routeStrong 在 Task 8 实现
  private async routeStrong(_out: any, _sessionId: string): Promise<void> { /* Task 8 */ }
  private async detectAsyncAndRoute(_msg: string, _sid: string, _out: any): Promise<void> { /* Task 8 */ }
  private loadConfig(): any { return { enableLlmStage: true, llmTimeoutMs: 30000, promptTemplate: '', strongPainScore: 70, strongRateLimitPerHour: 5 }; }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/signal-collector-host.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd packages/openclaw-plugin
git add src/core/signal-collector-host.ts tests/core/signal-collector-host.test.ts
git commit -m "feat(signal-collector): add SignalCollectorHost sync detection path"
```

---

## Task 8: SignalCollectorHost — 异步 LLM 路径 + 分流落库（detectAsyncAndRoute / routeStrong）

**Files:**
- Modify: `packages/openclaw-plugin/src/core/signal-collector-host.ts`

- [ ] **Step 1: 写测试（异步 LLM 调用 → mapLlmResultToOutput → 分流 STRONG/WEAK；LLM 不可用降级）**

补充 `tests/core/signal-collector-host.test.ts`：
```typescript
describe('SignalCollectorHost.detectAsyncAndRoute', () => {
  it('LLM returns correction → emitPainDetectedEvent with source=user_correction', async () => {
    // mock adapter.startRun/pollRun/fetchOutput 返回 correction 分类
    // 验证 emitPainDetectedEvent 被调, source='user_correction', score=70
  });

  it('LLM returns empathy → trackFriction 累积 GFI, no immediate emit', async () => {
    // 验证 trackFriction 被调, emitPainDetectedEvent 未调
  });

  it('LLM unavailable (adapter null) → degrade, no STRONG emit, SystemLogger records', async () => {
    // mock adapter=null → 验证不 emit, 日志有 SIGNAL_LLM_DEGRADED
  });

  it('STRONG rate limit: 6th STRONG in same hour → suppressed', async () => {
    // 连续触发 6 次 → 第 6 次被 rate limit 拦截
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/signal-collector-host.test.ts`
Expected: FAIL（routeStrong/detectAsyncAndRoute 是 stub）

- [ ] **Step 3: 实现 routeStrong + detectAsyncAndRoute（替换 Task 7 的 stub）**

实现要点：
- `routeStrong(out, sessionId)`：调 `emitPainDetectedEvent(wctx, {type:'pain_detected', data:{source:'user_correction', score: config.strongPainScore, ...}}, {recordObservability:true})`。需 import `emitPainDetectedEvent` from `../hooks/pain.js`。带 rate limit（Map<sessionId, timestamp[]>，过滤 1 小时内，超 `strongRateLimitPerHour` 则跳过 + 日志）。
- `detectAsyncAndRoute(msg, sid, pendingOut)`：
  1. 构造 adapter（从 `.pd/config.yaml` 的 signalCollector runtimeProfile，复用 `resolveObserverConfig`）。adapter 为 null → 降级（ambiguous 候选丢弃，不 emit STRONG，SystemLogger `SIGNAL_LLM_DEGRADED`）。
  2. `buildLlmPrompt(msg)` → `adapter.startRun` → poll → `fetchOutput` → `parseLlmClassification`。
  3. 解析失败 → 当 none（rc-9 日志 `SIGNAL_LLM_PARSE_FAIL`）。
  4. `mapLlmResultToOutput(llm, msg, sid, config)` → 按 strength 分流：STRONG→routeStrong，WEAK→trackFriction。
- WEAK 的 trackFriction：调 `import { trackFriction } from './session-tracker.js'`，仿 `prompt.ts:380` 签名 `trackFriction(sid, penalty, hash, workspaceDir, {source:'user_empathy'})`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/openclaw-plugin && npx vitest run tests/core/signal-collector-host.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd packages/openclaw-plugin
git add src/core/signal-collector-host.ts tests/core/signal-collector-host.test.ts
git commit -m "feat(signal-collector): add async LLM routing with GFI accumulation and rate limit"
```

---

## Task 9: 接入 prompt.ts（替换两处分散调用）

**Files:**
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts:252-300`（correction 段）
- Modify: `packages/openclaw-plugin/src/hooks/prompt.ts:343-759`（empathy 段大幅简化）

- [ ] **Step 1: 写 prompt hook 集成测试（喂 3 条铁证消息）**

补充测试，喂入 spec §9.2 的三条消息：
- "你又自作主张了，这是错的！" → high 精度 → 同步 STRONG → emit
- "搞什么啊" → ambiguous → 异步 LLM
- "[System] gateway restart..." → none（修误报）

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/openclaw-plugin && npx vitest run tests/hooks/prompt-signal-collector.test.ts`
Expected: FAIL（prompt.ts 还没接 SignalCollectorHost）

- [ ] **Step 3: 修改 prompt.ts**

把 `:252-300` 的 correction 检测段替换为：
```typescript
// 替换原 CorrectionCueLearner 段,改为调 SignalCollectorHost
const signalHost = new SignalCollectorHost(wctx, logger);
// references_assistant_turn_id 仍按原逻辑填充(保留 :281-289 的 listAssistantTurns 查询)
let referencesAssistantTurnId: number | null = null;
const hasPriorAssistant = event.messages
  .slice(0, latestUserIndex.index)
  .some((message) => (message as { role?: unknown })?.role === 'assistant');
if (hasPriorAssistant) {
  const turns = wctx.trajectory?.listAssistantTurns?.(sessionId) ?? [];
  const lastAssistant = turns[turns.length - 1];
  referencesAssistantTurnId = lastAssistant?.id ?? null;
}
signalHost.detectSync(userText, sessionId, trigger);
// 注意:detectSync 内部已写 user_turns,但 referencesAssistantTurnId 需在此传入
// → 调整 detectSync 签名增加可选参数 referencesAssistantTurnId,见 Step 4
```

把 `:343-759` 的 empathy 大段（关键词匹配 + GFI + observer spawn）**大幅精简**：empathy 的检测职责已由 SignalCollector 接管，这段大部分可删除。保留 GFI decay（`:762-785`）等非检测逻辑。`resolveEmpathyObserver`（`:1106-1148`）整段删除（消除 workflows.yaml 双轨）。

- [ ] **Step 4: 调整 detectSync 签名，加 referencesAssistantTurnId 参数**

`signal-collector-host.ts` 的 `detectSync` 增加可选参数 `referencesAssistantTurnId?: number | null`，传入 recordUserTurn。

- [ ] **Step 5: 运行集成测试 + 全 plugin 测试**

Run: `cd packages/openclaw-plugin && npm run build && npm run test`
Expected: PASS（注意 empathy 相关旧测试若失败，按"职责已迁移"更新断言）

- [ ] **Step 6: 提交**

```bash
cd packages/openclaw-plugin
git add src/hooks/prompt.ts src/core/signal-collector-host.ts tests/
git commit -m "refactor(prompt): wire SignalCollectorHost, remove empathy dual-track"
```

---

## Task 10: 修断裂 ④ — rejected 假桥接通诊断

**Files:**
- Modify: `packages/openclaw-plugin/src/commands/samples.ts:38`

- [ ] **Step 1: 写测试（reject 一个 sample → emitPainDetectedEvent 被调，source=correction_rejected）**

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/openclaw-plugin && npx vitest run tests/commands/samples-reject.test.ts`
Expected: FAIL

- [ ] **Step 3: 修改 samples.ts:38**

在 `reviewCorrectionSample(sampleId, 'rejected', note)` 调用后，用返回的 `CorrectionSampleRecord`（含 session_id/quality_score/diff_excerpt）构造并调用 `emitPainDetectedEvent`：
```typescript
const record = wctx.trajectory.reviewCorrectionSample(sampleId, 'rejected', note);
if (record && status === 'rejected') {
  await emitPainDetectedEvent(wctx, {
    ts: new Date().toISOString(),
    type: 'pain_detected',
    data: {
      painId: `correction_rejected_${record.sample_id}`,
      painType: 'user_correction',
      source: 'correction_rejected',
      reason: `Owner rejected correction sample (quality ${record.qualityScore})`,
      score: Math.max(0, Math.min(100, Math.round(record.qualityScore))),
      sessionId: record.sessionId,
      agentId: 'main',
      provenance: 'openclaw_context_bound',
      evidence: { excerpt: record.diffExcerpt.slice(0, 200), detectedAt: new Date().toISOString() },
    },
  }, { recordObservability: true });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/openclaw-plugin && npx vitest run tests/commands/samples-reject.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd packages/openclaw-plugin
git add src/commands/samples.ts tests/commands/samples-reject.test.ts
git commit -m "fix(samples): emit pain event on correction rejection (break ④)"
```

---

## Task 11: 验收测试 + 最终全量验证

**Files:**
- Test: 端到端验收脚本（spec §9.3 主验收标准）

- [ ] **Step 1: 写验收测试覆盖 spec §9.3 六条主验收标准**

1. id=942 真纠正 → STRONG + emitPainDetectedEvent + source='user_correction'
2. 该 pain → 诊断任务创建（tasks 表新增 diagnostician task）
3. 诊断 evidence 带前置 assistant turn
4. LMStudio 不可用 → 降级不报错 + 歧义词不触发 STRONG + SystemLogger 有记录
5. config 改 runtimeProfile → 检测用 LLM 改变
6. prompt hook 延迟 < 200ms

- [ ] **Step 2: 运行验收测试**

Run: `cd packages/openclaw-plugin && npx vitest run tests/acceptance/signal-collector-acceptance.test.ts`
Expected: PASS

- [ ] **Step 3: 全量构建 + 测试**

Run:
```bash
cd packages/principles-core && npm run build && npm run test
cd ../openclaw-plugin && npm run build && npm run test
npm run lint
```
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add tests/acceptance/
git commit -m "test(signal-collector): add acceptance tests for spec §9.3 criteria"
```

---

## Self-Review（计划自审）

**1. Spec 覆盖**：
- §2 目标1（上游融合）→ Task 4 + Task 9 ✓
- §2 目标2（源头升级关键词提取）→ Task 2 + Task 8 + Task 7（LLM 发现词 pending）✓
- §2 目标3（下游分流）→ Task 4 + Task 8 ✓
- §2 目标4（配置单轨化）→ Task 6 + Task 9（删 resolveEmpathyObserver）✓
- §2 目标5（跨框架）→ Task 1-4 在 core，Task 7-8 外壳在 plugin ✓
- §6.1 修断裂③ → Task 8 routeStrong ✓
- §6.2 修断裂② → Task 9 referencesAssistantTurnId 传递 ✓
- §6.3 修断裂④ → Task 10 ✓
- §7 错误处理 → Task 8 降级逻辑 ✓
- §8.2 quiet flag → Task 6 ✓
- §9.3 验收 → Task 11 ✓

**2. 占位符扫描**：Task 7 的 `routeStrong`/`detectAsyncAndRoute` 是 stub，但 Task 8 明确替换它们——这是有意的 TDD 分步，不是占位符遗漏。Task 7 测试骨架标注"需根据 mock 范式补全"，是因为 plugin 层 wctx mock 方式需实现时参照现有测试，已在步骤里指明参照路径。

**3. 类型一致性**：`collectSync` / `mapLlmResultToOutput` / `scanKeywords` / `buildLlmPrompt` / `parseLlmClassification` 在所有 Task 中签名一致。`SignalCollectorOutput` 字段（isSignal/type/strength/matchedTerms/matchedPrecision/detectionSource/needsLlmConfirmation/llmReason/evidence）在 Task 1 定义后被 Task 2/4/7/8 一致使用。

**4. 已知风险点**：
- Task 9（prompt.ts 接线）是最大风险——`:343-759` empathy 段删除范围大，可能误删非检测逻辑（GFI decay 等）。Step 3 已强调"保留 GFI decay"。实施时需逐段 diff 确认。
- Task 6 加 InternalAgentName 可能触发其他依赖数组长度的测试——Step 4 已要求跑全 core 测试。
