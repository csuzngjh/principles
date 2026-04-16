import type { PluginHookBeforeMessageWriteEvent, PluginHookBeforeMessageWriteResult } from '../openclaw-sdk.js';

const INTERNAL_TAG_PATTERNS = [
  /\[EMOTIONAL_DAMAGE_DETECTED(?::(?:mild|moderate|severe))?\]/gi,
  /\[EMPATHY_ROLLBACK_REQUEST\]/gi,
  /<empathy\s+[^>]*\/?>(?:<\/empathy>)?/gi,
];

/**
 * Type predicate: true if msg is an assistant message with content.
 * Used for safe narrowing after spread operations on message union.
 */
function isAssistantMessageWithContent(
  msg: unknown
): msg is { role: 'assistant'; content: string } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { role?: string }).role === 'assistant' &&
    typeof (msg as { content?: unknown }).content === 'string'
  );
}

export function sanitizeAssistantText(text: string): string {
  let result = text;
  for (const pattern of INTERNAL_TAG_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function handleBeforeMessageWrite(
  event: PluginHookBeforeMessageWriteEvent,
): PluginHookBeforeMessageWriteResult | void {
  const msg = event.message as { role?: string; content?: unknown } | undefined;
  if (!msg || msg.role !== 'assistant') return;

  if (isAssistantMessageWithContent(msg)) {
    const sanitized = sanitizeAssistantText(msg.content);
    if (sanitized !== msg.content) {
      return { message: { ...msg, content: sanitized } };
    }
    return;
  }

  if (Array.isArray(msg.content)) {
    const next = msg.content.map((part: unknown) => {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
        return { ...part, text: sanitizeAssistantText((part as { text: string }).text) };
      }
      return part;
    });
    return { message: { ...msg, content: next } };
  }

  return;
}
