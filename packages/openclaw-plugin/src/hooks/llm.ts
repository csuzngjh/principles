import type { PluginHookLlmOutputEvent, PluginHookAgentContext, TokenUsage } from '../openclaw-sdk.js';
import { trackLlmOutput, resetFriction } from '../core/session-tracker.js';
import { normalizeSeverity } from '../core/empathy-types.js';
import { DetectionService } from '../core/detection-service.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { sanitizeAssistantText } from './message-sanitize.js';
import { emitPainDetectedEvent, buildTrajectoryEvidence } from './pain.js';
import { evaluatePainDiagnosticGate } from '../core/pain-diagnostic-gate.js';
import { loadFeatureFlagFromConfig } from '../core/pd-config-loader.js';
import { recordSelfReportFromText } from '../core/principle-application-ledger.js';
import { resolveSourceKind, type RawObservation } from './raw-observation-adapter.js';
import { evaluateEvidenceTriage } from './triage-adapter.js';
import { evaluateTriggerController } from '@principles/core/runtime-v2';
import { isSharedCooldownActive, markSharedEpisodeAsDiagnosed } from './trigger-cooldown-tracker.js';

export interface EmpathySignal {
    detected: boolean;
    severity: 'mild' | 'moderate' | 'severe';
    confidence: number;
    reason?: string;
    mode?: 'structured' | 'legacy_tag';
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function parseConfidence(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 1;
    return clamp(parsed, 0, 1);
}

function parseTrustedLegacyTag(text: string): RegExpMatchArray | null {
    return /^\s*\[EMOTIONAL_DAMAGE_DETECTED(?::(mild|moderate|severe))?\]\s*$/i.exec(text);
}

/**
 * 检测标签是否是被用户诱导/引用输出的（回显），而非 LLM 主动输出的情绪信号
 */
function isEchoedTag(text: string, tagMatch: RegExpMatchArray): boolean {
    const tagIndex = tagMatch.index ?? 0;
    const before = text.substring(Math.max(0, tagIndex - 100), tagIndex).toLowerCase();

    // 1. 检查是否在引号内（用户引用）
    const quotesBefore = (before.match(/["'\u300c\u300d\u201c\u201d`]/g) || []).length;
    if (quotesBefore % 2 === 1) return true;

    // 2. Strong patterns: 用户指令关键词（任意位置匹配）
    const strongPatterns = [
        /用户(说|让|要求|让我输出)/,
        /user\s+(said|asked|told|wants)\s+me\s+to\s+(output|write|say)/,
        /请(输出|包含|显示).*\[emotional/,
        /please\s+(output|include).*\[emotional/,
        /你让我输出/,
    ];
    for (const pattern of strongPatterns) {
        if (pattern.test(before)) return true;
    }

    // 3. Weak patterns: 仅在标签 15 字符内触发
    const weakPatterns = [
        { pattern: /echo/, window: 15 },
        { pattern: /copy/, window: 15 },
        { pattern: /复述/, window: 15 },
    ];
    for (const { pattern, window } of weakPatterns) {
        const nearTag = text.substring(Math.max(0, tagIndex - window), tagIndex).toLowerCase();
        if (pattern.test(nearTag)) return true;
    }

    // 4. 检查是否在代码块内
    const codeBlocksBefore = (before.match(/```/g) || []).length;
    if (codeBlocksBefore % 2 === 1) return true;

    return false;
}

export function extractEmpathySignal(text: string): EmpathySignal {
    if (!text || typeof text !== 'string') {
        return { detected: false, severity: 'mild', confidence: 1 };
    }

    const xmlMatch = /<empathy\s+([^>]*)\/?>(?:<\/empathy>)?/i.exec(text);
    if (xmlMatch?.[1]) {
        const [, attrs] = xmlMatch;
        const signal = (/signal\s*=\s*"([^"]+)"/i.exec(attrs))?.[1]?.toLowerCase();
        if (signal === 'damage' || signal === 'pain' || signal === 'frustration') {
            const severity = normalizeSeverity((/severity\s*=\s*"([^"]+)"/i.exec(attrs))?.[1]);
            const confidence = parseConfidence((/confidence\s*=\s*"([^"]+)"/i.exec(attrs))?.[1]);
            const reason = (/reason\s*=\s*"([^"]+)"/i.exec(attrs))?.[1];
            return { detected: true, severity, confidence, reason, mode: 'structured' };
        }
    }

    const jsonMatch = /"empathy"\s*:\s*\{[\s\S]*?\}/i.exec(text);
    if (jsonMatch) {
        const jsonText = `{${jsonMatch[0]}}`;
        try {
            const parsed = JSON.parse(jsonText) as {
                empathy?: { damageDetected?: boolean; severity?: string; confidence?: number; reason?: string };
            };
            if (parsed.empathy?.damageDetected === true) {
                return {
                    detected: true,
                    severity: normalizeSeverity(parsed.empathy.severity),
                    confidence: clamp(Number(parsed.empathy.confidence ?? 1), 0, 1),
                    reason: parsed.empathy.reason,
                    mode: 'structured'
                };
            }
        } catch {
            // ignore malformed snippet
        }
    }

    const tagMatch = parseTrustedLegacyTag(text);
    if (tagMatch) {
        if (isEchoedTag(text, tagMatch)) {
            return { detected: false, severity: 'mild', confidence: 1 };
        }
        return {
            detected: true,
            severity: normalizeSeverity(tagMatch[1]),
            confidence: 1,
            mode: 'legacy_tag'
        };
    }

    return { detected: false, severity: 'mild', confidence: 1 };
}

export function isEmpathyAuditPayload(text: string): boolean {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    if (/^\{[\s\S]*"damageDetected"[\s\S]*\}$/.test(trimmed)) return true;
    if (/^<empathy\s+([^>]*)\/?>/i.test(trimmed)) return true;
    if (/^\s*\[EMOTIONAL_DAMAGE_DETECTED(?::(mild|moderate|severe))?\]\s*$/i.test(trimmed)) return true;
    return false;
}

/**
 * Extract enhanced fields from lastAssistant (complete AssistantMessage) in hook payload.
 * Pure function — no I/O, no side effects. ERR-001 compliant.
 */
export function extractAssistantEnhancedFields(lastAssistant: unknown): {
    stopReason: string | null;
    thinkingBlocksCount: number | null;
} {
    if (!lastAssistant || typeof lastAssistant !== 'object' || Array.isArray(lastAssistant)) {
        return { stopReason: null, thinkingBlocksCount: null };
    }

    const obj = lastAssistant as Record<string, unknown>;

    // stopReason: typeof guard
    const stopReason = typeof obj.stopReason === 'string' ? obj.stopReason : null;

    // thinkingBlocksCount: iterate content array, count thinking/redacted_thinking blocks
    let thinkingBlocksCount: number | null = null;
    if (Array.isArray(obj.content)) {
        let count = 0;
        for (const block of obj.content) {
            if (block && typeof block === 'object' && !Array.isArray(block)) {
                const blockType = (block as Record<string, unknown>).type;
                if (blockType === 'thinking' || blockType === 'redacted_thinking') {
                    count++;
                }
            }
        }
        thinkingBlocksCount = count;
    }

    return { stopReason, thinkingBlocksCount };
}

export function handleLlmOutput(
    event: PluginHookLlmOutputEvent,
    ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
    if (!ctx.workspaceDir || !ctx.sessionId) return;

    const wctx = WorkspaceContext.fromHookContext(ctx);
    const {config} = wctx;
    const {eventLog} = wctx;

    // Track this turn in the core session memory
    const trigger = (event as { trigger?: string }).trigger ?? undefined;
    const usage = event.usage as TokenUsage | undefined;
    const sessionId = (ctx as { sessionId?: string }).sessionId ?? 'unknown';
    const workspaceDir = (ctx as { workspaceDir?: string }).workspaceDir;
    const sessionKey = (ctx as { sessionKey?: string }).sessionKey ?? 'unknown';
    const state = trackLlmOutput(sessionId, usage, config, workspaceDir, sessionKey, trigger);

    // We need actual assistant text to analyze
    if (!event.assistantTexts || event.assistantTexts.length === 0) return;

    const text = event.assistantTexts.join('\n');
    // PRI-532: capture agent self-report 📌 lines into the receipt ledger
    // (flag-gated inside the helper; never throws; 60s flag cache).
    try {
        recordSelfReportFromText(workspaceDir ?? '', text, ctx.sessionId, (ctx as { logger?: { warn?: (m: string) => void } }).logger);
    } catch {
        // capture must never affect the trajectory/observability path (rc-9 is
        // handled per-row inside the helper; this guard is for the scan itself)
    }
    const signal = extractEmpathySignal(text);
    const enhancedFields = extractAssistantEnhancedFields(event.lastAssistant);
    const createdAt = new Date().toISOString();
    try {
        wctx.trajectory?.recordAssistantTurn?.({
            sessionId: ctx.sessionId,
            runId: event.runId ?? 'unknown',
            provider: event.provider ?? 'unknown',
            model: event.model ?? 'unknown',
            rawText: text,
            sanitizedText: sanitizeAssistantText(text),
            usageJson: event.usage || {},
            empathySignalJson: signal,
            stopReason: enhancedFields.stopReason,
            thinkingBlocksCount: enhancedFields.thinkingBlocksCount,
            createdAt,
        });
    } catch (error) {
        ctx.logger?.warn?.(`[PD:LLM] Failed to persist assistant turn to trajectory: ${String(error)}`);
    }

    // ── Track B: Semantic Pain Detection (V1.3.0 Funnel) ──
    const detectionText = isEmpathyAuditPayload(text) ? '' : text;
    const detectionService = DetectionService.get(wctx.stateDir);
    const detection = detectionService.detect(detectionText);

    // recordRuleMatch call removed (PRI-451 Wave 1): dead code — its only
    // consumer was stats.pain.rulesMatched (dead counter, removed in Wave 1.5).

    let painScore = detection.detected ? (detection.severity || 0) : 0;
    let source = detection.detected
        ? (detection.ruleId ? `llm_${detection.ruleId.toLowerCase()}` : `llm_${detection.source}`)
        : '';
    let matchedReason = detection.detected
        ? `Agent triggered pain detection (Source: ${detection.source}${detection.ruleId ? `, Rule: ${detection.ruleId}` : ''})`
        : '';

    // ═══ Natural Language Rollback Detection ═══
    const rollbackMatch = /^\s*\[EMPATHY_ROLLBACK_REQUEST\]\s*$/m.exec(text);
    if (rollbackMatch) {
        const eventId = eventLog.getLastEmpathyEventId(ctx.sessionId);
        if (eventId) {
            const rolledBackScore = eventLog.rollbackEmpathyEvent(
                eventId,
                ctx.sessionId,
                'Natural language rollback request detected',
                'natural_language'
            );
            if (rolledBackScore > 0) {
                // Reset GFI after successful rollback
                resetFriction(ctx.sessionId, ctx.workspaceDir, {
                    source: 'user_empathy',
                    amount: rolledBackScore,
                });
            }
        }
    }

    // 3. Paralysis Check (from session state tracker)
    const stuckThreshold = config.get('thresholds.stuck_loops_trigger') || 3;
    const inputThreshold = config.get('thresholds.cognitive_paralysis_input') || 4000;
    const paralysisScore = config.get('scores.paralysis') || 40;

    if (state.stuckLoops >= stuckThreshold && state.totalInputTokens > inputThreshold && painScore < paralysisScore) {
        painScore = paralysisScore;
        source = 'llm_paralysis';
        matchedReason = `Agent is stuck in low-output loops (${state.stuckLoops} consecutive turns with tiny output but huge context), indicating cognitive paralysis.`;
    }

    // If a semantic pain threshold is crossed, only valuable episodes enter Runtime v2.
    // Lower-signal detections remain in the event log/GFI layer for accumulation.
    const painTriggerThreshold = config.get('thresholds.pain_trigger') || 30;

    // GFI-triggered pain: when accumulated friction crosses highGfi threshold,
    // emit pain signal even if L1 detection didn't fire.
    const highGfiThreshold = Math.max(config.get('severity_thresholds.high') || 70, painTriggerThreshold + 30);
    let isGfiTriggered = false;
    if (state.currentGfi >= highGfiThreshold && painScore < painTriggerThreshold) {
        painScore = Math.min(state.currentGfi, 60);
        source = 'user_empathy';
        isGfiTriggered = true;
        matchedReason = `Accumulated GFI (${state.currentGfi.toFixed(1)}) crossed highGfi threshold (${highGfiThreshold}). Source: empathy keyword friction.`;
    }

    if (painScore >= painTriggerThreshold) {
        // PRI-454: Dual-gate migration. When both flags ON → Gate B (TriggerController).
        // When either OFF → Gate A (PainDiagnosticGate, rollback).
        const triageFlag = loadFeatureFlagFromConfig(ctx.workspaceDir!, 'painEvidenceAdmission');
        const defaultFlag = loadFeatureFlagFromConfig(ctx.workspaceDir!, 'painEvidenceAdmissionDefault');
        const useGateB = triageFlag.enabled && defaultFlag.enabled;

        eventLog.recordPainSignal(ctx.sessionId, {
            score: painScore,
            source: source,
            reason: matchedReason,
            isRisky: false
        });

        // PRI-453: Generate painId early and write to trajectory.db via legacy
        // recordPainEvent so that disabling SDK observability path does not lose
        // trajectory coverage. canonicalPainId enables dedup.
        const painId = `llm_${Date.now()}`;
        wctx.trajectory?.recordPainEvent?.({
            sessionId: ctx.sessionId || 'unknown',
            source,
            score: painScore,
            reason: matchedReason,
            origin: 'system_infer',
            canonicalPainId: painId,
        });

        if (useGateB) {
            // PRI-454: Gate B path — TriggerController owns admission
            const rawObs: RawObservation = {
                observedAt: new Date().toISOString(),
                workspaceId: ctx.workspaceDir,
                sessionId: ctx.sessionId,
                detectionSource: source,
                isGfiTriggered,
            };
            const sourceKind = resolveSourceKind(rawObs);
            const triage = evaluateEvidenceTriage(sourceKind, painScore);
            if (triage.decision !== 'admit') {
                ctx.logger?.info?.(`[PD:LLM] Triage ${triage.decision}: ${triage.reason}`);
            } else {
                const cooldownActive = isSharedCooldownActive(sourceKind, ctx.sessionId, source);
                const triggerDecision = evaluateTriggerController({
                    triageResult: triage,
                    isOwnerManual: false,
                    isCooldownActive: cooldownActive,
                    isValid: true,
                    score: painScore,
                    sessionId: ctx.sessionId,
                });
                if (triggerDecision.shouldCreateDiagnosticTask) {
                    markSharedEpisodeAsDiagnosed(sourceKind, ctx.sessionId, source);
                    const evidence = buildTrajectoryEvidence(wctx, ctx.sessionId || 'unknown');
                    emitPainDetectedEvent(wctx, {
                        ts: new Date().toISOString(),
                        type: 'pain_detected',
                        data: {
                            painId,
                            painType: 'user_frustration' as const,
                            source,
                            reason: `${matchedReason}; trigger=${triggerDecision.outcome}`,
                            score: painScore,
                            sessionId: ctx.sessionId || 'unknown',
                            agentId: ctx.agentId,
                            provenance: 'host_context_bound',
                            hostKind: 'openclaw',
                            evidence,
                        },
                    }, { recordObservability: false });
                } else {
                    ctx.logger?.info?.(`[PD:LLM] Gate B skipped: ${triggerDecision.reason}`);
                }
            }
        } else {
            // PRI-454: Gate A path (rollback when either flag is OFF)
            const gate = evaluatePainDiagnosticGate({
                source: source === 'llm_paralysis' ? 'llm_paralysis' : 'semantic',
                score: painScore,
                currentGfi: state.currentGfi,
                consecutiveErrors: state.consecutiveErrors,
                sessionId: ctx.sessionId || 'unknown',
                errorHash: source,
                thresholds: {
                    painTrigger: painTriggerThreshold,
                    highSeverity: config.get('severity_thresholds.high') || 70,
                    semanticPain: Math.max(painTriggerThreshold, 60),
                },
            });

            if (gate.shouldDiagnose) {
                const evidence = buildTrajectoryEvidence(wctx, ctx.sessionId || 'unknown');
                emitPainDetectedEvent(wctx, {
                    ts: new Date().toISOString(),
                    type: 'pain_detected',
                    data: {
                        painId,
                        painType: 'user_frustration' as const,
                        source,
                        reason: `${matchedReason}; diagnosticGate=${gate.reason}`,
                        score: painScore,
                        sessionId: ctx.sessionId || 'unknown',
                        agentId: ctx.agentId,
                        provenance: 'host_context_bound',
                        hostKind: 'openclaw',
                        evidence,
                    },
                }, { recordObservability: false });
            } else {
                ctx.logger?.info?.(`[PD:LLM] Pain signal recorded without Runtime V2 diagnosis: ${gate.detail}`);
            }
        }
    }

}
