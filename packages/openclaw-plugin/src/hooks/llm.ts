import * as fs from 'fs';
import * as path from 'path';
import { PluginHookLlmOutputEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { trackLlmOutput } from '../core/session-tracker.js';
import { writePainFlag } from '../core/pain.js';
import { DetectionService } from '../core/detection-service.js';
import { WorkspaceContext } from '../core/workspace-context.js';

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
    trackThinkingModelUsage(text, wctx);
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

function trackThinkingModelUsage(text: string, wctx: WorkspaceContext): void {
    const logPath = wctx.resolve('THINKING_OS_USAGE');
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    
    let usageLog: Record<string, number> = {};

    if (fs.existsSync(logPath)) {
        try {
            usageLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch (e) {}
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
        try {
            fs.writeFileSync(logPath, JSON.stringify(usageLog, null, 2), 'utf8');
        } catch (e) {}
    }
}
