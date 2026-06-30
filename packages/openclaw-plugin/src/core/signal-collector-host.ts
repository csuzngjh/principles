/**
 * SignalCollectorHost — plugin I/O 外壳 (design spec §4.2)
 *
 * 把 core 的纯逻辑 (collectSync / mapLlmResultToOutput) 接进 openclaw 运行时。
 *
 * 同步路径 (prompt.ts before_prompt_build 钩子调用,绝不阻塞):
 *   - trigger 门控 (仅 user)
 *   - Stage1 关键词快扫 (零成本)
 *   - 写 user_turns (复用 recordUserTurn)
 *   - 高精度短语命中 (high) → 直接走 STRONG 分流 (同步,纯内存)
 *   - 普通歧义词 / 未命中 → 入队异步 LLM 确认 (不阻塞)
 *
 * 异步路径 (fire-and-forget):
 *   - Stage2 LLM 确认 (后台,不阻塞 prompt hook)
 *   - LLM 不可用 → 降级:丢弃 ambiguous 候选 (不触发 STRONG,避免误判泛滥)
 *   - 按 strength 分流:STRONG → emitPainDetectedEvent (修断裂 ③);WEAK → trackFriction 累积 GFI
 *
 * 降级不静默 (rc-9):所有降级路径走 SystemLogger。
 */

import {
  collectSync,
  mapLlmResultToOutput,
  type UnifiedKeywordStore,
  type SignalCollectorConfig,
  type SignalCollectorOutput,
} from '@principles/core/runtime-v2';
import { emitPainDetectedEvent } from '../hooks/pain.js';
import { trackFriction } from './session-tracker.js';
import { SystemLogger } from './system-logger.js';
import { createTraceId } from './evolution-logger.js';
import type { WorkspaceContext } from './workspace-context.js';
import type { TrajectoryUserTurnInput } from './trajectory-types.js';

// ── 默认配置 / 内置 seed 词库 ─────────────────────────────────────────────────
//
// 注意:完整的 <stateDir>/signal_keywords.json 加载 + 旧词库合并迁移 (spec §5.1)
// 属于另一项工作,这里先用内置 seed 保证 host 可独立工作。host 接口预留了
// keywordStore / config 的注入点,plugin 层接入真实文件 store 时无需改逻辑。

export const DEFAULT_SIGNAL_CONFIG: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30_000,
  promptTemplate: '',
  strongPainScore: 70,
  strongRateLimitPerHour: 5,
};

export function buildDefaultKeywordStore(): UnifiedKeywordStore {
  const terms: UnifiedKeywordStore['terms'] = {
    // 高精度纠正短语 (命中即判 STRONG,不走 LLM)
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不要自作主张': { term: '不要自作主张', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不应该这么做': { term: '不应该这么做', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    // 普通歧义词 (仅作 evidence 候选,强制过 Stage2 LLM 二次确认)
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '错了': { term: '错了', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '搞什么': { term: '搞什么', category: 'empathy', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  };
  return { version: 1, terms };
}

// ── STRONG 信号 rate limit 门控 (spec §7.2) ──────────────────────────────────
// 单个 session 每小时最多触发 N 次 STRONG → emitPainDetectedEvent (防泛滥,N 可配,默认 5)。
// 纯内存计数,不引入新子系统。

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

const ONE_HOUR_MS = 60 * 60 * 1000;

// ── 异步 LLM 候选队列 (来自 detectSync 入队) ─────────────────────────────────

interface PendingSignal {
  output: SignalCollectorOutput;   // Stage1 待 LLM 确认的候选 (needsLlmConfirmation=true)
  sessionId: string;
  text: string;
  traceId: string;
}

/**
 * adapter 抽象 (Stage2 LLM 调用)。plugin 层可注入真实 adapter (LMStudio);
 * 为 null / 不可用时 host 走纯关键词降级。
 *
 * 本文件不依赖具体的 PDRuntimeAdapter 实现,只依赖一个最小的分类函数,
 * 以保持 host 可单测 (测试可注入 mock classifier)。
 */
export type SignalLlmClassifier = (text: string, promptTemplate: string) =>
  Promise<{ is_feedback: boolean; type: 'correction' | 'empathy' | 'none'; confidence: number; reason: string } | null>;

export interface SignalCollectorHostOptions {
  keywordStore?: UnifiedKeywordStore;
  config?: SignalCollectorConfig;
  /** Stage2 LLM 分类器。null/undefined → 降级纯关键词。 */
  llmClassifier?: SignalLlmClassifier | null;
}

export class SignalCollectorHost {
  private readonly wctx: WorkspaceContext;
  private readonly store: UnifiedKeywordStore;
  private readonly config: SignalCollectorConfig;
  private readonly llmClassifier: SignalLlmClassifier | null;

  /** rate limit 状态:sessionId → STRONG 计数桶 */
  private readonly rateLimit = new Map<string, RateLimitBucket>();

  constructor(wctx: WorkspaceContext, options: SignalCollectorHostOptions = {}) {
    this.wctx = wctx;
    this.store = options.keywordStore ?? buildDefaultKeywordStore();
    this.config = options.config ?? DEFAULT_SIGNAL_CONFIG;
    this.llmClassifier = options.llmClassifier ?? null;
  }

  /**
   * ★ 同步路径 (prompt.ts before_prompt_build 钩子里调用,绝不能阻塞)。
   *
   * 只做:trigger 门控 + Stage1 关键词快扫 + 写 user_turns。
   * 高精度短语命中 (high) → 直接走 STRONG 分流 (同步,纯内存)。
   * 普通歧义词 / 未命中 → 入队异步 LLM 确认 (不阻塞)。
   */
  detectSync(userMessage: string, sessionId: string, trigger: string): void {
    // 1. trigger 门控 (保留现有 trigger 门控,仅处理真实用户消息)
    if (trigger !== 'user') {
      return;
    }

    // 2. Stage1 关键词快扫 (同步,零成本)
    const output = collectSync(userMessage, sessionId, this.store, this.config);

    // 3. 写 user_turns (复用 recordUserTurn)
    //    correctionDetected 含义扩展:isSignal && strength=STRONG (spec §5.2)
    const turnInput: TrajectoryUserTurnInput = {
      sessionId,
      // host 不维护 turn 索引,由调用方/DB 决定;这里用时间戳递增避免冲突。
      turnIndex: Date.now(),
      rawText: userMessage,
      correctionDetected: output.isSignal && output.strength === 'STRONG',
      correctionCue: output.matchedTerms.length > 0 ? output.matchedTerms.join(', ') : null,
    };
    try {
      this.wctx.trajectory?.recordUserTurn?.(turnInput);
    } catch (e) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_TRAJECTORY_FAIL', `recordUserTurn threw: ${String(e)}`);
    }

    // 4. 高精度短语命中 (high, STRONG) → 直接走 STRONG 分流 (同步)
    if (output.isSignal && output.strength === 'STRONG' && output.matchedPrecision === 'high') {
      this.routeStrong(output, sessionId);
      return;
    }

    // 5. 普通歧义词 / 未命中 → 入队异步 LLM 确认 (不阻塞 prompt hook)
    if (output.needsLlmConfirmation) {
      const pending: PendingSignal = {
        output,
        sessionId,
        text: userMessage,
        traceId: createTraceId(),
      };
      // fire-and-forget,失败不影响用户消息处理 (spec §4.2)
      void this.detectAsyncAndRoute(pending);
    }
  }

  /**
   * ★ 异步路径 (fire-and-forget)。
   *
   * 1. Stage2 LLM 确认 (后台,不阻塞用户)
   * 2. LLM 不可用 → 降级:丢弃 ambiguous 候选 (不触发 STRONG,避免误判泛滥)
   * 3. 按 strength 分流:STRONG → emitPainDetectedEvent;WEAK → trackFriction 累积 GFI;none → 仅记录
   */
  private async detectAsyncAndRoute(pending: PendingSignal): Promise<void> {
    // 1. Stage2 LLM 确认
    let confirmed: SignalCollectorOutput;
    if (this.llmClassifier && this.config.enableLlmStage) {
      let llmResult = null;
      try {
        llmResult = await this.llmClassifier(pending.text, this.config.promptTemplate);
      } catch (e) {
        SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_PARSE_FAIL', `LLM classifier threw: ${String(e)}`);
      }
      if (llmResult) {
        confirmed = mapLlmResultToOutput(llmResult, pending.text, pending.sessionId, this.config);
      } else {
        // LLM 返回非法结果 → 当 none 处理 (rc-1),降级不静默
        SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_PARSE_FAIL', 'LLM returned invalid result, treating as none');
        confirmed = mapLlmResultToOutput(
          { is_feedback: false, type: 'none', confidence: 1, reason: 'LLM parse failed' },
          pending.text, pending.sessionId, this.config,
        );
      }
    } else {
      // LLM 不可用 → 降级纯关键词:丢弃 ambiguous 候选 (不触发 STRONG,避免误判泛滥)
      // (Stage1 已对该候选标 needsLlmConfirmation=true 且 isSignal=false,这里维持不触发)
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_DEGRADED',
        'LLM unavailable, dropping ambiguous candidate (no STRONG trigger)');
      return;
    }

    // 3. 按 strength 分流
    if (confirmed.isSignal && confirmed.strength === 'STRONG') {
      this.routeStrong(confirmed, pending.sessionId);
    } else if (confirmed.isSignal && confirmed.strength === 'WEAK') {
      this.routeWeak(confirmed, pending.sessionId);
    }
    // none → 仅记录,无副作用
  }

  /**
   * STRONG 分流 → emitPainDetectedEvent (修断裂 ③)。
   * 带 STRONG rate limit 门控 (spec §7.2):单 session 每小时上限 strongRateLimitPerHour。
   */
  private routeStrong(output: SignalCollectorOutput, sessionId: string): void {
    if (!this.tryConsumeRateLimit(sessionId)) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_STRONG_RATE_LIMITED',
        `STRONG signal suppressed by rate limit for session ${sessionId}`);
      return;
    }

    const reason = output.llmReason
      || (output.matchedTerms.length > 0
        ? `User correction detected: ${output.matchedTerms.join(', ')}`
        : 'User correction detected');

    // emitPainDetectedEvent 是 async,但同步路径不能 await (会阻塞 prompt hook)。
    // 这里 fire-and-forget,失败 catch (不 throw,不阻断用户消息处理)。
    void emitPainDetectedEvent(
      this.wctx,
      {
        ts: new Date().toISOString(),
        type: 'pain_detected',
        data: {
          painId: `correction_${Date.now()}`,
          painType: 'user_frustration',
          source: 'user_correction',          // Layer 2 强信号 (spec §6.1)
          reason,
          score: this.config.strongPainScore, // STRONG_PAIN_SCORE 默认 70
          sessionId,
          agentId: 'main',
          provenance: 'openclaw_context_bound',
          evidence: [
            { sourceRef: 'signal_collector', note: output.evidence.excerpt },
          ],
        },
      },
      { recordObservability: true },
    ).catch((e) => {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_EMIT_FAIL',
        `emitPainDetectedEvent failed: ${String(e)}`);
    });
  }

  /**
   * WEAK 分流 → trackFriction 累积 GFI + 写 evidence (维持现状,spec §3.2)。
   */
  private routeWeak(output: SignalCollectorOutput, sessionId: string): void {
    const hash = (output.evidence.detectedAt + sessionId).slice(0, 32);
    trackFriction(sessionId, this.config.strongPainScore, hash, this.wctx.workspaceDir, {
      source: 'user_empathy',
    });
  }

  /**
   * STRONG rate limit 门控:成功消耗一个名额返回 true;超限返回 false。
   * 窗口满一小时自动重置。
   */
  private tryConsumeRateLimit(sessionId: string): boolean {
    const limit = this.config.strongRateLimitPerHour;
    const now = Date.now();
    let bucket = this.rateLimit.get(sessionId);
    if (!bucket || now - bucket.windowStart >= ONE_HOUR_MS) {
      bucket = { count: 0, windowStart: now };
      this.rateLimit.set(sessionId, bucket);
    }
    if (bucket.count >= limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}
