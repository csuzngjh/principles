import type { HostEvent, HostEventContext, HostEventKind } from '@principles/core/host';

export const CODEX_EVENT_PRE_TOOL_USE = 'PreToolUse';
export const CODEX_EVENT_POST_TOOL_USE = 'PostToolUse';
export const CODEX_EVENT_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
export const CODEX_EVENT_SESSION_START = 'SessionStart';
export const CODEX_EVENT_STOP = 'Stop';
export const CODEX_EVENT_SESSION_END = 'SessionEnd';

const EVENT_KINDS = new Map<string, HostEventKind>([
  [CODEX_EVENT_PRE_TOOL_USE, 'before_tool_call'],
  [CODEX_EVENT_POST_TOOL_USE, 'after_tool_call'],
  [CODEX_EVENT_USER_PROMPT_SUBMIT, 'before_prompt_build'],
  [CODEX_EVENT_SESSION_START, 'session_start'],
  [CODEX_EVENT_STOP, 'turn_complete'],
]);

export class CodexDecoderError extends Error {
  constructor(readonly reason: string, readonly nextAction: string) {
    super(`Codex input decode failed: ${reason}`);
    this.name = 'CodexDecoderError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = own(value, key);
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new CodexDecoderError(`missing or malformed required field "${key}"`, `Use the exact codex-cli 0.147.0 ${key} field.`);
  }
  return candidate;
}

function requiredNullableString(value: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(value, key)) throw new CodexDecoderError(`missing required field "${key}"`, `Use the exact codex-cli 0.147.0 ${key} field.`);
  const candidate = own(value, key);
  if (candidate !== null && typeof candidate !== 'string') {
    throw new CodexDecoderError(`malformed required field "${key}"`, `${key} must be a string or null.`);
  }
  return candidate;
}

function requiredUnknown(value: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(value, key)) throw new CodexDecoderError(`missing required field "${key}"`, `Use the exact codex-cli 0.147.0 ${key} field.`);
  return own(value, key);
}

function validateCommon(raw: Record<string, unknown>, needsTurn: boolean): { workspaceDir: string; sessionId: string; turnId?: string } {
  const sessionId = requiredString(raw, 'session_id');
  requiredNullableString(raw, 'transcript_path');
  const workspaceDir = requiredString(raw, 'cwd');
  requiredString(raw, 'model');
  requiredString(raw, 'permission_mode');
  const turnId = needsTurn ? requiredString(raw, 'turn_id') : undefined;
  return { workspaceDir, sessionId, ...(turnId ? { turnId } : {}) };
}

export function decodeCodexInput(raw: unknown): HostEvent {
  if (!isRecord(raw)) throw new CodexDecoderError('stdin payload is not a JSON object', 'Run this executable only as a Codex command hook.');
  const eventName = requiredString(raw, 'hook_event_name');
  const kind = EVENT_KINDS.get(eventName);
  if (!kind) throw new CodexDecoderError(`unknown hook_event_name "${eventName}"`, 'Configure only PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, or Stop.');
  const common = validateCommon(raw, kind !== 'session_start');
  let context: HostEventContext;
  let rawPayload: unknown = raw;
  if (kind === 'before_tool_call' || kind === 'after_tool_call') {
    const toolName = requiredString(raw, 'tool_name');
    const toolInput = requiredUnknown(raw, 'tool_input');
    requiredString(raw, 'tool_use_id');
    const toolOutput = kind === 'after_tool_call' ? requiredUnknown(raw, 'tool_response') : undefined;
    context = { ...common, toolName, toolInput, ...(kind === 'after_tool_call' ? { toolOutput } : {}) };
    rawPayload = { toolInput: { toolName, params: toolInput } };
  } else if (kind === 'before_prompt_build') {
    context = { ...common, promptContent: requiredString(raw, 'prompt') };
  } else if (kind === 'turn_complete') {
    // Stop is the G1-verified turn-complete event (probe report §2). Its
    // payload carries stop_hook_active (required boolean); PD consumes the
    // already-flushed transcript, never last_assistant_message directly.
    const stopHookActive = own(raw, 'stop_hook_active');
    if (typeof stopHookActive !== 'boolean') {
      throw new CodexDecoderError('missing or malformed required field "stop_hook_active"', 'Use the exact codex-cli 0.148.0 stop_hook_active field.');
    }
    context = { ...common };
  } else {
    context = { ...common, source: requiredString(raw, 'source') };
  }
  const source = `codex:${eventName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
  return { kind, context, rawPayload, source };
}
