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
}
