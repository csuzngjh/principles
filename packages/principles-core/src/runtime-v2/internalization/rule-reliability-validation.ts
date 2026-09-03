/**
 * Rule Reliability Validation & Failure Attribution — PRI-634-F Phase 3
 *
 * PURPOSE: answer "哪里错 / 为什么 / 谁负责" for rule reliability failures
 * (SPEC §8) instead of free-text "replay failed". Two pure capabilities:
 *
 *   1. validateRuleReliability — deterministic pre-gate check (SPEC §7/§9 V1):
 *      every declared tool (affectedTools + goldenTraceCases toolName) must be
 *      known to the ToolSemanticRegistry, otherwise adapter/tool_alias_unknown.
 *
 *   2. classifyReplayFailure — map a RefinerRuleHostGate outcome to ONE
 *      FailureLayer with a stable reasonCode, bounded evidence and a next
 *      action. Routing only — no repair (SPEC §10).
 *
 * Layer semantics (SPEC §8):
 *   rule    — the generated RuleCode itself is defective
 *   test    — the golden trace material is deficient
 *   adapter — the tool mapping/host adapter surface is wrong
 *   runtime — the evaluation infrastructure/environment failed
 *   unknown — cannot be determined
 *
 * Pure logic — zero I/O. No new subsystem, no repair loop.
 */

import type { RefinerRuleHostGateDecision, } from './refiner-rulehost-gate.js';
import type { RefinerSandboxResult } from './refiner-sandbox-wrapper.js';
import type { ToolSemanticRegistry } from './tool-semantic-registry.js';

export type FailureLayer = 'rule' | 'test' | 'adapter' | 'runtime' | 'unknown';

export interface RuleReliabilityFailure {
  readonly layer: FailureLayer;
  readonly reasonCode: string;
  /** Bounded human-readable evidence (rc-8: never assume stringify of arbitrary values). */
  readonly evidence: string;
  readonly nextAction: string;
}

const EVIDENCE_MAX_CHARS = 300;

function boundEvidence(text: string): string {
  return text.length > EVIDENCE_MAX_CHARS ? `${text.slice(0, EVIDENCE_MAX_CHARS)}…` : text;
}

// ---------------------------------------------------------------------------
// 1. Rule Reliability Validation (SPEC §7 / §9 — Tool存在性)
// ---------------------------------------------------------------------------

export interface RuleReliabilityValidationInput {
  /** ArtificerRuleOutput.affectedTools (declared scope of the rule). */
  readonly affectedTools: readonly string[];
  /** Tool names used by the rule's goldenTraceCases. */
  readonly goldenTraceCaseToolNames: readonly string[];
  /** The registry the production gate resolves tool semantics with. */
  readonly toolSemantics: ToolSemanticRegistry;
}

export interface RuleReliabilityValidationResult {
  readonly valid: boolean;
  readonly failure?: RuleReliabilityFailure;
}

/**
 * V1 validation (SPEC §9): every tool name the rule declares or tests against
 * must resolve in the registry. Unknown names are an adapter-layer defect —
 * the rule would reference a tool the host can never dispatch, so replay
 * passing would be meaningless (SPEC SC1).
 */
export function validateRuleReliability(
  input: RuleReliabilityValidationInput,
): RuleReliabilityValidationResult {
  const unknownAffected = input.affectedTools.filter((tool) => input.toolSemantics.lookup(tool) === null);
  if (unknownAffected.length > 0) {
    return {
      valid: false,
      failure: {
        layer: 'adapter',
        reasonCode: 'tool_alias_unknown',
        evidence: boundEvidence(`affectedTools not in tool semantic registry: ${unknownAffected.join(', ')}`),
        nextAction: 'update the host tool semantic mapping, or regenerate the rule against known tools',
      },
    };
  }

  const unknownCaseTools = input.goldenTraceCaseToolNames.filter(
    (tool) => input.toolSemantics.lookup(tool) === null,
  );
  if (unknownCaseTools.length > 0) {
    return {
      valid: false,
      failure: {
        layer: 'adapter',
        reasonCode: 'tool_alias_unknown',
        evidence: boundEvidence(`goldenTraceCases toolName not in tool semantic registry: ${unknownCaseTools.join(', ')}`),
        nextAction: 'update the host tool semantic mapping, or regenerate golden trace cases against known tools',
      },
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 2. Replay Failure Classification (SPEC §8 / §10 — routing only)
// ---------------------------------------------------------------------------

/** Sentinel caseIds produced by infrastructure, never by a trace case. */
const INFRA_CASE_IDS: ReadonlySet<string> = new Set(['__sandbox__', '__no_evaluator__', '__compile__', '__return_shape__', '__matched_false_decision__']);

export function classifyReplayFailure(
  decision: Exclude<RefinerRuleHostGateDecision, 'accepted_shadow'>,
  sandboxResult: RefinerSandboxResult,
): RuleReliabilityFailure {
  switch (decision) {
    case 'rejected_no_cases':
      return {
        layer: 'test',
        reasonCode: 'golden_trace_empty',
        evidence: 'goldenTrace.cases is empty — no test material to validate against',
        nextAction: 'regenerate the artifact with at least one positive and one negative golden trace case',
      };
    case 'rejected_forbidden_pattern':
      return {
        layer: 'rule',
        reasonCode: 'forbidden_pattern',
        evidence: boundEvidence(`forbidden patterns: ${sandboxResult.forbiddenPatternViolations.join(', ')}`),
        nextAction: 'regenerate RuleCode without forbidden APIs (no fs/process/require/eval/network)',
      };
    case 'rejected_timeout':
      return {
        layer: 'rule',
        reasonCode: 'evaluation_timeout',
        evidence: boundEvidence(
          sandboxResult.failedCases.map((c) => `${c.caseId}: ${c.message}`).join('; '),
        ),
        nextAction: 'regenerate RuleCode with bounded logic (no unbounded loops)',
      };
    case 'rejected_validation_failed': {
      // Sentinels here are static-shape defects of the RULE CODE itself
      // (return shape, matched=false pairing) — still rule-layer.
      const detail = sandboxResult.failedCases
        .filter((c) => c.errorType === 'validation_failed')
        .map((c) => `${c.caseId}: ${c.message}`)
        .join('; ');
      return {
        layer: 'rule',
        reasonCode: 'replay_decision_mismatch',
        evidence: boundEvidence(detail || 'validation failed with no case detail'),
        nextAction: 'fix the RuleCode decision logic to satisfy the golden trace expectations',
      };
    }
    case 'rejected_runtime_error': {
      // Distinguish rule-code defects (case-level syntax/runtime errors) from
      // infrastructure failures (sandbox adapter throw, opaque sandbox state).
      const infraCases = sandboxResult.failedCases.filter((c) => INFRA_CASE_IDS.has(c.caseId));
      if (infraCases.length > 0) {
        return {
          layer: 'runtime',
          reasonCode: 'sandbox_infrastructure_failure',
          evidence: boundEvidence(infraCases.map((c) => `${c.caseId}: ${c.message}`).join('; ')),
          nextAction: 'inspect the sandbox/gate adapter wiring, then re-run the gate',
        };
      }
      const ruleCases = sandboxResult.failedCases.map((c) => `${c.caseId}: ${c.errorType} — ${c.message}`);
      return {
        layer: 'rule',
        reasonCode: 'rule_code_execution_error',
        evidence: boundEvidence(ruleCases.join('; ')),
        nextAction: 'fix the RuleCode so evaluate() handles every input shape without throwing',
      };
    }
    default:
      return {
        layer: 'unknown',
        reasonCode: 'unclassified',
        evidence: boundEvidence(`gate decision ${String(decision)}`),
        nextAction: 'inspect the full gate result manually',
      };
  }
}
