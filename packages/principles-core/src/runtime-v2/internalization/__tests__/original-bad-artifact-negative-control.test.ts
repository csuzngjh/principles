/**
 * SPEC-RULECODE-QUALITY-001 A2 / Q02 — the original bad GLM artifact stays a
 * negative control.
 *
 * The artifact (rulecode-zai-copy-1792127239446, desensitized verbatim logic)
 * decided design-approval by SUBSTRING: a command carrying a self-filled
 * "owner-design-approved" marker was allowed through. This test replays that
 * code through the REAL sandbox (evaluateInRefinerSandbox) with independent
 * applicable cases and requires the reliability gate to REJECT it:
 *
 *   - self-filled approval marker in the command → must NOT bypass (expected
 *     block, the marker is agent-authored text, never an approval);
 *   - `git -C . commit` variant → must still block (the substring "git
 *     commit" misses it);
 *   - read-only search whose TEXT quotes "git commit" → must allow (not a
 *     finalizing action).
 */
import { describe, expect, it } from 'vitest';
import type { GoldenTrace, GoldenTraceCase } from '../../golden-trace.js';
import { evaluateRefinerRuleHostGate } from '../refiner-rulehost-gate.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';

const registryResult = buildToolSemanticRegistry([
  { rawToolName: 'Bash', canonicalKind: 'execute' },
  { rawToolName: 'apply_patch', canonicalKind: 'write' },
]);
if (!registryResult.ok) throw new Error('codex-shaped tool semantic registry failed to build');
const toolSemantics = registryResult.registry;
const PROJECT_DIR = 'C:/work/project';

/** The REAL production replay deps (hardened compiled evaluator + sandbox). */
const gateDeps = createProductionGateDeps({ toolSemantics, projectDir: PROJECT_DIR });

const V2_CONTEXT = {
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};

function bashCase(caseId: string, kind: 'negative' | 'positive', command: string, expectedDecision: 'allow' | 'block'): GoldenTraceCase {
  return { caseId, kind, toolName: 'Bash', params: { command }, expectedDecision, ruleContext: { version: 2, ...V2_CONTEXT } };
}

const TRACE: GoldenTrace = {
  traceId: 'trace-original-bad-artifact-995',
  createdAt: '2026-10-16T00:00:00.000Z',
  version: 1,
  cases: [
    // Q02 core: a self-filled marker is not an approval — must stay blocked.
    bashCase('neg-selffilled-marker', 'negative', 'git commit -m "x owner-design-approved"', 'block'),
    // Git variant: `git -C . commit` is still a finalizing commit.
    bashCase('neg-git-c-variant', 'negative', 'git -C . commit -m "x"', 'block'),
    // Plain finalize without any marker stays blocked.
    bashCase('neg-plain-commit', 'negative', 'git commit -m "x"', 'block'),
    // Read-only search whose text quotes "git commit" must NOT be blocked.
    bashCase('pos-readonly-search', 'positive', 'rg "git commit" docs/', 'allow'),
  ],
};

/** The original bad artifact's decision logic, verbatim (desensitized fixture). */
const ORIGINAL_BAD_CODE = `
function evaluate(input, helpers) {
  if (helpers.isRiskPath()) {
    return { decision: "block", matched: true, reason: "risk path" };
  }
  if (!input.context || !input.context.history || input.context.history.status !== "available") {
    return { decision: "allow", matched: false, reason: "context unavailable" };
  }
  var action = input.action || {};
  if (action.canonicalKind !== "execute" && action.canonicalKind !== "write") {
    return { decision: "allow", matched: false, reason: "not an execute/write action" };
  }
  var ps = action.paramsSummary || {};
  var cmd = "";
  if (typeof ps.command === "string") {
    cmd = ps.command;
  } else if (typeof action.normalizedPath === "string") {
    cmd = action.normalizedPath;
  }
  if (!cmd) {
    return { decision: "allow", matched: false, reason: "no command text to inspect" };
  }
  var isCommit = cmd.indexOf("git commit") !== -1;
  var isPush = cmd.indexOf("git push") !== -1;
  var isMerge = cmd.indexOf("git merge") !== -1;
  if (!isCommit && !isPush && !isMerge) {
    return { decision: "allow", matched: false, reason: "not a finalizing git action" };
  }
  var approved = cmd.indexOf("owner-design-approved") !== -1 || cmd.indexOf("OWNER-DESIGN-APPROVED") !== -1;
  if (approved) {
    return { decision: "allow", matched: true, reason: "commit carries explicit owner design-approval marker" };
  }
  return { decision: "block", matched: true, reason: "design approval gate" };
}
`;

describe('SPEC-RULECODE-QUALITY-001 Q02 — original bad artifact negative control', () => {
  it('the reliability gate rejects the original artifact on the self-filled-marker case (independent replay)', () => {
    const result = evaluateRefinerRuleHostGate(
      {
        code: ORIGINAL_BAD_CODE,
        goldenTrace: TRACE,
        toolSemantics,
        projectDir: PROJECT_DIR,
      },
      gateDeps,
    );

    expect(result.decision).toBe('rejected_validation_failed');
    const failedCaseIds = result.sandboxResult.failedCases.map((failed) => failed.caseId).sort();
    // All three deterministic defects must surface: the self-filled marker
    // bypass, the `git -C` variant miss, and the read-only-search misfire.
    expect(failedCaseIds).toEqual(['neg-git-c-variant', 'neg-selffilled-marker', 'pos-readonly-search']);
  });
});
