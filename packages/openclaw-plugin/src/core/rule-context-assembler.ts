/**
 * PRI-482 Phase 3 — Production RuleContext v2 assembler
 *
 * Converts raw TrajectoryDatabase rows into a validated RuleHistoryWindow,
 * and provides buildProductionRuleContext for gate integration.
 *
 * ERR prevention:
 *   - ERR-001: every row field is validated as unknown. No `as` bypass on
 *     parsed params_json or outcome.
 *   - ERR-024: buildProductionRuleContext fail-soft — query failure returns
 *     unavailable, never throws.
 *   - ERR-025: callers use recordToolCall → getRuleHostContextRows → this
 *     assembler, covering the full production chain.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md §5.
 */

import {
  computeBehaviorFacts,
  extractFilePathFromParams,
  normalizePathPure,
  UNAVAILABLE_RULE_CONTEXT,
} from '@principles/core/runtime-v2';
import { OPENCLAW_TOOL_SEMANTICS } from '../constants/tool-semantics.js';
import type {
  CanonicalKind,
  RuleContextV2,
  RuleHistoryWindow,
  RuleToolCallRecord,
  RuleToolOutcome,
} from '@principles/core/runtime-v2';
import type {
  RuleHostContextResult,
  RuleHostContextRow,
} from './trajectory-types.js';

// ── types ──────────────────────────────────────────────────────────────────

/**
 * Minimal interface for the data source that TrajectoryDatabase satisfies.
 * Allows testing buildProductionRuleContext without a real DB.
 */
export interface RuleContextDataSource {
  getRuleHostContextRows(sessionId: string, limit: number): RuleHostContextResult;
}

// ── internal constants ─────────────────────────────────────────────────────

const VALID_OUTCOMES: ReadonlySet<string> = new Set<RuleToolOutcome>([
  'success',
  'failure',
  'blocked',
]);

const DEFAULT_HISTORY_LIMIT = 20;

// ── type guards (rc-2: no `as` bypass) ─────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuleToolOutcome(value: unknown): value is RuleToolOutcome {
  return typeof value === 'string' && VALID_OUTCOMES.has(value);
}

// ── assembleHistoryFromRows ────────────────────────────────────────────────

/**
 * Convert raw DB rows into a validated RuleHistoryWindow.
 *
 * If ANY row is malformed (bad params_json, invalid outcome, empty tool_name),
 * the entire window is marked unavailable (fail loud, spec §5.2).
 *
 * ERR-001: row fields are validated as unknown. params_json is JSON.parsed
 * then structurally checked (must be a non-array object). No `as` bypass.
 */
export function assembleHistoryFromRows(
  rows: readonly RuleHostContextRow[],
  truncated: boolean,
  projectDir: string,
): RuleHistoryWindow {
  const records: RuleToolCallRecord[] = [];

  for (const row of rows) {
    // ── validate tool_name (ERR-001: unknown) ──
    const toolName = row.toolName;
    if (typeof toolName !== 'string' || toolName.length === 0) {
      return unavailable(`row id=${row.id}: tool_name must be a non-empty string`);
    }

    // ── validate outcome (ERR-001: unknown, enum check) ──
    const outcome = row.outcome;
    if (!isRuleToolOutcome(outcome)) {
      return unavailable(`row id=${row.id}: outcome "${row.outcome}" is not a valid RuleToolOutcome`);
    }

    // ── validate & parse params_json (ERR-001: unknown) ──
    const paramsJsonStr = row.paramsJson;
    if (typeof paramsJsonStr !== 'string') {
      return unavailable(`row id=${row.id}: params_json must be a string`);
    }

    let parsedParams: unknown;
    try {
      parsedParams = JSON.parse(paramsJsonStr);
    } catch {
      return unavailable(`row id=${row.id}: params_json is not valid JSON`);
    }

    // Must be a non-array object (spec §5.2)
    if (!isPlainObject(parsedParams)) {
      return unavailable(`row id=${row.id}: params_json must parse to a non-array object`);
    }

    // ── build RuleToolCallRecord ──
    // PRI-634-F: resolve through the OpenClaw registry (baseline + host
    // layer) instead of baseline-only canonicalizeToolKind — production tools
    // like 'shell'/'cmd'/'delete_file' previously degraded to 'other' here
    // while the gate classified them as bash/write (vocabulary drift).
    const canonicalKind: CanonicalKind = OPENCLAW_TOOL_SEMANTICS.resolve(toolName);

    // Extract normalized path using the same pure logic as buildRuleHostAction
    // (avoids production/replay drift, spec §4.4)
    const rawPath = extractFilePathFromParams(parsedParams, {
      isBashTool: canonicalKind === 'execute',
      isWriteTool: canonicalKind === 'write',
      toolName,
    });
    const normalizedPath = normalizePathPure(rawPath, projectDir);

    records.push({
      sequenceId: row.id,
      toolName,
      canonicalKind,
      normalizedPath: normalizedPath === '' ? null : normalizedPath,
      paramsSummary: parsedParams,
      outcome,
    });
  }

  return {
    status: 'available',
    truncated,
    calls: records,
  };
}

// ── buildProductionRuleContext ─────────────────────────────────────────────

/**
 * Build a RuleContextV2 from the production data source (TrajectoryDatabase).
 *
 * ERR-024: if the query or assembly fails, returns an unavailable context
 * (fail-soft). Never throws.
 *
 * sameActionBlockCount is always null in this version (spec §5.4:
 * session-tracker.blockedAttempts is a session total, not per-action).
 */
export function buildProductionRuleContext(
  sessionId: string | null | undefined,
  targetPath: string | null,
  source: RuleContextDataSource,
  projectDir: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): RuleContextV2 {
  // Guard: no session → no context
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length === 0) {
    return UNAVAILABLE_RULE_CONTEXT;
  }

  try {
    const result = source.getRuleHostContextRows(sessionId, limit);
    const history = assembleHistoryFromRows(result.rows, result.truncated, projectDir);

    // sameActionBlockCount = null (spec §5.4 — no reliable per-action source)
    const facts = computeBehaviorFacts(history, targetPath, null);

    return {
      version: 2,
      history,
      facts,
    };
  } catch {
    // ERR-024: fail-soft — never let a DB error propagate to the rule host
    return unavailableContext('query or assembly failed');
  }
}

// ── internal helpers ───────────────────────────────────────────────────────

function unavailable(reason: string): RuleHistoryWindow {
  return {
    status: 'unavailable',
    unavailableReason: reason,
    truncated: false,
    calls: [],
  };
}

function unavailableContext(reason: string): RuleContextV2 {
  return {
    version: 2,
    history: unavailable(reason),
    facts: {
      priorReadOfTarget: 'unknown',
      readCount: null,
      writeCount: null,
      uniqueWritePathCount: null,
      sameActionBlockCount: null,
    },
  };
}
