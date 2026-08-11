/**
 * Codex stdin input decoder (ADR-0020 §2.5, SPEC v4.1 §5.3)
 *
 * Codex CLI spawns `pd-hook.js` and writes a JSON object to stdin using
 * **snake_case** field names (asymmetric with stdout, which uses camelCase).
 *
 * This module decodes that raw JSON into a unified {@link HostEvent}. All
 * input is treated as `unknown` and validated via type guards — never `as`
 * casts (rc-1, rc-2). Missing required fields fail loud (rc-3).
 *
 * Lineage consistency (rc-6): sessionId/turnId are extracted from the same
 * payload — never mixed across sources.
 *
 * VERIFIED against codex-rs/hooks/src/schema.rs (HEAD 2cc9dbb984, 2026-08-11):
 * - `hook_event_name` discriminates the event kind.
 * - `session_id` is present on all events.
 * - `turn_id` is present on PreToolUse / PostToolUse / UserPromptSubmit, but
 *   MISSING on SessionStart (SessionStartCommandInput in schema.rs:486-497).
 * - `tool_name` + `tool_input` on PreToolUse; `tool_name` + `tool_response` on PostToolUse.
 * - `prompt` on UserPromptSubmit.
 * - `source` on SessionStart (e.g. 'startup', 'resume', 'clear').
 */
import type { HostEvent, HostEventContext, HostEventKind } from '@principles/core/host';

// ─── Codex native event names (snake_case) ──────────────────────────────────
export const CODEX_EVENT_PRE_TOOL_USE = 'PreToolUse';
export const CODEX_EVENT_POST_TOOL_USE = 'PostToolUse';
export const CODEX_EVENT_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
export const CODEX_EVENT_SESSION_START = 'SessionStart';
export const CODEX_EVENT_SESSION_END = 'SessionEnd';

const CODEX_EVENT_TO_KIND: Readonly<Record<string, HostEventKind>> = {
  [CODEX_EVENT_PRE_TOOL_USE]: 'before_tool_call',
  [CODEX_EVENT_POST_TOOL_USE]: 'after_tool_call',
  [CODEX_EVENT_USER_PROMPT_SUBMIT]: 'before_prompt_build',
  [CODEX_EVENT_SESSION_START]: 'session_start',
  [CODEX_EVENT_SESSION_END]: 'session_end',
};

// ─── Decoder error ───────────────────────────────────────────────────────────
export class CodexDecoderError extends Error {
  readonly reason: string;
  readonly nextAction: string;
  constructor(reason: string, nextAction: string) {
    super(`Codex input decode failed: ${reason}`);
    this.name = 'CodexDecoderError';
    this.reason = reason;
    this.nextAction = nextAction;
  }
}

// ─── Type guards (rc-2: no `as` bypass) ─────────────────────────────────────
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(obj: Record<string, unknown>, key: string): string | undefined {
  if (Object.hasOwn(obj, key) && typeof obj[key] === 'string') {
    return obj[key];
  }
  return undefined;
}

function requireStringField(obj: Record<string, unknown>, key: string, errorContext: string): string {
  const value = readStringField(obj, key);
  if (value === undefined) {
    throw new CodexDecoderError(
      `missing required field "${key}"${errorContext ? ` (${errorContext})` : ''}`,
      `Codex hook input must include ${key}. Check Codex version >= 0.124.0 and matcher configuration (ADR-0020 §2.4).`,
    );
  }
  return value;
}

// ─── Per-event context builders ──────────────────────────────────────────────
interface ContextBase {
  workspaceDir: string;
  sessionId: string;
  turnId?: string;
}

function buildPreToolUseContext(raw: Record<string, unknown>, base: ContextBase): HostEventContext {
  const toolName = requireStringField(raw, 'tool_name', 'PreToolUse');
  const hasToolInput = Object.hasOwn(raw, 'tool_input');
  return {
    workspaceDir: base.workspaceDir,
    sessionId: base.sessionId,
    ...(base.turnId !== undefined ? { turnId: base.turnId } : {}),
    toolName,
    ...(hasToolInput ? { toolInput: raw.tool_input } : {}),
  };
}

function buildPostToolUseContext(raw: Record<string, unknown>, base: ContextBase): HostEventContext {
  const toolName = requireStringField(raw, 'tool_name', 'PostToolUse');
  const hasToolResponse = Object.hasOwn(raw, 'tool_response');
  return {
    workspaceDir: base.workspaceDir,
    sessionId: base.sessionId,
    ...(base.turnId !== undefined ? { turnId: base.turnId } : {}),
    toolName,
    ...(hasToolResponse ? { toolOutput: raw.tool_response } : {}),
  };
}

function buildUserPromptSubmitContext(raw: Record<string, unknown>, base: ContextBase): HostEventContext {
  const prompt = requireStringField(raw, 'prompt', 'UserPromptSubmit');
  return {
    workspaceDir: base.workspaceDir,
    sessionId: base.sessionId,
    ...(base.turnId !== undefined ? { turnId: base.turnId } : {}),
    promptContent: prompt,
  };
}

function buildSessionStartContext(raw: Record<string, unknown>, base: Pick<ContextBase, 'workspaceDir' | 'sessionId'>): HostEventContext {
  // SessionStart lacks turn_id per schema.rs:486-497 — do NOT synthesize one.
  const source = readStringField(raw, 'source');
  return {
    workspaceDir: base.workspaceDir,
    sessionId: base.sessionId,
    ...(source !== undefined ? { source } : {}),
  };
}

// ─── Public decoder ─────────────────────────────────────────────────────────
/**
 * Decode a raw Codex hook payload (read from stdin) into a unified HostEvent.
 *
 * @throws {CodexDecoderError} when required fields are missing or malformed (rc-3).
 *  Codex's own `deny_unknown_fields` would reject our output if we proceeded
 *  with malformed input; failing loud here keeps the fail-OPEN risk visible.
 */
export function decodeCodexInput(raw: unknown): HostEvent {
  // rc-1, rc-2: treat as unknown, use type guards
  if (!isObject(raw)) {
    throw new CodexDecoderError(
      'stdin payload is not a JSON object',
      'Verify pd-hook.js is invoked by Codex (not manually); Codex always sends a JSON object on stdin.',
    );
  }

  // Discriminator: hook_event_name
  const codexEventName = requireStringField(raw, 'hook_event_name', '');
  const kind = CODEX_EVENT_TO_KIND[codexEventName];
  if (!kind) {
    throw new CodexDecoderError(
      `unknown hook_event_name "${codexEventName}"`,
      `PD adapter only subscribes to: ${Object.keys(CODEX_EVENT_TO_KIND).join(', ')}. Other Codex events (PermissionRequest, Compact, SubagentStop, Stop) are deferred to post-MVP.`,
    );
  }

  // Common fields: session_id (required on every Codex hook)
  const sessionId = requireStringField(raw, 'session_id', '');

  // turn_id: present on PreToolUse/PostToolUse/UserPromptSubmit, MISSING on SessionStart
  // (verified from SessionStartCommandInput in schema.rs:486-497, SPEC v4.1 §5.3.4)
  const turnId = readStringField(raw, 'turn_id');

  // workspaceDir: Codex does not provide this directly in the hook payload.
  // The pd-hook.js wrapper resolves it from process.env.PD_WORKSPACE_DIR
  // (set by the installer) or falls back to process.cwd(). The decoder
  // expects the wrapper to inject `workspace_dir` before calling decode.
  const workspaceDir = requireStringField(raw, 'workspace_dir', '');

  // Build per-event context
  const base: ContextBase = { workspaceDir, sessionId, turnId };
  let context: HostEventContext;
  switch (kind) {
    case 'before_tool_call':
      context = buildPreToolUseContext(raw, base);
      break;
    case 'after_tool_call':
      context = buildPostToolUseContext(raw, base);
      break;
    case 'before_prompt_build':
      context = buildUserPromptSubmitContext(raw, base);
      break;
    case 'session_start':
      context = buildSessionStartContext(raw, base);
      break;
    case 'session_end':
      // SessionEnd is deferred (observe-only); minimal context
      context = { workspaceDir, sessionId };
      break;
  }

  const source = `codex:${codexEventName.toLowerCase()}`;
  return {
    kind,
    context,
    rawPayload: raw, // retained for telemetry/trace (rc-1: consumers must re-validate)
    source,
  };
}
