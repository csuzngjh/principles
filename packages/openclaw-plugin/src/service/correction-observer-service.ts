import type { OpenClawPluginServiceContext, PluginLogger } from '../openclaw-sdk.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { CorrectionCueLearner } from '../core/correction-cue-learner.js';
import {
    WorkflowFunnelLoader,
    PiAiRuntimeAdapter,
    CorrectionObserver,
    AgentScheduler,
} from '@principles/core/runtime-v2';
import { KeywordOptimizationService } from './keyword-optimization-service.js';
import { SystemLogger } from '../core/system-logger.js';

export interface CorrectionObserverServiceShape {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void;
    stop?: (ctx: OpenClawPluginServiceContext) => void;
}

let correctionObserverTimeoutId: ReturnType<typeof setTimeout> | null = null;
let correctionObserverStopped = false;

const CORRECTION_OBSERVER_INTERVAL_MS = 15 * 60 * 1000;
const CORRECTION_OBSERVER_INITIAL_DELAY_MS = 10_000;
const CORRECTION_OBSERVER_MAX_RECENT_SESSIONS = 20;
const CORRECTION_OBSERVER_MAX_PAYLOAD_SESSIONS = 5;

export function resolveCorrectionObserver(wctx: WorkspaceContext, logger?: Pick<PluginLogger, 'info' | 'warn' | 'error' | 'debug'>): CorrectionObserver | null {
    try {
        const loader = new WorkflowFunnelLoader(wctx.stateDir);
        const funnel = loader.getFunnel('pd-correction-observer');
        const policy = funnel?.policy;
        if (!policy || policy.runtimeKind !== 'pi-ai') {
            logger?.debug?.('[PD:CorrectionObserver] workflows.yaml pd-correction-observer policy not found. Falling back to environment variables.');
            const provider = process.env.PD_CORRECTION_PROVIDER || 'anthropic';
            const model = process.env.PD_CORRECTION_MODEL || 'anthropic/claude-3-5-sonnet';
            const apiKeyEnv = process.env.PD_CORRECTION_API_KEY_ENV || 'ANTHROPIC_API_KEY';
            const baseUrl = process.env.PD_CORRECTION_BASE_URL;

            if (!process.env[apiKeyEnv]) {
                logger?.debug?.(`[PD:CorrectionObserver] API key env ${apiKeyEnv} is not set. Periodic optimization disabled.`);
                return null;
            }

            const adapter = new PiAiRuntimeAdapter({
                provider,
                model,
                apiKeyEnv,
                baseUrl,
                workspace: wctx.workspaceDir,
            });
            return new CorrectionObserver({ runtimeAdapter: adapter });
        }

        const adapter = new PiAiRuntimeAdapter({
            provider: String(policy.provider),
            model: String(policy.model),
            apiKeyEnv: String(policy.apiKeyEnv),
            maxRetries: policy.maxRetries,
            timeoutMs: policy.timeoutMs ?? 30_000,
            baseUrl: policy.baseUrl,
            workspace: wctx.workspaceDir,
        });
        return new CorrectionObserver({ runtimeAdapter: adapter }, { timeoutMs: policy.timeoutMs });
    } catch (err) {
        logger?.warn?.(`[PD:CorrectionObserver] Failed to resolve CorrectionObserver: ${String(err)}`);
        return null;
    }
}

export async function runCorrectionObserverCycle(wctx: WorkspaceContext, logger: PluginLogger): Promise<void> {
    try {
        const observer = resolveCorrectionObserver(wctx, logger);
        if (!observer) {
            logger?.info?.('[PD:CorrectionObserver] Observer not resolved (no API key or config). Skipping cycle.');
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
        const keywordStoreSummary = {
            totalKeywords: keywords.length,
            terms: keywords.map(k => ({
                term: k.term,
                weight: k.weight,
                hitCount: k.hitCount ?? 0,
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

        if (result.updated) {
            optimizationService.applyResult(result);
        }
    } catch (err) {
        const errMsg = `Correction observer cycle failed: ${String(err)}`;
        logger?.warn?.(`[PD:CorrectionObserver] ${errMsg}`);
        SystemLogger.log(wctx.workspaceDir, 'CORRECTION_OBSERVER_CYCLE_FAILED', errMsg);
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

        correctionObserverStopped = false;

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, ...ctx.config });
        if (logger) logger.info(`[PD:CorrectionObserver] Starting with workspaceDir=${wctx.workspaceDir}, stateDir=${wctx.stateDir}`);

        const interval = CORRECTION_OBSERVER_INTERVAL_MS;

        async function runCycle(): Promise<void> {
            if (correctionObserverStopped) return;
            await runCorrectionObserverCycle(wctx, logger);
            if (correctionObserverStopped) return;
            correctionObserverTimeoutId = setTimeout(runCycle, interval);
            correctionObserverTimeoutId.unref();
        }

        correctionObserverTimeoutId = setTimeout(() => {
            void runCycle().catch((err) => {
                if (logger) logger.error(`[PD:CorrectionObserver] Startup cycle failed: ${String(err)}`);
                if (correctionObserverStopped) return;
                correctionObserverTimeoutId = setTimeout(runCycle, interval);
                correctionObserverTimeoutId.unref();
            });
        }, CORRECTION_OBSERVER_INITIAL_DELAY_MS);
        correctionObserverTimeoutId.unref();
    },

    stop(_ctx: OpenClawPluginServiceContext): void {
        correctionObserverStopped = true;
        if (correctionObserverTimeoutId) clearTimeout(correctionObserverTimeoutId);
        correctionObserverTimeoutId = null;
    },
};
