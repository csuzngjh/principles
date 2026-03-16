import * as fs from 'fs';
import * as path from 'path';
import { PluginHookLlmOutputEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { trackFriction, trackLlmOutput, recordThinkingCheckpoint, resetFriction } from '../core/session-tracker.js';
import { writePainFlag } from '../core/pain.js';
import { DetectionService } from '../core/detection-service.js';
import { WorkspaceContext } from '../core/workspace-context.js';

export interface EmpathySignal {
    detected: boolean;
    severity: 'mild' | 'moderate' | 'severe';
    confidence: number;
    reason?: string;
    mode?: 'structured' | 'legacy_tag';
}

type EmpathyRateState = {
    turnScore: number;
    hourScore: number;
    hourWindowStart: number;
    lastRunId?: string;
};

const empathyDedupState = new Map<string, number>();
const empathyRateState = new Map<string, EmpathyRateState>();

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeSeverity(input?: string): 'mild' | 'moderate' | 'severe' {
    const normalized = (input || '').toLowerCase();
    if (normalized === 'severe' || normalized === 'high') return 'severe';
    if (normalized === 'moderate' || normalized === 'medium') return 'moderate';
    return 'mild';
}

function parseConfidence(raw?: string): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 1;
    return clamp(parsed, 0, 1);
}

function parseTrustedLegacyTag(text: string): RegExpMatchArray | null {
    return text.match(/^\s*\[EMOTIONAL_DAMAGE_DETECTED(?::(mild|moderate|severe))?\]\s*$/i);
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

    const xmlMatch = text.match(/<empathy\s+([^>]*)\/?>(?:<\/empathy>)?/i);
    if (xmlMatch?.[1]) {
        const attrs = xmlMatch[1];
        const signal = attrs.match(/signal\s*=\s*"([^"]+)"/i)?.[1]?.toLowerCase();
        if (signal === 'damage' || signal === 'pain' || signal === 'frustration') {
            const severity = normalizeSeverity(attrs.match(/severity\s*=\s*"([^"]+)"/i)?.[1]);
            const confidence = parseConfidence(attrs.match(/confidence\s*=\s*"([^"]+)"/i)?.[1]);
            const reason = attrs.match(/reason\s*=\s*"([^"]+)"/i)?.[1];
            return { detected: true, severity, confidence, reason, mode: 'structured' };
        }
    }

    const jsonMatch = text.match(/"empathy"\s*:\s*\{[\s\S]*?\}/i);
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

function mapSeverityToPenalty(severity: 'mild' | 'moderate' | 'severe', config: ReturnType<typeof WorkspaceContext.fromHookContext>['config']): number {
    const mild = Number(config.get('empathy_engine.penalties.mild') ?? 10);
    const moderate = Number(config.get('empathy_engine.penalties.moderate') ?? 25);
    const severe = Number(config.get('empathy_engine.penalties.severe') ?? 40);

    if (severity === 'severe') return severe;
    if (severity === 'moderate') return moderate;
    return mild;
}

function dedupeKey(sessionId: string, runId: string, signal: EmpathySignal): string {
    return `${sessionId}:${runId}:${signal.severity}:${(signal.reason || '').slice(0, 80)}`;
}

function shouldDedupe(sessionId: string, runId: string, signal: EmpathySignal, windowMs: number): boolean {
    const key = dedupeKey(sessionId, runId, signal);
    const now = Date.now();
    const last = empathyDedupState.get(key);
    if (typeof last === 'number' && now - last <= windowMs) {
        return true;
    }
    empathyDedupState.set(key, now);
    return false;
}

function resolveCalibrationFactor(
    event: PluginHookLlmOutputEvent,
    config: ReturnType<typeof WorkspaceContext.fromHookContext>['config']
): number {
    const table = config.get('empathy_engine.model_calibration') as Record<string, number> | undefined;
    if (!table || typeof table !== 'object') return 1;

    const modelKey = `${event.provider}/${event.model}`;
    const factor = Number(table[modelKey] ?? 1);
    if (!Number.isFinite(factor)) return 1;
    return clamp(factor, 0.1, 3);
}

function applyRateLimit(
    sessionId: string,
    runId: string,
    score: number,
    config: ReturnType<typeof WorkspaceContext.fromHookContext>['config']
): number {
    const maxPerTurn = Number(config.get('empathy_engine.rate_limit.max_per_turn') ?? 40);
    const maxPerHour = Number(config.get('empathy_engine.rate_limit.max_per_hour') ?? 120);
    const now = Date.now();

    const prev = empathyRateState.get(sessionId) ?? {
        turnScore: 0,
        hourScore: 0,
        hourWindowStart: now,
        lastRunId: runId,
    };

    if (prev.lastRunId !== runId) {
        prev.turnScore = 0;
        prev.lastRunId = runId;
    }

    if (now - prev.hourWindowStart >= 60 * 60 * 1000) {
        prev.hourScore = 0;
        prev.hourWindowStart = now;
    }

    const byTurn = Math.max(0, maxPerTurn - prev.turnScore);
    const byHour = Math.max(0, maxPerHour - prev.hourScore);
    const allowed = Math.max(0, Math.min(score, byTurn, byHour));

    prev.turnScore += allowed;
    prev.hourScore += allowed;
    empathyRateState.set(sessionId, prev);

    return allowed;
}


export function handleLlmOutput(
    event: PluginHookLlmOutputEvent,
    ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
    if (!ctx.workspaceDir || !ctx.sessionId) return;

    const wctx = WorkspaceContext.fromHookContext(ctx);
    const config = wctx.config;
    const eventLog = wctx.eventLog;

    // Track this turn in the core session memory
    const state = trackLlmOutput(ctx.sessionId, event.usage, config, ctx.workspaceDir);

    // We need actual assistant text to analyze
    if (!event.assistantTexts || event.assistantTexts.length === 0) return;

    const text = event.assistantTexts.join('\n');

    // ── Track B: Semantic Pain Detection (V1.3.0 Funnel) ──
    const detectionService = DetectionService.get(wctx.stateDir);
    const detection = detectionService.detect(text);

    if (detection.detected) {
        eventLog.recordRuleMatch(ctx.sessionId, {
            ruleId: detection.ruleId || detection.source,
            layer: detection.source === 'l1_exact' ? 'L1' : (detection.source === 'l2_cache' ? 'L2' : 'L3'),
            severity: detection.severity || 0,
            textPreview: text.substring(0, 100)
        });
    }

    let painScore = detection.detected ? (detection.severity || 0) : 0;
    let source = detection.detected
        ? (detection.ruleId ? `llm_${detection.ruleId.toLowerCase()}` : `llm_${detection.source}`)
        : '';
    let matchedReason = detection.detected
        ? `Agent triggered pain detection (Source: ${detection.source}${detection.ruleId ? `, Rule: ${detection.ruleId}` : ''})`
        : '';

    // empathy sub-pipeline (enabled by default)
    const empathyEnabled = config.get('empathy_engine.enabled');
    if (empathyEnabled !== false) {
        const signal = extractEmpathySignal(text);
        if (signal.detected) {
            const dedupeWindow = Number(config.get('empathy_engine.dedupe_window_ms') ?? 60000);
            const deduped = shouldDedupe(ctx.sessionId, event.runId, signal, dedupeWindow);

            if (!deduped) {
                const baseScore = mapSeverityToPenalty(signal.severity, config);
                const weightedScore = Math.round(baseScore * signal.confidence);
                const calibrationFactor = resolveCalibrationFactor(event, config);
                const calibratedScore = Math.round(weightedScore * calibrationFactor);
                const boundedScore = applyRateLimit(ctx.sessionId, event.runId, calibratedScore, config);

                if (boundedScore > 0) {
                    trackFriction(ctx.sessionId, boundedScore, `user_empathy_${signal.severity}`, ctx.workspaceDir);
                    // Generate unique event ID for rollback support
                    const eventId = `emp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                    eventLog.recordPainSignal(ctx.sessionId, {
                        score: boundedScore,
                        source: 'user_empathy',
                        reason: signal.reason || 'Assistant self-reported user emotional distress.',
                        isRisky: false,
                        origin: 'assistant_self_report',
                        severity: signal.severity,
                        confidence: signal.confidence,
                        detection_mode: signal.mode,
                        deduped: false,
                        trigger_text_excerpt: text.substring(0, 120),
                        raw_score: weightedScore,
                        calibrated_score: calibratedScore,
                        eventId,
                    } as any);
                }
            } else {
                eventLog.recordPainSignal(ctx.sessionId, {
                    score: 0,
                    source: 'user_empathy',
                    reason: signal.reason || 'Deduped empathy signal.',
                    isRisky: false,
                    origin: 'assistant_self_report',
                    severity: signal.severity,
                    confidence: signal.confidence,
                    detection_mode: signal.mode,
                    deduped: true,
                    trigger_text_excerpt: text.substring(0, 120),
                    raw_score: Math.round(mapSeverityToPenalty(signal.severity, config) * signal.confidence),
                    calibrated_score: Math.round(mapSeverityToPenalty(signal.severity, config) * signal.confidence * resolveCalibrationFactor(event, config))
                });
            }
        }
    }

    // ═══ Natural Language Rollback Detection ═══
    // Detect [EMPATHY_ROLLBACK_REQUEST] tag and trigger rollback
    const rollbackMatch = text.match(/^\s*\[EMPATHY_ROLLBACK_REQUEST\]\s*$/m);
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
                resetFriction(ctx.sessionId);
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

        writePainFlag(ctx.workspaceDir, {
            source,
            score: String(painScore),
            time: new Date().toISOString(),
            reason: matchedReason,
            is_risky: 'false',
            trigger_text_preview: snippet
        });

        eventLog.recordPainSignal(ctx.sessionId, {
            score: painScore,
            source: source,
            reason: matchedReason,
            isRisky: false
        });
    }

    // ═══ Thinking OS: Mental Model Usage Tracking ═══
    trackThinkingModelUsage(text, wctx, ctx.sessionId);
}

const THINKING_MODEL_SIGNALS: Record<string, RegExp[]> = {
    'T-01': [
        /let me (first )?(understand|map|outline|survey|review the (structure|architecture|dependencies))/i,
        /让我先(梳理|了解|画出|理解|查看)(一下)?(结构|架构|依赖|全貌)/,
    ],
    'T-02': [
        /(type|test|contract|schema|interface) (constraint|requirement|check|validation)/i,
        /we (must|need to) (respect|follow|adhere to) the/i,
        /(必须|需要).*?(遵守|符合|满足).*?(类型|测试|契约|接口|规范)/,
    ],
    'T-03': [
        /based on (the |this )?(evidence|logs?|output|error|stack trace|test result)/i,
        /let me (check|verify|confirm|read|look at) (the |)(actual|source|code|file|log)/i,
        /根据(日志|证据|输出|报错|堆栈|测试结果)/,
    ],
    'T-04': [
        /this (is|would be) (irreversible|destructive|permanent|not easily undone)/i,
        /(reversible|can be undone|safely roll back)/i,
        /(不可逆|破坏性|永久的|无法回滚|可以回滚|安全地撤销)/,
    ],
    'T-05': [
        /we (must|should) (not|never|avoid|prevent|ensure we don't)/i,
        /(critical|important) (not to|that we don't|to avoid)/i,
        /(绝不能|必须避免|不可以|禁止|确保不会)/,
    ],
    'T-06': [
        /(simpl(er|est|ify)|minimal|straightforward|lean) (approach|solution|fix|implementation)/i,
        /(simple is better|keep it simple|no need to over)/i,
        /(最简(单|洁)|精简|没有必要(过度|额外))/,
    ],
    'T-07': [
        /(minimal|smallest|narrowest|least) (change|diff|modification|impact)/i,
        /only (change|modify|touch|edit) (the |what)/i,
        /(最小(改动|变更|修改)|只(改|动|修))/,
    ],
    'T-08': [ // Pain as Signal
        /this (error|failure|issue) (tells us|indicates|signals|suggests|means)/i,
        /let me (stop|pause|step back|reconsider|rethink)/i,
        /这个(错误|失败|问题)(告诉我们|表明|说明|意味)/,
        /让我(停下|暂停|退一步|重新(考虑|思考|审视))/,
    ],
    'T-09': [ // Divide and Conquer
        /(break|split|decompose|divide) (this |the task |it )?(into|down)/i,
        /(step 1|first,? (we|i|let's)|phase 1)/i,
        /(拆分|分解|分步|分阶段|第一步)/,
    ],
};

function trackThinkingModelUsage(text: string, wctx: WorkspaceContext, sessionId?: string): void {
    const logPath = wctx.resolve('THINKING_OS_USAGE');
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    let usageLog: Record<string, number> = {};

    if (fs.existsSync(logPath)) {
        try {
            usageLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch (e) {
            console.error(`[PD:LLM] Failed to parse thinking OS usage log: ${String(e)}`);
        }
    }

    let anyMatch = false;
    for (const [modelId, patterns] of Object.entries(THINKING_MODEL_SIGNALS)) {
        for (const pattern of patterns) {
            if (pattern.test(text)) {
                usageLog[modelId] = (usageLog[modelId] || 0) + 1;
                anyMatch = true;
                break;
            }
        }
    }

    usageLog['_total_turns'] = (usageLog['_total_turns'] || 0) + 1;

    if (anyMatch) {
        // Record thinking checkpoint for gate enforcement
        if (sessionId) {
            recordThinkingCheckpoint(sessionId, wctx.workspaceDir);
        }
        try {
            fs.writeFileSync(logPath, JSON.stringify(usageLog, null, 2), 'utf8');
        } catch (e) {
            console.error(`[PD:LLM] Failed to write thinking OS usage log: ${String(e)}`);
        }
    }
}
