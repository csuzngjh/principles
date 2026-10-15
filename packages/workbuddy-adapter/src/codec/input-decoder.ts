/**
 * WorkBuddy input decoder — stdin JSON → unified HostEvent.
 *
 * CONTRACT SOURCE (frozen): tests/fixtures/host-contract/hook-runtime-contract.json,
 * captured by Phase 0 real-host probes P01–P06 on WorkBuddy Desktop 5.8.1 /
 * engine 2.161.0 (2026-10-12). Every required-field set below mirrors that
 * contract's per-event `payloadFields.required` exactly; the 10 real payload
 * fixtures under tests/fixtures/host-contract/events/ are the decode tests'
 * primary inputs.
 *
 * Runtime Contract rules applied (AGENTS.md §9):
 * - rc-1/rc-2: the payload is `unknown`; every consumed field is guarded, never
 *   `as`-cast;
 * - rc-3: missing/malformed required fields fail loud via WorkBuddyDecoderError;
 * - rc-6: sessionId/turnId/toolCallId all come from the SAME raw payload — a
 *   missing id is left undefined, never fabricated from timestamps/hashes;
 * - rc-5: Object.hasOwn-based own-field reads.
 *
 * SPEC workbuddy-host-adapter §4.2 decisions frozen here:
 * - SessionStart has NO cwd (probe P00) — workspaceDir is left empty for the
 *   process entry to replace with the resolved governance workspace;
 * - generation_id → context.turnId (present on all observed events, stable
 *   within one turn); call_id (= tool_use_id) → context.toolCallId; both
 *   OPTIONAL per the frozen contract — undefined stays undefined;
 * - transcript_path is validated for TYPE only and never opened (MVP privacy
 *   boundary: PD does not read the transcript);
 * - permission_mode is type-validated and retained WITHOUT granting any extra
 *   authority — bypassPermissions never bypasses the governance gate;
 * - PostToolUseFailure (thrown tool errors) maps onto the SAME after_tool_call
 *   pain path as PostToolUse: a thrown tool error is a real tool failure.
 *   Registration history (OD-02, evidence-driven): v1 did NOT register it —
 *   P03 was then read as "ordinary failures already reach PostToolUse". The
 *   independent re-verification (2026-10-13, engine 2.161.0 sha256 1b1a01bc…,
 *   scripts/dev/workbuddy-probe/probe-post-tool-use-failure.mjs) FALSIFIED
 *   that reading: a Write to an existing-but-not-read file emits ONLY
 *   PostToolUseFailure (tool_error_code=2009, thrown `error`, NO
 *   tool_response) — PostToolUse never fires for that failure class. hooks.json
 *   therefore registers the event (matcher '*'), still without adding a core
 *   event kind: the payload normalizes to the shared failure envelope below.
 */
import path from 'node:path';
import type { HostEvent, HostEventContext, HostEventKind } from '@principles/core/host';

const HOST_CONTRACT_BASELINE = 'WorkBuddy Desktop 5.8.1 / engine 2.161.0 (Phase 0 probe contract, 2026-10-12)';

export const WORKBUDDY_EVENT_PRE_TOOL_USE = 'PreToolUse';
export const WORKBUDDY_EVENT_POST_TOOL_USE = 'PostToolUse';
export const WORKBUDDY_EVENT_POST_TOOL_USE_FAILURE = 'PostToolUseFailure';
export const WORKBUDDY_EVENT_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
export const WORKBUDDY_EVENT_SESSION_START = 'SessionStart';

const EVENT_KINDS = new Map<string, HostEventKind>([
  [WORKBUDDY_EVENT_PRE_TOOL_USE, 'before_tool_call'],
  [WORKBUDDY_EVENT_POST_TOOL_USE, 'after_tool_call'],
  [WORKBUDDY_EVENT_POST_TOOL_USE_FAILURE, 'after_tool_call'],
  [WORKBUDDY_EVENT_USER_PROMPT_SUBMIT, 'before_prompt_build'],
  [WORKBUDDY_EVENT_SESSION_START, 'session_start'],
]);

export class WorkBuddyDecoderError extends Error {
  constructor(readonly reason: string, readonly nextAction: string) {
    super(`WorkBuddy input decode failed: ${reason}`);
    this.name = 'WorkBuddyDecoderError';
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
    throw new WorkBuddyDecoderError(`missing or malformed required field "${key}"`, `Use the exact ${HOST_CONTRACT_BASELINE} ${key} field.`);
  }
  return candidate;
}

/** Required-presence field whose value may legitimately be null (transcript_path). */
function requiredNullableString(value: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(value, key)) throw new WorkBuddyDecoderError(`missing required field "${key}"`, `Use the exact ${HOST_CONTRACT_BASELINE} ${key} field.`);
  const candidate = own(value, key);
  if (candidate !== null && typeof candidate !== 'string') {
    throw new WorkBuddyDecoderError(`malformed required field "${key}"`, `${key} must be a string or null.`);
  }
  return candidate;
}

function requiredRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!Object.hasOwn(value, key)) throw new WorkBuddyDecoderError(`missing required field "${key}"`, `Use the exact ${HOST_CONTRACT_BASELINE} ${key} field.`);
  const candidate = own(value, key);
  if (!isRecord(candidate)) {
    throw new WorkBuddyDecoderError(`malformed required field "${key}"`, `${key} must be a JSON object.`);
  }
  return candidate;
}

/** Optional field CONSUMED for lineage: absent → undefined; present-but-invalid → fail loud (rc-3/rc-6). */
function consumedOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const candidate = own(value, key);
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new WorkBuddyDecoderError(`malformed optional field "${key}"`, `${key} must be a non-empty string when present.`);
  }
  return candidate;
}

/** Optional field NOT consumed for logic: type-check only when present, value retained nowhere. */
function validateOptionalStringType(value: Record<string, unknown>, key: string): void {
  if (!Object.hasOwn(value, key)) return;
  const candidate = own(value, key);
  if (typeof candidate !== 'string') {
    throw new WorkBuddyDecoderError(`malformed optional field "${key}"`, `${key} must be a string when present.`);
  }
}

function requiredAbsoluteCwd(value: Record<string, unknown>): string {
  const cwd = requiredString(value, 'cwd');
  if (!path.isAbsolute(cwd)) {
    throw new WorkBuddyDecoderError('cwd is not an absolute path', 'WorkBuddy hook payloads carry the absolute project cwd.');
  }
  return cwd;
}

function field(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/**
 * SPEC §4.2 failure normalization: WorkBuddy marks tool failure through
 * explicit shapes — `{is_error:true,...}` (Read failures), Bash
 * `{exitCode>0, error}` — while SUCCESS may be a bare STRING (rendered Read
 * output). A string carries no failure marker and is passed through
 * faithfully (the frozen fixtures show string === Read success; asserting
 * success-or-failure from string-ness alone would be fabrication).
 *
 * The shared production pain path (production-pain-evidence normalizeOutcome)
 * detects failure from an `error` field or a non-zero `exitCode` on the
 * envelope/result. `{is_error:true}` WITHOUT either (the read-iserror fixture
 * shape) would silently classify as success there — so this decoder wraps
 * every DETECTED failure in an explicit envelope
 * `{result: <original>, error: <explicit>}`, preserving the raw response
 * inside `result` while guaranteeing the failure is never missed. Missing
 * exitCode on a detected failure NEVER defaults to success.
 */
export function normalizeWorkbuddyToolResponse(toolResponse: unknown, eventForDiagnostics: string): unknown {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!isRecord(toolResponse)) {
    throw new WorkBuddyDecoderError(`malformed required field "tool_response"`, `${eventForDiagnostics} tool_response must be the rendered string or the engine result object from ${HOST_CONTRACT_BASELINE}.`);
  }
  const isError = field(toolResponse, 'is_error') === true;
  const exitCodeValue = field(toolResponse, 'exitCode');
  const exitCode = typeof exitCodeValue === 'number' ? exitCodeValue : undefined;
  const errorValue = field(toolResponse, 'error');
  const errorText = typeof errorValue === 'string' && errorValue.trim().length > 0 ? errorValue : undefined;
  const failed = isError || (exitCode !== undefined && exitCode > 0) || errorText !== undefined;
  if (!failed) return toolResponse;
  const toolErrorCode = field(toolResponse, 'tool_error_code');
  let explicitError: string;
  if (errorText !== undefined) {
    explicitError = errorText;
  } else {
    const codeSuffix = typeof toolErrorCode === 'string' && toolErrorCode.length > 0 ? ` tool_error_code=${toolErrorCode}` : '';
    explicitError = `workbuddy tool failure: is_error=true${codeSuffix}`;
  }
  return { result: toolResponse, error: explicitError };
}

export function decodeWorkbuddyInput(raw: unknown): HostEvent {
  if (!isRecord(raw)) throw new WorkBuddyDecoderError('stdin payload is not a JSON object', 'Run this executable only as a WorkBuddy command hook.');
  const eventName = requiredString(raw, 'hook_event_name');
  const kind = EVENT_KINDS.get(eventName);
  if (!kind) {
    throw new WorkBuddyDecoderError(`unknown hook_event_name "${eventName}"`, 'Configure only PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, or SessionStart.');
  }
  const sessionId = requiredString(raw, 'session_id');
  requiredNullableString(raw, 'transcript_path');
  // ID mapping (frozen contract §ids): generation_id → turnId on every event
  // where the host provides it; call_id (= tool_use_id) → toolCallId. Neither
  // is ever fabricated when missing (rc-6).
  const turnId = consumedOptionalString(raw, 'generation_id');
  const base = { sessionId, ...(turnId !== undefined ? { turnId } : {}) };

  let context: HostEventContext;
  let rawPayload: unknown = raw;
  if (kind === 'session_start') {
    // SessionStart has NO cwd (probe P00): source/permission_mode/client/version
    // are the frozen required set. workspaceDir stays empty here — the process
    // entry replaces it with the resolved governance workspace before dispatch.
    const source = requiredString(raw, 'source');
    requiredString(raw, 'permission_mode');
    requiredString(raw, 'client');
    requiredString(raw, 'version');
    context = { ...base, workspaceDir: '', source };
  } else if (kind === 'before_prompt_build') {
    const cwd = requiredAbsoluteCwd(raw);
    validateOptionalStringType(raw, 'permission_mode');
    context = { ...base, workspaceDir: cwd, promptContent: requiredString(raw, 'prompt') };
  } else {
    const cwd = requiredAbsoluteCwd(raw);
    validateOptionalStringType(raw, 'permission_mode');
    const toolName = requiredString(raw, 'tool_name');
    const toolInput = requiredRecord(raw, 'tool_input');
    const callId = consumedOptionalString(raw, 'call_id') ?? consumedOptionalString(raw, 'tool_use_id');
    if (kind === 'after_tool_call') {
      let toolOutput: unknown;
      if (eventName === WORKBUDDY_EVENT_POST_TOOL_USE) {
        if (!Object.hasOwn(raw, 'tool_response')) {
          throw new WorkBuddyDecoderError('missing required field "tool_response"', `Use the exact ${HOST_CONTRACT_BASELINE} tool_response field.`);
        }
        toolOutput = normalizeWorkbuddyToolResponse(own(raw, 'tool_response'), eventName);
      } else {
        // PostToolUseFailure: the engine result is the thrown `error` (+ codes).
        // Normalize to the same explicit failure envelope so the shared pain
        // path sees it identically to an is_error PostToolUse result.
        const thrownError = requiredString(raw, 'error');
        toolOutput = { result: raw, error: thrownError };
      }
      context = { ...base, workspaceDir: cwd, toolName, ...(callId !== undefined ? { toolCallId: callId } : {}), toolInput, toolOutput };
    } else {
      context = { ...base, workspaceDir: cwd, toolName, ...(callId !== undefined ? { toolCallId: callId } : {}), toolInput };
    }
    // The shared production gate reads its tool tuple from rawPayload.toolInput
    // (production-rulehost-gate readToolInput contract).
    rawPayload = { toolInput: { toolName, params: toolInput } };
  }
  const source = `workbuddy:${eventName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
  return { kind, context, rawPayload, source };
}
