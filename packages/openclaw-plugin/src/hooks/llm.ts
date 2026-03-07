import * as fs from 'fs';
import * as path from 'path';
import { PluginHookLlmOutputEvent, PluginHookAgentContext } from '../openclaw-sdk.js';
import { trackLlmOutput, getSession } from '../core/session-tracker.js';
import { writePainFlag } from '../core/pain.js';

// **Enhanced Bilingual Cognitive Distress Patterns**
// The goal is not to catch every error, but to catch the *Agent's internal realization*
// that it is struggling to satisfy the user or solve the problem.

const CONFUSION_PATTERNS = [
    // English: Doubt & Uncertainty
    /i\s+am\s+(not sure|unsure|confused|uncertain|struggling to|currently struggling to|having trouble)/i,
    /i\s+(don't|cannot|can't)\s+(understand|figure out|determine|locate|find|resolve)/i,
    /it\s+(seems|appears)\s+(there is|there's)\s+a\s+(mismatch|discrepancy|conflict|missing piece)/i,
    /this\s+(is|seems)\s+more\s+complex\s+than/i,
    /let me\s+(re-?read|re-?evaluate|check again|look at this again|re-?examine|double-?check)/i,
    /i\s+apologize\s+for\s+the\s+confusion/i, // Classic "I messed up" signature
    // English: Context Loss or Loops
    /i\s+(can't|cannot)\s+see\s+the\s+(file|definition|code) (anymore|here)/i,
    /i\s+must\s+have\s+(lost|forgotten|missed)\s+the\s+context/i,

    // 中文: 疑惑与不确定
    /我(似乎|好像)?(不确定|不太确定|不清楚|不太清楚|不明白|困惑|无法确认|找不到|定位不到)/,
    /(这|这个问题)?(看起来|似乎)?比我(预期|想象)的要复杂/,
    /(存在|可能有)(差异|冲突|矛盾|遗漏)/,
    /让我(再|重新)(看看|看下|确认一下|评估一下|梳理一下|阅读一下)/,
    /非常抱歉(,|\s|，)?(之前的回答|我)?给您带来了?(困扰|混淆)/,
    /我好像(丢失了|失去了|没有把握住)(上下文|前置信息|相关代码)/,
    /我之前(可能)?(理解错|搞错)了/
];

const REPETITION_PATTERNS = [
    // English: Stuck in a loop
    /as\s+(i mentioned|i said|noted above|previously stated|we saw earlier)/i,
    /again,?\s+(let me|i'll|we need to|i must)/i,
    /still\s+(seeing|getting|having|encountering)\s+(the same|this)( error| issue| problem)?/i,
    /it\s+seems\s+we\s+are\s+(back to square one|going in circles|looping)/i,
    /this\s+is\s+the\s+same\s+error( as before)?/i,

    // 中文: 陷入循环
    /正如(我)?之前(所说|提到|指出)的/,
    /再次说明|再一次(,|\s|，)/,
    /(仍然|依然|还在)(报|遇到|面对)?(这个|同样的|相同的)(错误|问题)/,
    /似乎.*?(陷入了?循环|回到了?原点|原地打转)/
];

export function handleLlmOutput(
    event: PluginHookLlmOutputEvent,
    ctx: PluginHookAgentContext & { workspaceDir?: string }
): void {
    if (!ctx.workspaceDir || !ctx.sessionId) return;

    // Track this turn in the core session memory
    const state = trackLlmOutput(ctx.sessionId, event.usage);

    // We need actual assistant text to analyze
    if (!event.assistantTexts || event.assistantTexts.length === 0) return;

    const text = event.assistantTexts.join('\n');

    let painScore = 0;
    let source = '';
    let matchedReason = '';

    // 1. Check for Cognitive Confusion
    for (const pattern of CONFUSION_PATTERNS) {
        if (pattern.test(text)) {
            painScore = Math.max(painScore, 35);
            source = 'llm_confusion';
            matchedReason = `Agent expressed confusion/uncertainty (matched pattern: ${pattern.toString()})`;
            break;
        }
    }

    // 2. Check for Loop/Repetition Awareness (Increases severity if already confused)
    for (const pattern of REPETITION_PATTERNS) {
        if (pattern.test(text)) {
            if (painScore > 0) {
                painScore = 45; // Escalate
                source = 'llm_confusion_loop';
                matchedReason += ` AND expressed repetition/looping awareness.`;
            } else {
                painScore = Math.max(painScore, 30);
                source = 'llm_repetition';
                matchedReason = `Agent expressed repetition/looping awareness (matched pattern: ${pattern.toString()})`;
            }
            break;
        }
    }

    // 3. Paralysis Check (from session state tracker)
    // If the agent has output < 50 tokens for 3+ consecutive turns while reading 4000+ context,
    // it is likely thrashing/paralyzed without producing work.
    if (state.stuckLoops >= 3 && painScore < 40) {
        painScore = 40;
        source = 'llm_paralysis';
        matchedReason = `Agent is stuck in low-output loops (${state.stuckLoops} consecutive turns with tiny output but huge context), indicating cognitive paralysis.`;
    }

    // If a pain threshold is crossed, write the autonomous pain flag
    if (painScore >= 30) {
        // Inject the actual text snippet that triggered this for the diagnostician to read later
        const snippet = text.length > 200 ? text.substring(0, 100) + '...' + text.substring(text.length - 100) : text;

        writePainFlag(ctx.workspaceDir, {
            source,
            score: String(painScore),
            time: new Date().toISOString(),
            reason: matchedReason,
            is_risky: 'false', // This is cognitive, not a risky file write
            trigger_text_preview: snippet
        });
    }

    // ═══ Thinking OS: Mental Model Usage Tracking ═══
    // Track which mental models the agent is actively using
    // This data feeds into /thinking-os audit and the archival mechanism
    const actualStateDir = ctx.stateDir || path.join(ctx.workspaceDir, 'memory', '.state');
    trackThinkingModelUsage(text, actualStateDir);
}

// ── Thinking OS Usage Tracking ──────────────────────────────────────────────
// Detects behavioral signals indicating the agent is following specific mental models.
// Bilingual patterns (EN/CN) to match agent output in either language.

const THINKING_MODEL_SIGNALS: Record<string, RegExp[]> = {
    'T-01': [ // Map Before Territory
        /let me (first )?(understand|map|outline|survey|review the (structure|architecture|dependencies))/i,
        /让我先(梳理|了解|画出|理解|查看)(一下)?(结构|架构|依赖|全貌)/,
    ],
    'T-02': [ // Constraints as Lighthouses
        /(type|test|contract|schema|interface) (constraint|requirement|check|validation)/i,
        /we (must|need to) (respect|follow|adhere to) the/i,
        /(必须|需要).*?(遵守|符合|满足).*?(类型|测试|契约|接口|规范)/,
    ],
    'T-03': [ // Evidence Over Intuition
        /based on (the |this )?(evidence|logs?|output|error|stack trace|test result)/i,
        /let me (check|verify|confirm|read|look at) (the |)(actual|source|code|file|log)/i,
        /根据(日志|证据|输出|报错|堆栈|测试结果)/,
    ],
    'T-04': [ // Reversibility Governs Speed
        /this (is|would be) (irreversible|destructive|permanent|not easily undone)/i,
        /(reversible|can be undone|safely roll back)/i,
        /(不可逆|破坏性|永久的|无法回滚|可以回滚|安全地撤销)/,
    ],
    'T-05': [ // Via Negativa
        /we (must|should) (not|never|avoid|prevent|ensure we don't)/i,
        /(critical|important) (not to|that we don't|to avoid)/i,
        /(绝不能|必须避免|不可以|禁止|确保不会)/,
    ],
    'T-06': [ // Occam's Razor
        /(simpl(er|est|ify)|minimal|straightforward|lean) (approach|solution|fix|implementation)/i,
        /(simple is better|keep it simple|no need to over)/i,
        /(最简(单|洁)|精简|没有必要(过度|额外))/,
    ],
    'T-07': [ // Minimum Viable Change
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

function trackThinkingModelUsage(text: string, stateDir: string): void {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    const logPath = path.join(stateDir, 'thinking_os_usage.json');
    let usageLog: Record<string, number> = {};

    if (fs.existsSync(logPath)) {
        try {
            usageLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch (e) {
            console.debug('[PD] Failed to read model usage:', e);
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

    // Track total turns for calculating usage rates
    usageLog['_total_turns'] = (usageLog['_total_turns'] || 0) + 1;

    if (anyMatch) {
        try {
            fs.writeFileSync(logPath, JSON.stringify(usageLog, null, 2), 'utf8');
        } catch (e) {
            console.debug('[PD] Failed to write model usage:', e);
        }
    }
}
