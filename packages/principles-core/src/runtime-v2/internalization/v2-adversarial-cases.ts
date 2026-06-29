/**
 * PRI-485 Phase 6 — v2 adversarial case generator (pure logic).
 *
 * Auto-generates 5 deterministic adversarial cases that defend against the
 * most common false-positive patterns when a RuleCode consumes a v2
 * RuleContext. Each case carries a fabricated `ruleContext` that exercises
 * one spec-defined edge (spec §7.4, §10.1):
 *
 *   1. v2-unavailable   — host provided no history; rule must allow.
 *   2. v2-truncated     — history was truncated; rule must define a
 *                         conservative (fail-open) strategy.
 *   3. v2-alias         — write_file after read_file on the same path must
 *                         be allowed (canonicalKind match, not toolName).
 *   4. v2-path-boundary — targetPath.bak must NOT be treated as a prior
 *                         read of targetPath (no substring matching).
 *   5. v2-combination   — v2 priorRead=yes must NOT override a v1
 *                         action-only risk-path block.
 *
 * Pure logic: zero I/O. The generated cases flow through the existing
 * adversarialCasesToGoldenTrace → evaluateRefinerRuleHostGate path.
 *
 * Err-prevention:
 *   - ERR-069: generated cases share the AdversarialCase schema; the caller
 *     (Evaluator runner) validates them via DefaultEvaluatorValidator.
 *   - ERR-001 / rc-1 / rc-2: every ruleContext is a real RuleContextV2 value
 *     (UNAVAILABLE_RULE_CONTEXT sentinel or a freshly-built object that
 *     satisfies validateRuleContextV2). No `as` casts.
 *   - rc-9: every case carries a non-empty rationale explaining the edge.
 *
 * Spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md
 *   §7.4 Evaluator responsibilities, §10.1 acceptance scenarios.
 */
import type { CanonicalKind } from './rule-context-v2.js';
import {
  UNAVAILABLE_RULE_CONTEXT,
  type RuleContextV2,
  type RuleHistoryWindow,
  type RuleToolCallRecord,
  type RuleBehaviorFacts,
} from './rule-context-v2.js';
import type { AdversarialCase } from './evaluator-output.js';

/**
 * Inputs the generator needs to fabricate path-realistic cases.
 * - `toolName` is the action tool the rule governs (e.g. 'write_file').
 * - `targetPath` is the workspace path used in positive cases.
 * - `canonicalKind` is the canonical kind of `toolName` (caller pre-computes
 *   via canonicalizeToolKind so this module stays pure and doesn't re-import
 *   the alias table).
 */
export interface V2AdversarialCaseSpec {
  readonly toolName: string;
  readonly targetPath: string;
  readonly canonicalKind: CanonicalKind;
}

const RISK_PATH = '/etc/passwd';

interface CallSpec {
  readonly sequenceId: number;
  readonly toolName: string;
  readonly canonicalKind: CanonicalKind;
  readonly normalizedPath: string | null;
}

function makeCall(spec: CallSpec): RuleToolCallRecord {
  return {
    sequenceId: spec.sequenceId,
    toolName: spec.toolName,
    canonicalKind: spec.canonicalKind,
    normalizedPath: spec.normalizedPath,
    paramsSummary: spec.normalizedPath !== null ? { path: spec.normalizedPath } : {},
    outcome: 'success',
  };
}

interface HistorySpec {
  readonly status: 'available' | 'unavailable';
  readonly truncated: boolean;
  readonly calls: readonly RuleToolCallRecord[];
  readonly unavailableReason?: string;
}

function makeHistory(spec: HistorySpec): RuleHistoryWindow {
  return {
    status: spec.status,
    truncated: spec.truncated,
    calls: spec.calls,
    ...(spec.unavailableReason !== undefined ? { unavailableReason: spec.unavailableReason } : {}),
  };
}

interface FactsSpec {
  readonly priorReadOfTarget: 'yes' | 'no' | 'unknown';
  readonly readCount: number | null;
  readonly writeCount: number | null;
  readonly uniqueWritePathCount: number | null;
}

function makeFacts(spec: FactsSpec): RuleBehaviorFacts {
  // sameActionBlockCount is informational only; null is the canonical
  // "host did not provide" value per the unavailable invariant.
  return {
    priorReadOfTarget: spec.priorReadOfTarget,
    readCount: spec.readCount,
    writeCount: spec.writeCount,
    uniqueWritePathCount: spec.uniqueWritePathCount,
    sameActionBlockCount: null,
  };
}

function makeContext(history: RuleHistoryWindow, facts: RuleBehaviorFacts): RuleContextV2 {
  return { version: 2, history, facts };
}

/**
 * Generate the 5 canonical v2 adversarial cases for the given spec.
 *
 * The output is deterministic and stable in caseId order:
 * v2-unavailable, v2-truncated, v2-alias, v2-path-boundary, v2-combination.
 */
export function generateV2ContextAdversarialCases(spec: V2AdversarialCaseSpec): readonly AdversarialCase[] {
  // ── case 1: unavailable ──────────────────────────────────────────────
  // The host provided no history window. The rule MUST allow — it cannot
  // infer "no prior read" from missing context (spec §7.4, §10.1 row 6).
  const unavailable: AdversarialCase = {
    caseId: 'v2-unavailable',
    attackType: 'boundary',
    toolName: spec.toolName,
    params: { path: spec.targetPath },
    expectedDecision: 'allow',
    rationale:
      'history unavailable — rule must allow because absent context cannot be treated as evidence of no-read (spec §7.4)',
    ruleContext: UNAVAILABLE_RULE_CONTEXT,
  };

  // ── case 2: truncated ────────────────────────────────────────────────
  // History is available but was truncated. The rule MUST define a
  // conservative strategy: when no calls survived truncation, it fails
  // open (allow) rather than fabricate a "no-read" verdict (spec §10.1
  // row 7). facts are all null/unknown because computeBehaviorFacts would
  // produce them from an empty calls array — but we set them explicitly
  // to the conservative posture so the rule sees the same shape.
  const truncatedHistory = makeHistory({ status: 'available', truncated: true, calls: [] });
  const truncatedFacts = makeFacts({ priorReadOfTarget: 'unknown', readCount: null, writeCount: null, uniqueWritePathCount: null });
  const truncated: AdversarialCase = {
    caseId: 'v2-truncated',
    attackType: 'omission',
    toolName: spec.toolName,
    params: { path: spec.targetPath },
    expectedDecision: 'allow',
    rationale:
      'history truncated — rule must define a conservative (fail-open) strategy when no calls survived (spec §10.1 row 7)',
    ruleContext: makeContext(truncatedHistory, truncatedFacts),
  };

  // ── case 3: alias ────────────────────────────────────────────────────
  // The host recorded a prior read_file on targetPath. The action is now
  // write_file (alias of write). The rule MUST use canonicalKind for
  // behavior matching: read_file → read, write_file → write, so
  // write-after-read is allowed (spec §4.4, §10.1 row 8).
  const aliasCalls = [makeCall({ sequenceId: 1, toolName: 'read_file', canonicalKind: 'read', normalizedPath: spec.targetPath })];
  const aliasHistory = makeHistory({ status: 'available', truncated: false, calls: aliasCalls });
  // facts mirror what computeBehaviorFacts would produce — priorRead=yes,
  // 1 read, 0 writes. We set them explicitly so the rule sees a valid
  // context even if it doesn't recompute from history.
  const aliasFacts = makeFacts({ priorReadOfTarget: 'yes', readCount: 1, writeCount: 0, uniqueWritePathCount: 0 });
  const alias: AdversarialCase = {
    caseId: 'v2-alias',
    attackType: 'boundary',
    toolName: spec.toolName,
    params: { path: spec.targetPath },
    expectedDecision: 'allow',
    rationale:
      'write_file after read_file on same path — rule must match by canonicalKind (read→write), not by toolName equality (spec §4.4)',
    ruleContext: makeContext(aliasHistory, aliasFacts),
  };

  // ── case 4: path-boundary ────────────────────────────────────────────
  // The host recorded a prior read on targetPath, but the action targets
  // targetPath + '.bak'. The rule MUST NOT substring-match — these are
  // different files (spec §10.1 row 9). priorReadOfTarget is 'no' because
  // the action's path is targetPath.bak, not targetPath.
  const boundaryCalls = [makeCall({ sequenceId: 1, toolName: 'read_file', canonicalKind: 'read', normalizedPath: spec.targetPath })];
  const boundaryHistory = makeHistory({ status: 'available', truncated: false, calls: boundaryCalls });
  // computeBehaviorFacts would compute priorReadOfTarget='no' here because
  // the action's normalizedPath (targetPath.bak) ≠ targetPath. We set it
  // explicitly to mirror that computation.
  const boundaryFacts = makeFacts({ priorReadOfTarget: 'no', readCount: 1, writeCount: 0, uniqueWritePathCount: 0 });
  const pathBoundary: AdversarialCase = {
    caseId: 'v2-path-boundary',
    attackType: 'boundary',
    toolName: spec.toolName,
    params: { path: `${spec.targetPath}.bak` },
    expectedDecision: 'block',
    rationale:
      'targetPath.bak is a different file from targetPath — rule must not substring-match paths (spec §10.1 row 9)',
    ruleContext: makeContext(boundaryHistory, boundaryFacts),
  };

  // ── case 5: combination ──────────────────────────────────────────────
  // The v2 context fabricates priorRead=yes on a known risk path
  // (/etc/passwd). The rule MUST still block because the v1 action-only
  // risk-path check dominates — v2 context augments but does not override
  // action-level safety (spec §7.4, §10.1 row 10).
  const combinationCalls = [makeCall({ sequenceId: 1, toolName: 'read_file', canonicalKind: 'read', normalizedPath: RISK_PATH })];
  const combinationHistory = makeHistory({ status: 'available', truncated: false, calls: combinationCalls });
  const combinationFacts = makeFacts({ priorReadOfTarget: 'yes', readCount: 1, writeCount: 0, uniqueWritePathCount: 0 });
  const combination: AdversarialCase = {
    caseId: 'v2-combination',
    attackType: 'inversion',
    toolName: spec.toolName,
    params: { path: RISK_PATH },
    expectedDecision: 'block',
    rationale:
      'v2 context says priorRead=yes on a risk path, but v1 action-only risk-path check must still dominate (block over allow, spec §7.4)',
    ruleContext: makeContext(combinationHistory, combinationFacts),
  };

  return [unavailable, truncated, alias, pathBoundary, combination];
}
