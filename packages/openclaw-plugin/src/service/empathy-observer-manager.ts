import { WorkspaceContext } from '../core/workspace-context.js';
import { trackFriction } from '../core/session-tracker.js';
import { isSubagentRuntimeAvailable } from '../utils/subagent-probe.js';
import type { PluginLogger, SubagentRunResult, SubagentWaitResult } from '../openclaw-sdk.js';

const OBSERVER_SESSION_PREFIX = 'agent:main:subagent:empathy-obs-';

// Default timeout for waitForRun (30 seconds)
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/**
 * Run metadata for active empathy observer runs
 */
interface ObserverRunMetadata {
    runId: string;
    parentSessionId: string;
    observerSessionKey: string;
    workspaceDir?: string;
    startedAt: number;
}

type EmpathyObserverPayload = {
    damageDetected?: boolean;
    severity?: 'mild' | 'moderate' | 'severe' | string;
    confidence?: number;
    reason?: string;
};

export interface EmpathyObserverApi {
    config?: {
        empathy_engine?: {
            enabled?: boolean;
        };
    };
    runtime: {
        subagent: {
            run: (params: {
                sessionKey: string;
                message: string;
                lane?: string;
                deliver?: boolean;
                idempotencyKey?: string;
                expectsCompletionMessage?: boolean;
            }) => Promise<unknown>;
            waitForRun: (params: { runId: string; timeoutMs?: number }) => Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string }>;
            getSessionMessages: (params: { sessionKey: string; limit?: number }) => Promise<{ messages: unknown[]; assistantTexts?: string[] }>;
            deleteSession: (params: { sessionKey: string; deleteTranscript?: boolean }) => Promise<void>;
        };
    };
    logger: PluginLogger;
}

export class EmpathyObserverManager {
    private static instance: EmpathyObserverManager;
    private sessionLocks = new Map<string, string>();
    private activeRuns = new Map<string, ObserverRunMetadata>();
    private completedSessions = new Map<string, number>();

    private constructor() {}

    static getInstance(): EmpathyObserverManager {
        if (!EmpathyObserverManager.instance) {
            EmpathyObserverManager.instance = new EmpathyObserverManager();
        }
        return EmpathyObserverManager.instance;
    }

    /**
     * Build a safe session key for empathy observer
     * Format: agent:main:subagent:empathy-obs-{safeParentSessionId}-{timestamp}
     */
    buildEmpathyObserverSessionKey(parentSessionId: string): string {
        const safeParentSessionId = parentSessionId
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .substring(0, 64);
        const timestamp = Date.now();
        return `${OBSERVER_SESSION_PREFIX}${safeParentSessionId}-${timestamp}`;
    }

    /**
     * Check if a session key is an empathy observer session
     */
    isObserverSession(sessionKey: string): boolean {
        return isEmpathyObserverSession(sessionKey);
    }

    private markCompleted(observerSessionKey: string): void {
        this.completedSessions.set(observerSessionKey, Date.now());
    }

    private isCompleted(observerSessionKey: string): boolean {
        const timestamp = this.completedSessions.get(observerSessionKey);
        if (!timestamp) return false;
        if (Date.now() - timestamp > 5 * 60 * 1000) {
            this.completedSessions.delete(observerSessionKey);
            return false;
        }
        return true;
    }

    shouldTrigger(api: EmpathyObserverApi | null | undefined, sessionId: string): boolean {
        if (!api || !sessionId) {
            api?.logger?.warn?.('[PD:EmpathyObserver] shouldTrigger=false: api or sessionId null');
            return false;
        }
        const enabled = api.config?.empathy_engine?.enabled !== false;
        if (!enabled) {
            api.logger?.warn?.('[PD:EmpathyObserver] shouldTrigger=false: empathy_engine disabled');
            return false;
        }
        // Skip BOOT sessions - they run outside "gateway request" context where subagent.run() is unavailable
        if (sessionId.startsWith('boot-')) {
            api.logger?.warn?.('[PD:EmpathyObserver] shouldTrigger=false: boot session (gateway request context unavailable)');
            return false;
        }
        const subagentOk = isSubagentRuntimeAvailable(api.runtime?.subagent);
        if (!subagentOk) {
            api.logger?.warn?.('[PD:EmpathyObserver] shouldTrigger=false: subagent runtime unavailable');
            return false;
        }
        if (this.sessionLocks.has(sessionId)) {
            api.logger?.warn?.(`[PD:EmpathyObserver] shouldTrigger=false: session ${sessionId} locked`);
            return false;
        }
        api.logger?.info?.(`[PD:EmpathyObserver] shouldTrigger=true for session ${sessionId}`);
        return true;
    }

    async spawn(
        api: EmpathyObserverApi | null | undefined,
        sessionId: string,
        userMessage: string,
        workspaceDir?: string
    ): Promise<string | null> {
        if (!api) return null;
        if (!this.shouldTrigger(api, sessionId)) {
            api?.logger?.warn?.(`[PD:EmpathyObserver] spawn skipped: shouldTrigger=false for session ${sessionId}`);
            return null;
        }
        if (!userMessage?.trim()) {
            api?.logger?.warn?.('[PD:EmpathyObserver] spawn skipped: empty userMessage');
            return null;
        }

        const sessionKey = this.buildEmpathyObserverSessionKey(sessionId);
        this.sessionLocks.set(sessionId, sessionKey);
        api.logger.info(`[PD:EmpathyObserver] Spawn starting for session ${sessionId}, key=${sessionKey}`);

        const prompt = [
            'You are an empathy observer.',
            'Analyze ONLY the user message and return strict JSON (no markdown):',
            '{"damageDetected": boolean, "severity": "mild|moderate|severe", "confidence": number, "reason": string}',
            `User message: ${JSON.stringify(userMessage.trim())}`,
        ].join('\n');

        let runId: string;
        try {
            const result = await api.runtime.subagent.run({
                sessionKey,
                message: prompt,
                lane: 'subagent',
                deliver: false,
                idempotencyKey: `${sessionId}:${Date.now()}`,
                expectsCompletionMessage: true,
            }) as SubagentRunResult;
            runId = result.runId;
            api.logger.info(`[PD:EmpathyObserver] Spawn succeeded for ${sessionKey}, runId=${runId}`);
        } catch (error) {
            this.sessionLocks.delete(sessionId);
            api.logger.warn(`[PD:EmpathyObserver] Spawn failed for ${sessionId}: ${String(error)}`);
            return null;
        }

        this.activeRuns.set(sessionId, {
            runId,
            parentSessionId: sessionId,
            observerSessionKey: sessionKey,
            workspaceDir,
            startedAt: Date.now(),
        });

        this.finalizeRun(api, sessionId, sessionKey, workspaceDir).catch((err) => {
            api.logger.warn(`[PD:EmpathyObserver] finalizeRun failed for ${sessionKey}: ${String(err)}`);
        });

        return sessionKey;
    }

    /**
     * Main回收链路: 使用 waitForRun 驱动回收
     * 无论 ok/error/timeout 都执行统一 cleanup
     */
    private async finalizeRun(
        api: EmpathyObserverApi,
        parentSessionId: string,
        observerSessionKey: string,
        workspaceDir?: string
    ): Promise<void> {
        const metadata = this.activeRuns.get(parentSessionId);
        const runId = metadata?.runId;

        if (!runId) {
            api.logger.warn(`[PD:EmpathyObserver] finalizeRun: no runId for ${observerSessionKey}`);
            this.cleanupState(parentSessionId, observerSessionKey);
            return;
        }

        api.logger.info(`[PD:EmpathyObserver] finalizeRun: waiting for runId=${runId}`);

        let waitResult: SubagentWaitResult;
        try {
            waitResult = await api.runtime.subagent.waitForRun({
                runId,
                timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
            });
            api.logger.info(`[PD:EmpathyObserver] finalizeRun: wait completed status=${waitResult.status}`);
        } catch (error) {
            api.logger.warn(`[PD:EmpathyObserver] finalizeRun: waitForRun threw for ${runId}: ${String(error)}`);
            waitResult = { status: 'error', error: String(error) };
        }

        await this.reapBySession(api, observerSessionKey, parentSessionId, workspaceDir);
    }

    /**
     * 统一回收入口: reap + deleteSession + 清理状态
     */
    private async reapBySession(
        api: EmpathyObserverApi,
        observerSessionKey: string,
        parentSessionId: string,
        workspaceDir?: string
    ): Promise<void> {
        if (this.isCompleted(observerSessionKey)) {
            api.logger.info(`[PD:EmpathyObserver] reapBySession: already processed ${observerSessionKey}, skipping`);
            this.cleanupState(parentSessionId, observerSessionKey);
            return;
        }

        this.markCompleted(observerSessionKey);
        api.logger.info(`[PD:EmpathyObserver] reapBySession starting for ${observerSessionKey}`);

        const sessionId = this.extractParentSessionId(observerSessionKey);

        try {
            const messages = await api.runtime.subagent.getSessionMessages({
                sessionKey: observerSessionKey,
                limit: 20,
            });
            api.logger.info(`[PD:EmpathyObserver] Retrieved messages for ${observerSessionKey}`);

            const rawText = this.extractAssistantText(messages.messages, messages.assistantTexts);
            api.logger?.debug?.(`[PD:EmpathyObserver] Raw observer output for ${observerSessionKey}: ${JSON.stringify(rawText)}`);
            const parsed = this.parseJsonPayload(rawText, api.logger);
            api.logger.info(`[PD:EmpathyObserver] Payload parsed: ${JSON.stringify(parsed)}`);

            if (parsed?.damageDetected && sessionId) {
                const wctx = WorkspaceContext.fromHookContext({ workspaceDir: workspaceDir || '' });
                const score = this.scoreFromSeverity(parsed.severity, wctx.config);
                trackFriction(
                    sessionId,
                    score,
                    `observer_empathy_${parsed.severity || 'mild'}`,
                    workspaceDir || '',
                    { source: 'user_empathy' }
                );
                const eventId = `emp_obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                wctx.eventLog.recordPainSignal(sessionId, {
                    score,
                    source: 'user_empathy',
                    reason: parsed.reason || 'Empathy observer detected likely user frustration.',
                    isRisky: false,
                    origin: 'system_infer',
                    severity: this.normalizeSeverity(parsed.severity),
                    confidence: this.normalizeConfidence(parsed.confidence),
                    detection_mode: 'structured',
                    deduped: false,
                    trigger_text_excerpt: rawText.substring(0, 120),
                    raw_score: score,
                    calibrated_score: score,
                    eventId,
                });
                try {
                    wctx.trajectory?.recordPainEvent?.({
                        sessionId,
                        source: 'user_empathy',
                        score,
                        reason: parsed.reason || 'Empathy observer detected likely user frustration.',
                        severity: this.normalizeSeverity(parsed.severity),
                        origin: 'system_infer',
                        confidence: this.normalizeConfidence(parsed.confidence),
                    });
                } catch (error) {
                    api.logger.warn(`[PD:EmpathyObserver] Failed to persist observer pain event for ${sessionId}: ${String(error)}`);
                }
                api.logger.info(`[PD:EmpathyObserver] Applied GFI +${score} for ${sessionId}`);
            } else {
                api.logger.info(`[PD:EmpathyObserver] No damage detected or no sessionId for ${observerSessionKey}`);
            }
        } catch (error) {
            api.logger.warn(`[PD:EmpathyObserver] reapBySession failed to read messages for ${observerSessionKey}: ${String(error)}`);
        }

        try {
            await api.runtime.subagent.deleteSession({ sessionKey: observerSessionKey });
            api.logger.info(`[PD:EmpathyObserver] deleteSession succeeded for ${observerSessionKey}`);
        } catch (error) {
            api.logger.warn(`[PD:EmpathyObserver] deleteSession failed for ${observerSessionKey}: ${String(error)}`);
        }

        this.cleanupState(parentSessionId, observerSessionKey);
    }

    /**
     * Fallback回收: 由 subagent_ended 触发
     * 仅在主链路未处理时执行补救回收
     */
    async reap(
        api: EmpathyObserverApi | null | undefined,
        targetSessionKey: string,
        workspaceDir?: string
    ): Promise<void> {
        if (!api || !this.isObserverSession(targetSessionKey)) return;

        if (this.isCompleted(targetSessionKey)) {
            api.logger.info(`[PD:EmpathyObserver] reap fallback: already processed ${targetSessionKey}, skipping`);
            return;
        }

        const parentSessionId = this.extractParentSessionId(targetSessionKey) || '';
        await this.reapBySession(api, targetSessionKey, parentSessionId, workspaceDir);
    }

    private cleanupState(parentSessionId: string, observerSessionKey: string): void {
        this.activeRuns.delete(parentSessionId);
        if (this.sessionLocks.get(parentSessionId) === observerSessionKey) {
            this.sessionLocks.delete(parentSessionId);
        }
    }

    /**
     * Extract parent session ID from observer session key
     */
    extractParentSessionId(sessionKey: string): string | null {
        if (!this.isObserverSession(sessionKey)) return null;
        const match = sessionKey.match(/empathy-obs-(.+)-(\d+)$/);
        return match ? match[1] : null;
    }

    private parseJsonPayload(rawText: string, logger?: PluginLogger): EmpathyObserverPayload | null {
        if (!rawText?.trim()) return null;

        try {
            return JSON.parse(rawText.trim()) as EmpathyObserverPayload;
        } catch {
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) {
                logger?.warn('[PD:EmpathyObserver] Observer payload is not valid JSON, skipping.');
                return null;
            }
            try {
                return JSON.parse(match[0]) as EmpathyObserverPayload;
            } catch {
                logger?.warn('[PD:EmpathyObserver] Failed to parse observer JSON payload, skipping.');
                return null;
            }
        }
    }

    private extractAssistantText(messages: unknown[], assistantTexts?: string[]): string {
        if (assistantTexts && assistantTexts.length > 0) {
            return assistantTexts[assistantTexts.length - 1] || '';
        }

        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as { role?: string; content?: unknown };
            if (msg?.role !== 'assistant') continue;
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) {
                const txt = msg.content
                    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                    .map((part: any) => part.text)
                    .join('\n');
                if (txt) return txt;
            }
        }

        return '';
    }

    private scoreFromSeverity(severity: string | undefined, config: WorkspaceContext['config']): number {
        if (severity === 'severe') return Number(config.get('empathy_engine.penalties.severe') ?? 40);
        if (severity === 'moderate') return Number(config.get('empathy_engine.penalties.moderate') ?? 25);
        return Number(config.get('empathy_engine.penalties.mild') ?? 10);
    }

    private normalizeSeverity(severity: string | undefined): 'mild' | 'moderate' | 'severe' {
        if (severity === 'severe') return 'severe';
        if (severity === 'moderate') return 'moderate';
        return 'mild';
    }

    private normalizeConfidence(value: number | undefined): number {
        if (!Number.isFinite(value)) return 1;
        return Math.max(0, Math.min(1, Number(value)));
    }
}

export const empathyObserverManager = EmpathyObserverManager.getInstance();

export function isEmpathyObserverSession(sessionKey: string): boolean {
    return typeof sessionKey === 'string' && sessionKey.startsWith(OBSERVER_SESSION_PREFIX);
}
