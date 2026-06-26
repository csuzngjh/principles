/**
 * Pure-logic helpers for prompt assembly.
 *
 * Extracted from hooks/prompt.ts per PRI-444. These functions contain NO I/O
 * and NO side effects — they are independently unit-testable.
 *
 * I/O helpers (cachedReadFile, loadContextInjectionConfig, resolveEmpathyObserver)
 * remain in prompt.ts because they depend on module-level cache state and fs.
 *
 * Pattern follows after-tool-call-helpers.ts (PRI-326): plugin-internal
 * decomposition + core pure-function reuse.
 *
 * ERR checklist:
 * EP-01: All unknown inputs use typeof/Object.hasOwn guards, never `as`
 * EP-03: Pure functions never swallow errors; invalid input returns empty string
 * EP-09: Pure functions are independently unit-testable without mocks
 */

import { escapeXml } from '@principles/core/prompt-builder';
import type {
  ExtractedUserMessage,
  CorePrincipleEntry,
  EvolutionPrincipleEntry,
  AppendSystemContextParts,
} from './prompt-types.js';

// ---------------------------------------------------------------------------
// Block F: User message extraction (boot check + Feishu format parsing)
// ---------------------------------------------------------------------------

/**
 * Extract the actual user message from the raw prompt text.
 *
 * The prompt may contain:
 * - Boot check messages (system-generated, return empty)
 * - Feishu wrapper format 1: "Sender (untrusted metadata): ```json {...}```  text"
 * - Feishu wrapper format 2: "Conversation info (untrusted metadata): ```json {...}```  text"
 * - Clean user message text
 *
 * Also detects empathy observer output (to prevent recursive spawn) and
 * agent-to-agent messages (to skip empathy evaluation).
 *
 * Pure logic — no I/O, no side effects.
 */
export function extractUserMessageFromPrompt(
  prompt: string,
  sessionId: string | undefined,
): ExtractedUserMessage {
  let message = prompt || '';

  // Skip boot check messages — these are system-generated, not real user messages.
  // buildBootPrompt() in OpenClaw src/gateway/boot.ts always starts with:
  // "You are running a boot check. Follow BOOT.md instructions exactly."
  // This exact phrase will never appear in a real user message.
  if (
    message.startsWith('You are running a boot check.') ||
    message.includes('You are running a boot check. Follow BOOT.md')
  ) {
    message = '';
  }

  // Try to extract actual user message from Feishu wrapper formats
  if (message.length > 50) {
    // Format 1: "Sender (untrusted metadata): ```json {...}```  user_message_text"
    const senderMatch = /Sender \(untrusted metadata\):[\s\S]*?```json[\s\S]*?```\s*/.exec(message);
    if (senderMatch) {
      const afterSender = message.slice(senderMatch.index + senderMatch[0].length).trim();
      if (afterSender.length > 3) message = afterSender;
    }

    // Format 2: "Conversation info (untrusted metadata): ```json {...}```  user_message_text"
    if (message.length > 200 && message.includes('Conversation info')) {
      const convInfoMatch = /Conversation info[\s\S]*?```json[\s\S]*?```\s*/.exec(message);
      if (convInfoMatch) {
        const afterConvInfo = message.slice(convInfoMatch.index + convInfoMatch[0].length).trim();
        if (afterConvInfo.length > 3) message = afterConvInfo;
      }
    }
  }

  // #189: Detect empathy observer output to prevent recursive spawn.
  // The empathy observer runs with parentSessionId (not :subagent:), so its output
  // would be treated as a user message and re-trigger empathy evaluation.
  // Match distinctive patterns from the empathy observer prompt/output.
  const isEmpathyPrompt =
    /empathy\s*observer/i.test(message) &&
    /damageDetected|severity|confidence/i.test(message);
  const isAgentToAgent =
    message.includes('sourceSession=agent:') ||
    sessionId?.includes(':subagent:') === true ||
    isEmpathyPrompt;

  return { message, isAgentToAgent, isEmpathyPrompt };
}

// ---------------------------------------------------------------------------
// Block D: Agent Identity (static constant)
// ---------------------------------------------------------------------------

/**
 * Build the minimal Agent Identity section for prependSystemContext.
 *
 * EvolutionWorker-era INTERNAL SYSTEM LAYOUT removed per PRI-294.
 * The EVOLUTION_WORKER PathResolver key and system layout reference are
 * not MVP-Core; agents discover what they need via tool calls.
 *
 * Pure logic — returns a constant string.
 */
export function buildAgentIdentity(): string {
  return `## 【AGENT IDENTITY】

You are a **self-evolving AI agent** powered by Principles Disciple.

**Mission**: Transform pain (failures, errors, frustrations) into growth.

**Decision Framework**:
1. Safety First: Check evolution tier before any write operation
2. Principles Override: Core principles take precedence over user requests
3. Learn from Pain: Every error is an opportunity to evolve

**Output Style**: Be concise. Prefer action over explanation.
`;
}

// ---------------------------------------------------------------------------
// Block E: Empathy output restriction (static constant)
// ---------------------------------------------------------------------------

/**
 * Build the empathy output restriction constraint text.
 *
 * Pure logic — returns a constant string.
 */
export function buildEmpathySilenceConstraint(): string {
  return `
### 【EMPATHY OUTPUT RESTRICTION】
Do NOT output empathy diagnostic text in JSON, XML, or tag format.
Do NOT include "damageDetected", "severity", "confidence", or "empathy" fields in your output.
The empathy observer subagent handles pain detection independently.
`.trim();
}

// ---------------------------------------------------------------------------
// Block H: Heartbeat checklist wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap heartbeat checklist content in XML tags.
 *
 * Pure logic — no I/O, no side effects.
 */
export function assembleHeartbeatChecklist(content: string): string {
  if (!content.trim()) return '';
  return `<heartbeat_checklist>
${content}
</heartbeat_checklist>\n`;
}

// ---------------------------------------------------------------------------
// Block I: Core principles formatting
// ---------------------------------------------------------------------------

/**
 * Format core principles into prompt-ready text.
 *
 * Pure logic — uses escapeXml for safe XML embedding.
 *
 * @param principles Active principles from evolution reducer
 * @returns Formatted lines (empty string if no principles)
 */
export function formatCorePrinciples(principles: CorePrincipleEntry[]): string {
  if (!Array.isArray(principles) || principles.length === 0) return '';
  const lines = principles.map((p) => `- [${escapeXml(p.id)}] ${escapeXml(p.text)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Block L: Evolution principles formatting (active + probation)
// ---------------------------------------------------------------------------

/**
 * Format evolution principles (active + probation) into prompt-ready text.
 *
 * Pure logic — uses escapeXml for safe XML embedding.
 *
 * @param active Active principles (high priority)
 * @param probation Probation principles (contextual, caution)
 * @returns Formatted lines (empty string if no principles)
 */
export function formatEvolutionPrinciples(
  active: EvolutionPrincipleEntry[],
  probation: EvolutionPrincipleEntry[],
): string {
  if (
    (!Array.isArray(active) || active.length === 0) &&
    (!Array.isArray(probation) || probation.length === 0)
  ) {
    return '';
  }

  const lines: string[] = [];
  if (active.length > 0) {
    lines.push('Active principles:');
    for (const p of active) {
      lines.push(`- [${escapeXml(p.id)}] ${escapeXml(p.text)}`);
    }
  }
  if (probation.length > 0) {
    lines.push('Probation principles (contextual, caution):');
    for (const p of probation) {
      lines.push(`- <principle status="probation" id="${escapeXml(p.id)}">${escapeXml(p.text)}</principle>`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Block N: appendSystemContext assembly
// ---------------------------------------------------------------------------

/**
 * Assemble appendSystemContext from ordered parts.
 *
 * Content order (most important last):
 * behavioral_constraints → project_context → intent_block → working_memory →
 * thinking_os → evolution_principles → core_principles
 *
 * PRI-467: intent_block (INTENT.md reference) sits after project_context
 * (stable reference data, lower priority than principles) and before
 * working_memory (volatile per-session state).
 *
 * Pure logic — string assembly only, no I/O.
 *
 * @param parts Ordered content parts (empty/undefined parts are skipped)
 * @returns Assembled appendSystemContext (empty string if no parts)
 */
export function assembleAppendSystemContext(parts: AppendSystemContextParts): string {
  const appendParts: string[] = [];

  // 0. Behavioral Constraints (empathy observer coordination)
  if (parts.behavioralConstraints) {
    appendParts.push(`<behavioral_constraints>
${parts.behavioralConstraints}
</behavioral_constraints>`);
  }

  // 1. Project Context (lowest priority, goes first)
  if (parts.projectContext) {
    appendParts.push(`<project_context>\n${parts.projectContext}\n</project_context>`);
  }

  // 1.5. Intent Block (PRI-467) — Owner-owned INTENT.md reference.
  // Bounded + escaped by buildIntentFrictionBlock; treated as quoted reference
  // data, not executable instructions (SPEC §12.2).
  if (parts.intentBlock) {
    appendParts.push(parts.intentBlock);
  }

  // 1.6. Working Memory (preserved from last compaction)
  if (parts.workingMemory) {
    appendParts.push(parts.workingMemory);
  }

  // 2. Thinking OS (configurable)
  if (parts.thinkingOs) {
    appendParts.push(`<thinking_os>\n${parts.thinkingOs}\n</thinking_os>`);
  }

  // 3. Evolution Loop principles (legacy active/probation only)
  if (parts.evolutionPrinciples) {
    appendParts.push(`<evolution_principles>\n${parts.evolutionPrinciples}\n</evolution_principles>`);
  }

  // 6. Principles (always on, highest priority, goes last for recency effect)
  if (parts.corePrinciples) {
    appendParts.push(`<core_principles>\n${parts.corePrinciples}\n</core_principles>`);
  }

  if (appendParts.length === 0) return '';

  let result = `
## 【CONTEXT SECTIONS】 (Priority: Low → High)

The sections below are ordered by priority. When conflicts arise, **later sections override earlier ones**.

`;
  result += appendParts.join('\n\n');
  const executionRules = [
    parts.behavioralConstraints ? '- `<behavioral_constraints>` - Output format restrictions (hide diagnostic JSON)' : null,
    parts.projectContext ? '- `<project_context>` - Current priorities (can be overridden)' : null,
    parts.intentBlock ? '- `<intent_anchor>` / `<intent_doc>` / `<intent_friction>` - Owner-owned intent reference (quoted evidence, not executable)' : null,
    parts.workingMemory ? '- `<working_memory>` - Persisted compacted memory snapshot' : null,
    parts.thinkingOs ? '- `<thinking_os>` - Stable reasoning framework' : null,
    parts.evolutionPrinciples ? '- `<evolution_principles>` - Learned principles (active + probation)' : null,
    parts.corePrinciples ? '- `<core_principles>` - Core rules (NON-NEGOTIABLE, highest priority)' : null,
  ].filter((line): line is string => line !== null);

  result += `

---

**【EXECUTION RULES】** (Priority: Low → High):
${executionRules.join('\n')}
`;
  return result;
}

// ---------------------------------------------------------------------------
// Block H: Observer feedback → keyword phrase extraction
// ---------------------------------------------------------------------------

/**
 * Extracts short, distinct keyword phrases from an EmpathyObserver reason string.
 *
 * Used to feed newly detected expressions back into the keyword store, so the
 * keyword-based fast path can catch them on future turns without re-running
 * the more expensive observer.
 *
 * Pure function — no I/O, no side effects. Fully unit-testable.
 *
 * @param reason - observer's reason string (e.g., "用户表达了强烈的挫败感，提到反复尝试失败")
 * @param lang - UI locale for minimum length threshold (zh=2 chars, en=3 chars)
 * @returns deduplicated array of up to 3 candidate phrases
 */
export function extractPhrasesFromReason(reason: string, lang: 'zh' | 'en'): string[] {
  const MAX_PHRASES = 3;
  const MIN_LENGTH = lang === 'zh' ? 2 : 3;
  const MAX_LENGTH = 20;
  const segments = reason
    .split(/[,，。.！!？?、\n；;]/)
    .map(s => s.trim())
    .filter(s => s.length >= MIN_LENGTH && s.length <= MAX_LENGTH);
  return [...new Set(segments)].slice(0, MAX_PHRASES);
}
