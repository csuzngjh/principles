import type { HostEventResult } from '@principles/core/host';

type HookName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart';
interface HookSpecificOutput { hookEventName: HookName; permissionDecision?: 'deny'; permissionDecisionReason?: string; additionalContext?: string }
export interface CodexPreToolUseOutput { hookSpecificOutput: HookSpecificOutput }
export interface CodexPostToolUseOutput { hookSpecificOutput: HookSpecificOutput }
export interface CodexUserPromptSubmitOutput { hookSpecificOutput: HookSpecificOutput }
export interface CodexSessionStartOutput { hookSpecificOutput: HookSpecificOutput }
export type CodexHookOutput = CodexPreToolUseOutput | CodexPostToolUseOutput | CodexUserPromptSubmitOutput | CodexSessionStartOutput;

export class CodexEncoderError extends Error {
  constructor(readonly reason: string, readonly nextAction: string) {
    super(`Codex output encode failed: ${reason}`);
    this.name = 'CodexEncoderError';
  }
}

function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

export function encodeCodexOutput(result: HostEventResult, kind: string): CodexHookOutput {
  if (result.modifiedInput !== undefined) throw new CodexEncoderError('modifiedInput is unsupported by the PD Codex adapter', 'Deny or allow the original input.');
  if (result.additionalContext !== undefined && !nonEmpty(result.additionalContext)) throw new CodexEncoderError('additionalContext must be non-empty', 'Drop or populate additionalContext.');
  const names = new Map<string, HookName>([['before_tool_call', 'PreToolUse'], ['after_tool_call', 'PostToolUse'], ['before_prompt_build', 'UserPromptSubmit'], ['session_start', 'SessionStart']]);
  const hookEventName = names.get(kind);
  if (!hookEventName) throw new CodexEncoderError(`unknown event kind "${kind}"`, 'Encode only a supported Codex hook event.');
  if (result.decision === 'deny' && kind !== 'before_tool_call') throw new CodexEncoderError(`deny is unsupported for ${kind}`, 'Return the route-compatible host result.');
  const hookSpecificOutput: HookSpecificOutput = { hookEventName };
  if (result.decision === 'deny') {
    if (!nonEmpty(result.reason)) throw new CodexEncoderError('deny requires a non-empty reason', 'Supply an operator-readable reason.');
    hookSpecificOutput.permissionDecision = 'deny';
    hookSpecificOutput.permissionDecisionReason = result.reason.trim();
  } else if (result.reason !== undefined) {
    throw new CodexEncoderError('reason without deny is unsupported', 'Drop reason for a non-deny decision.');
  }
  if (result.additionalContext !== undefined) hookSpecificOutput.additionalContext = result.additionalContext;
  return { hookSpecificOutput };
}

const TOP_LEVEL = new Set(['hookSpecificOutput']);
const NESTED = new Set(['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'additionalContext']);
export function codexOutputFieldsAreWhitelisted(output: unknown): { ok: boolean; violators: string[] } {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) return { ok: false, violators: ['<not-an-object>'] };
  const top = Object.keys(output).filter((key) => !TOP_LEVEL.has(key));
  const descriptor = Object.getOwnPropertyDescriptor(output, 'hookSpecificOutput')?.value;
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) return { ok: false, violators: [...top, 'hookSpecificOutput'] };
  const nested = Object.keys(descriptor).filter((key) => !NESTED.has(key)).map((key) => `hookSpecificOutput.${key}`);
  const name = Object.getOwnPropertyDescriptor(descriptor, 'hookEventName')?.value;
  if (!['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart'].includes(String(name))) nested.push('hookSpecificOutput.hookEventName');
  return { ok: top.length + nested.length === 0, violators: [...top, ...nested] };
}
