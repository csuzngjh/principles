/**
 * Codex stdout output encoder (ADR-0020 §2.5, SPEC v4.1 §5.3.1)
 *
 * Encodes a unified {@link HostEventResult} into the camelCase JSON object
 * Codex CLI expects on stdout. Codex's schema uses `deny_unknown_fields`
 * (29 occurrences in codex-rs/hooks/src/schema.rs) — emitting any field
 * outside the schema generates `invalid_reason`, which is fail-OPEN
 * (the tool PROCEEDS — ADR-0020 §6, SPEC v4.1 E3).
 *
 * VERIFIED hard constraints (gate-critical before `host.codex.enabled = true`):
 * - `continue: true` MUST be hardcoded. `continue: false` in PreToolUse
 *   generates `invalid_reason` (fail-OPEN).
 * - `permissionDecision` MUST be `undefined | "allow" | "deny"`. NEVER `"ask"`
 *   (unconditionally generates `invalid_reason` per output_parser.rs:445-447).
 * - `suppressOutput` MUST be `undefined` in UserPromptSubmit/SessionStart/Stop/
 *   Compact (not implemented — `let _ =` ignored). MUST be `undefined` or `false`
 *   in PreToolUse/PostToolUse (generates `invalid_reason` if `true`).
 * - `systemMessage` MUST be a non-empty string when present.
 * - `additionalContext` MUST be a string when present (PreToolUse/PostToolUse/
 *   UserPromptSubmit/SessionStart).
 *
 * Exit code semantics (separate from stdout JSON):
 * - exit 0: success (Codex parses stdout JSON)
 * - exit 2: hard block (Codex blocks the tool call, ignores stdout)
 */
import type { HostEventResult } from '@principles/core/host';

// ─── Codex output shapes (per schema.rs, deny_unknown_fields) ───────────────
export interface CodexPreToolUseOutput {
  /** Hardcoded true — continue hook chain. */
  continue: true;
  /** Hook decision. */
  permissionDecision: 'allow' | 'deny';
  /** Reason shown to operator when deny. */
  reason?: string;
  /** Additional context injected into the agent prompt. */
  additionalContext?: string;
  /** Never set — Codex does not implement suppressOutput in PreToolUse. */
  suppressOutput?: false;
  /** Operator-facing message. */
  systemMessage?: string;
}

export interface CodexPostToolUseOutput {
  continue: true;
  /** PostToolUse has no should_stop field (post_tool_use.rs:40-45). */
  additionalContext?: string;
  systemMessage?: string;
}

export interface CodexUserPromptSubmitOutput {
  continue: true;
  /** Additional context injected before the prompt. */
  additionalContext?: string;
  /** Never set in UserPromptSubmit. */
  suppressOutput?: undefined;
}

export interface CodexSessionStartOutput {
  continue: true;
  additionalContext?: string;
}

export type CodexHookOutput =
  | CodexPreToolUseOutput
  | CodexPostToolUseOutput
  | CodexUserPromptSubmitOutput
  | CodexSessionStartOutput;

// ─── Encoder error ───────────────────────────────────────────────────────────
export class CodexEncoderError extends Error {
  readonly reason: string;
  readonly nextAction: string;
  constructor(reason: string, nextAction: string) {
    super(`Codex output encode failed: ${reason}`);
    this.name = 'CodexEncoderError';
    this.reason = reason;
    this.nextAction = nextAction;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertNoExtraFields(result: HostEventResult): void {
  // The HostEventResult only has: decision, reason, modifiedInput,
  // additionalContext, source. We don't reject based on extra HostEventResult
  // fields (they are interpreted, not passed through), but we DO validate
  // that the values map cleanly to Codex's allowed fields.
  //
  // rc-9-no-silent-fallback: `modifiedInput` is not supported on ANY Codex
  // event (Codex's output schema has no field for it). Previously this check
  // was only in encodePreToolUse, silently dropping the value on other events.
  // Now called from encodeCodexOutput before the switch, so all events fail
  // loud instead of silently dropping.
  if (result.modifiedInput !== undefined) {
    throw new CodexEncoderError(
      `HostEventResult.modifiedInput is not supported on Codex (cannot rewrite tool input)`,
      'Codex PreToolUse supports `deny` (block) or `allow` (proceed); use `deny` + reason to block, or `allow` + additionalContext to advise.',
    );
  }
}

// ─── Per-event encoders (declared before public encoder to satisfy
//     @typescript-eslint/no-use-before-define) ────────────────────────────────
function encodePreToolUse(result: HostEventResult): CodexPreToolUseOutput {
  const permissionDecision: 'allow' | 'deny' = result.decision === 'deny' ? 'deny' : 'allow';

  const output: CodexPreToolUseOutput = {
    continue: true, // HARDCODED — never false (fail-OPEN)
    permissionDecision,
  };

  if (result.reason !== undefined) {
    output.reason = result.reason;
  }
  if (result.additionalContext !== undefined) {
    output.additionalContext = result.additionalContext;
  }

  return output;
}

function encodePostToolUse(result: HostEventResult): CodexPostToolUseOutput {
  // PostToolUse has no should_stop / permissionDecision field
  // `decision: 'deny'` is meaningless here (tool already ran) — we surface
  // the reason via systemMessage instead.
  const output: CodexPostToolUseOutput = { continue: true };

  if (result.additionalContext !== undefined) {
    output.additionalContext = result.additionalContext;
  }
  if (result.decision === 'deny' && result.reason !== undefined) {
    // Translate deny + reason into a systemMessage so the operator sees
    // the post-tool observation without trying to block (impossible post-fact).
    output.systemMessage = `[PD observe] ${result.reason}`;
  }

  return output;
}

function encodeUserPromptSubmit(result: HostEventResult): CodexUserPromptSubmitOutput {
  const output: CodexUserPromptSubmitOutput = { continue: true };

  if (result.additionalContext !== undefined) {
    output.additionalContext = result.additionalContext;
  }
  // UserPromptSubmit supports `decision: "block"` in Codex's own schema, but PD
  // uses `additionalContext` for prompt injection. If PD returns deny, we
  // translate it to a systemMessage + continue:true (cannot block prompt submit
  // without disrupting the agent loop).
  //
  // rc-9: merge with existing additionalContext instead of overwriting —
  // previously `deny + reason` would silently replace the injected context.
  if (result.decision === 'deny' && result.reason !== undefined) {
    const denyNote = `[PD] ${result.reason}`;
    output.additionalContext = result.additionalContext !== undefined
      ? `${result.additionalContext}\n${denyNote}`
      : denyNote;
  }

  return output;
}

function encodeSessionStart(result: HostEventResult): CodexSessionStartOutput {
  const output: CodexSessionStartOutput = { continue: true };

  if (result.additionalContext !== undefined) {
    output.additionalContext = result.additionalContext;
  }

  return output;
}

// ─── Public encoder ──────────────────────────────────────────────────────────
/**
 * Encode a unified HostEventResult into a Codex stdout JSON object.
 *
 * The `kind` parameter selects which Codex output shape applies, because
 * Codex's per-event schemas differ (PreToolUse has permissionDecision;
 * PostToolUse does not; etc.).
 *
 * @throws {CodexEncoderError} when the result cannot be safely encoded
 *  without triggering Codex's fail-OPEN invalid_reason path.
 */
export function encodeCodexOutput(result: HostEventResult, kind: string): CodexHookOutput {
  // Validate reason: required for `deny`, optional otherwise but must be
  // a non-empty string when present.
  // Check deny-specific case first so the operator-facing message is precise.
  if (result.decision === 'deny' && !isNonEmptyString(result.reason)) {
    throw new CodexEncoderError(
      'decision "deny" requires a non-empty reason',
      'Codex shows `reason` to the operator when denying; supply an explanation + nextAction.',
    );
  }
  if (result.reason !== undefined && !isNonEmptyString(result.reason)) {
    throw new CodexEncoderError(
      'reason must be a non-empty string when present',
      'Drop reason or supply a non-empty operator-readable message.',
    );
  }
  if (result.additionalContext !== undefined && !isNonEmptyString(result.additionalContext)) {
    throw new CodexEncoderError(
      'additionalContext must be a non-empty string when present',
      'Drop additionalContext or supply non-empty injection text.',
    );
  }

  // rc-9-no-silent-fallback: validate no unsupported fields before encoding.
  // Called here (not per-encoder) so ALL event kinds check modifiedInput.
  assertNoExtraFields(result);

  switch (kind) {
    case 'before_tool_call':
      return encodePreToolUse(result);
    case 'after_tool_call':
      return encodePostToolUse(result);
    case 'before_prompt_build':
      return encodeUserPromptSubmit(result);
    case 'session_start':
      return encodeSessionStart(result);
    case 'session_end':
      // SessionEnd is deferred (observe-only) — return a minimal continue:true
      return { continue: true };
    default:
      throw new CodexEncoderError(
        `unknown event kind "${kind}"`,
        'CodexHostAdapter.encodeOutput was called with an event kind that does not map to a Codex hook output.',
      );
  }
}

// ─── Whitelist test (gate-critical, ADR-0020 §6 mitigation #1) ──────────────
/**
 * Verify an encoded CodexHookOutput contains ONLY schema-allowed fields.
 * Used by the gate-critical contract test to catch any future field that
 * would trigger Codex's `deny_unknown_fields` rejection (fail-OPEN).
 *
 * This is a pure function — no I/O. Exposed for the codec whitelist test.
 */
const CODEX_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'continue',
  'permissionDecision',
  'reason',
  'additionalContext',
  'suppressOutput',
  'systemMessage',
  'stopReason',
  'updatedInput',
  'updatedMCPToolOutput',
]);

export function codexOutputFieldsAreWhitelisted(output: unknown): { ok: boolean; violators: string[] } {
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    return { ok: false, violators: ['<not-an-object>'] };
  }
  const keys = Object.keys(output);
  const violators = keys.filter((k) => !CODEX_ALLOWED_FIELDS.has(k));
  return { ok: violators.length === 0, violators };
}
