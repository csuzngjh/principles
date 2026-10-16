/** Shared validated history assembly; host vocabulary is supplied by its owner. */
import { extractFilePathFromParams, normalizePathPure } from '@principles/core/runtime-v2/internalization/rule-host-input-builder';
import type { CanonicalKind, RuleHistoryWindow, RuleToolCallRecord, RuleToolOutcome, ToolSemanticRegistry } from '@principles/core/runtime-v2';
import type { RuleHostContextRow } from '@principles/core/trajectory-types';
const VALID_OUTCOMES: ReadonlySet<string> = new Set<RuleToolOutcome>(['success', 'failure', 'blocked']);
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isRuleToolOutcome(value: unknown): value is RuleToolOutcome {
  return typeof value === 'string' && VALID_OUTCOMES.has(value);
}
function unavailable(reason: string): RuleHistoryWindow {
  return {
    status: 'unavailable',
    unavailableReason: reason,
    truncated: false,
    calls: [],
  };
}


export function assembleBehaviorHistory(
  rows: readonly RuleHostContextRow[],
  truncated: boolean,
  options: { projectDir: string; toolSemantics: ToolSemanticRegistry },
): RuleHistoryWindow {
  const { projectDir, toolSemantics } = options;
  const records: RuleToolCallRecord[] = [];

  for (const row of rows) {
    // ── validate tool_name (ERR-001: unknown) ──
    const { toolName } = row;
    if (typeof toolName !== 'string' || toolName.length === 0) {
      return unavailable(`row id=${row.id}: tool_name must be a non-empty string`);
    }

    // ── validate outcome (ERR-001: unknown, enum check) ──
    const { outcome } = row;
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
    // PRI-634-F: resolve through the supplied registry (baseline + host
    // layer) instead of baseline-only canonicalizeToolKind — production tools
    // like 'shell'/'cmd'/'delete_file' previously degraded to 'other' here
    // while the gate classified them as bash/write (vocabulary drift).
    const canonicalKind: CanonicalKind = toolSemantics.resolve(toolName);

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

