import type { PluginHookLlmOutputEvent, PluginHookAgentContext, TokenUsage } from '../openclaw-sdk.js';
import { trackLlmOutput, getInjectedPrincipleIds } from '../core/session-tracker.js';
import { normalizeSeverity } from '../core/empathy-types.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { sanitizeAssistantText } from './message-sanitize.js';
import { recordSelfReportFromText } from '../core/principle-application-ledger.js';

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
    trackLlmOutput(sessionId, usage, config, workspaceDir, sessionKey, trigger);

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

    // PRI-768 v5 follow-up: task_outcomes had schema + writer API but ZERO
    // production callers, so the terminal node of the evidence chain
    // (user_turn → … → effect receipt → outcome) was never recorded. Write
    // one bounded outcome row per turn that produced assistant output:
    // ids come from the shared injection container the prompt hook populates
    // (same source as presence receipts), taskId is the host run id so the
    // row joins assistant_turns.run_id. Observability only — never throws.
    try {
        const injectedIds = getInjectedPrincipleIds(sessionId);
        wctx.trajectory?.recordTaskOutcome?.({
            sessionId,
            taskId: event.runId ?? null,
            outcome: 'completed',
            summary: text.slice(0, 400),
            principleIdsJson: injectedIds ?? [],
        });
    } catch (error) {
        ctx.logger?.warn?.(`[PD:LLM] Failed to record task outcome: ${String(error)}`);
    }

    // ── Pain emission (SPEC PD-PAIN-SEMANTICS-AND-DETECTION-ARCHITECTURE-001
    // Phase 0): the legacy Semantic Confusion detection path (DetectionService
    // funnel) was retired — error is not Pain. Its detection branch and Pain
    // writes are gone; GFI was removed entirely in GFI-COMPLETE-REMOVAL-001.

    // ═══ Natural Language Rollback Detection ═══
    const rollbackMatch = /^\s*\[EMPATHY_ROLLBACK_REQUEST\]\s*$/m.exec(text);
    if (rollbackMatch) {
        const eventId = eventLog.getLastEmpathyEventId(ctx.sessionId);
        if (eventId) {
            eventLog.rollbackEmpathyEvent(
                eventId,
                ctx.sessionId,
                'Natural language rollback request detected',
                'natural_language'
            );
        }
    }

}
