import { WorkspaceContext } from '../core/workspace-context.js';
import { trackFriction } from '../core/session-tracker.js';
import { isSubagentRuntimeAvailable } from '../utils/subagent-probe.js';
const OBSERVER_SESSION_PREFIX = 'empathy_obs:';
export class EmpathyObserverManager {
    static instance;
    sessionLocks = new Map();
    constructor() { }
    static getInstance() {
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
    subagentAvailableCache = null;
    isSubagentAvailable(api) {
        if (this.subagentAvailableCache !== null)
            return this.subagentAvailableCache;
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
            const result = probe.call(api.runtime.subagent, {});
            if (result && typeof result.catch === 'function') {
                // It returned a Promise → runtime is real (even if the call fails for bad params)
                result.catch(() => { });
                this.subagentAvailableCache = true;
                return true;
            }
            this.subagentAvailableCache = false;
            return false;
        }
        catch {
            // Threw synchronously → unavailable runtime
            this.subagentAvailableCache = false;
            return false;
        }
    }
    shouldTrigger(api, sessionId) {
        if (!api || !sessionId)
            return false;
        const enabled = api.config?.empathy_engine?.enabled !== false;
        if (!enabled)
            return false;
        if (!isSubagentRuntimeAvailable(api.runtime?.subagent))
            return false;
        return !this.sessionLocks.has(sessionId);
    }
    async spawn(api, sessionId, userMessage) {
        if (!api)
            return null;
        if (!this.shouldTrigger(api, sessionId))
            return null;
        if (!userMessage?.trim())
            return null;
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
        }
        catch (error) {
            this.sessionLocks.delete(sessionId);
            api.logger.warn(`[PD:EmpathyObserver] Failed to spawn observer for ${sessionId}: ${String(error)}`);
            return null;
        }
    }
    async reap(api, targetSessionKey, workspaceDir) {
        if (!api || !workspaceDir || !this.isObserverSession(targetSessionKey))
            return;
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
                trackFriction(sessionId, score, `observer_empathy_${parsed.severity || 'mild'}`, workspaceDir, { source: 'user_empathy' });
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
                }
                catch (error) {
                    api.logger.warn(`[PD:EmpathyObserver] Failed to persist observer pain event for ${sessionId}: ${String(error)}`);
                }
                api.logger.info(`[PD:EmpathyObserver] Applied GFI +${score} for ${sessionId}`);
            }
        }
        catch (error) {
            api.logger.warn(`[PD:EmpathyObserver] Failed to reap ${targetSessionKey}: ${String(error)}`);
        }
        finally {
            unlock();
        }
    }
    isObserverSession(sessionKey) {
        return typeof sessionKey === 'string' && sessionKey.startsWith(OBSERVER_SESSION_PREFIX);
    }
    extractParentSessionId(sessionKey) {
        if (!this.isObserverSession(sessionKey))
            return null;
        const rest = sessionKey.slice(OBSERVER_SESSION_PREFIX.length);
        const marker = rest.lastIndexOf(':');
        if (marker <= 0)
            return null;
        return rest.slice(0, marker);
    }
    parseJsonPayload(rawText, logger) {
        if (!rawText?.trim())
            return null;
        try {
            return JSON.parse(rawText.trim());
        }
        catch {
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) {
                logger?.warn('[PD:EmpathyObserver] Observer payload is not valid JSON, skipping.');
                return null;
            }
            try {
                return JSON.parse(match[0]);
            }
            catch {
                logger?.warn('[PD:EmpathyObserver] Failed to parse observer JSON payload, skipping.');
                return null;
            }
        }
    }
    extractAssistantText(messages, assistantTexts) {
        if (assistantTexts && assistantTexts.length > 0) {
            return assistantTexts[assistantTexts.length - 1] || '';
        }
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg?.role !== 'assistant')
                continue;
            if (typeof msg.content === 'string')
                return msg.content;
            if (Array.isArray(msg.content)) {
                const txt = msg.content
                    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                    .map((part) => part.text)
                    .join('\n');
                if (txt)
                    return txt;
            }
        }
        return '';
    }
    scoreFromSeverity(severity, config) {
        if (severity === 'severe')
            return Number(config.get('empathy_engine.penalties.severe') ?? 40);
        if (severity === 'moderate')
            return Number(config.get('empathy_engine.penalties.moderate') ?? 25);
        return Number(config.get('empathy_engine.penalties.mild') ?? 10);
    }
    normalizeSeverity(severity) {
        if (severity === 'severe')
            return 'severe';
        if (severity === 'moderate')
            return 'moderate';
        return 'mild';
    }
    normalizeConfidence(value) {
        if (!Number.isFinite(value))
            return 1;
        return Math.max(0, Math.min(1, Number(value)));
    }
}
export const empathyObserverManager = EmpathyObserverManager.getInstance();
