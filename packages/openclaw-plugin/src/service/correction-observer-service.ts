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

export interface CorrectionObserverServiceShape {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void;
    stop?: (ctx: OpenClawPluginServiceContext) => void;
}

let correctionObserverTimeoutId: ReturnType<typeof setTimeout> | null = null;
let correctionObserverStopped = false;
const startedWorkspaces = new Set<string>();

const CORRECTION_OBSERVER_INTERVAL_MS = 15 * 60 * 1000;
const CORRECTION_OBSERVER_INITIAL_DELAY_MS = 10_000;
const CORRECTION_OBSERVER_MAX_RECENT_SESSIONS = 20;
const CORRECTION_OBSERVER_MAX_PAYLOAD_SESSIONS = 5;

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

export async function runCorrectionObserverCycle(wctx: WorkspaceContext, logger: PluginLogger): Promise<void> {
    try {
        const observer = resolveCorrectionObserver(wctx, logger);
        if (!observer) {
            // PRI-307: No noisy "no API key" cycling. Only log at debug level.
            logger?.debug?.(`[PD:CorrectionObserver] Observer not resolved. Skipping cycle.`);
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
        startedWorkspaces.clear();
        if (correctionObserverTimeoutId) clearTimeout(correctionObserverTimeoutId);
        correctionObserverTimeoutId = null;
    },
};
