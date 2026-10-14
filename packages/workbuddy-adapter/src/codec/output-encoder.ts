/**
 * WorkBuddy output encoder — unified HostEventResult → host stdout JSON.
 *
 * CONTRACT SOURCE (frozen, probe P02/P04): the WorkBuddy engine wraps ANY
 * raw stdout text (even invalid JSON, even with exit codes 1/2/3) into a
 * model-visible <system-reminder data-role="hook"> on SessionStart and
 * UserPromptSubmit. Therefore:
 *
 *   NEUTRAL RESULT = EMPTY STDOUT. The encoder returns `null` and the entry
 *   writes NOTHING. `{}` or a JSON document without additionalContext is NOT
 *   a safe neutral on this host — it would be injected verbatim.
 *
 * Whitelist (SPEC §4.3, first version): hookSpecificOutput.{hookEventName,
 * permissionDecision (deny ONLY), permissionDecisionReason, additionalContext}.
 * - permissionDecision "allow" is NEVER emitted: the probe proved allow
 *   bypasses the host permission ask (P02), so silence is the only neutral;
 * - deny is PreToolUse-only and requires a non-empty reason (verified to
 *   block the tool and reach the model as `Error: <reason>`);
 * - additionalContext is the verified clean injection channel
 *   (UserPromptSubmit, probe P04) — v1 enables it for before_prompt_build;
 * - modifiedInput/updatedToolOutput/ask/continue:false are REJECTED (OD-06 +
 *   probe side effects: continue:false re-submits the user prompt).
 */
import type { HostEventResult } from '@principles/core/host';

type HookName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart';
interface HookSpecificOutput { hookEventName: HookName; permissionDecision?: 'deny'; permissionDecisionReason?: string; additionalContext?: string }
export interface WorkBuddyHookOutput { hookSpecificOutput: HookSpecificOutput }

export class WorkBuddyEncoderError extends Error {
  constructor(readonly reason: string, readonly nextAction: string) {
    super(`WorkBuddy output encode failed: ${reason}`);
    this.name = 'WorkBuddyEncoderError';
  }
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/**
 * @returns the stdout JSON document, or `null` when the correct output is an
 * EMPTY stdout (neutral — see the file header for why silence is the only
 * safe neutral on this host).
 */
export function encodeWorkbuddyOutput(result: HostEventResult, kind: string): WorkBuddyHookOutput | null {
  if (result.modifiedInput !== undefined) throw new WorkBuddyEncoderError('modifiedInput is rejected by the PD WorkBuddy adapter (OD-06)', 'Deny or stay silent on the original input.');
  const names = new Map<string, HookName>([['before_tool_call', 'PreToolUse'], ['after_tool_call', 'PostToolUse'], ['before_prompt_build', 'UserPromptSubmit'], ['session_start', 'SessionStart']]);
  const hookEventName = names.get(kind);
  if (!hookEventName) throw new WorkBuddyEncoderError(`unknown event kind "${kind}"`, 'Encode only a supported WorkBuddy hook event.');
  if (result.decision === 'deny') {
    if (kind !== 'before_tool_call') throw new WorkBuddyEncoderError(`deny is unsupported for ${kind}`, 'Return the route-compatible host result.');
    if (!nonEmpty(result.reason)) throw new WorkBuddyEncoderError('deny requires a non-empty reason', 'Supply an operator-readable reason.');
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason.trim() } };
  }
  if (result.reason !== undefined) {
    throw new WorkBuddyEncoderError('reason without deny is unsupported', 'Drop reason for a non-deny decision.');
  }
  if (result.additionalContext !== undefined) {
    if (kind !== 'before_prompt_build') throw new WorkBuddyEncoderError(`additionalContext is unsupported for ${kind} in v1`, 'Only the verified UserPromptSubmit injection channel is enabled (SPEC §4.3).');
    if (!nonEmpty(result.additionalContext)) throw new WorkBuddyEncoderError('additionalContext must be non-empty', 'Drop or populate additionalContext.');
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.additionalContext } };
  }
  return null;
}

const TOP_LEVEL = new Set(['hookSpecificOutput']);
const NESTED = new Set(['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'additionalContext']);
const HOOK_NAMES = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart']);

/**
 * Whitelist guard for the encoded output (test surface + runtime belt): the
 * document may carry ONLY the four frozen keys under hookSpecificOutput, and
 * permissionDecision may ONLY be the string "deny" (never "allow"/"ask" —
 * P02 proved allow bypasses the host permission ask).
 */
export function workbuddyOutputFieldsAreWhitelisted(output: unknown): { ok: boolean; violators: string[] } {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return { ok: false, violators: ['<not-an-object>'] };
  const top = Object.keys(output).filter((key) => !TOP_LEVEL.has(key));
  const descriptor = Object.getOwnPropertyDescriptor(output, 'hookSpecificOutput')?.value;
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) return { ok: false, violators: [...top, 'hookSpecificOutput'] };
  const nested = Object.keys(descriptor).filter((key) => !NESTED.has(key)).map((key) => `hookSpecificOutput.${key}`);
  const name = Object.getOwnPropertyDescriptor(descriptor, 'hookEventName')?.value;
  if (typeof name !== 'string' || !HOOK_NAMES.has(name)) nested.push('hookSpecificOutput.hookEventName');
  const decision = Object.getOwnPropertyDescriptor(descriptor, 'permissionDecision')?.value;
  if (decision !== undefined && decision !== 'deny') nested.push('hookSpecificOutput.permissionDecision');
  return { ok: top.length + nested.length === 0, violators: [...top, ...nested] };
}

/**
 * Type guard for values returned by HostAdapter.encodeOutput (interface
 * return type is `unknown` — rc-2: narrow with a guard, never an `as` cast).
 * A document that violates the whitelist is NOT a WorkBuddy hook output.
 */
export function isWorkBuddyHookOutput(value: unknown): value is WorkBuddyHookOutput {
  return value !== null && typeof value === 'object' && workbuddyOutputFieldsAreWhitelisted(value).ok;
}
