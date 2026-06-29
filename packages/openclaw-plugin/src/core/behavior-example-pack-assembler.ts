/**
 * PRI-484 — Phase 5 Task 28 — BehaviorExamplePackAssembler (plugin I/O)
 *
 * Reads pain lineage + trajectory rows from TrajectoryDatabase and assembles
 * a validated BehaviorExamplePack for the Artificer. Fail loud on any gap
 * (missing pain, empty trajectory, invalid pack) — no silent fallback.
 *
 * Err-prevention:
 *   - ERR-001: every DB row field validated as `unknown` (no `as` bypass on
 *     parsed params_json or row casts).
 *   - ERR-069: Artificer shared schema — invalid pack must fail loud.
 *   - ERR-026: reuses production TrajectoryDatabase (no hand-written DDL).
 *   - rc-2: structural type guards, no `as T` on parsed input.
 *   - rc-5: Object.hasOwn over `in`.
 *   - rc-9: every failure path throws a structured Error with a clear reason.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §7.2
 *
 * Boundary: this module is I/O. Pure logic (type + validator) lives in
 * `@principles/core/runtime-v2` → `behavior-example-pack.ts`.
 */
import {
  buildRuleHostAction,
  computeBehaviorFacts,
  validateBehaviorExamplePack,
} from '@principles/core/runtime-v2';
import type {
  RuleContextV2,
  BehaviorExamplePack,
  GoldenTraceCaseInput,
} from '@principles/core/runtime-v2';
import type { TrajectoryDatabase } from './trajectory.js';
import { TrajectoryRegistry } from './trajectory.js';
import type {
  RuleHostEvidenceRow,
  RuleHostContextRow,
  RuleHostContextResult,
} from './trajectory-types.js';
import { assembleHistoryFromRows } from './rule-context-assembler.js';

// ── public types ───────────────────────────────────────────────────────────

export interface BehaviorExamplePackAssemblerOptions {
  /** Workspace directory — used to obtain the shared TrajectoryDatabase. */
  readonly workspaceDir: string;
  /**
   * State directory (unused for direct DB access but required by the
   * WorkspaceContext facade pattern; future-proofing for redaction config).
   */
  readonly stateDir: string;
}

export interface BehaviorExamplePackAssemblerInput {
  /** Canonical pain ID (e.g. pain_<ts>_<hash>) — entry point into pain lineage. */
  readonly sourcePainId: string;
  /** Owner's natural-language desired outcome — must be non-empty. */
  readonly ownerDesiredOutcome: string;
  /** Owner-selected call that demonstrates behaviour to block. */
  readonly sourceNegativeToolCallId: number;
  /** Owner-selected calls that demonstrate behaviour to allow (1..3). */
  readonly positiveToolCallIds: readonly number[];
  /**
   * Project directory, used to detect absolute paths that should be redacted
   * to relative/basename form in the assembled pack.
   */
  readonly projectDir: string;
}

// ── internal constants ─────────────────────────────────────────────────────

const MAX_POSITIVES = 3;
const MAX_EVIDENCE_REFS = 5;
const HISTORY_LIMIT = 100;

const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

// ── type guards (rc-2: no `as` bypass) ─────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNoProtoKeys(value: Record<string, unknown>): boolean {
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) return false;
  }
  return true;
}

// ── BehaviorExamplePackAssembler ───────────────────────────────────────────

/**
 * Plugin I/O assembler: pain lineage + trajectory → validated BehaviorExamplePack.
 *
 * Lifecycle: cheap to construct; obtains TrajectoryDatabase via the registry.
 * Dispose is the registry's responsibility (singleton per workspace).
 */
export class BehaviorExamplePackAssembler {
  private readonly db: TrajectoryDatabase;

  constructor(opts: BehaviorExamplePackAssemblerOptions) {
    // TrajectoryRegistry.get returns the workspace-wide singleton; do NOT
    // dispose it here. The caller (typically a workspace lifecycle hook)
    // owns dispose.
    this.db = TrajectoryRegistry.get(opts.workspaceDir);
  }

  /** Assemble only from explicit Owner labels; execution outcome is not a label. */
  assemble(input: BehaviorExamplePackAssemblerInput): BehaviorExamplePack {
    const pain = this.db.getPainEventByCanonicalId(input.sourcePainId);
    if (!pain) {
      throw new Error(
        `[BehaviorExamplePackAssembler] pain event not found for canonical_pain_id="${input.sourcePainId}" (ERR-069 fail loud)`,
      );
    }

    validateOwnerSelection(input);
    const negativeRow = requireSelectedRow(this.db.getRuleHostEvidenceRow(input.sourceNegativeToolCallId), input.sourceNegativeToolCallId);
    const positiveRows = input.positiveToolCallIds.map((id) => requireSelectedRow(this.db.getRuleHostEvidenceRow(id), id));
    for (const row of [negativeRow, ...positiveRows]) {
      if (row.sessionId !== pain.sessionId) {
        throw new Error(`[BehaviorExamplePackAssembler] selected tool call ${row.id} session mismatch; all examples must belong to pain session ${pain.sessionId}`);
      }
    }

    const redactionNotes: string[] = [];
    const sourceNegativeCase = this.buildSelectedCase(negativeRow, 'negative', 'block', input.projectDir, redactionNotes);
    const positiveCounterexamples = positiveRows.map((row) => this.buildSelectedCase(row, 'positive', 'allow', input.projectDir, redactionNotes));
    const pack: BehaviorExamplePack = {
      sourceNegativeCase,
      ownerDesiredOutcome: input.ownerDesiredOutcome,
      positiveCounterexamples,
      evidenceRefs: [`pain:${pain.id}`, `tool_call:${negativeRow.id}`, ...positiveRows.map((row) => `tool_call:${row.id}`)].slice(0, MAX_EVIDENCE_REFS),
      redactionNotes,
    };

    // ── 9. Validate — fail loud (ERR-069) ──
    const validation = validateBehaviorExamplePack(pack);
    if (!validation.valid) {
      throw new Error(
        `[BehaviorExamplePackAssembler] assembled pack failed validateBehaviorExamplePack: ${validation.errors.join('; ')} (ERR-069 fail loud)`,
      );
    }

    return pack;
  }

  private buildSelectedCase(
    row: RuleHostEvidenceRow,
    kind: 'positive' | 'negative',
    expectedDecision: 'allow' | 'block',
    projectDir: string,
    redactionNotes: string[],
  ): GoldenTraceCaseInput {
    const base = buildCaseFromRow(row, kind, expectedDecision, projectDir);
    const redaction = redactParams(base.params, projectDir);
    redactionNotes.push(...redaction.notes);
    const historyResult: RuleHostContextResult = this.db.getRuleHostContextRowsBefore(row.sessionId, row.id, HISTORY_LIMIT);
    const history = assembleHistoryFromRows(historyResult.rows, historyResult.truncated, projectDir);
    const action = buildRuleHostAction(row.toolName, redaction.redacted, projectDir);
    const ruleContext: RuleContextV2 = { version: 2, history, facts: computeBehaviorFacts(history, action.normalizedPath || null, null) };
    return { ...base, params: redaction.redacted, ruleContext };
  }
}

function validateOwnerSelection(input: BehaviorExamplePackAssemblerInput): void {
  if (!Number.isSafeInteger(input.sourceNegativeToolCallId) || input.sourceNegativeToolCallId <= 0) {
    throw new Error('[BehaviorExamplePackAssembler] sourceNegativeToolCallId must be a positive integer');
  }
  if (!Array.isArray(input.positiveToolCallIds) || input.positiveToolCallIds.length === 0 || input.positiveToolCallIds.length > MAX_POSITIVES) {
    throw new Error('[BehaviorExamplePackAssembler] positiveToolCallIds must contain 1 to at most 3 IDs');
  }
  const allIds = [input.sourceNegativeToolCallId, ...input.positiveToolCallIds];
  if (allIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(allIds).size !== allIds.length) {
    throw new Error('[BehaviorExamplePackAssembler] selected tool call IDs must be unique positive integers');
  }
}

function requireSelectedRow(row: RuleHostEvidenceRow | null, id: number): RuleHostEvidenceRow {
  if (!row) throw new Error(`[BehaviorExamplePackAssembler] selected tool call id=${id} not found`);
  return row;
}

// ── internal: case builder ─────────────────────────────────────────────────

/**
 * Build a GoldenTraceCaseInput from a trajectory tool_call row.
 *
 * ERR-001: parses params_json as unknown and structurally validates (must be
 * a plain object without proto-pollution keys). Throws on malformed input
 * (rc-9: no silent fallback).
 */
function buildCaseFromRow(
  row: RuleHostContextRow,
  kind: 'positive' | 'negative',
  expectedDecision: 'allow' | 'block',
  _projectDir: string,
): GoldenTraceCaseInput {
  if (typeof row.toolName !== 'string' || row.toolName.length === 0) {
    throw new Error(
      `[BehaviorExamplePackAssembler] row id=${row.id}: toolName must be a non-empty string (rc-9 fail loud)`,
    );
  }
  if (typeof row.paramsJson !== 'string') {
    throw new Error(
      `[BehaviorExamplePackAssembler] row id=${row.id}: paramsJson must be a string (rc-9 fail loud)`,
    );
  }

  let parsedParams: unknown;
  try {
    parsedParams = JSON.parse(row.paramsJson);
  } catch {
    throw new Error(
      `[BehaviorExamplePackAssembler] row id=${row.id}: paramsJson is not valid JSON (rc-9 fail loud)`,
    );
  }

  if (!isPlainObject(parsedParams)) {
    throw new Error(
      `[BehaviorExamplePackAssembler] row id=${row.id}: paramsJson must parse to a non-array object (rc-9 fail loud)`,
    );
  }
  if (!hasNoProtoKeys(parsedParams)) {
    throw new Error(
      `[BehaviorExamplePackAssembler] row id=${row.id}: paramsJson must not carry prototype-pollution keys (ERR-076, rc-9 fail loud)`,
    );
  }

  return {
    caseId: `case-${kind}-${row.id}`,
    kind,
    toolName: row.toolName,
    params: parsedParams,
    expectedDecision,
  };
}

// ── internal: redaction ────────────────────────────────────────────────────

interface RedactionResult {
  redacted: Record<string, unknown>;
  notes: string[];
}

/**
 * Redact sensitive fields from tool call params before they enter the pack.
 *
 * First-version policy:
 *   - Absolute paths outside the project tree → replaced with `<redacted:absolute-path>`
 *   - String values that look like secrets (long base64 / AKIA-style keys / etc.)
 *     → replaced with `<redacted:secret>`
 *
 * Records each redaction in `notes` so the Artificer and the owner can see
 * what was stripped (spec §7.2: redactionNotes is part of the pack contract).
 */
function redactParams(
  params: Record<string, unknown>,
  projectDir: string,
): RedactionResult {
  const notes: string[] = [];
  const redacted: Record<string, unknown> = {};

  for (const key of Object.keys(params)) {
    if (PROTO_KEYS.has(key)) continue; // defense in depth (ERR-076)
    const value = params[key];
    if (typeof value !== 'string') {
      redacted[key] = value;
      continue;
    }

    // Path-like values
    if (looksLikeAbsolutePath(value) && !value.startsWith(projectDir)) {
      redacted[key] = '<redacted:absolute-path>';
      notes.push(`redacted absolute path in field "${key}" (outside project tree)`);
      continue;
    }

    // Secret-like values (AWS keys, long base64 tokens, etc.)
    if (looksLikeSecret(value)) {
      redacted[key] = '<redacted:secret>';
      notes.push(`redacted possible secret in field "${key}"`);
      continue;
    }

    redacted[key] = value;
  }

  return { redacted, notes };
}

function looksLikeAbsolutePath(value: string): boolean {
  // POSIX absolute path or Windows drive path
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /AKIA[0-9A-Z]{16}/, // AWS access key ID
  /[A-Za-z0-9+/]{40,}/, // long base64-ish token (≥40 chars, no spaces)
];

function looksLikeSecret(value: string): boolean {
  if (value.length < 20) return false; // too short to be a real secret
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) return true;
  }
  return false;
}
