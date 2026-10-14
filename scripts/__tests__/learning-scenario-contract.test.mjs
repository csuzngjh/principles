// Round-4 R2 remediation (Owner mandate): regression tests for the
// full-learning acceptance script's SUCCESS CONDITIONS themselves. The
// script's exit logic and this test file share ONE pure module
// (scripts/dev/workbuddy-probe/lib/learning-scenario-contract.mjs), so every
// case below is the real production contract, not a reimplementation.
//
// The defect class being guarded: the script could exit 0 (report success)
// while the principle proposal → approval → injection → withdraw → stop chain
// never ran — all-policy-terminal chains, rule-only chains and vacuous SKIP
// rows all passed. Success must come ONLY from the scenario's DECLARED
// required-step set, never from "no FAIL rows" or a dynamic PASS count.

import { describe, expect, it } from 'vitest';
import {
  EXIT_CODES,
  SCENARIOS,
  SCENARIO_IDS,
  STEPS,
  VERDICTS,
  evaluateScenario,
  formatEvaluationReport,
  isBlockingRecord,
  resolveScenarioId,
} from '../dev/workbuddy-probe/lib/learning-scenario-contract.mjs';

/** Record factory shaped exactly like the script's rows. */
function rec(step, verdict, detail = '', options = {}) {
  return { step, verdict, detail, blocking: options.blocking ?? true };
}

/** A complete successful full-principle-learning run (with the declared
 * non-blocking engine-capability probe BLOCKED present — the evidence-class-1
 * probe does not own the scenario exit; the chain's declared evidence class is
 * synthetic-protocol). */
function fullLearningSuccessRecords() {
  return [
    rec(STEPS.PREFLIGHT, VERDICTS.PASS),
    rec(STEPS.REAL_FAILURE_EVIDENCE, VERDICTS.PASS),
    rec(STEPS.REAL_ELIGIBLE_SIGNAL, VERDICTS.BLOCKED, 'engine build fired no observable post-event (probe scope)', { blocking: false }),
    rec(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, VERDICTS.PASS),
    rec(STEPS.BACKGROUND_CHAIN, VERDICTS.PASS, 'identity-chain approvals after N REAL worker cycles'),
    rec(STEPS.CHAIN_DISPOSITION, VERDICTS.PASS),
    rec(STEPS.OWNER_APPROVAL, VERDICTS.PASS, 'prompt channel, exit 0 ok=true'),
    rec(STEPS.NEXT_TURN_INJECTION, VERDICTS.PASS, 'probe injected into the next real turn'),
    rec(STEPS.WITHDRAW, VERDICTS.PASS, 'pd activation deactivate exit 0'),
    rec(STEPS.POST_WITHDRAW, VERDICTS.PASS, 'statement no longer injected'),
  ];
}

/** A chain whose candidates are ALL policy-terminal: prompt legs recorded as
 * explicit SKIPs (policy classification, not a provider BLOCKED). */
function allPolicyTerminalRecords() {
  return [
    rec(STEPS.PREFLIGHT, VERDICTS.PASS),
    rec(STEPS.REAL_ELIGIBLE_SIGNAL, VERDICTS.BLOCKED, 'probe scope', { blocking: false }),
    rec(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, VERDICTS.PASS),
    rec(STEPS.BACKGROUND_CHAIN, VERDICTS.PASS, 'chain reached its designed policy terminal'),
    rec(STEPS.POLICY_TERMINAL_CANDIDATES, VERDICTS.POLICY, 'not_internalizable intake refusal, approvals absent BY DESIGN'),
    rec(STEPS.NEXT_TURN_INJECTION, VERDICTS.SKIP, 'no approval exists for a policy-terminal chain'),
    rec(STEPS.WITHDRAW, VERDICTS.SKIP, 'nothing to withdraw'),
    rec(STEPS.POST_WITHDRAW, VERDICTS.SKIP, 'no injection happened'),
  ];
}

/** A chain with ONLY rule (code_tool_hook) approvals: injection legs SKIP,
 * rule channel durably verified. */
function ruleOnlyRecords() {
  return [
    rec(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, VERDICTS.PASS),
    rec(STEPS.BACKGROUND_CHAIN, VERDICTS.PASS),
    rec(STEPS.CHAIN_DISPOSITION, VERDICTS.PASS),
    rec(STEPS.OWNER_APPROVAL, VERDICTS.PASS, 'code_tool_hook channel, exit 0 ok=true'),
    rec(STEPS.RULE_APPROVAL_ACTIVATION, VERDICTS.PASS, 'durable shadow activation row on its own channel'),
    rec(STEPS.NEXT_TURN_INJECTION, VERDICTS.SKIP, 'no prompt-channel approval in this chain'),
    rec(STEPS.WITHDRAW, VERDICTS.SKIP),
    rec(STEPS.POST_WITHDRAW, VERDICTS.SKIP),
  ];
}

describe('scenario declarations', () => {
  it('declares exactly the three Owner-mandated scenarios', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(['full-principle-learning', 'policy-refusal', 'rule-channel'].sort());
  });

  it('full-principle-learning requires the COMPLETE chain and never the rule row', () => {
    const required = Object.keys(SCENARIOS[SCENARIO_IDS.FULL].required);
    expect(required).toEqual([
      STEPS.ELIGIBLE_SIGNAL_SYNTHETIC,
      STEPS.BACKGROUND_CHAIN,
      STEPS.OWNER_APPROVAL,
      STEPS.NEXT_TURN_INJECTION,
      STEPS.WITHDRAW,
      STEPS.POST_WITHDRAW,
    ]);
    expect(required).not.toContain(STEPS.RULE_APPROVAL_ACTIVATION);
    expect(SCENARIOS[SCENARIO_IDS.FULL].requiresFullLearning).toBe(true);
  });

  it('rule-channel requires the durable rule row and never the prompt legs', () => {
    const required = Object.keys(SCENARIOS[SCENARIO_IDS.RULE].required);
    expect(required).toContain(STEPS.RULE_APPROVAL_ACTIVATION);
    expect(required).not.toContain(STEPS.NEXT_TURN_INJECTION);
    expect(SCENARIOS[SCENARIO_IDS.RULE].requiresFullLearning).toBe(false);
  });

  it('policy-refusal requires the POLICY verdict (not PASS) for the terminal proof', () => {
    expect(SCENARIOS[SCENARIO_IDS.POLICY].required[STEPS.POLICY_TERMINAL_CANDIDATES]).toEqual([VERDICTS.POLICY]);
    expect(SCENARIOS[SCENARIO_IDS.POLICY].requiresFullLearning).toBe(false);
  });

  it('no scenario accepts SKIP as satisfying any required leg', () => {
    for (const scenario of Object.values(SCENARIOS)) {
      for (const accepted of Object.values(scenario.required)) {
        expect(accepted).not.toContain(VERDICTS.SKIP);
      }
    }
  });
});

describe('resolveScenarioId', () => {
  it.each([
    [undefined, SCENARIO_IDS.FULL],
    ['', SCENARIO_IDS.FULL],
    ['full', SCENARIO_IDS.FULL],
    ['full-principle-learning', SCENARIO_IDS.FULL],
    ['rule', SCENARIO_IDS.RULE],
    ['rule-channel', SCENARIO_IDS.RULE],
    ['policy', SCENARIO_IDS.POLICY],
    ['policy-refusal', SCENARIO_IDS.POLICY],
  ])('resolves %j → %j (default: full-principle-learning)', (raw, expected) => {
    expect(resolveScenarioId(raw)).toBe(expected);
  });

  it('returns null for an unknown scenario (the caller must refuse, never guess)', () => {
    expect(resolveScenarioId('bogus')).toBeNull();
  });
});

describe('FULL PRINCIPLE LEARNING success conditions', () => {
  it('passes ONLY a complete chain (all required legs PASS) — exit 0', () => {
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, fullLearningSuccessRecords());
    expect(evaluation.ok).toBe(true);
    expect(evaluation.exitCode).toBe(EXIT_CODES.OK);
    expect(evaluation.missingRequired).toHaveLength(0);
    expect(evaluation.fullLearningObserved).toBe(true);
    expect(evaluation.fullLearningStatement).toContain('RAN end to end');
  });

  it('never derives success from "no FAIL rows": an all-policy-terminal chain FAILS with explicit missing legs', () => {
    const records = allPolicyTerminalRecords();
    expect(records.some((r) => r.verdict === VERDICTS.FAIL)).toBe(false); // precondition: zero FAIL rows
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    const missingSteps = evaluation.missingRequired.map((m) => m.step);
    expect(missingSteps).toEqual(expect.arrayContaining([STEPS.OWNER_APPROVAL, STEPS.NEXT_TURN_INJECTION, STEPS.WITHDRAW, STEPS.POST_WITHDRAW]));
    expect(evaluation.fullLearningStatement).toContain('did NOT complete');
  });

  it('never derives success from a dynamic PASS count: a rule-only chain FAILS the full scenario', () => {
    const records = ruleOnlyRecords();
    expect(records.filter((r) => r.verdict === VERDICTS.PASS).length).toBeGreaterThan(0); // precondition: PASS rows exist
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    const missingSteps = evaluation.missingRequired.map((m) => m.step);
    expect(missingSteps).toEqual(expect.arrayContaining([STEPS.NEXT_TURN_INJECTION, STEPS.WITHDRAW, STEPS.POST_WITHDRAW]));
  });

  it('a missing leg (approval failed after the chain) FAILS — exit 1, FAIL row named', () => {
    const records = fullLearningSuccessRecords().map((r) => (
      r.step === STEPS.OWNER_APPROVAL ? rec(STEPS.OWNER_APPROVAL, VERDICTS.FAIL, 'approve exit 1: artifact locked') : r
    ));
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    expect(evaluation.failures.map((f) => f.step)).toContain(STEPS.OWNER_APPROVAL);
  });

  it('an empty queue (background-chain FAIL, synthetic signal admitted) FAILS — exit 1', () => {
    const records = [
      rec(STEPS.PREFLIGHT, VERDICTS.PASS),
      rec(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, VERDICTS.PASS),
      rec(STEPS.BACKGROUND_CHAIN, VERDICTS.FAIL, 'no identity-chain approval after N cycles; last=…'),
    ];
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    expect(evaluation.ok).toBe(false);
  });

  it('a required leg that never ran at all FAILS with a "never recorded" reason (rc-3)', () => {
    const records = fullLearningSuccessRecords().filter((r) => r.step !== STEPS.POST_WITHDRAW);
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    const postWithdraw = evaluation.missingRequired.find((m) => m.step === STEPS.POST_WITHDRAW);
    expect(postWithdraw.reason).toContain('never recorded');
  });

  it('a non-PASS verdict on a required leg names the recorded verdicts in the reason', () => {
    const records = fullLearningSuccessRecords().map((r) => (
      r.step === STEPS.NEXT_TURN_INJECTION ? rec(STEPS.NEXT_TURN_INJECTION, VERDICTS.SKIP, 'legs did not run') : r
    ));
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    const injection = evaluation.missingRequired.find((m) => m.step === STEPS.NEXT_TURN_INJECTION);
    expect(injection.reason).toContain('SKIP');
    expect(injection.reason).toContain('PASS');
  });

  it('the engine-capability probe BLOCKED (blocking: false, by declaration) does NOT block a complete chain', () => {
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, fullLearningSuccessRecords());
    expect(evaluation.blocked).toHaveLength(0);
    expect(evaluation.exitCode).toBe(EXIT_CODES.OK);
  });
});

describe('RULE CHANNEL scenario', () => {
  it('passes a rule-only chain on its own channel (no prompt assertion) — exit 0', () => {
    const evaluation = evaluateScenario(SCENARIO_IDS.RULE, ruleOnlyRecords());
    expect(evaluation.ok).toBe(true);
    expect(evaluation.exitCode).toBe(EXIT_CODES.OK);
    expect(evaluation.fullLearningStatement).toContain('did NOT run in this scenario');
  });

  it('FAILS when the chain produced no rule-channel row (e.g. prompt-only chain)', () => {
    const records = fullLearningSuccessRecords(); // prompt chain, no rule row
    const evaluation = evaluateScenario(SCENARIO_IDS.RULE, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    expect(evaluation.missingRequired.map((m) => m.step)).toContain(STEPS.RULE_APPROVAL_ACTIVATION);
  });

  it('FAILS an all-policy-terminal chain (no rule row, no approval)', () => {
    const evaluation = evaluateScenario(SCENARIO_IDS.RULE, allPolicyTerminalRecords());
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
  });
});

describe('POLICY REFUSAL scenario', () => {
  it('passes an all-policy-terminal chain honestly — exit 0 — and states that full learning did NOT run', () => {
    const evaluation = evaluateScenario(SCENARIO_IDS.POLICY, allPolicyTerminalRecords());
    expect(evaluation.ok).toBe(true);
    expect(evaluation.exitCode).toBe(EXIT_CODES.OK);
    expect(evaluation.fullLearningObserved).toBe(false);
    expect(evaluation.fullLearningStatement).toContain('full principle learning did NOT run');
  });

  it('FAILS when the POLICY proof is absent (e.g. empty queue / chain defect)', () => {
    const records = [
      rec(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, VERDICTS.PASS),
      rec(STEPS.BACKGROUND_CHAIN, VERDICTS.FAIL, 'no identity-chain approval; no policy terminal'),
    ];
    const evaluation = evaluateScenario(SCENARIO_IDS.POLICY, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    expect(evaluation.missingRequired.map((m) => m.step)).toContain(STEPS.POLICY_TERMINAL_CANDIDATES);
  });

  it('a POLICY verdict is NEVER a provider BLOCKED (distinct verdict, distinct exit)', () => {
    const evaluation = evaluateScenario(SCENARIO_IDS.POLICY, allPolicyTerminalRecords());
    expect(evaluation.blocked).toHaveLength(0);
    expect(evaluation.exitCode).not.toBe(EXIT_CODES.BLOCKED);
  });

  it('when prompt legs actually ran in this run, the statement reports them without certifying them', () => {
    const records = [
      ...allPolicyTerminalRecords().filter((r) => !['next-turn-injection', 'withdraw', 'post-withdraw'].includes(r.step)),
      rec(STEPS.NEXT_TURN_INJECTION, VERDICTS.PASS),
      rec(STEPS.WITHDRAW, VERDICTS.PASS),
      rec(STEPS.POST_WITHDRAW, VERDICTS.PASS),
    ];
    const evaluation = evaluateScenario(SCENARIO_IDS.POLICY, records);
    expect(evaluation.fullLearningObserved).toBe(true);
    expect(evaluation.fullLearningStatement).toContain('does not certify');
  });
});

describe('provider BLOCKED vs ordinary failures (exit-code contract)', () => {
  it('a persisted rate-limit BLOCKED (runs.error_category=rate_limit evidence) exits 2', () => {
    const records = [
      rec(STEPS.PREFLIGHT, VERDICTS.PASS),
      rec(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, VERDICTS.PASS),
      rec(STEPS.BACKGROUND_CHAIN, VERDICTS.BLOCKED, 'diagnostician rate-limited (task=…, runs.error_category=rate_limit)'),
    ];
    for (const scenarioId of Object.values(SCENARIO_IDS)) {
      const evaluation = evaluateScenario(scenarioId, records);
      expect(evaluation.exitCode).toBe(EXIT_CODES.BLOCKED);
      expect(evaluation.blocked.map((b) => b.step)).toContain(STEPS.BACKGROUND_CHAIN);
    }
  });

  it('an ordinary execution failure is NEVER generalized into a BLOCKED: FAIL wins over BLOCKED (defect must not be masked as environment)', () => {
    const records = [
      rec(STEPS.ELIGIBLE_SIGNAL_SYNTHETIC, VERDICTS.PASS),
      rec(STEPS.BACKGROUND_CHAIN, VERDICTS.BLOCKED, 'rate_limit on diagnostician'),
      rec(STEPS.OWNER_APPROVAL, VERDICTS.FAIL, 'approve exit 1'),
    ];
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    expect(evaluation.failures).toHaveLength(1);
  });

  it('a BLOCKED row WITHOUT the blocking flag counts as blocking (conservative legacy default)', () => {
    const legacy = { step: STEPS.BACKGROUND_CHAIN, verdict: VERDICTS.BLOCKED, detail: 'no flag recorded' };
    expect(isBlockingRecord(legacy)).toBe(true);
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, [legacy]);
    expect(evaluation.exitCode).toBe(EXIT_CODES.BLOCKED);
  });

  it('a BLOCKED row with blocking: false never blocks (probe scope)', () => {
    const probe = { step: STEPS.REAL_ELIGIBLE_SIGNAL, verdict: VERDICTS.BLOCKED, detail: 'probe', blocking: false };
    expect(isBlockingRecord(probe)).toBe(false);
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, [probe]);
    expect(evaluation.blocked).toHaveLength(0);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL); // required legs missing, not blocked
  });

  it('missing required legs under a blocking BLOCKED classify as BLOCKED (the block explains them)', () => {
    const records = [
      rec(STEPS.PREFLIGHT, VERDICTS.BLOCKED, 'AMD_RADEON_API_KEY not set — real LLM unavailable'),
    ];
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, records);
    expect(evaluation.exitCode).toBe(EXIT_CODES.BLOCKED);
    expect(evaluation.missingRequired.length).toBeGreaterThan(0);
  });
});

describe('evaluateScenario guards', () => {
  it('throws on an unknown scenario id (programmer error, not operator input)', () => {
    expect(() => evaluateScenario('nope', [])).toThrow(/unknown scenario/);
  });

  it('treats a non-array records argument as an empty run', () => {
    const evaluation = evaluateScenario(SCENARIO_IDS.FULL, undefined);
    expect(evaluation.exitCode).toBe(EXIT_CODES.FAIL);
    expect(evaluation.missingRequired.length).toBe(Object.keys(SCENARIOS[SCENARIO_IDS.FULL].required).length);
  });
});

describe('formatEvaluationReport', () => {
  it('prints the required-leg table, missing-leg reasons, the full-learning statement and the verdict', () => {
    const report = formatEvaluationReport(evaluateScenario(SCENARIO_IDS.FULL, allPolicyTerminalRecords()));
    expect(report).toContain('FULL PRINCIPLE LEARNING');
    expect(report).toContain('required leg eligible-signal-synthetic');
    expect(report).toContain('MISSING REQUIRED LEG');
    expect(report).toContain('full principle learning did NOT complete');
    expect(report).toContain('SCENARIO VERDICT: FAIL (exit 1)');
  });

  it('prints the explicit NOT-run statement for a passing policy-refusal scenario', () => {
    const report = formatEvaluationReport(evaluateScenario(SCENARIO_IDS.POLICY, allPolicyTerminalRecords()));
    expect(report).toContain('full principle learning did NOT run in this scenario');
    expect(report).toContain('SCENARIO VERDICT: OK (exit 0)');
  });

  it('prints blocking BLOCKED rows so an environmental stop is never silent', () => {
    const records = [rec(STEPS.PREFLIGHT, VERDICTS.BLOCKED, 'AMD_RADEON_API_KEY not set')];
    const report = formatEvaluationReport(evaluateScenario(SCENARIO_IDS.FULL, records));
    expect(report).toContain('BLOCKING BLOCKED ROW [preflight]');
    expect(report).toContain('SCENARIO VERDICT: BLOCKED (exit 2)');
  });
});
