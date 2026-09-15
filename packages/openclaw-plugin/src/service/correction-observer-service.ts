import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import {
    PiAiRuntimeAdapter,
    CorrectionObserver,
    AgentScheduler,
} from '@principles/core/runtime-v2';
import { KeywordOptimizationService } from './keyword-optimization-service.js';
import { SystemLogger } from '../core/system-logger.js';
import { resolveObserverConfig } from '../core/pd-config-loader.js';
import { createSignalLlmClassifierFromConfig } from '../core/signal-collector-host.js';
import { getSignalCollectorHost } from '../hooks/prompt.js';
import { updateSignalHealth } from '../core/signal-health.js';

export interface CorrectionObserverServiceShape {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void;
    stop?: (ctx: OpenClawPluginServiceContext) => void;
}

let correctionObserverTimeoutId: ReturnType<typeof setTimeout> | null = null;
let correctionObserverStopped = false;
/**
 * PRI-788 G2: 单消费者边界——同一进程内任意时刻只允许一个周期在跑。
 * `runCycle` 会等上一周期结束再调度下一周期，但 `stop` 只清定时器、不取消
 * 正在 await classifier 的周期；随后 `start` 又把 `correctionObserverStopped`
 * 置回 false。没有这道闸，stop→start 后新旧周期会同时读到同一批 pending，
 * 两边都执行 emitCueFeedback / routeStrong，而 markSignalConfirmationResult
 * 只对 pending 生效，于是关键词 TP/FP 与 STRONG 路由被记录两次。
 *
 * 取"单消费者边界"而不是 DB 层 `pending → processing` 认领：审查意见本身允许
 * 二者等价（"或使用等价的单消费者边界"）。被描述的竞态是**进程内**的
 * （stop 不取消在途周期 → start 复活），边界 + epoch 已完整覆盖；而给
 * `signal_confirmations.status` 增加 'processing' 需要改 CHECK 约束，该表由
 * PRI-790/791/792 三个并行 PR 共同创建，只有其中一个改 CHECK 会让另一个建的
 * 库拒绝 'processing'（`CREATE TABLE IF NOT EXISTS` 不会迁移既有表），
 * 反而引入更危险的静默失效。
 */
let correctionObserverCycleRunning = false;
/**
 * PRI-788 G2: 每次 start/stop 递增。周期在开始时捕获自己的 epoch；一旦 epoch
 * 变化（服务被 stop 或 stop→start 重启过），旧周期不再继续写任何状态。
 * 与单消费者边界互补：边界防并发，epoch 防"停顿后复活"的旧周期。
 */
let correctionObserverEpoch = 0;
const startedWorkspaces = new Set<string>();

const CORRECTION_OBSERVER_INTERVAL_MS = 15 * 60 * 1000;
const CORRECTION_OBSERVER_INITIAL_DELAY_MS = 10_000;
const CORRECTION_OBSERVER_MAX_RECENT_SESSIONS = 20;
const CORRECTION_OBSERVER_MAX_PAYLOAD_SESSIONS = 5;

/** PRI-788 G2: 每周期批量确认的待确认信号条数上限。 */
const SIGNAL_CONFIRM_BATCH_LIMIT = 20;
/** PRI-788 G2: 单条候选确认失败次数上限，超过转 abandoned（不再重试）。 */
const SIGNAL_CONFIRM_MAX_ATTEMPTS = 5;

/**
 * PRI-788 G2: 批量确认 signal_confirmations 里的 pending 候选。
 *
 * 用每周期新鲜解析的 signal classifier 重新分类——检测时 LLM 不可用而入队的
 * 候选，在通道恢复后由这里补确认：correction → 回写标志位 + 复用 realtime
 * STRONG 分流（同一限流桶/pain 身份派生）；none → rejected；连续失败达上限
 * → abandoned。classifier 本身不可用（通道仍死）时整批跳过、不计失败次数。
 *
 * @returns 本轮 resolved（confirmed/rejected/abandoned）条数。
 * @param isStale 可选：返回 true 时停止继续处理（服务已 stop / 已重启），
 *   用于让旧周期在 stop→start 之后不再写状态（单消费者边界的第二道闸）。
 */
export async function batchConfirmPendingSignals(
    wctx: WorkspaceContext,
    logger: PluginLogger,
    isStale?: () => boolean,
): Promise<number> {
    const trajectory = wctx.trajectory;
    if (!trajectory?.listPendingSignalConfirmations) return 0;
    const pending = trajectory.listPendingSignalConfirmations(SIGNAL_CONFIRM_BATCH_LIMIT);
    if (pending.length === 0) return 0;

    const classifier = createSignalLlmClassifierFromConfig(wctx, logger);
    if (!classifier) {
        logger?.debug?.('[PD:CorrectionObserver] batch confirm skipped: signal classifier unavailable');
        return 0;
    }
    // 共享 realtime host：确认补发 pain 走同一限流桶与身份派生（ADR-0020 §11.4）。
    const host = getSignalCollectorHost(wctx, logger);

    let resolved = 0;

    /**
     * 单条候选确认失败一次：attempts++，达上限转 abandoned。
     * `failed` disposition 与"抛异常"共用同一套计数/终止规则——确定性失败
     * （classifier 每次都抛）也必须能走到 abandoned，否则它会以最低 attempts
     * 永久留在队首，反复占用批次容量并阻塞后续候选。
     */
    const recordFailedAttempt = (id: string, detail: string): void => {
        const attempts = trajectory.bumpSignalConfirmationAttempt(id);
        if (attempts >= SIGNAL_CONFIRM_MAX_ATTEMPTS) {
            trajectory.markSignalConfirmationResult(id, 'abandoned', `attempts exhausted (${attempts}): ${detail}`);
            resolved++;
            SystemLogger.log(wctx.workspaceDir, 'SIGNAL_CONFIRMATION_ABANDONED', `${id} after ${attempts} attempts`);
        }
    };

    for (const item of pending) {
        // 服务已 stop / 已重启 ⇒ 旧周期立即停手，不与新周期争同一批 pending。
        if (isStale?.()) break;
        try {
            const result = await host.confirmPendingSignal(
                {
                    sessionId: item.sessionId,
                    userTurnRowid: item.userTurnRowid,
                    occurrenceId: item.occurrenceId,
                    excerpt: item.excerpt,
                    terms: item.terms,
                },
                classifier,
            );
            if (result.disposition === 'failed') {
                recordFailedAttempt(item.id, result.detail);
                continue;
            }
            trajectory.markSignalConfirmationResult(item.id, result.disposition, result.detail);
            resolved++;
            if (result.disposition === 'confirmed') {
                updateSignalHealth(wctx.stateDir, (s) => {
                    s.stage2Confirmed += 1;
                    s.lastStage2SuccessAt = new Date().toISOString();
                });
            }
            SystemLogger.log(wctx.workspaceDir, 'SIGNAL_CONFIRMATION_RESOLVED',
                `${item.id} -> ${result.disposition} (${result.detail.slice(0, 80)})`);
        } catch (err) {
            // 单条失败不中断整批（rc-9）；该条仍 pending，下一周期重试，
            // 但必须累加 attempts 才能最终 abandoned。
            logger?.warn?.(`[PD:CorrectionObserver] confirm failed for ${item.id}: ${String(err)}`);
            recordFailedAttempt(item.id, `threw: ${String(err)}`);
        }
    }
    return resolved;
}

/**
 * PRI-307: Resolve CorrectionObserver from .pd/config.yaml.
 *
 * States:
 * - disabled: feature flag off → return null, no noisy logs
 * - needs_setup: enabled but missing API key or profile → return null with structured reason
 * - ready/not_ready: enabled and configured → return observer instance
 */
export function resolveCorrectionObserver(wctx: WorkspaceContext, logger?: Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'>): CorrectionObserver | null {
    try {
        const observerConfig = resolveObserverConfig(
            wctx.workspaceDir,
            'correction_observer',
            'correctionObserver',
            logger,
        );

        if (!observerConfig.enabled) {
            if (observerConfig.readiness === 'config_malformed') {
                logger?.warn?.(`[PD:CorrectionObserver] Config malformed: ${observerConfig.reason}. ${observerConfig.nextAction}`);
            } else {
                logger?.debug?.(`[PD:CorrectionObserver] ${observerConfig.reason}`);
            }
            return null;
        }

        if (observerConfig.readiness === 'needs_setup') {
            logger?.info?.(`[PD:CorrectionObserver] ${observerConfig.reason}. ${observerConfig.nextAction}`);
            return null;
        }

        // ready or not_ready — create the observer
        if (observerConfig.runtimeProfileType === 'pi-ai') {
            const adapter = new PiAiRuntimeAdapter({
                provider: observerConfig.provider ?? 'anthropic',
                model: observerConfig.model ?? 'anthropic/claude-3-5-sonnet',
                apiKeyEnv: observerConfig.apiKeyEnv ?? 'ANTHROPIC_API_KEY',
                timeoutMs: observerConfig.timeoutMs ?? undefined,
                // PRI-788 G3: profile 的 maxTokens 透传（思考型本地模型小 token 预算会返回空）
                maxTokens: observerConfig.maxTokens ?? undefined,
                baseUrl: observerConfig.baseUrl ?? undefined,
                workspace: wctx.workspaceDir,
            });
            return new CorrectionObserver({ runtimeAdapter: adapter }, { timeoutMs: observerConfig.timeoutMs ?? undefined });
        }

        // OpenClaw profile — not yet supported for observer runtime
        logger?.info?.(`[PD:CorrectionObserver] OpenClaw runtime profile not yet supported for correction observer. Skipping.`);
        return null;
    } catch (err) {
        logger?.warn?.(`[PD:CorrectionObserver] Failed to resolve CorrectionObserver: ${String(err)}`);
        return null;
    }
}

/** PRI-788 G4: 周期成功/失败计数（旁路；成功归零连续失败计数）。 */
function recordObserverCycleOutcome(wctx: WorkspaceContext, ok: boolean): void {
    updateSignalHealth(wctx.stateDir, (s) => {
        if (ok) {
            s.observerLastSuccessAt = new Date().toISOString();
            s.observerConsecutiveFailures = 0;
        } else {
            s.observerConsecutiveFailures += 1;
        }
    });
}

export async function runCorrectionObserverCycle(
    wctx: WorkspaceContext,
    logger: PluginLogger,
    isStale?: () => boolean,
): Promise<void> {
    try {
        // PRI-788 G2: 先批量确认持久化的待确认信号——独立于 observer 本身的
        // 解析结果（observer 未就绪时，信号补确认仍应进行）。
        const confirmedCount = await batchConfirmPendingSignals(wctx, logger, isStale);
        if (confirmedCount > 0) {
            logger?.info?.(`[PD:CorrectionObserver] batch-confirmed ${confirmedCount} pending signals`);
        }
        // 服务在等待 classifier 期间被 stop/重启 ⇒ 本轮其余（会写 keyword store
        // 与 signal-health）不再执行，也不计成功/失败轮。
        if (isStale?.()) return;
        // PRI-788 G4: 刷新队列深度快照
        updateSignalHealth(wctx.stateDir, (s) => {
            s.pendingCount = wctx.trajectory?.countPendingSignalConfirmations?.() ?? s.pendingCount;
        });

        const observer = resolveCorrectionObserver(wctx, logger);
        if (!observer) {
            // PRI-307: No noisy "no API key" cycling. Only log at debug level.
            logger?.debug?.(`[PD:CorrectionObserver] Observer not resolved. Skipping cycle.`);
            // G4: 周期正常完成（observer 未配置不是失败）
            recordObserverCycleOutcome(wctx, true);
            return;
        }

        logger?.info?.('[PD:CorrectionObserver] Observer resolved. Initiating periodic optimization...');

        const db = TrajectoryRegistry.get(wctx.workspaceDir);
        const recentSessions = db.listRecentSessions({ limit: CORRECTION_OBSERVER_MAX_RECENT_SESSIONS });
        const recentSessionIds = recentSessions.map(s => s.sessionId);

        if (recentSessionIds.length === 0) {
            logger?.info?.('[PD:CorrectionObserver] No recent sessions found. Skipping correction optimization.');
            return;
        }

        const recentMessages: string[] = [];
        for (const sId of recentSessionIds.slice(0, CORRECTION_OBSERVER_MAX_PAYLOAD_SESSIONS)) {
            try {
                const turns = db.listUserTurnsForSession(sId);
                for (const t of turns) {
                    if (t.rawExcerpt) {
                        recentMessages.push(t.rawExcerpt);
                    }
                }
            } catch (turnErr) {
                logger?.warn?.(`[PD:CorrectionObserver] Failed to load user turns for session ${sId}: ${String(turnErr)}`);
            }
        }

        const learner = CorrectionCueLearner.get(wctx.stateDir);
        const keywords = learner.getStore().keywords;
        // PRI-812: hitCount 不再投影——recordHits 已删除（死写者），该字段在
        // payload 里结构性恒 0，只会喂养 prompt 里失真的 REMOVE 判据。
        const keywordStoreSummary = {
            totalKeywords: keywords.length,
            terms: keywords.map(k => ({
                term: k.term,
                weight: k.weight,
                truePositiveCount: k.truePositiveCount ?? 0,
                falsePositiveCount: k.falsePositiveCount ?? 0,
            })),
        };

        const optimizationService = KeywordOptimizationService.get(wctx.stateDir, wctx.workspaceDir, logger);
        const trajectoryHistory = await optimizationService.buildTrajectoryHistory(recentSessionIds);

        const payload = {
            parentSessionId: 'correction-observer-service',
            workspaceDir: wctx.workspaceDir,
            keywordStoreSummary,
            recentMessages,
            trajectoryHistory,
        };

        const scheduler = new AgentScheduler();
        scheduler.register({
            agentId: 'correction-observer',
            mode: 'realtime',
            runner: observer,
        });

        logger?.info?.(`[PD:CorrectionObserver] Dispatching with ${trajectoryHistory.length} trajectory events, ${recentMessages.length} recent messages.`);
        const result = await scheduler.dispatch('correction-observer', payload);
        logger?.info?.(`[PD:CorrectionObserver] Completed: updated=${result.updated}, summary="${result.summary}"`);

        // dispatch 期间可能被 stop/重启 ⇒ 不再写 keyword store / 健康度。
        if (isStale?.()) return;
        // PRI-812: 无条件投递——FP-only 裁决（updated=false 但 fpTerms 非空）
        // 是 earned-high 降级闭环的唯一自动反证来源，applyResult 内部把
        // store mutations 与 FP 记录分开处理，空结果只记 info 不产生变更。
        optimizationService.applyResult(result);
        // PRI-788 G4: 整个周期成功（含 observer 未配置的 no-op 轮）
        recordObserverCycleOutcome(wctx, true);
    } catch (err) {
        const errMsg = `Correction observer cycle failed: ${String(err)}`;
        logger?.warn?.(`[PD:CorrectionObserver] ${errMsg}`);
        SystemLogger.log(wctx.workspaceDir, 'CORRECTION_OBSERVER_CYCLE_FAILED', errMsg);
        // PRI-788 G4: 失败计数上浮到健康产物（doctor 呈现 degraded）。
        // 若本轮已因 stop/重启失效，则不再把失败记到新一代的计数上。
        if (!isStale?.()) {
            recordObserverCycleOutcome(wctx, false);
        }
    }
}

export const CorrectionObserverService: CorrectionObserverServiceShape = {
    id: 'principles-correction-observer',

    start(ctx: OpenClawPluginServiceContext): void {
        const workspaceDir = ctx?.workspaceDir;
        const logger = ctx?.logger || console;

        if (!workspaceDir) {
            if (logger) logger.warn('[PD:CorrectionObserver] workspaceDir not found in service config. Correction observer disabled.');
            return;
        }

        if (startedWorkspaces.has(workspaceDir)) {
            if (logger) logger.info(`[PD:CorrectionObserver] Already started for workspace: ${workspaceDir}. Skipping duplicate start.`);
            return;
        }

        // PRI-307: Check observer config before starting
        const observerConfig = resolveObserverConfig(
            workspaceDir,
            'correction_observer',
            'correctionObserver',
            logger,
        );

        if (!observerConfig.enabled) {
            // Disabled → no start, no noisy cycling. Single structured log.
            logger?.info?.(`[PD:CorrectionObserver] ${observerConfig.reason}. ${observerConfig.nextAction}`);
            return;
        }

        if (observerConfig.readiness === 'needs_setup') {
            // Enabled but missing setup → structured needs_setup, no noisy cycling
            logger?.info?.(`[PD:CorrectionObserver] ${observerConfig.reason}. ${observerConfig.nextAction}`);
            return;
        }

        startedWorkspaces.add(workspaceDir);
        correctionObserverStopped = false;
        // 新一代 epoch：任何仍在 await 的旧周期（来自上一次 start）就此失效。
        correctionObserverEpoch += 1;
        const myEpoch = correctionObserverEpoch;

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
        if (logger) logger.info(`[PD:CorrectionObserver] Starting with workspaceDir=${wctx.workspaceDir}, stateDir=${wctx.stateDir}`);

        const interval = CORRECTION_OBSERVER_INTERVAL_MS;

        /** 本轮（或本代服务）是否已失效：被 stop 过，或已 stop→start 换过代。 */
        const isStale = () => correctionObserverStopped || myEpoch !== correctionObserverEpoch;

        async function runCycle(): Promise<void> {
            if (isStale()) return;
            // 单消费者边界：上一周期（可能来自 stop 之前的旧 start）尚未结束时不重入。
            if (correctionObserverCycleRunning) return;
            correctionObserverCycleRunning = true;
            try {
                await runCorrectionObserverCycle(wctx, logger, isStale);
            } finally {
                correctionObserverCycleRunning = false;
            }
            if (isStale()) return;
            correctionObserverTimeoutId = setTimeout(runCycle, interval);
            correctionObserverTimeoutId.unref();
        }

        correctionObserverTimeoutId = setTimeout(() => {
            void runCycle().catch((err) => {
                if (logger) logger.error(`[PD:CorrectionObserver] Startup cycle failed: ${String(err)}`);
                if (isStale()) return;
                correctionObserverTimeoutId = setTimeout(runCycle, interval);
                correctionObserverTimeoutId.unref();
            });
        }, CORRECTION_OBSERVER_INITIAL_DELAY_MS);
        correctionObserverTimeoutId.unref();
    },

    stop(_ctx: OpenClawPluginServiceContext): void {
        correctionObserverStopped = true;
        // 使在途周期失效：它可能在 classifier await 期间观察到 stopped=false（若
        // 期间发生过 start），epoch 递增保证它不会继续写状态。
        correctionObserverEpoch += 1;
        startedWorkspaces.clear();
        if (correctionObserverTimeoutId) clearTimeout(correctionObserverTimeoutId);
        correctionObserverTimeoutId = null;
    },
};
