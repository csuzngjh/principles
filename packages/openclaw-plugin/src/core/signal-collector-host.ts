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
 *   - 按 strength 分流:STRONG → emitPainDetectedEvent (修断裂 ③)
 *
 * 降级不静默 (rc-9):所有降级路径走 SystemLogger。
 */

import {
  collectSync,
  mapLlmResultToOutput,
  evaluateStage2ConfidenceGate,
  type UnifiedKeywordStore,
  type SignalCollectorConfig,
  type SignalCollectorOutput,
  type Stage2ConversationContext,
} from '@principles/core/runtime';
import {
  GOVERNANCE_STRONG_PAIN_SCORE,
  GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR,
  createSignalLlmClassifier,
  deriveProductionCorrectionPainIdentity,
} from '@principles/host-runtime';
import { createHash } from 'node:crypto';
import { emitPainDetectedEvent } from '../hooks/pain.js';
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
  // 零命中的「发现」调用按小时限量（见 SignalCollectorConfig 注释）：
  // 实测 live 语料约九成（不同时间窗 90–93%）消息零命中，全量发起等于把普通消息也送去分类。
  discoveryRateLimitPerHour: 6,
  // 同一预算的 session 维度：全局上限之外再给每个 session 一个上限，避免一个
  // 闲聊会话耗尽所有发现额度，把其它 session 的明确纠正挡在 LLM 确认之外。
  discoveryRateLimitPerSessionPerHour: 2,
};

/**
 * PD-BEHAVIOR-FIDELITY-001 Gate 3: bounded size of the conversation facts
 * handed to Stage-2. The classifier needs enough to tell "the user is
 * correcting what the assistant just did" from "the user is issuing the first
 * instruction of the session"; it does not need a transcript.
 */
const STAGE2_CONTEXT_TURN_LIMIT = 3;
const STAGE2_CONTEXT_TURN_MAX_CHARS = 240;

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
    '这是错的': { term: '这是错的', weight: 0.9, precision: 'high', source: 'seed' },
    '不要自作主张': { term: '不要自作主张', weight: 0.9, precision: 'high', source: 'seed' },
    '不应该这么做': { term: '不应该这么做', weight: 0.9, precision: 'high', source: 'seed' },
    // 普通歧义词 (仅作 evidence 候选,强制过 Stage2 LLM 二次确认)
    '不对': { term: '不对', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '错了': { term: '错了', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    // 2026-11-13 真实宿主回归：Owner 句「这种没有数据支撑的激进改动我不接受。
    // 以后改配置参数前，先说明依据和影响，等我确认后再动手。」在零命中预算下
    // 没有进入候选。以下表达只作为候选，必须经既有 Stage2 LLM 确认，绝不直达
    // STRONG；普通否定/技术讨论仍可被 LLM 判为 none。
    '不接受': { term: '不接受', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '我不同意': { term: '我不同意', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '我没让你': { term: '我没让你', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '没有让你': { term: '没有让你', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '未经确认': { term: '未经确认', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '先别执行': { term: '先别执行', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '没有依据': { term: '没有依据', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '这不是我要求的': { term: '这不是我要求的', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  };
  return { version: 1, terms };
}

// ── STRONG 信号 rate limit 门控 (spec §7.2) ──────────────────────────────────
// 单个 session 每小时最多触发 N 次 STRONG → emitPainDetectedEvent (防泛滥,N 可配,默认 5)。
// 纯内存计数,不引入新子系统。

interface RateLimitBucket {
  count: number;
  windowStart: number;
  /** Diagnostics only: the first refusal in this window is logged once. */
  exhaustionLogged?: boolean;
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
  /** PRI-844: 回合锚点,确认后随 correctionEvidence 一起进 Pain 证据。 */
  turnIndex?: number;
  referencesAssistantTurnId?: number | null;
  /**
   * PRI-788 G1: Stage1 写入 user_turns 返回的 rowid。Stage2 确认为纠正后据此
   * 回写 correction_detected 标志（recordUserTurn 当时只写了 Stage1 的 0）。
   * recordUserTurn 不可用时为 undefined → 回写跳过（可观测降级）。
   */
  userTurnRowid?: number;
}

/**
 * Same-run signal state retained across retries of a transient user_turn write.
 * This keeps classification and signal-routing side effects idempotent.
 */
interface ProcessedSignalRun {
  userMessageDigest: string;
  output: SignalCollectorOutput;
  occurrenceId: string;
  userTurnRowid?: number;
  pendingSignal?: PendingSignal;
}

const MAX_PROCESSED_SIGNAL_RUNS = 512;

/**
 * Adapter abstraction for Stage-2 LLM classification. The plugin may inject
 * a real provider; null/unavailable keeps the host on keyword-only fallback.
 */
/**
 * PD-BEHAVIOR-FIDELITY-001 Gate 3: the second argument is host-owned
 * conversation facts, not a prompt template. It used to carry
 * `config.promptTemplate`, which the factory ignored; every caller either
 * passed `''` or the unused template. Passing real context is what the R3
 * misclassification was missing.
 */
export type SignalLlmClassifier = (text: string, context?: Stage2ConversationContext) =>
  Promise<{ is_feedback: boolean; type: 'correction' | 'none'; confidence: number; reason: string } | null>;

/**
 * PRI-1137: `detectSync` must report whether THIS invocation's `user_turns`
 * row was actually persisted. A `void` return made a swallowed write failure
 * indistinguishable from success, so the shared round-key provider could read
 * a PREVIOUS ordinal and claim fair rotation for a round that was never
 * recorded. Only `user_turn_persisted` authorises a round key / run claim.
 */
export type SignalSyncOutcome =
  | { readonly status: 'not_user_interaction' }
  | { readonly status: 'user_turn_persisted'; readonly userTurnRowid: number }
  | { readonly status: 'user_turn_persist_failed'; readonly reason: string };

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

  /**
   * Same-run retry cache. A failed user_turn persistence may be retried, but
   * Stage-1 classification, discovery-budget consumption and signal routing
   * are one-shot for that host run.
   */
  private readonly processedRuns = new Map<string, ProcessedSignalRun>();

  /** Zero-hit discovery budget for this workspace's host process. */
  private discoveryBucket: RateLimitBucket = { count: 0, windowStart: 0 };

  /**
   * Per-session discovery buckets. The global bucket alone lets one chatty
   * session starve every other session's explicit corrections; the per-session
   * dimension keeps ordinary conversation from exhausting the shared budget.
   */
  private readonly discoverySessionBuckets = new Map<string, RateLimitBucket>();

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
    options?: { referencesAssistantTurnId?: number | null; turnIndex?: number; idempotencyKey?: string },
  ): SignalSyncOutcome {
    // 1. trigger 门控:仅处理真实用户交互(user/api/undefined)。
    //    与 prompt.ts 共享 isUserInteractionTrigger,避免两处门控不一致导致
    //    api/undefined 触发的纠正信号在 detectSync 内部被静默丢弃。
    if (!isUserInteractionTrigger(trigger)) {
      return { status: 'not_user_interaction' };
    }

    // 2. Stage1 关键词快扫 (同步,零成本)。The first invocation snapshots
    // the live keyword store; a retry reuses that exact classification.
    const idempotencyKey = options?.idempotencyKey;
    const userMessageDigest = createHash('sha256').update(userMessage, 'utf8').digest('hex');
    const cachedRun = idempotencyKey ? this.processedRuns.get(idempotencyKey) : undefined;
    if (cachedRun && cachedRun.userMessageDigest !== userMessageDigest) {
      const reason = 'run_id_reused_with_different_message';
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_RUN_ID_CONFLICT', reason);
      return { status: 'user_turn_persist_failed', reason };
    }
    if (cachedRun?.userTurnRowid !== undefined) {
      return { status: 'user_turn_persisted', userTurnRowid: cachedRun.userTurnRowid };
    }
    const output = cachedRun?.output ?? collectSync(
      userMessage, sessionId, this.storeProvider(), this.config, new Date().toISOString(),
    );
    const occurrenceId = cachedRun?.occurrenceId ?? this.resolveOccurrenceId(sessionId, userMessage, options);
    const runState: ProcessedSignalRun | undefined = cachedRun ?? (idempotencyKey
      ? { userMessageDigest, output, occurrenceId }
      : undefined);
    if (!cachedRun && idempotencyKey && runState) {
      this.processedRuns.set(idempotencyKey, runState);
      if (this.processedRuns.size > MAX_PROCESSED_SIGNAL_RUNS) {
        const oldestKey = this.processedRuns.keys().next().value;
        if (typeof oldestKey === 'string') this.processedRuns.delete(oldestKey);
      }
    }

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
    let persistFailureReason: string | undefined;
    try {
      const rowid = this.wctx.trajectory?.recordUserTurn?.(turnInput);
      if (typeof rowid === 'number' && Number.isInteger(rowid)) {
        userTurnRowid = rowid;
        if (runState) {
          runState.userTurnRowid = rowid;
          // The first LLM attempt may still be awaiting its verdict. Updating
          // the shared pending object lets that verdict attach to the row
          // created by a successful retry instead of losing its write-back.
          if (runState.pendingSignal) runState.pendingSignal.userTurnRowid = rowid;
        }
      } else {
        // No writer / no rowid is a persistence FAILURE, never a silent success.
        persistFailureReason = 'trajectory_writer_unavailable';
      }
    } catch (e) {
      persistFailureReason = `record_user_turn_threw: ${String(e)}`;
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_TRAJECTORY_FAIL', `recordUserTurn threw: ${String(e)}`);
    }
    const persistence: SignalSyncOutcome = userTurnRowid !== undefined
      ? { status: 'user_turn_persisted', userTurnRowid }
      : { status: 'user_turn_persist_failed', reason: persistFailureReason ?? 'record_user_turn_returned_no_rowid' };

    // 5. 高精度短语命中 (high, STRONG) → 直接走 STRONG 分流 (同步)
    if (!cachedRun && output.isSignal && output.strength === 'STRONG' && output.matchedPrecision === 'high') {
      // PRI-788 G4: 健康度计数（旁路，失败不阻塞）。
      // updateSignalHealth 是同步文件 I/O（readFileSync + mkdirSync + 原子写），
      // 不能留在 before_prompt_build 的同步检测路径上；交由 countStage1Strong
      // 推迟到微任务队列执行（与 hooks/trajectory-collector.ts 同一惯例），
      // routeStrong 与 hook 返回不再被磁盘延迟放大。
      this.countStage1Strong();
      this.routeStrong(output, sessionId, userMessage, occurrenceId, {
        turnIndex: options?.turnIndex,
        referencesAssistantTurnId: options?.referencesAssistantTurnId ?? undefined,
      });
      return persistence;
    }

    // 6. 普通歧义词 / 未命中 → 入队异步 LLM 确认 (不阻塞 prompt hook)
    if (!cachedRun && output.needsLlmConfirmation) {
      // 零命中(Stage1 没有任何候选词)只有「发现新纠正词」这一种价值,不是确认:
      // 按小时配额放行,超出直接返回(计数可见,不静默)。歧义命中是确认调用,不受限。
      // 分类器不可用时本来就不会发生 LLM 调用,不消耗配额(降级语义保持原样)。
      const willCallLlm = this.llmClassifier !== null && this.config.enableLlmStage;
      if (willCallLlm && output.matchedTerms.length === 0) {
        const budget = this.takeDiscoveryBudget(sessionId);
        if (!budget.allowed) {
          this.countStage2DiscoverySkipped();
          return persistence;
        }
      }
      const pending: PendingSignal = {
        output,
        sessionId,
        text: userMessage,
        occurrenceId,
        traceId: createTraceId(),
        userTurnRowid,
        turnIndex: options?.turnIndex,
        referencesAssistantTurnId: options?.referencesAssistantTurnId ?? undefined,
      };
      // fire-and-forget,失败不影响用户消息处理 (spec §4.2)
      if (runState) runState.pendingSignal = pending;
      void this.detectAsyncAndRoute(pending);
    }
    return persistence;
  }

  /**
   * ★ 异步路径 (fire-and-forget)。
   *
   * 1. Stage2 LLM 确认 (后台,不阻塞用户)
   * 2. LLM 不可用 → 降级:ambiguous / 未命中候选丢弃(不触发 STRONG,避免误判泛滥)
   * 3. 按 strength 分流:STRONG → emitPainDetectedEvent;none → 仅记录
   */
  private async detectAsyncAndRoute(pending: PendingSignal): Promise<void> {
    // 1. Stage2 LLM 确认
    let confirmed: SignalCollectorOutput;
    if (this.llmClassifier && this.config.enableLlmStage) {
      // AUDIT-P2-02: 实际发起的分类调用计数。注意：本分支位于 detectSync 的
      // 同步调用栈上（async 函数体在首个 await 前同步执行），计数写入必须推迟
      // 到微任务，否则会把健康文件读改写带回 before_prompt_build（AUDIT-P2-01
      // 的同族问题，countStage1Strong 惯例）。
      this.countStage2Invocation();
      let llmResult = null;
      // Gate 3: snapshot the conversation facts BEFORE the await. This runs on
      // the detectSync stack (before the assistant replies), so the count is
      // "prior assistant turns", not "including the current reply".
      const stage2Context = this.buildStage2Context(
        pending.sessionId,
        pending.referencesAssistantTurnId,
      );
      try {
        llmResult = await this.llmClassifier(pending.text, stage2Context);
      } catch (e) {
        SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_PARSE_FAIL', `LLM classifier threw: ${String(e)}`);
        // PRI-788 G2: 异常不再静默丢候选——持久化待确认（通道恢复后批量确认）。
        // 无 verdict ⇒ 立即结束：绝不能落到下方"当 none 处理"分支，否则通道故障
        // 会被当成"LLM 判为普通消息"并 emitCueFeedback(false)，把通道故障记成
        // 关键词 FP、拉低权重并撤销 earned precision（CodeRabbit G3 review）。
        this.queueUnconfirmedForBatch(pending, 'llm_classifier_threw', { allowKeywordless: true });
        return;
      }
      const llmDetectedAt = new Date().toISOString();
      if (llmResult) {
        // SPEC v0.3 §3.3 P-3：低置信度结果既不能准入，也不能当 NONE 结论。
        // Gate 3: pass the host-observed behavior fact — a correction with no
        // prior assistant turn in this session must clear the higher bar.
        const gate = evaluateStage2ConfidenceGate(llmResult, undefined, {
          priorAssistantTurnCount: stage2Context.priorAssistantTurnCount,
        });
        if (gate.verdict === 'pending_low_confidence') {
          // Gate 3 review P1: this only records the gate verdict. "Queued" is
          // logged by the queue path itself, after the row actually lands —
          // otherwise a dropped candidate would log "queued for batch
          // confirmation" it never received (rc-9).
          SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LOW_CONFIDENCE_PENDING',
            `confidence=${String(gate.confidence)} below threshold; routing to batch confirmation`);
          this.queueUnconfirmedForBatch(pending, 'low_confidence', { allowKeywordless: true });
          return;
        }
        confirmed = mapLlmResultToOutput(llmResult, pending.text, pending.sessionId, this.config, llmDetectedAt);
      } else {
        // 超时/不可用返回 null 同样没有 verdict —— 入队一次后结束（rc-1，降级不静默）。
        SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_PARSE_FAIL', 'LLM returned invalid result, queued for batch confirm');
        // PRI-788 G2: 同上——超时/不可用返回 null 的候选持久化，不丢。
        this.queueUnconfirmedForBatch(pending, 'llm_result_unavailable', { allowKeywordless: true });
        return;
      }
    } else {
      // LLM 不可用 → 降级:丢弃 ambiguous 候选 (不触发 STRONG,避免误判泛滥)。
      // AUDIT-P2-01: 本降级分支没有执行任何 await —— async 函数体在首个 await 前
      // 同步执行，因此这里到达 queueUnconfirmedForBatch / countStage2Dropped 时仍在
      // detectSync（before_prompt_build）的同步调用栈上。健康计数写入已统一推迟到
      // 微任务；enqueueSignalConfirmation 的 SQLite 持久化保持同步（可靠性优先：
      // 候选落库不能被进程事件循环淘汰，AUDIT 整改明确禁止异步化队列记录）。
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_LLM_DEGRADED',
        'LLM unavailable, dropping candidate (no STRONG trigger)');
      // PRI-788 G2: 丢弃改持久化——通道恢复后批量确认，不再"通道死=信号丢"。
      this.queueUnconfirmedForBatch(pending, 'llm_unavailable');
      return;
    }

    // 3. 按 strength 分流
    const correctionTerms = pending.output.matchedTerms;
    if (confirmed.isSignal && confirmed.strength === 'STRONG') {
      // PRI-788 G3: LLM 确认是纠正 → 命中词记 TP（earned precision 证据）
      this.emitCueFeedback(correctionTerms, true);
      // PRI-788 G1: LLM 确认的纠正回写标志位。Stage1 写入时歧义候选置 0，若不
      // 回写，证据构建器与 correction_samples 闭环永远看不到这条纠正。标志位
      // 陈述"这条消息是纠正"的事实，独立于 pain 事件的 rate limit，故先于
      // routeStrong 执行。correctionTerms 为空时 cue 落 llm: 判词——保留
      // "消息经 LLM 确认为纠正"的事实，但不伪造关键词。
      this.writeBackConfirmedCorrection(pending.userTurnRowid, confirmed, correctionTerms);
      // PRI-788 G4: 健康度计数
      updateSignalHealth(this.wctx.stateDir, (s) => {
        s.stage2Confirmed += 1;
        s.lastStage2SuccessAt = new Date().toISOString();
      });
      this.routeStrong(confirmed, pending.sessionId, pending.text, pending.occurrenceId);
    } else {
      // LLM 判为普通消息 → 命中词记 FP
      this.emitCueFeedback(correctionTerms, false);
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
   *
   * Gate 3 review P1：零命中候选有一个例外——它已经作为 discovery 候选真实
   * 调用过 Stage-2（消费了 discovery 配额）。此时若 LLM 判为 correction、只是
   * 置信度没过 0.9 门槛，丢弃就等于把"保持 pending"偷偷变成"删除真纠正"。
   * 因此 LLM 已表态的路径传入 `allowKeywordless`；没有 LLM 的降级路径
   * （`llm_unavailable`）仍维持原过滤，避免普通消息无界入队。
   *
   * AUDIT-P2-01: stage2Queued 计数推迟到微任务执行（本方法可从无 await 的
   * 降级分支同步到达）；SQLite 入队本身保持同步——它是可靠性要求，不是旁路
   * 观测，微任务/事件循环淘汰不能承担丢候选的风险。
   */
  private queueUnconfirmedForBatch(
    pending: PendingSignal,
    reason: string,
    options: { allowKeywordless?: boolean } = {},
  ): void {
    const terms = pending.output.matchedTerms;
    const keywordCandidate = pending.output.matchedPrecision === 'ambiguous' && terms.length > 0;
    const keywordlessDiscovery = options.allowKeywordless === true
      && pending.output.needsLlmConfirmation
      && !keywordCandidate
      && terms.length === 0;
    if (pending.userTurnRowid === undefined) { // 无行可回写，持久化无意义
      this.countStage2Dropped();
      this.logConfirmationNotQueued(reason, 'no_user_turn_rowid');
      return;
    }
    if (!keywordCandidate && !keywordlessDiscovery) {
      this.countStage2Dropped();
      this.logConfirmationNotQueued(reason, 'keywordless_not_admitted');
      return;
    }
    const trajectory = this.wctx.trajectory;
    if (typeof trajectory?.enqueueSignalConfirmation !== 'function') {
      // 没有 writer 时静默"入队"会让日志与事实不符（rc-9）。
      this.countStage2Dropped();
      this.logConfirmationNotQueued(reason, 'no_confirmation_writer');
      return;
    }
    // PRI-2053: 归因必须在 Stage1 快照仍有效的此刻完成——批量恢复时 terms_json
    // 只有词、没有当时的类别。持久化命中词，suggestedType 恒为 correction。
    const correctionTerms = terms;
    const suggestedType = 'correction';
    try {
      trajectory.enqueueSignalConfirmation({
        sessionId: pending.sessionId,
        userTurnRowid: pending.userTurnRowid,
        occurrenceId: pending.occurrenceId,
        excerpt: pending.text.slice(0, 400),
        terms: correctionTerms,
        suggestedType,
        createdAt: new Date().toISOString(),
      });
      this.countStage2Queued();
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_CONFIRMATION_QUEUED',
        `${reason}; queued for batch confirmation (suggested=${suggestedType})`);
    } catch (e) {
      this.countStage2Dropped();
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_CONFIRMATION_QUEUE_FAIL',
        `enqueueSignalConfirmation threw: ${String(e)}`);
    }
  }

  /**
   * Gate 3 review P1: 候选未入队时留下结构化原因。此前该分支只做计数，
   * 日志仍写着"queued for batch confirmation"，线上无法区分"入队成功"与
   * "被过滤/无 writer 丢弃"（rc-9）。
   */
  private logConfirmationNotQueued(reason: string, dropReason: string): void {
    SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_CONFIRMATION_NOT_QUEUED',
      `${reason}; not queued (${dropReason})`);
  }

  /**
   * PRI-788 G4: 未经确认就消失的候选计数（旁路，失败不阻塞）。
   * AUDIT-P2-01: 推迟到微任务——本计数可从无 await 的降级分支同步到达，
   * 不能把健康文件读改写留在 before_prompt_build 的同步调用栈上。
   */
  private countStage2Dropped(): void {
    const stateDir = this.wctx.stateDir;
    queueMicrotask(() => {
      updateSignalHealth(stateDir, (s) => { s.stage2Dropped += 1; });
    });
  }

  /** AUDIT-P2-02: 入队计数（旁路），与 countStage2Dropped 同理推迟到微任务。 */
  private countStage2Queued(): void {
    const stateDir = this.wctx.stateDir;
    queueMicrotask(() => {
      updateSignalHealth(stateDir, (s) => { s.stage2Queued += 1; });
    });
  }

  /**
   * AUDIT-P2-02: Stage2 分类调用计数（旁路）。realtime 路径的调用点位于
   * detectSync 的同步调用栈上（async 函数体首个 await 前同步执行），批量路径
   * 虽在后台周期内，也复用同一惯例推迟到微任务，保证两种路径计数语义一致。
   */
  private countStage2Invocation(): void {
    const stateDir = this.wctx.stateDir;
    queueMicrotask(() => {
      updateSignalHealth(stateDir, (s) => { s.stage2Invocations += 1; });
    });
  }

  /**
   * 零命中发现调用的配额判定（纯内存,同步安全）。
   * 全局每小时最多 discoveryRateLimitPerHour 次，且每个 session 最多
   * discoveryRateLimitPerSessionPerHour 次；0/未设置 = 该维度不限制。
   *
   * 先判 session 再判全局：一个 session 达到自己的上限时不能继续消耗共享
   * 预算，否则"某个会话聊得多"仍会间接饿死其它会话的明确纠正。
   */
  private takeDiscoveryBudget(sessionId: string): { allowed: boolean } {
    const globalLimit = this.config.discoveryRateLimitPerHour ?? 0;
    if (globalLimit <= 0) return { allowed: true };
    const sessionLimit = this.config.discoveryRateLimitPerSessionPerHour ?? 0;
    const now = Date.now();

    if (now - this.discoveryBucket.windowStart >= ONE_HOUR_MS) {
      this.discoveryBucket = { count: 0, windowStart: now };
    }

    if (sessionLimit > 0) {
      const existing = this.discoverySessionBuckets.get(sessionId);
      const bucket: RateLimitBucket = !existing || now - existing.windowStart >= ONE_HOUR_MS
        ? { count: 0, windowStart: now }
        : existing;
      if (bucket.count >= sessionLimit) {
        this.discoverySessionBuckets.set(sessionId, bucket);
        this.reportDiscoveryExhaustion('session', sessionId, sessionLimit, bucket);
        return { allowed: false };
      }
      bucket.count += 1;
      this.discoverySessionBuckets.set(sessionId, bucket);
      this.pruneDiscoverySessionBuckets(now);
    }

    if (this.discoveryBucket.count >= globalLimit) {
      this.reportDiscoveryExhaustion('global', sessionId, globalLimit, this.discoveryBucket);
      return { allowed: false };
    }
    this.discoveryBucket.count += 1;
    return { allowed: true };
  }

  /**
   * 预算耗尽的结构化诊断：每小时窗口内每个 scope 只记一次 SYSTEM log，
   * 健康计数仍然逐次累加（stage2DiscoverySkipped）。既有"挡下了多少次"，
   * 也有"为什么被挡、是哪个 scope、上限多少"。
   */
  private reportDiscoveryExhaustion(
    scope: 'session' | 'global',
    sessionId: string,
    limit: number,
    bucket: RateLimitBucket,
  ): void {
    if (bucket.exhaustionLogged) return;
    bucket.exhaustionLogged = true;
    const sessionDigest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 12);
    SystemLogger.log(
      this.wctx.workspaceDir,
      'SIGNAL_DISCOVERY_BUDGET_EXHAUSTED',
      JSON.stringify({ scope, sessionDigest, limit, windowMs: ONE_HOUR_MS }),
    );
  }

  /** Expired session buckets carry no information; keep the map bounded. */
  private pruneDiscoverySessionBuckets(now: number): void {
    if (this.discoverySessionBuckets.size <= 64) return;
    for (const [key, bucket] of this.discoverySessionBuckets) {
      if (now - bucket.windowStart >= ONE_HOUR_MS) this.discoverySessionBuckets.delete(key);
    }
  }

  /** 被配额挡下的零命中发现计数（旁路，同 countStage2* 推迟到微任务）。 */
  private countStage2DiscoverySkipped(): void {
    const stateDir = this.wctx.stateDir;
    queueMicrotask(() => {
      updateSignalHealth(stateDir, (s) => { s.stage2DiscoverySkipped += 1; });
    });
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
   * none → rejected；classifier 失败 → failed（调用方
   * attempts++，达上限转 abandoned）。
   */
  async confirmPendingSignal(
    item: {
      sessionId: string;
      userTurnRowid: number;
      occurrenceId: string;
      excerpt: string;
      terms?: readonly string[];
      /**
       * PRI-2053: `terms` 是否为「enqueue 时按 Stage1 快照筛出的 correction 类
       * 命中词」。缺省 / false ⇒ 归因不可信（旧格式队列项），保守降级为无关键词
       * 证据（rc-9：降级可见，不伪造）。
       */
      termsVerified?: boolean;
    },
    classifier: SignalLlmClassifier,
  ): Promise<{ disposition: 'confirmed' | 'rejected' | 'failed'; detail: string }> {
    // AUDIT-P2-02: 批量确认的补跑同样是一次真实的 Stage2 分类调用（花钱），
    // 与 realtime 路径共用 stage2Invocations 计数。
    this.countStage2Invocation();
    let llmResult: Awaited<ReturnType<SignalLlmClassifier>> = null;
    try {
      // Gate 3: the batch path has no session snapshot at hand; omitting the
      // context makes the prompt say "facts unavailable" instead of implying
      // prior assistant behavior. Gate behaviour stays pre-Gate-3 here.
      llmResult = await classifier(item.excerpt);
    } catch (e) {
      return { disposition: 'failed', detail: `classifier threw: ${String(e)}` };
    }
    if (!llmResult) return { disposition: 'failed', detail: 'classifier unavailable' };
    // SPEC v0.3 §3.3 P-3：低置信度不是终态——failed 让调用方 attempts++，
    // 达上限转 abandoned；不确定性的保留与 LLM 通道故障使用同一状态机。
    const gate = evaluateStage2ConfidenceGate(llmResult);
    if (gate.verdict === 'pending_low_confidence') {
      return { disposition: 'failed', detail: `low_confidence (${String(gate.confidence)})` };
    }
    const confirmed = mapLlmResultToOutput(llmResult, item.excerpt, item.sessionId, this.config, new Date().toISOString());
    // PRI-2053 归因边界：恢复侧没有 Stage1 快照，只能使用入队时已验证的词集。
    // 旧格式队列项无法恢复当时的类别 → 保守降级为空集：不把推测类别当作事实，
    // 但消息级纠正事实照常保留（llm: 判词 + routeStrong）。
    const correctionTerms = item.termsVerified ? (item.terms ?? []) : [];
    if (item.termsVerified !== true && (item.terms?.length ?? 0) > 0) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_CONFIRMATION_ATTRIBUTION_UNVERIFIED',
        'queued signal carries unclassified Stage1 hits (pre-PRI-2053 row); correction-word attribution skipped, message-level correction preserved');
    }
    if (confirmed.isSignal && confirmed.strength === 'STRONG') {
      this.emitCueFeedback(correctionTerms, true);
      this.writeBackConfirmedCorrection(item.userTurnRowid, confirmed, correctionTerms);
      // PRI-844: recover the Owner's VERBATIM turn — the persisted queue only
      // stores a 400-char excerpt. turnIndex comes from the numeric
      // occurrenceId; the full text comes from the user_turns row via rowid.
      // Both degrade gracefully: no row → the excerpt is the honest fallback.
      const turnIndexFromOccurrence = /^\d+$/.test(item.occurrenceId) ? Number(item.occurrenceId) : undefined;
      let storedTurn: { turnIndex: number; text: string; referencesAssistantTurnId: number | null; occurredAt: string } | undefined;
      try {
        storedTurn = this.wctx.trajectory.getCorrectionTurnByRowid(item.userTurnRowid);
      } catch {
        storedTurn = undefined;
      }
      this.routeStrong(confirmed, item.sessionId, storedTurn?.text ?? item.excerpt, item.occurrenceId, {
        turnIndex: storedTurn?.turnIndex ?? turnIndexFromOccurrence,
        referencesAssistantTurnId: storedTurn?.referencesAssistantTurnId ?? undefined,
        occurredAt: storedTurn?.occurredAt,
      });
      return { disposition: 'confirmed', detail: confirmed.llmReason ?? 'confirmed correction' };
    }
    this.emitCueFeedback(correctionTerms, false);
    return { disposition: 'rejected', detail: confirmed.llmReason ?? 'classified none' };
  }

  /**
   * PRI-788 G1: Stage2 确认为纠正后回写 user_turns.correction_detected（G1）。
   * 以 Stage1 写入返回的 rowid 精确寻址（rc-7）；rowid 缺失/行已不存在均为
   * 可观测降级，不阻塞路由。
   */
  private writeBackConfirmedCorrection(
    userTurnRowid: number | undefined,
    confirmed: SignalCollectorOutput,
    matchedTerms: readonly string[],
  ): void {
    if (userTurnRowid === undefined) return;
    // correction_cue means "which keyword fired". Overwriting it with the
    // Stage2 verdict prose destroyed exactly the evidence the keyword optimizer
    // needs to attribute a correction to a term, and the prose was then echoed
    // back into correction_keywords.json as a whole-sentence "term". Verdict
    // prose is only used when no keyword fired at all.
    // matchedTerms is required, not defaulted from `confirmed`: the Stage2
    // verdict object always carries an empty list, so reading it back would
    // silently fall into the prose branch for every keyword hit.
    const cue = matchedTerms.length > 0
      ? matchedTerms.join(', ')
      : (confirmed.llmReason ? `llm:${confirmed.llmReason.slice(0, 120)}` : null);
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
  /**
   * PD-BEHAVIOR-FIDELITY-001 Gate 3: assemble the conversation facts Stage-2
   * was missing.
   *
   * Read-only and bounded. Two contract points:
   * - `priorAssistantTurnCount: null` means UNKNOWN (no trajectory writer or a
   *   failed read), never 0. A read failure must not be reported as "this
   *   session had no assistant behavior".
   * - The snapshot is taken before the classifier await, i.e. before the
   *   assistant replies to this message, so it is exactly "prior turns".
   */
  private buildStage2Context(
    sessionId: string,
    referencesAssistantTurnId?: number | null,
  ): Stage2ConversationContext {
    const trajectory = this.wctx.trajectory;
    if (!trajectory) {
      // Distinguishable from "this session had no assistant behavior": ops must
      // be able to tell a host without a trajectory writer from a genuine
      // first message (Gate 3 review P2).
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_STAGE2_CONTEXT_UNAVAILABLE', 'no_trajectory_writer');
      return { priorAssistantTurnCount: null, recentAssistantTurns: [] };
    }
    if (typeof trajectory.getAssistantTurnContext !== 'function') {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_STAGE2_CONTEXT_UNAVAILABLE',
        'no_assistant_turn_context_reader');
      return { priorAssistantTurnCount: null, recentAssistantTurns: [] };
    }
    try {
      const anchorId = typeof referencesAssistantTurnId === 'number' ? referencesAssistantTurnId : undefined;
      // Narrow read: count + last N sanitized summaries + optional anchor. The
      // analytics reader (`listAssistantTurns`) fetches every turn including
      // raw_text, which is both unbounded and unnecessary on this synchronous
      // before_prompt_build stack (Gate 3 review P2).
      const context = trajectory.getAssistantTurnContext(sessionId, {
        recentLimit: STAGE2_CONTEXT_TURN_LIMIT,
        ...(anchorId !== undefined ? { anchorTurnId: anchorId } : {}),
      });
      const bounded = (text: string): string =>
        text.replace(/\s+/g, ' ').trim().slice(0, STAGE2_CONTEXT_TURN_MAX_CHARS);
      const recent = context.recentTurns.map((turn) => ({
        summary: bounded(turn.sanitizedText),
        referenced: anchorId !== undefined && turn.id === anchorId,
      }));
      if (context.anchorTurn) {
        recent.unshift({ summary: bounded(context.anchorTurn.sanitizedText), referenced: true });
      }
      return {
        priorAssistantTurnCount: context.priorTurnCount,
        recentAssistantTurns: recent,
        ...(anchorId !== undefined ? { referencedAssistantTurnId: anchorId } : {}),
      };
    } catch (e) {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_STAGE2_CONTEXT_UNAVAILABLE', String(e));
      return { priorAssistantTurnCount: null, recentAssistantTurns: [] };
    }
  }

  private routeStrong(
    output: SignalCollectorOutput,
    sessionId: string,
    text: string,
    occurrenceId: string,
    turnProvenance?: { turnIndex?: number; referencesAssistantTurnId?: number | null; occurredAt?: string },
  ): void {
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
          // PRI-844: the Owner's verbatim message as FIRST-CLASS evidence —
          // the 200-char excerpt above stays for compatibility, but the
          // diagnosis prompt now sees the full original sentence.
          correctionEvidence: {
            text,
            sessionId,
            turnIndex: turnProvenance?.turnIndex,
            referencesAssistantTurnId: turnProvenance?.referencesAssistantTurnId ?? undefined,
            occurredAt: turnProvenance?.occurredAt ?? new Date().toISOString(),
          },
        },
      },
      { recordObservability: true },
    ).catch((e) => {
      SystemLogger.log(this.wctx.workspaceDir, 'SIGNAL_EMIT_FAIL',
        `emitPainDetectedEvent failed: ${String(e)}`);
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

/**
 * 从 .pd/config.yaml 的 signalCollector runtimeProfile 构造 SignalLlmClassifier。
 * 完成配置单轨化(spec §3.3 决策3):统一走 .pd/config.yaml,移除 empathy 的 workflows.yaml 双轨。
 *
 * 返回 null 的情况(走纯关键词降级):
 * - feature flag signal_collector 关闭（Owner 刻意关闭 → debug 级，不算告警）
 * - runtimeProfile 未配置 / apiKeyEnv 缺失 / profile 是 openclaw 类型
 *   → PRI-797: **WARN 级显性提醒**（每 workspace 一次，rc-9 不静默）——
 *     语义确认链（歧义词纠正判定/批量确认/TP 记录）此刻全部停摆，
 *     Owner 必须可感知，而不是翻 7 天滚动日志才能发现。
 *
 * 这是 Task 11 的最后一块:让本地 LLM(LMStudio)真正参与检测。
 */

/** 每个 workspace 只告警一次（进程生命周期内），避免每次构建 host 都刷屏。 */
const signalClassifierWarnedWorkspaces = new Set<string>();

/** 测试专用：清空告警去重状态。 */
export function _resetSignalClassifierWarnState(): void {
  signalClassifierWarnedWorkspaces.clear();
}

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
      // PRI-797: needs_setup / config_malformed = 配置不完整，语义确认链停摆——
      // 这是 Owner 必须看见的状态（ERR-101 静默失败家族），升 WARN 并去重。
      const message = `[PD:Signal] 语义纠正检测降级为关键词-only (${cfg.readiness}): ${cfg.reason}. ${cfg.nextAction}`;
      const warnKey = `${wctx.workspaceDir}:${cfg.readiness}`;
      if (!signalClassifierWarnedWorkspaces.has(warnKey)) {
        signalClassifierWarnedWorkspaces.add(warnKey);
        logger?.warn?.(message);
        SystemLogger.log(wctx.workspaceDir, 'SIGNAL_CLASSIFIER_NEEDS_SETUP', message);
      }
      return null;
    }
    if (!cfg.provider || !cfg.model || !cfg.apiKeyEnv) {
      logger?.debug?.(`[PD:Signal] LLM classifier missing provider/model/apiKeyEnv`);
      return null;
    }

    // B4: the adapter call lives in @principles/host-runtime so Codex and
    // WorkBuddy workers consume the SAME Stage-2 implementation.
    const shared = createSignalLlmClassifier(
      {
        provider: cfg.provider,
        model: cfg.model,
        apiKeyEnv: cfg.apiKeyEnv,
        timeoutMs: cfg.timeoutMs ?? 30_000,
        // PRI-788 G3: profile 的 maxTokens 透传（思考型本地模型小 token 预算会返回空）
        ...(cfg.maxTokens !== null && cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
        ...(cfg.baseUrl !== null && cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
      },
      wctx.workspaceDir,
      { log: (event, detail) => SystemLogger.log(wctx.workspaceDir, event, detail) },
    );
    // Gate 3: forward the host-owned conversation facts into the ONE shared
    // Stage-2 implementation (no second classifier).
    return async (text: string, context?: Stage2ConversationContext) => {
      return shared(text, context ? { context } : undefined);
    };
  } catch (e) {
    logger?.warn?.(`[PD:Signal] createSignalLlmClassifierFromConfig failed: ${String(e)}`);
    return null;
  }
}

