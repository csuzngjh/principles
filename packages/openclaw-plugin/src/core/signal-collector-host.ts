/**
 * SignalCollectorHost — plugin I/O 外壳 (design spec §4.2)
 *
 * 把 core 的纯逻辑 (collectSync / mapLlmResultToOutput) 接进 openclaw 运行时。
 *
 * 同步路径 (prompt.ts before_prompt_build 钩子调用,绝不阻塞):
 *   - trigger 门控 (user/api/undefined 视为用户交互,其余跳过)
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
  buildLlmPrompt,
  SIGNAL_CLASSIFIER_SYSTEM_PROMPT,
  resolveLlmClassificationPayload,
  safeStringifyPreview,
  PiAiRuntimeAdapter,
  type UnifiedKeywordStore,
  type SignalCollectorConfig,
  type SignalCollectorOutput,
} from '@principles/core/runtime-v2';
import {
  GOVERNANCE_STRONG_PAIN_SCORE,
  GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR,
  deriveProductionCorrectionPainIdentity,
} from '@principles/host-runtime';
import { createHash } from 'node:crypto';
import { emitPainDetectedEvent } from '../hooks/pain.js';
import { trackFriction } from './session-tracker.js';
import { SystemLogger } from './system-logger.js';
import { createTraceId } from '../utils/trace-id.js';
import { resolveObserverConfig } from './pd-config-loader.js';
import { updateSignalHealth } from './signal-health.js';
import type { PluginLogger } from '../openclaw-sdk.js';
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
  // Shared with the host-neutral governance admission constants (SPEC §12):
  // one score/rate-limit truth for OpenClaw and Codex.
  strongPainScore: GOVERNANCE_STRONG_PAIN_SCORE,
  strongRateLimitPerHour: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR,
};

/**
 * 判定 trigger 是否代表真实用户交互。
 *
 * `user` / `api` / `undefined` 均视为用户交互(prompt.ts 与 detectSync 共享同一判定,
 * 避免两处门控不一致导致 api/undefined 触发的纠正信号丢失)。
 * `heartbeat` / `cron` / `subagent` 等系统触发不视为用户交互。
 */
export function isUserInteractionTrigger(trigger: string | undefined): boolean {
  return trigger === 'user' || trigger === 'api' || trigger === undefined;
}

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
  /** Stable occurrence identity for correction dedup (ADR-0020 §11.4). */
  occurrenceId: string;
  traceId: string;
  /** Stage1 扫描时的词库快照(异步路径复用同一份,避免检测期间词库漂移) */
  storeSnapshot: UnifiedKeywordStore;
  /**
   * PRI-788 G1: Stage1 写入 user_turns 返回的 rowid。Stage2 确认为纠正后据此
   * 回写 correction_detected 标志（recordUserTurn 当时只写了 Stage1 的 0）。
   * recordUserTurn 不可用时为 undefined → 回写跳过（可观测降级）。
   */
  userTurnRowid?: number;
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
  /**
   * Live store provider (P0-B Learn→Detect 闭环): 每次检测调用,mtime 变化时
   * 重载 learned correction cues。设置后优先于 keywordStore 静态快照——
   * optimizer 学到的词无需重启 OpenClaw 即进入下一次检测。
   */
  keywordStoreProvider?: () => UnifiedKeywordStore;
  config?: SignalCollectorConfig;
  /** Stage2 LLM 分类器。null/undefined → 降级纯关键词。 */
  llmClassifier?: SignalLlmClassifier | null;
  /**
   * PRI-788 G3: 关键词确认反馈（earned precision 的证据源）。LLM 确认 verdict
   * 出现时以命中的词回调——wasCorrection=true 记 TP（LLM 确认是纠正），
   * false 记 FP（命中但不是纠正）。由 prompt.ts 接线到 CorrectionCueLearner；
   * 未注入时为 no-op（earned 永不升级，行为=G3 之前）。
   */
  cueFeedbackRecorder?: (terms: readonly string[], wasCorrection: boolean) => void;
}

export class SignalCollectorHost {
  private readonly wctx: WorkspaceContext;
  private readonly storeProvider: () => UnifiedKeywordStore;
  private readonly config: SignalCollectorConfig;
  private readonly llmClassifier: SignalLlmClassifier | null;
  private readonly cueFeedbackRecorder?: (terms: readonly string[], wasCorrection: boolean) => void;

  /** rate limit 状态:sessionId → STRONG 计数桶 */
  private readonly rateLimit = new Map<string, RateLimitBucket>();

  constructor(wctx: WorkspaceContext, options: SignalCollectorHostOptions = {}) {
    this.wctx = wctx;
    this.storeProvider = options.keywordStoreProvider
      ?? (options.keywordStore ? () => options.keywordStore as UnifiedKeywordStore : () => buildDefaultKeywordStore());
    this.config = options.config ?? DEFAULT_SIGNAL_CONFIG;
    this.llmClassifier = options.llmClassifier ?? null;
    this.cueFeedbackRecorder = options.cueFeedbackRecorder;
  }

  /**
   * ★ 同步路径 (prompt.ts before_prompt_build 钩子里调用,绝不能阻塞)。
   *
   * 只做:trigger 门控 + Stage1 关键词快扫 + 写 user_turns。
   * 高精度短语命中 (high) → 直接走 STRONG 分流 (同步,纯内存)。
   * 普通歧义词 / 未命中 → 入队异步 LLM 确认 (不阻塞)。
   */
  /**
   * 可选入参:lineage 字段(由调用方算好传入,host 不感知 trajectory 结构)。
   * referencesAssistantTurnId 让诊断 evidence 能 JOIN 到前置 assistant turn。
   */
  detectSync(
    userMessage: string,
    sessionId: string,
    trigger: string,
    options?: { referencesAssistantTurnId?: number | null; turnIndex?: number },
  ): void {
    // 1. trigger 门控:仅处理真实用户交互(user/api/undefined)。
    //    与 prompt.ts 共享 isUserInteractionTrigger,避免两处门控不一致导致
    //    api/undefined 触发的纠正信号在 detectSync 内部被静默丢弃。
    if (!isUserInteractionTrigger(trigger)) {
      return;
    }

    // 2. Stage1 关键词快扫 (同步,零成本)。detectedAt 由 plugin 层注入(core 不取时间,CodeRabbit #11)
    //    词库经 provider 按次解析(P0-B: learned cues 无需重启即生效)。
    const detectedAt = new Date().toISOString();
    const store = this.storeProvider();
    const output = collectSync(userMessage, sessionId, store, this.config, detectedAt);

    // 3. 写 user_turns (复用 recordUserTurn)
    //    correctionDetected 含义扩展:isSignal && strength=STRONG (spec §5.2)
    const turnInput: TrajectoryUserTurnInput = {
      sessionId,
      // turnIndex 由调用方传入(基于 event.messages 的真实计数);未传则用时间戳递增避免冲突。
      turnIndex: options?.turnIndex ?? Date.now(),
      rawText: userMessage,
      correctionDetected: output.isSignal && output.strength === 'STRONG',
      correctionCue: output.matchedTerms.length > 0 ? output.matchedTerms.join(', ') : null,
      referencesAssistantTurnId: options?.referencesAssistantTurnId ?? null,
    };
    let userTurnRowid: number | undefined;
    try {
      userTurnRowid = this.wctx.trajectory?.recordUserTurn?.(turnInput);
    } catch (e) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_TRAJECTORY_FAIL', `recordUserTurn threw: ${String(e)}`);
    }

    // 5. 高精度短语命中 (high, STRONG) → 直接走 STRONG 分流 (同步)
    if (output.isSignal && output.strength === 'STRONG' && output.matchedPrecision === 'high') {
      // PRI-788 G4: 健康度计数（旁路，失败不阻塞）。
      // updateSignalHealth 是同步文件 I/O（readFileSync + mkdirSync + 原子写），
      // 不能留在 before_prompt_build 的同步检测路径上；交由 countStage1Strong
      // 推迟到微任务队列执行（与 hooks/trajectory-collector.ts 同一惯例），
      // routeStrong 与 hook 返回不再被磁盘延迟放大。
      this.countStage1Strong();
      this.routeStrong(output, sessionId, userMessage, this.resolveOccurrenceId(sessionId, userMessage, options));
      return;
    }

    // 6. 普通歧义词 / 未命中 → 入队异步 LLM 确认 (不阻塞 prompt hook)
    if (output.needsLlmConfirmation) {
      const pending: PendingSignal = {
        output,
        sessionId,
        text: userMessage,
        occurrenceId: this.resolveOccurrenceId(sessionId, userMessage, options),
        traceId: createTraceId(),
        storeSnapshot: store,
        userTurnRowid,
      };
      // fire-and-forget,失败不影响用户消息处理 (spec §4.2)
      void this.detectAsyncAndRoute(pending);
    }
  }

  /**
   * ★ 异步路径 (fire-and-forget)。
   *
   * 1. Stage2 LLM 确认 (后台,不阻塞用户)
   * 2. LLM 不可用 → 降级:empathy ambiguous 候选作为 WEAK 信号路由(保留旧版 GFI 累积);
   *    correction ambiguous / 未命中候选丢弃(不触发 STRONG,避免误判泛滥)
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
        // PRI-788 G2: 异常不再静默丢候选——持久化待确认（通道恢复后批量确认）。
        // 无 verdict ⇒ 立即结束：绝不能落到下方"当 none 处理"分支，否则通道故障
        // 会被当成"LLM 判为普通消息"并 emitCueFeedback(false)，把通道故障记成
        // 关键词 FP、拉低权重并撤销 earned precision（CodeRabbit review）。
        this.queueUnconfirmedForBatch(pending, 'llm_classifier_threw');
        return;
      }
      const llmDetectedAt = new Date().toISOString();
      if (llmResult) {
        confirmed = mapLlmResultToOutput(llmResult, pending.text, pending.sessionId, this.config, llmDetectedAt);
      } else {
        // 超时/不可用返回 null 同样没有 verdict —— 入队一次后结束（rc-1，降级不静默）。
        SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_PARSE_FAIL', 'LLM returned invalid result, queued for batch confirm');
        // PRI-788 G2: 同上——超时/不可用返回 null 的候选持久化，不丢。
        this.queueUnconfirmedForBatch(pending, 'llm_result_unavailable');
        return;
      }
    } else {
      // LLM 不可用 → 降级:empathy ambiguous 候选作为 WEAK 信号路由(累积 GFI,不触发 STRONG)。
      // 保留旧版 empathy keyword matcher 的 GFI 累积行为,避免 LLM 未配置(默认)时
      // empathy 检测完全失效。correction ambiguous 候选仍然丢弃(旧版 correction cue
      // 不触发 trackFriction,仅 recordUserTurn,已在 detectSync 中完成)。
      if (pending.output.matchedPrecision === 'ambiguous' && pending.output.matchedTerms.length > 0) {
        const hasEmpathyMatch = pending.output.matchedTerms.some(
          (term) => pending.storeSnapshot.terms[term]?.category === 'empathy',
        );
        if (hasEmpathyMatch) {
          SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_DEGRADED_WEAK',
            'LLM unavailable, routing empathy ambiguous as WEAK (GFI accumulation, no STRONG trigger)');
          const degradedOutput: SignalCollectorOutput = {
            ...pending.output,
            isSignal: true,
            type: 'empathy',
            strength: 'WEAK',
            detectionSource: 'keyword',
            needsLlmConfirmation: false,
          };
          this.routeWeak(degradedOutput, pending.sessionId);
          return;
        }
      }
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_DEGRADED',
        'LLM unavailable, dropping candidate (no STRONG trigger)');
      // PRI-788 G2: 丢弃改持久化——通道恢复后批量确认，不再"通道死=信号丢"。
      this.queueUnconfirmedForBatch(pending, 'llm_unavailable');
      return;
    }

    // 3. 按 strength 分流
    if (confirmed.isSignal && confirmed.strength === 'STRONG') {
      // PRI-788 G3: LLM 确认是纠正 → 命中词记 TP（earned precision 证据）
      this.emitCueFeedback(pending.output.matchedTerms, true);
      // PRI-788 G1: LLM 确认的纠正回写标志位。Stage1 写入时歧义候选置 0，若不
      // 回写，证据构建器与 correction_samples 闭环永远看不到这条纠正。标志位
      // 陈述"这条消息是纠正"的事实，独立于 pain 事件的 rate limit，故先于
      // routeStrong 执行。
      this.writeBackConfirmedCorrection(pending.userTurnRowid, confirmed);
      // PRI-788 G4: 健康度计数
      updateSignalHealth(this.wctx.stateDir, (s) => {
        s.stage2Confirmed += 1;
        s.lastStage2SuccessAt = new Date().toISOString();
      });
      this.routeStrong(confirmed, pending.sessionId, pending.text, pending.occurrenceId);
    } else if (confirmed.isSignal && confirmed.strength === 'WEAK') {
      // LLM 判为情绪/挫败而非纠正 → 命中的纠正词记 FP
      this.emitCueFeedback(pending.output.matchedTerms, false);
      this.routeWeak(confirmed, pending.sessionId);
    } else {
      // LLM 判为普通消息 → 命中词记 FP
      this.emitCueFeedback(pending.output.matchedTerms, false);
    }
  }

  /**
   * PRI-788 G3: 把 LLM 确认 verdict 转成关键词 TP/FP 反馈（earned precision 的
   * 证据源）。recorder 未注入或抛错均不阻塞路由（rc-9：抛错记结构化日志）。
   */
  private emitCueFeedback(terms: readonly string[] | undefined, wasCorrection: boolean): void {
    if (!terms || terms.length === 0 || !this.cueFeedbackRecorder) return;
    try {
      this.cueFeedbackRecorder(terms, wasCorrection);
    } catch (e) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_CUE_FEEDBACK_FAIL', String(e));
    }
  }

  /**
   * PRI-788 G2: Stage2 不可用时的持久化兜底。LLM 不可用/超时/解析失败的丢弃
   * 分支改为落库 signal_confirmations（pending），由 CorrectionObserverService
   * 每周期批量确认——通道恢复后信号可补确认，不再"通道死=信号丢"。
   *
   * 只入队"词库命中过的歧义候选"：零命中的普通消息体量与噪声不可控，其纠正
   * 语义覆盖由 G3 的词库扩充/earned 解锁承担。
   */
  private queueUnconfirmedForBatch(pending: PendingSignal, reason: string): void {
    if (pending.userTurnRowid === undefined) { this.countStage2Dropped(); return; } // 无行可回写，持久化无意义
    if (pending.output.matchedPrecision !== 'ambiguous' || pending.output.matchedTerms.length === 0) {
      this.countStage2Dropped();
      return;
    }
    const suggestedType = pending.output.matchedTerms.some(
      (term) => pending.storeSnapshot.terms[term]?.category === 'correction',
    ) ? 'correction' : 'empathy';
    try {
      this.wctx.trajectory?.enqueueSignalConfirmation?.({
        sessionId: pending.sessionId,
        userTurnRowid: pending.userTurnRowid,
        occurrenceId: pending.occurrenceId,
        excerpt: pending.text.slice(0, 400),
        terms: pending.output.matchedTerms,
        suggestedType,
        createdAt: new Date().toISOString(),
      });
      updateSignalHealth(this.wctx.stateDir, (s) => { s.stage2Queued += 1; });
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_CONFIRMATION_QUEUED',
        `${reason}; queued for batch confirmation (suggested=${suggestedType})`);
    } catch (e) {
      this.countStage2Dropped();
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_CONFIRMATION_QUEUE_FAIL',
        `enqueueSignalConfirmation threw: ${String(e)}`);
    }
  }

  /** PRI-788 G4: 未经确认就消失的候选计数（旁路，失败不阻塞）。 */
  private countStage2Dropped(): void {
    updateSignalHealth(this.wctx.stateDir, (s) => { s.stage2Dropped += 1; });
  }

  /**
   * PRI-788 G4: stage1Strong 计数（旁路观测），刻意离开同步检测路径。
   *
   * `updateSignalHealth` 是同步 read-modify-write，直接放在 `detectSync` 里会让
   * `before_prompt_build` 承担磁盘延迟。这里只触发计数，实际写入推迟到微任务
   * 队列执行（写入本身仍在一个 tick 内同步完成，不会与其它写入交错）。
   */
  private countStage1Strong(): void {
    const stateDir = this.wctx.stateDir;
    queueMicrotask(() => {
      updateSignalHealth(stateDir, (s) => { s.stage1Strong += 1; });
    });
  }

  /**
   * PRI-788 G2: 批量确认一条持久化的待确认信号（CorrectionObserverService 每
   * 周期调用）。用调用方提供的 classifier（每 cycle 新鲜解析）重新分类：
   * correction → 回写标志 + 复用 realtime STRONG 分流（限流/身份派生一致）；
   * WEAK → trackFriction；none → rejected；classifier 失败 → failed（调用方
   * attempts++，达上限转 abandoned）。
   */
  async confirmPendingSignal(
    item: { sessionId: string; userTurnRowid: number; occurrenceId: string; excerpt: string; terms?: readonly string[] },
    classifier: SignalLlmClassifier,
  ): Promise<{ disposition: 'confirmed' | 'rejected' | 'failed'; detail: string }> {
    let llmResult: Awaited<ReturnType<SignalLlmClassifier>> = null;
    try {
      llmResult = await classifier(item.excerpt, '');
    } catch (e) {
      return { disposition: 'failed', detail: `classifier threw: ${String(e)}` };
    }
    if (!llmResult) return { disposition: 'failed', detail: 'classifier unavailable' };
    const confirmed = mapLlmResultToOutput(llmResult, item.excerpt, item.sessionId, this.config, new Date().toISOString());
    if (confirmed.isSignal && confirmed.strength === 'STRONG') {
      this.emitCueFeedback(item.terms, true);
      this.writeBackConfirmedCorrection(item.userTurnRowid, confirmed);
      this.routeStrong(confirmed, item.sessionId, item.excerpt, item.occurrenceId);
      return { disposition: 'confirmed', detail: confirmed.llmReason ?? 'confirmed correction' };
    }
    if (confirmed.isSignal && confirmed.strength === 'WEAK') {
      this.emitCueFeedback(item.terms, false);
      this.routeWeak(confirmed, item.sessionId);
      return { disposition: 'rejected', detail: 'weak/empathy at confirmation' };
    }
    this.emitCueFeedback(item.terms, false);
    return { disposition: 'rejected', detail: confirmed.llmReason ?? 'classified none' };
  }

  /**
   * PRI-788 G1: Stage2 确认为纠正后回写 user_turns.correction_detected（G1）。
   * 以 Stage1 写入返回的 rowid 精确寻址（rc-7）；rowid 缺失/行已不存在均为
   * 可观测降级，不阻塞路由。
   */
  private writeBackConfirmedCorrection(userTurnRowid: number | undefined, confirmed: SignalCollectorOutput): void {
    if (userTurnRowid === undefined) return;
    const cue = confirmed.llmReason ? `llm:${confirmed.llmReason.slice(0, 120)}` : null;
    try {
      const updated = this.wctx.trajectory?.markUserTurnCorrection(userTurnRowid, cue);
      if (updated === false) {
        SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_WRITEBACK_MISS',
          `user_turn rowid ${userTurnRowid} no longer exists; correction flag write-back skipped`);
      }
    } catch (e) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_WRITEBACK_FAIL',
        `markUserTurnCorrection threw: ${String(e)}`);
    }
  }

  /**
   * Stable occurrence identity for correction dedup (ADR-0020 §11.4): the real
   * per-session turn index when the caller supplies one (parity with
   * recordUserTurn), otherwise a content-derived legacy fallback. The fallback
   * is a degradation — never silent (rc-9).
   */
  private resolveOccurrenceId(
    sessionId: string,
    userMessage: string,
    options?: { referencesAssistantTurnId?: number | null; turnIndex?: number },
  ): string {
    if (options?.turnIndex !== undefined) {
      return String(options.turnIndex);
    }
    SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_OCCURRENCE_ID_LEGACY',
      'turnIndex not provided; correction occurrence identity degraded to content hash');
    return 'legacy:' + createHash('sha256').update(sessionId + ':' + userMessage).digest('hex').slice(0, 16);
  }

  /**
   * STRONG 分流 → emitPainDetectedEvent (修断裂 ③)。
   * 带 STRONG rate limit 门控 (spec §7.2):单 session 每小时上限 strongRateLimitPerHour。
   *
   * Codex Governance Closure Slice B 收敛 (ADR-0020 §11.4):pain id 走
   * production-pain-evidence 的内容派生 canonicalization(同一 pain identity
   * 权威),不再铸造随机 `correction_<traceId>`;trace id 降级为 correlation 字段。
   */
  private routeStrong(output: SignalCollectorOutput, sessionId: string, text: string, occurrenceId: string): void {
    if (!this.tryConsumeRateLimit(sessionId)) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_STRONG_RATE_LIMITED',
        'STRONG signal suppressed by rate limit');  // 不记录 sessionId(隐私,CodeRabbit #2)
      return;
    }

    const reason = output.llmReason
      || (output.matchedTerms.length > 0
        ? `User correction detected: ${output.matchedTerms.join(', ')}`
        : 'User correction detected');

    // 内容派生 canonical pain id:同一 workspace+session 的同一 occurrence
    // (turnIndex / legacy 内容哈希)重试/重投递只会得到同一个 id,由
    // pain_events.canonical_pain_id 唯一索引兜底;同一段文本的后续真实 turn
    // 因 occurrenceId 不同而成为新的 pain。
    const { painId } = deriveProductionCorrectionPainIdentity({
      workspaceDir: this.wctx.workspaceDir,
      sessionId,
      occurrenceId,
      text,
    });

    // emitPainDetectedEvent 是 async,但同步路径不能 await (会阻塞 prompt hook)。
    // 这里 fire-and-forget,失败 catch (不 throw,不阻断用户消息处理)。
    void emitPainDetectedEvent(
      this.wctx,
      {
        ts: new Date().toISOString(),
        type: 'pain_detected',
        data: {
          painId,
          painType: 'user_frustration',
          source: 'user_correction',          // Layer 2 强信号 (spec §6.1)
          reason,
          score: this.config.strongPainScore, // STRONG_PAIN_SCORE 默认 70
          sessionId,
          agentId: 'main',
          traceId: createTraceId(),           // correlation only — never dedup identity (ADR-0020 §11.4)
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
   *
   * WEAK 是 Layer 3 弱信号,用较小的摩擦分(20)累积,过 highGfi 阈值(70)才触发诊断。
   * 不用 strongPainScore(70),因为 WEAK 单条不该直接顶满 GFI。
   */
  private routeWeak(output: SignalCollectorOutput, sessionId: string): void {
    try {
      const hash = createHash('sha256')
        .update(`${output.evidence.detectedAt}:${sessionId}`)
        .digest('hex')
        .slice(0, 32);
      trackFriction(sessionId, 20, hash, this.wctx.workspaceDir, {
        source: 'user_empathy',
      });
    } catch (e) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_TRACK_FRICTION_FAIL', `trackFriction threw: ${String(e)}`);
    }
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

/**
 * 从 .pd/config.yaml 的 signalCollector runtimeProfile 构造 SignalLlmClassifier。
 * 完成配置单轨化(spec §3.3 决策3):统一走 .pd/config.yaml,移除 empathy 的 workflows.yaml 双轨。
 *
 * 返回 null 的情况(走纯关键词降级,rc-9 不静默):
 * - feature flag signal_collector 关闭
 * - runtimeProfile 未配置 / apiKeyEnv 缺失
 * - profile 是 openclaw 类型(observer 不支持)
 *
 * 这是 Task 11 的最后一块:让本地 LLM(LMStudio)真正参与检测。
 */
export function createSignalLlmClassifierFromConfig(
  wctx: WorkspaceContext,
  logger?: Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'>,
): SignalLlmClassifier | null {
  try {
    const cfg = resolveObserverConfig(
      wctx.workspaceDir,
      'signal_collector',
      'signalCollector',
      logger,
    );

    if (!cfg.enabled) {
      logger?.debug?.(`[PD:Signal] LLM classifier disabled: ${cfg.reason}`);
      return null;
    }
    if (cfg.readiness !== 'not_ready' && cfg.readiness !== 'ready') {
      // needs_setup / disabled / config_malformed → 降级
      logger?.debug?.(`[PD:Signal] LLM classifier not ready (${cfg.readiness}): ${cfg.reason}. ${cfg.nextAction}`);
      return null;
    }
    if (!cfg.provider || !cfg.model || !cfg.apiKeyEnv) {
      logger?.debug?.(`[PD:Signal] LLM classifier missing provider/model/apiKeyEnv`);
      return null;
    }

    const adapter = new PiAiRuntimeAdapter({
      provider: cfg.provider,
      model: cfg.model,
      apiKeyEnv: cfg.apiKeyEnv,
      timeoutMs: cfg.timeoutMs ?? 30_000,
      // PRI-788 G3: profile 的 maxTokens 透传（思考型本地模型小 token 预算会返回空）
      maxTokens: cfg.maxTokens ?? undefined,
      baseUrl: cfg.baseUrl ?? undefined,
      workspace: wctx.workspaceDir,
    });

    // 包装成 SignalLlmClassifier:内部调 startRun/pollRun/fetchOutput。
    // Runtime contract (MVP_CORE_LOOP_CONTRACT INV-01): startRun 携带
    // outputSchemaRef='signal-classification-output-v1',adapter 负责 JSON
    // extraction + schema validation(+bounded repair),分类器 canonical 路径
    // 直接消费 validated structured payload;string payload 仅作其他 adapter
    // 的 compatibility fallback(不再有 object→stringify→parse 补丁路径)。
    const classifier: SignalLlmClassifier = async (text: string, _promptTemplate: string) => {
      void _promptTemplate;  // 用 core 的 buildLlmPrompt(标准化的),不用外部传入
      const prompt = buildLlmPrompt(text);
      try {
      const handle = await adapter.startRun({
        agentSpec: { agentId: 'signal-collector', schemaVersion: '1' },
        inputPayload: { prompt },
        contextItems: [],
        timeoutMs: cfg.timeoutMs ?? 30_000,
        outputSchemaRef: 'signal-classification-output-v1',
        // PRI-633: 角色声明走 system 通道,消息只含任务数据。
        systemPrompt: SIGNAL_CLASSIFIER_SYSTEM_PROMPT,
      });
        let status = await adapter.pollRun(handle.runId);
        const deadline = Date.now() + (cfg.timeoutMs ?? 30_000);
        while (status.status === 'running' && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          status = await adapter.pollRun(handle.runId);
        }
        if (status.status !== 'succeeded') {
          SystemLogger.log(wctx.workspaceDir, 'SIGNAL_LLM_TIMEOUT', JSON.stringify({ status: status.status }));
          return null;
        }
        const output = await adapter.fetchOutput(handle.runId);
        const resolved = resolveLlmClassificationPayload(output?.payload);

        if (resolved.path === 'structured' && resolved.value) {
          return resolved.value;
        }
        if ((resolved.path === 'legacy_string' || resolved.path === 'legacy_envelope') && resolved.value) {
          SystemLogger.log(wctx.workspaceDir, 'SIGNAL_LLM_LEGACY_STRING_PAYLOAD',
            `adapter payload path=${resolved.path} (no outputSchemaRef support); parsed via legacy path`);
          return resolved.value;
        }

        // invalid — 带 bounded preview 降级 (rc-8/rc-9,ISSUE-022: 不可诊断的
        // PARSE_FAIL 是审计开放项,preview 必须有界)。
        SystemLogger.log(wctx.workspaceDir, 'SIGNAL_LLM_PARSE_FAIL',
          `unusable classifier payload path=${resolved.path}: ${safeStringifyPreview(output?.payload)}`);
        return null;
      } catch (e) {
        SystemLogger.log(wctx.workspaceDir, 'SIGNAL_LLM_FAILED', String(e).slice(0, 200));
        return null;
      }
    };

    return classifier;
  } catch (e) {
    logger?.warn?.(`[PD:Signal] createSignalLlmClassifierFromConfig failed: ${String(e)}`);
    return null;
  }
}

