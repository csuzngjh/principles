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
  UNAVAILABLE_RULE_CONTEXT,
} from '@principles/core/runtime-v2/internalization/rule-context-v2';
import { assembleBehaviorHistory } from '@principles/host-runtime/behavior-history';
import { OPENCLAW_TOOL_SEMANTICS } from '../constants/tool-semantics.js';
import type {
  RuleContextV2,
  RuleHistoryWindow,
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

const DEFAULT_HISTORY_LIMIT = 20;

export function assembleHistoryFromRows(rows: readonly RuleHostContextRow[], truncated: boolean, projectDir: string): RuleHistoryWindow {
  return assembleBehaviorHistory(rows, truncated, { projectDir, toolSemantics: OPENCLAW_TOOL_SEMANTICS });
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
