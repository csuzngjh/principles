import type { PluginHookBeforeMessageWriteEvent, PluginHookBeforeMessageWriteResult } from '../openclaw-sdk.js';
import {
  sanitizeString as coreSanitizeString,
  sanitizeValue as coreSanitizeValue,
  sanitizeToolParams as coreSanitizeToolParams,
  convergePath,
  MAX_EVIDENCE_VALUE_CHARS,
} from '@principles/core/runtime-v2';

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

// Re-export core constants and functions for backward compatibility
export { MAX_EVIDENCE_VALUE_CHARS, convergePath };

/**
 * Sanitize a single string value for evidence storage.
 * Delegates to core sanitizer with optional workspaceDir for path convergence.
 */
export function sanitizeForEvidence(value: unknown, workspaceDir?: string): string {
  if (value === null || value === undefined) return '';
  return coreSanitizeString(String(value), workspaceDir);
}

/**
 * Recursively sanitize any value for evidence storage.
 * Delegates to core sanitizer.
 */
export function sanitizeValueForEvidence(value: unknown, workspaceDir?: string): unknown {
  return coreSanitizeValue(value, 0, workspaceDir);
}

/**
 * Sanitize tool-call params for evidence/trajectory storage.
 * Delegates to core sanitizer — accepts unknown, runtime-validates.
 *
 * ERR-001: no `as` casts on input
 * ERR-055: ANY-segment sensitive field matching
 * ERR-056: token redaction on ALL strings via recursive sanitizeValue
 */
export function sanitizeToolParamsForEvidence(
  params: unknown,
  workspaceDir?: string,
): Record<string, unknown> {
  return coreSanitizeToolParams(params, workspaceDir);
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
