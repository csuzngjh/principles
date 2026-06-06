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

/** Max chars for any single value stored as evidence preview */
export const MAX_EVIDENCE_VALUE_CHARS = 200;

/**
 * Patterns that look like secrets, tokens, or API keys.
 * Matches any 32+ char alphanumeric string or typical secret patterns.
 */
const TOKEN_LIKE_PATTERNS = [
  /[A-Za-z0-9+/=]{40,}/g,          // ≥40 base64-like or hex tokens
  /sk-[A-Za-z0-9-_]{20,}/g,         // OpenAI-style secret keys
  /ghp_[A-Za-z0-9]{36,}/g,         // GitHub PATs
  /gho_[A-Za-z0-9]{36,}/g,         // GitHub OAuth tokens
  /xox[bpras]-[A-Za-z0-9-]{20,}/g, // Slack tokens
  /eyJ[A-Za-z0-9_-]{20,}\./g,     // JWT-like tokens
];

/**
 * Sanitizes a single value for durable evidence storage.
 * - Strips internal PD tags
 * - Bounds string length
 * - Redacts token-like value (40+ consecutive alphanumeric)
 */
export function sanitizeForEvidence(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  let result = raw;
  // Strip internal PD tags first
  for (const p of [/\[EMOTIONAL_DAMAGE_DETECTED(?:\:(?:mild|moderate|severe))?\]/gi, /\[EMPATHY_ROLLBACK_REQUEST\]/gi, /<empathy[^>]*\/?>(?:<\/empathy>)?/gi]) {
    result = result.replace(p, '');
  }
  // Redact token-like patterns
  for (const pattern of TOKEN_LIKE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const prefix = match.length > 50 ? match.slice(0, 8) : match.slice(0, 4);
      return `${prefix}___REDACTED___${match.length}`;
    });
  }
  // Bound length
  if (result.length > MAX_EVIDENCE_VALUE_CHARS) {
    result = result.slice(0, MAX_EVIDENCE_VALUE_CHARS) + '___TRUNCATED___';
  }
  return result.trim();
}

/**
 * Sanitizes tool-call params for evidence/trajectory storage.
 * Redacts or bounds sensitive/large string fields.
 */
export function sanitizeToolParamsForEvidence(params: Record<string, unknown>): Record<string, unknown> {
  const sensitiveFields = new Set(['content', 'text', 'input', 'new_string', 'arguments']);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (sensitiveFields.has(key) && typeof value === 'string') {
      result[key] = sanitizeForEvidence(value);
    } else if (typeof value === 'string') {
      result[key] = value.length > MAX_EVIDENCE_VALUE_CHARS
        ? value.slice(0, MAX_EVIDENCE_VALUE_CHARS) + '___TRUNCATED___'
        : value;
    } else {
      result[key] = value;
    }
  }
  return result;
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
