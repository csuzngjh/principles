import * as fs from 'fs';
import * as path from 'path';
import type { PluginHookLlmOutputEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { trackLlmOutput, recordThinkingCheckpoint, resetFriction } from '../core/session-tracker.js';
import { buildPainFlag, writePainFlag } from '../core/pain.js';
import { normalizeSeverity } from '../core/empathy-types.js';
import { ControlUiDatabase } from '../core/control-ui-db.js';
import { DetectionService } from '../core/detection-service.js';
import { detectThinkingModelMatches, deriveThinkingScenarios } from '../core/thinking-models.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { sanitizeAssistantText } from './message-sanitize.js';

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

export function handleLlmOutput(
    event: PluginHookLlmOutputEvent,
    ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
    if (!ctx.workspaceDir || !ctx.sessionId) return;

    const wctx = WorkspaceContext.fromHookContext(ctx);
    const {config} = wctx;
    const {eventLog} = wctx;

    // Track this turn in the core session memory
    const state = trackLlmOutput(ctx.sessionId, event.usage, config, ctx.workspaceDir, ctx.sessionKey, ctx.trigger);

    // We need actual assistant text to analyze
    if (!event.assistantTexts || event.assistantTexts.length === 0) return;

    const text = event.assistantTexts.join('\n');
    const signal = extractEmpathySignal(text);
    const createdAt = new Date().toISOString();
    let assistantTurnId: number | null = null;
    try {
        assistantTurnId = wctx.trajectory?.recordAssistantTurn?.({
            sessionId: ctx.sessionId,
            runId: event.runId,
            provider: event.provider,
            model: event.model,
            rawText: text,
            sanitizedText: sanitizeAssistantText(text),
            usageJson: event.usage || {},
            empathySignalJson: signal,
            createdAt,
        });
    } catch (error) {
        ctx.logger?.warn?.(`[PD:LLM] Failed to persist assistant turn to trajectory: ${String(error)}`);
    }

    // ── Track B: Semantic Pain Detection (V1.3.0 Funnel) ──
    const detectionText = isEmpathyAuditPayload(text) ? '' : text;
    const detectionService = DetectionService.get(wctx.stateDir);
    const detection = detectionService.detect(detectionText);

    if (detection.detected) {
        eventLog.recordRuleMatch(ctx.sessionId, {
            ruleId: detection.ruleId || detection.source,
            layer: detection.source === 'l1_exact' ? 'L1' : (detection.source === 'l2_cache' ? 'L2' : 'L3'),
            severity: detection.severity || 0,
            textPreview: detectionText.substring(0, 100)
        });
    }

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

    // If a pain threshold is crossed, write the autonomous pain flag
    const painTriggerThreshold = config.get('thresholds.pain_trigger') || 30;
    if (painScore >= painTriggerThreshold) {
        // Inject the actual text snippet that triggered this for the diagnostician to read later
        const snippet = text.length > 200 ? text.substring(0, 100) + '...' + text.substring(text.length - 100) : text;

        try {
            writePainFlag(ctx.workspaceDir, buildPainFlag({
                source,
                score: String(painScore),
                reason: matchedReason,
                is_risky: false,
                trigger_text_preview: snippet,
                session_id: ctx.sessionId || '',
                agent_id: ctx.agentId || '',
            }));
        } catch (e) {
            ctx.logger?.warn?.(`[PD:LLM] Failed to write pain flag: ${String(e)}`);
        }

        eventLog.recordPainSignal(ctx.sessionId, {
            score: painScore,
            source: source,
            reason: matchedReason,
            isRisky: false
        });
    }

    // ═══ Thinking OS: Mental Model Usage Tracking ═══
     
     
    trackThinkingModelUsage({
        text,
        wctx,
        sessionId: ctx.sessionId,
        runId: event.runId,
        assistantTurnId,
        createdAt,
        logger: ctx.logger,
    });
}

function trackThinkingModelUsage(args: {
    text: string;
    wctx: WorkspaceContext;
    sessionId?: string;
    runId: string;
    assistantTurnId: number | null;
    createdAt: string;
    logger?: PluginHookAgentContext['logger'];
}): void {
    const { text, wctx, sessionId, runId, assistantTurnId, createdAt, logger } = args;
    const logPath = wctx.resolve('THINKING_OS_USAGE');
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    let usageLog: Record<string, number> = {};

    if (fs.existsSync(logPath)) {
        try {
            usageLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch (e) {
            logger?.error?.(`[PD:LLM] Failed to parse thinking OS usage log: ${String(e)}`);
        }
    }

    const matches = detectThinkingModelMatches(text, wctx.workspaceDir);
    for (const match of matches) {
        usageLog[match.modelId] = (usageLog[match.modelId] || 0) + 1;
    }

    usageLog._total_turns = (usageLog._total_turns || 0) + 1;

    try {
        fs.writeFileSync(logPath, JSON.stringify(usageLog, null, 2), 'utf8');
    } catch (e) {
        logger?.error?.(`[PD:LLM] Failed to write thinking OS usage log: ${String(e)}`);
    }

    if (matches.length === 0) {
        return;
    }

    if (sessionId) {
        recordThinkingCheckpoint(sessionId, wctx.workspaceDir);
    }

    if (!sessionId || !assistantTurnId) {
        return;
    }

    const uiDb = new ControlUiDatabase({ workspaceDir: wctx.workspaceDir });
    try {
        const recentContext = uiDb.getRecentThinkingContext(sessionId, createdAt);
        const toolContext = recentContext.toolCalls.map((call) => ({
            toolName: call.toolName,
            outcome: call.outcome,
            errorType: call.errorType,
        }));
        const painContext = recentContext.painEvents.map((event) => ({
            source: event.source,
            score: event.score,
        }));
        const principleContext = recentContext.principleEvents.map((event) => ({
            principleId: event.principleId,
            eventType: event.eventType,
        }));
        const triggerExcerpt = text.length > 280 ? `${text.slice(0, 277)}...` : text;

        for (const match of matches) {
            const scenarios = deriveThinkingScenarios(match.modelId, {
                recentToolCalls: toolContext,
                recentPainEvents: painContext,
                recentGateBlocks: recentContext.gateBlocks.map((block) => ({
                    toolName: block.toolName,
                    reason: block.reason,
                })),
                recentUserCorrections: recentContext.userCorrections.map((correction) => ({
                    correctionCue: correction.correctionCue,
                })),
                recentPrincipleEvents: principleContext,
            });

            uiDb.recordThinkingModelEvent({
                sessionId,
                runId,
                assistantTurnId,
                modelId: match.modelId,
                matchedPattern: match.matchedPattern,
                scenarioJson: scenarios,
                toolContextJson: toolContext,
                painContextJson: painContext,
                principleContextJson: principleContext,
                triggerExcerpt,
                createdAt,
            });
        }
    } catch (error) {
        logger?.warn?.(`[PD:LLM] Failed to persist thinking model events: ${String(error)}`);
    } finally {
        uiDb.dispose();
    }
}
