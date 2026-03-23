import { WorkspaceContext } from '../core/workspace-context.js';
import { trackFriction } from '../core/session-tracker.js';
import type { PluginLogger } from '../openclaw-sdk.js';

const OBSERVER_SESSION_PREFIX = 'empathy_obs:';


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
            }) => Promise<unknown>;
            getSessionMessages: (params: { sessionKey: string; limit?: number }) => Promise<{ messages: unknown[]; assistantTexts?: string[] }>;
        };
    };
    logger: PluginLogger;
}

type EmpathyObserverPayload = {
    damageDetected?: boolean;
    severity?: 'mild' | 'moderate' | 'severe' | string;
    confidence?: number;
    reason?: string;
};

export class EmpathyObserverManager {
    private static instance: EmpathyObserverManager;
    private sessionLocks = new Map<string, string>();

    private constructor() {}

    static getInstance(): EmpathyObserverManager {
        if (!EmpathyObserverManager.instance) {
            EmpathyObserverManager.instance = new EmpathyObserverManager();
        }
        return EmpathyObserverManager.instance;
    }

    /**
     * Probe whether the subagent runtime is actually functional.
     * api.runtime.subagent always exists (it's a Proxy), but in embedded mode
     * every method throws "only available during a gateway request".
     * We cache the result to avoid repeated probing.
     */
    private subagentAvailableCache: boolean | null = null;

    private isSubagentAvailable(api: EmpathyObserverApi): boolean {
        if (this.subagentAvailableCache !== null) return this.subagentAvailableCache;
        try {
            // Accessing .run on the Proxy is safe; calling it with bad params
            // will throw the unavailability error synchronously before any async work.
            // We use a deliberate no-op probe: pass an empty object and catch immediately.
            const probe = api.runtime?.subagent?.run;
            if (typeof probe !== 'function') {
                this.subagentAvailableCache = false;
                return false;
            }
            // Call with intentionally invalid params — the unavailable runtime throws
            // synchronously, the real runtime returns a rejected Promise.
            const result = probe.call(api.runtime.subagent, {} as never);
            if (result && typeof result.catch === 'function') {
                // It returned a Promise → runtime is real (even if the call fails for bad params)
                result.catch(() => { /* suppress the expected bad-params rejection */ });
                this.subagentAvailableCache = true;
                return true;
            }
            this.subagentAvailableCache = false;
            return false;
        } catch {
            // Threw synchronously → unavailable runtime
            this.subagentAvailableCache = false;
            return false;
        }
    }

    shouldTrigger(api: EmpathyObserverApi | null | undefined, sessionId: string): boolean {
        if (!api || !sessionId) return false;
        const enabled = api.config?.empathy_engine?.enabled !== false;
        if (!enabled) return false;
        if (!this.isSubagentAvailable(api)) return false;

        return !this.sessionLocks.has(sessionId);
    }

    async spawn(api: EmpathyObserverApi | null | undefined, sessionId: string, userMessage: string): Promise<string | null> {
        if (!api) return null;
        if (!this.shouldTrigger(api, sessionId)) return null;
        if (!userMessage?.trim()) return null;


        const timestamp = Date.now();
        const sessionKey = `${OBSERVER_SESSION_PREFIX}${sessionId}:${timestamp}`;
        this.sessionLocks.set(sessionId, sessionKey);

        const prompt = [
            'You are an empathy observer.',
            'Analyze ONLY the user message and return strict JSON (no markdown):',
            '{"damageDetected": boolean, "severity": "mild|moderate|severe", "confidence": number, "reason": string}',
            `User message: ${JSON.stringify(userMessage.trim())}`,
        ].join('\n');

        try {
            await api.runtime.subagent.run({
                sessionKey,
                message: prompt,
                lane: 'subagent',
                deliver: false,
                idempotencyKey: `${sessionId}:${timestamp}`,
            });
            api.logger.info(`[PD:EmpathyObserver] Spawned observer ${sessionKey}`);
            return sessionKey;
        } catch (error) {
            this.sessionLocks.delete(sessionId);
            api.logger.warn(`[PD:EmpathyObserver] Failed to spawn observer for ${sessionId}: ${String(error)}`);
            return null;
        }
    }

    async reap(api: EmpathyObserverApi | null | undefined, targetSessionKey: string, workspaceDir: string): Promise<void> {
        if (!api || !workspaceDir || !this.isObserverSession(targetSessionKey)) return;

        const sessionId = this.extractParentSessionId(targetSessionKey);
        const unlock = () => {
            if (sessionId && this.sessionLocks.get(sessionId) === targetSessionKey) {
                this.sessionLocks.delete(sessionId);
            }
        };

        try {
            const messages = await api.runtime.subagent.getSessionMessages({
                sessionKey: targetSessionKey,
                limit: 20,
            });

            const rawText = this.extractAssistantText(messages.messages, messages.assistantTexts);
            const parsed = this.parseJsonPayload(rawText, api.logger);

            if (parsed?.damageDetected && sessionId) {
                const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
                const score = this.scoreFromSeverity(parsed.severity, wctx.config);
                trackFriction(
                    sessionId,
                    score,
                    `observer_empathy_${parsed.severity || 'mild'}`,
                    workspaceDir,
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
            }
        } catch (error) {
            api.logger.warn(`[PD:EmpathyObserver] Failed to reap ${targetSessionKey}: ${String(error)}`);
        } finally {
            unlock();
        }
    }

    private isObserverSession(sessionKey: string): boolean {
        return typeof sessionKey === 'string' && sessionKey.startsWith(OBSERVER_SESSION_PREFIX);
    }

    private extractParentSessionId(sessionKey: string): string | null {
        if (!this.isObserverSession(sessionKey)) return null;
        const rest = sessionKey.slice(OBSERVER_SESSION_PREFIX.length);
        const marker = rest.lastIndexOf(':');
        if (marker <= 0) return null;
        return rest.slice(0, marker);
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
