/**
 * Extract plain text content from message structures.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

export function extractMessageContent(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  const record = message as { content?: unknown };
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .filter((part: unknown) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text')
      .map((part) => String((part as { text?: unknown }).text ?? ''))
      .join('\n')
      .trim();
  }
  return '';
}