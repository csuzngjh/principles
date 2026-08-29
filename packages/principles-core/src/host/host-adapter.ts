/**
 * HostAdapter — Multi-platform host abstraction (ADR-0020 §2.2)
 *
 * Pure types and type guards only. No I/O. Lives in @principles/core so that
 * any host-specific adapter (Codex, OpenClaw, future Claude Code/OpenCode/Pi)
 * can depend on the interface without depending on each other.
 *
 * Product boundary (docs/product/PRODUCT_IDENTITY.md): PD owns owner-reviewed,
 * reversible behavior internalization. The HostAdapter only normalizes the
 * inbound hook event shape; it does not implement task execution, memory,
 * or autonomous value decisions.
 *
 * MVP scope (ADR-0014 / ADR-0020):
 * - Only `CodexHooksHostAdapter` implements this interface (in packages/codex-adapter/).
 * - `OpenClawHostAdapter` is deferred to Post-MVP (OpenClaw keeps direct api.on() registration).
 * - The interface exists to make the abstraction boundary explicit, not to be immediately polyglot.
 *
 * Runtime Contract Rules (AGENTS.md):
 * - rc-1-treat-as-unknown: rawPayload is `unknown`; consumers must validate before use.
 * - rc-2-no-as-bypass: use the provided type guards, not `as` casts.
 * - rc-3-fail-loud-missing: decoders must fail loud on missing required fields.
 * - rc-6-lineage-consistency: source/sessionId/turnId must come from the same raw payload.
 */

// ─── Unified event kinds ───────────────────────────────────────────────────
/**
 * The normalized set of hook event kinds PD subscribes to across all hosts.
 *
 * Naming is host-agnostic (e.g. `before_tool_call` maps to Codex `PreToolUse`
 * and OpenClaw `before_tool_call`). The host-specific adapter is responsible
 * for translating its native event names into these kinds.
 */
export type HostEventKind =
  | 'before_tool_call' // Codex PreToolUse / OpenClaw before_tool_call
  | 'after_tool_call' // Codex PostToolUse / OpenClaw after_tool_call
  | 'before_prompt_build' // Codex UserPromptSubmit / OpenClaw before_prompt_build
  | 'session_start' // Codex SessionStart / OpenClaw lifecycle start
  | 'turn_complete' // Codex Stop (G1-verified turn-complete event; ingestion trigger, not a dispatch route)
  | 'session_end'; // Codex SessionEnd / OpenClaw lifecycle end (deferred to post-MVP)

export const HOST_EVENT_KINDS: readonly HostEventKind[] = [
  'before_tool_call',
  'after_tool_call',
  'before_prompt_build',
  'session_start',
  'turn_complete',
  'session_end',
] as const;

// ─── Unified event context ──────────────────────────────────────────────────
/**
 * Normalized context extracted from a host's raw hook payload.
 *
 * Lineage fields (sessionId, turnId) MUST come from the same raw payload —
 * never mix sources (rc-6-lineage-consistency).
 *
 * NOTE on turnId: Codex `SessionStart` input lacks `turn_id` (verified in
 * schema.rs:486-497, SPEC v4.1 §5.3.4). Decoders MUST set `turnId = undefined`
 * for session_start events rather than synthesizing a placeholder.
 */
export interface HostEventContext {
  /** Absolute path to the workspace PD is operating on. */
  readonly workspaceDir: string;
  /** Host-assigned session identifier. */
  readonly sessionId: string;
  /**
   * Host-assigned turn identifier. Undefined when the host does not provide
   * one (e.g. Codex SessionStart per SPEC v4.1 §5.3.4).
   */
  readonly turnId?: string;
  /** Tool name for tool-call events (before_tool_call / after_tool_call). */
  readonly toolName?: string;
  /** Raw tool input for before_tool_call (untrusted — rc-1). */
  readonly toolInput?: unknown;
  /** Raw tool output for after_tool_call (untrusted — rc-1). */
  readonly toolOutput?: unknown;
  /** Prompt content for prompt events (before_prompt_build). */
  readonly promptContent?: string;
  /** Session start source (e.g. Codex SessionStart.source). */
  readonly source?: string;
}

// ─── Unified event ──────────────────────────────────────────────────────────
/**
 * A normalized hook event produced by a HostAdapter.decodeEvent().
 *
 * `rawPayload` is retained for traceability and host-specific debugging, but
 * consumers MUST NOT access it without re-validating (rc-1-treat-as-unknown).
 */
export interface HostEvent {
  readonly kind: HostEventKind;
  readonly context: HostEventContext;
  /**
   * The original host-specific payload. Treated as `unknown` per rc-1.
   * Used only for telemetry/trace; business logic MUST use `context`.
   */
  readonly rawPayload: unknown;
  /**
   * Host-scoped source identifier for telemetry, e.g.
   * 'codex:pre_tool_use' or 'openclaw:before_tool_call'.
   * Lineage-consistent with `context.sessionId` (rc-6).
   */
  readonly source: string;
}

// ─── Unified decision semantics ─────────────────────────────────────────────
/**
 * The decision a PD hook returns to the host.
 *
 * `allow` — proceed with the original input.
 * `deny`  — block the action with a reason (gate).
 * `modify` — proceed with modified input (e.g. injected context, sanitized args).
 * `observe` — no decision; record only (used by after_tool_call pain capture).
 */
export type HostDecision = 'allow' | 'deny' | 'modify' | 'observe';

// ─── Unified event result ───────────────────────────────────────────────────
/**
 * Normalized result returned by PD's hook business logic. The HostAdapter
 * encodes this into the host-specific output format (e.g. Codex camelCase JSON
 * on stdout, OpenClaw api return value).
 *
 * IMPORTANT (Codex fail-OPEN risk, ADR-0020 §6):
 * Codex's `deny_unknown_fields` is strict. A CodexHostAdapter.encodeOutput()
 * MUST NOT emit fields outside the Codex schema. `additionalContext` and
 * `modifiedInput` must be translated into the exact Codex output fields
 * (`additionalContext`, `updatedInput`). An invalid field generates
 * `invalid_reason`, which is fail-OPEN (the tool PROCEEDS).
 */
export interface HostEventResult {
  readonly decision: HostDecision;
  /** Human-readable reason (shown to the operator). Required for `deny`. */
  readonly reason?: string;
  /** Modified input for `modify` decision (untrusted shape — host-specific encoding). */
  readonly modifiedInput?: unknown;
  /** Additional context to inject into the prompt (for before_prompt_build). */
  readonly additionalContext?: string;
  /** Telemetry source, lineaged with the originating HostEvent.source (rc-6). */
  readonly source: string;
  /** Host-neutral, bounded degradation notices; adapters decide how to surface them. */
  readonly warnings?: readonly string[];
  /** Host-neutral evaluation facts; adapters must not forward these into strict host schemas. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ─── HostAdapter interface ───────────────────────────────────────────────────
/**
 * Abstraction over a host platform's hook extension model.
 *
 * - OpenClaw: in-process `api.on(eventName, handler)` — host calls PD directly.
 * - Codex CLI: out-of-process stdin/stdout JSON — host spawns `pd-hook.js`.
 *
 * The adapter owns:
 * 1. Decoding the host's raw payload into a unified {@link HostEvent}.
 * 2. Encoding a unified {@link HostEventResult} into the host's output format.
 *
 * The adapter does NOT own business logic (pain detection, principle injection,
 * gate enforcement). That logic consumes HostEvent and produces HostEventResult.
 */
export interface HostAdapter {
  /** Stable host identifier, e.g. 'codex', 'openclaw'. */
  readonly hostId: string;

  /** Extension model: in-process (OpenClaw) vs subprocess (Codex). */
  readonly hostKind: 'inprocess' | 'subprocess';

  /** List of hook event kinds this adapter subscribes to. */
  subscribedEvents(): readonly HostEventKind[];

  /**
   * Decode a host-specific raw payload into a unified HostEvent.
   *
   * Implementations MUST:
   * - Treat `raw` as `unknown` (rc-1) and use type guards (rc-2), never `as`.
   * - Fail loud on missing required fields (rc-3) by throwing a structured error.
   * - Preserve lineage consistency (rc-6): sessionId/turnId from same payload.
   */
  decodeEvent(raw: unknown): HostEvent;

  /**
   * Encode a unified HostEventResult into the host's output format.
   *
   * Implementations MUST:
   * - Respect host-specific `deny_unknown_fields` constraints (Codex schema.rs).
   * - Never emit `permissionDecision: "ask"` (unconditionally generates
   *   `invalid_reason` per output_parser.rs:445-447 — fail-OPEN).
   * - Hardcode safe defaults (e.g. `continue: true` for Codex universal output).
   *
   * @param result the unified result to encode
   * @param kind the originating event kind. Required because some hosts
   *  (Codex) have per-event output schemas — the same decision produces a
   *  different field set for PreToolUse vs PostToolUse vs SessionStart.
   */
  encodeOutput(result: HostEventResult, kind: HostEventKind): unknown;
}

// ─── Type guards (pure functions, no I/O) ────────────────────────────────────
/**
 * Type guard: is the value a valid HostEventKind?
 * Use this instead of `as HostEventKind` (rc-2-no-as-bypass).
 */
export function isHostEventKind(value: unknown): value is HostEventKind {
  if (typeof value !== 'string') return false;
  return (HOST_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Type guard: is the value a valid HostDecision?
 */
export function isHostDecision(value: unknown): value is HostDecision {
  return value === 'allow' || value === 'deny' || value === 'modify' || value === 'observe';
}

/**
 * Type guard: is the value a HostEventContext-shaped object?
 * Validates only structural presence; field-level semantic validation is
 * the decoder's responsibility (rc-4-validate-array-elements where applicable).
 */
export function isHostEventContext(value: unknown): value is HostEventContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.workspaceDir === 'string' &&
    typeof obj.sessionId === 'string'
  );
}

/**
 * Type guard: is the value a HostEvent-shaped object?
 */
export function isHostEvent(value: unknown): value is HostEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    isHostEventKind(obj.kind) &&
    isHostEventContext(obj.context) &&
    typeof obj.source === 'string' &&
    Object.hasOwn(obj, 'rawPayload')
  );
}

/**
 * Type guard: is the value a HostEventResult-shaped object?
 */
export function isHostEventResult(value: unknown): value is HostEventResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (Object.hasOwn(obj, 'warnings')) {
    if (!Array.isArray(obj.warnings) || !obj.warnings.every((warning) => typeof warning === 'string')) return false;
  }
  if (Object.hasOwn(obj, 'metadata') && (typeof obj.metadata !== 'object' || obj.metadata === null || Array.isArray(obj.metadata))) {
    return false;
  }
  return (
    isHostDecision(obj.decision) &&
    typeof obj.source === 'string'
  );
}
