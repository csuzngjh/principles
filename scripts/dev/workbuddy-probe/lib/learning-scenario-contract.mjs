/**
 * Learning-scenario contract for the WorkBuddy full-learning acceptance
 * (round-4 R2 remediation, Owner mandate).
 *
 * PURE functions only: given recorded step verdicts + a scenario id, compute
 * required-set satisfaction and the exit code. BOTH the acceptance script
 * (`scripts/dev/workbuddy-probe/e2e-full-learning.mjs`) and the regression
 * tests (`scripts/__tests__/learning-scenario-contract.test.mjs`) import this
 * module — ONE source of truth for "what counts as success". Success is NEVER
 * derived from "no FAIL rows" or from a dynamic PASS count; it is derived
 * ONLY from the scenario's DECLARED required-step set.
 *
 * Three separately declared acceptance scenarios (Owner mandate):
 *   - full-principle-learning (完整原则学习): requires the COMPLETE chain from
 *     this run's own identity chain — an actionable prompt-channel candidate →
 *     proposal → real Owner approval (exit 0 + ok) → next-turn REAL injection
 *     of the approved statement → real deactivate → post-withdraw stop.
 *     Missing ANY required leg (empty queue, no prompt candidate,
 *     all-policy-terminal, rule-only, missing correlation, approval failure)
 *     FAILS with a non-zero exit and an explicit reason.
 *   - rule-channel (规则通道): verifies the durable shadow approval/activation
 *     row on the code_tool_hook channel; never asserts prompt injection.
 *   - policy-refusal (政策拒绝): proves the not_internalizable intake terminal
 *     honestly (POLICY rows recorded); PASSES only that scenario, and its
 *     output states explicitly that full learning did NOT run. A policy
 *     refusal is NOT a provider BLOCKED.
 *
 * Exit contract (identical precedence for every scenario):
 *   0 OK            — every required leg satisfied, no FAIL, no blocking BLOCKED.
 *   1 FAIL          — any recorded FAIL row, or any required leg missing/not
 *                     satisfied (defect of the system under test; FAIL wins
 *                     over BLOCKED so a real defect is never masked as
 *                     environment).
 *   2 BLOCKED       — no FAIL, but a BLOCKING BLOCKED row exists (persisted
 *                     evidence only: runs.error_category='rate_limit' on the
 *                     diagnostician task, or an unset provider key at
 *                     preflight). A blocking BLOCKED wins over missing
 *                     required legs because the block EXPLAINS them.
 *
 * BLOCKED rows carry a `blocking` flag (default TRUE — a legacy/omitted flag
 * never silently unblocks a run). The engine-capability probe
 * (`real-eligible-signal`) is recorded `blocking: false` BY DECLARATION: the
 * acceptance chain's declared evidence class is SYNTHETIC-PROTOCOL input
 * (evidence class 2) whenever that probe cannot observe a post-event, so the
 * probe's classification stays visible without owning the scenario exit.
 */

export const SCENARIO_IDS = Object.freeze({
  FULL: 'full-principle-learning',
  RULE: 'rule-channel',
  POLICY: 'policy-refusal',
});

/** Step names recorded by the acceptance script (single shared vocabulary). */
export const STEPS = Object.freeze({
  PREFLIGHT: 'preflight',
  REAL_FAILURE_EVIDENCE: 'real-failure-evidence',
  REAL_ELIGIBLE_SIGNAL: 'real-eligible-signal',
  ELIGIBLE_SIGNAL_SYNTHETIC: 'eligible-signal-synthetic',
  BACKGROUND_CHAIN: 'background-chain',
  CHAIN_DISPOSITION: 'chain-disposition',
  POLICY_TERMINAL_CANDIDATES: 'policy-terminal-candidates',
  OWNER_APPROVAL: 'owner-approval',
  RULE_APPROVAL_ACTIVATION: 'rule-approval-activation',
  NEXT_TURN_INJECTION: 'next-turn-injection',
  WITHDRAW: 'withdraw',
  POST_WITHDRAW: 'post-withdraw',
  CRASH: 'crash',
});

/** The three prompt legs that constitute an observed full learning chain. */
const FULL_LEARNING_LEGS = Object.freeze([
  STEPS.NEXT_TURN_INJECTION,
  STEPS.WITHDRAW,
  STEPS.POST_WITHDRAW,
]);

export const VERDICTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  SKIP: 'SKIP',
  POLICY: 'POLICY',
});

export const EXIT_CODES = Object.freeze({ OK: 0, FAIL: 1, BLOCKED: 2 });

/**
 * The declared scenarios. `required` maps REQUIRED step name → the verdicts
 * that satisfy it. A required step with NO record, or none carrying an
 * accepted verdict, is a MISSING LEG → the scenario fails (exit 1) with that
 * explicit reason. Steps not listed here are observational only: they never
 * contribute to success (SKIP/POLICY rows document WHY a leg did not run).
 */
export const SCENARIOS = Object.freeze({
  [SCENARIO_IDS.FULL]: Object.freeze({
    id: SCENARIO_IDS.FULL,
    label: '完整原则学习 (FULL PRINCIPLE LEARNING)',
    requiresFullLearning: true,
    exitContract:
      'all required legs PASS → 0; any FAIL row or missing required leg → 1; blocking provider BLOCKED (persisted runs.error_category=rate_limit evidence only) → 2',
    required: Object.freeze({
      [STEPS.ELIGIBLE_SIGNAL_SYNTHETIC]: Object.freeze([VERDICTS.PASS]),
      [STEPS.BACKGROUND_CHAIN]: Object.freeze([VERDICTS.PASS]),
      [STEPS.OWNER_APPROVAL]: Object.freeze([VERDICTS.PASS]),
      [STEPS.NEXT_TURN_INJECTION]: Object.freeze([VERDICTS.PASS]),
      [STEPS.WITHDRAW]: Object.freeze([VERDICTS.PASS]),
      [STEPS.POST_WITHDRAW]: Object.freeze([VERDICTS.PASS]),
    }),
  }),
  [SCENARIO_IDS.RULE]: Object.freeze({
    id: SCENARIO_IDS.RULE,
    label: '规则通道 (RULE CHANNEL)',
    requiresFullLearning: false,
    exitContract:
      'eligible signal + identity-chain approval + at least one durably activated rule-channel row all PASS → 0; missing rule row / FAIL / missing leg → 1; blocking provider BLOCKED → 2. Prompt injection is NEVER asserted here',
    required: Object.freeze({
      [STEPS.ELIGIBLE_SIGNAL_SYNTHETIC]: Object.freeze([VERDICTS.PASS]),
      [STEPS.BACKGROUND_CHAIN]: Object.freeze([VERDICTS.PASS]),
      [STEPS.OWNER_APPROVAL]: Object.freeze([VERDICTS.PASS]),
      [STEPS.RULE_APPROVAL_ACTIVATION]: Object.freeze([VERDICTS.PASS]),
    }),
  }),
  [SCENARIO_IDS.POLICY]: Object.freeze({
    id: SCENARIO_IDS.POLICY,
    label: '政策拒绝 (POLICY REFUSAL)',
    requiresFullLearning: false,
    exitContract:
      'the not_internalizable intake terminal proven (POLICY rows) + eligible signal + identity chain PASS → 0, with the explicit statement that full learning did NOT run; missing POLICY proof / FAIL / missing leg → 1; blocking provider BLOCKED → 2. Policy refusal is NOT a provider BLOCKED',
    required: Object.freeze({
      [STEPS.ELIGIBLE_SIGNAL_SYNTHETIC]: Object.freeze([VERDICTS.PASS]),
      [STEPS.BACKGROUND_CHAIN]: Object.freeze([VERDICTS.PASS]),
      [STEPS.POLICY_TERMINAL_CANDIDATES]: Object.freeze([VERDICTS.POLICY]),
    }),
  }),
});

const SCENARIO_ALIASES = Object.freeze({
  full: SCENARIO_IDS.FULL,
  'full-principle-learning': SCENARIO_IDS.FULL,
  rule: SCENARIO_IDS.RULE,
  'rule-channel': SCENARIO_IDS.RULE,
  policy: SCENARIO_IDS.POLICY,
  'policy-refusal': SCENARIO_IDS.POLICY,
});

/**
 * Resolve operator `--scenario` input to a scenario id.
 * Returns the DEFAULT scenario (`full-principle-learning`) for empty input,
 * or null for an unknown value (the caller must refuse the run — never guess).
 */
export function resolveScenarioId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return SCENARIO_IDS.FULL;
  }
  return SCENARIO_ALIASES[String(raw).trim().toLowerCase()] ?? null;
}

/**
 * Round-5 R2b: declare a scenario DEFINITION with the same shape and rules
 * as the built-ins — the ONE way for another acceptance runner (e.g. the
 * installed-product driver) to parameterize its required-step set. It MUST
 * reuse this module's evaluator: no runner may carry a second finalize with
 * its own exit precedence (that duplication is exactly how the installed
 * runner came to rank BLOCKED above FAIL and mask a product defect).
 */
export function defineScenario({ id, label, requiresFullLearning = true, required }) {
  if (!id || !label || !required || typeof required !== 'object') {
    throw new Error('defineScenario requires id, label and a required-step map');
  }
  return Object.freeze({
    id: String(id),
    label: String(label),
    requiresFullLearning: requiresFullLearning === true,
    exitContract:
      'all required legs PASS → 0; any FAIL row or missing required leg → 1; blocking provider BLOCKED (persisted evidence only) → 2; FAIL outranks BLOCKED so a real defect is never reported as environment',
    required: Object.freeze(Object.fromEntries(
      Object.entries(required).map(([step, accepted]) => [step, Object.freeze([...accepted])]),
    )),
  });
}

/**
 * A BLOCKED record blocks the scenario exit unless it was EXPLICITLY recorded
 * `blocking: false` (probe-scope classification). An omitted flag blocks —
 * the conservative default.
 */
export function isBlockingRecord(record) {
  return record?.verdict === VERDICTS.BLOCKED && record?.blocking !== false;
}

/**
 * Evaluate one scenario run. Accepts a scenario ID (built-ins) or a
 * DEFINITION from defineScenario (parameterized runners — same rules).
 * `records` is the script's result rows ({ step, verdict, detail, blocking? }).
 *
 * Returns a frozen evaluation:
 *   ok                  true iff exitCode === 0
 *   exitCode            0 | 1 | 2 (precedence: FAIL > blocking BLOCKED > missing leg)
 *   requiresFullLearning  scenario declaration
 *   fullLearningObserved  measured: all three prompt legs PASSed in THIS run
 *   fullLearningStatement explicit output sentence (mandate: the policy
 *                         scenario must state that full learning did NOT run)
 *   requiredLegs        per-required-step satisfaction table
 *   missingRequired     unsatisfied required legs, each with an explicit reason
 *   failures            FAIL rows
 *   blocked             BLOCKING BLOCKED rows only
 */
export function evaluateScenario(scenarioIdOrDefinition, records) {
  const scenario = typeof scenarioIdOrDefinition === 'string'
    ? SCENARIOS[scenarioIdOrDefinition]
    : scenarioIdOrDefinition;
  if (!scenario || typeof scenario !== 'object' || !scenario.required) {
    throw new Error(`unknown scenario '${typeof scenarioIdOrDefinition === 'string' ? scenarioIdOrDefinition : 'definition'}' (known: ${Object.keys(SCENARIOS).join(', ')}, or pass a defineScenario() definition)`);
  }
  const list = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object');
  const failures = list.filter((r) => r.verdict === VERDICTS.FAIL);
  const blocked = list.filter((r) => isBlockingRecord(r));

  const requiredLegs = [];
  const missingRequired = [];
  for (const [step, accepted] of Object.entries(scenario.required)) {
    const rows = list.filter((r) => r.step === step);
    const satisfied = rows.some((r) => accepted.includes(r.verdict));
    requiredLegs.push(Object.freeze({
      step,
      acceptedVerdicts: Object.freeze([...accepted]),
      recordedVerdicts: Object.freeze(rows.map((r) => r.verdict)),
      satisfied,
    }));
    if (!satisfied) {
      missingRequired.push(Object.freeze({
        step,
        acceptedVerdicts: Object.freeze([...accepted]),
        reason: rows.length === 0
          ? `required leg "${step}" was never recorded (did not run, or was silently dropped — rc-3)`
          : `required leg "${step}" recorded [${rows.map((r) => r.verdict).join(', ')}] but requires [${accepted.join(' or ')}]`,
      }));
    }
  }

  let exitCode;
  if (failures.length > 0) exitCode = EXIT_CODES.FAIL;
  else if (blocked.length > 0) exitCode = EXIT_CODES.BLOCKED;
  else if (missingRequired.length > 0) exitCode = EXIT_CODES.FAIL;
  else exitCode = EXIT_CODES.OK;

  const fullLearningObserved = FULL_LEARNING_LEGS.every((leg) =>
    list.some((r) => r.step === leg && r.verdict === VERDICTS.PASS));
  const ok = exitCode === EXIT_CODES.OK;
  const fullLearningStatement = scenario.requiresFullLearning
    ? (ok
      ? 'full principle learning RAN end to end in this scenario (every required leg of the identity chain passed)'
      : 'full principle learning did NOT complete in this run — see the missing required legs / failures above')
    : (fullLearningObserved
      ? 'full principle learning legs RAN in this run, but this scenario does not certify them (not a full-learning acceptance)'
      : 'full principle learning did NOT run in this scenario (this is not a full-learning acceptance; see the scenario exit contract)');

  return Object.freeze({
    scenarioId: scenario.id,
    scenarioLabel: scenario.label,
    exitContract: scenario.exitContract,
    ok,
    exitCode,
    requiresFullLearning: scenario.requiresFullLearning,
    fullLearningObserved,
    fullLearningStatement,
    requiredLegs: Object.freeze(requiredLegs),
    missingRequired: Object.freeze(missingRequired),
    failures: Object.freeze(failures),
    blocked: Object.freeze(blocked),
  });
}

/**
 * Human-readable contract report for the script's finalize output (pure
 * string composition, so the output contract is testable).
 */
export function formatEvaluationReport(evaluation) {
  const lines = [];
  lines.push(`\n=== Scenario contract: ${evaluation.scenarioLabel} [${evaluation.scenarioId}] ===`);
  for (const leg of evaluation.requiredLegs) {
    const found = leg.recordedVerdicts.length > 0 ? leg.recordedVerdicts.join(', ') : 'not recorded';
    lines.push(`  required leg ${leg.step}: accepted=[${leg.acceptedVerdicts.join(' / ')}] recorded=[${found}] → ${leg.satisfied ? 'SATISFIED' : 'MISSING'}`);
  }
  for (const missing of evaluation.missingRequired) {
    lines.push(`  MISSING REQUIRED LEG: ${missing.reason}`);
  }
  for (const failure of evaluation.failures) {
    lines.push(`  FAIL ROW [${failure.step}]: ${String(failure.detail ?? '').slice(0, 300)}`);
  }
  for (const block of evaluation.blocked) {
    lines.push(`  BLOCKING BLOCKED ROW [${block.step}]: ${String(block.detail ?? '').slice(0, 300)}`);
  }
  lines.push(`  ${evaluation.fullLearningStatement}`);
  lines.push(`  exit contract: ${evaluation.exitContract}`);
  lines.push(`  SCENARIO VERDICT: ${evaluation.ok ? 'OK' : evaluation.exitCode === EXIT_CODES.BLOCKED ? 'BLOCKED' : 'FAIL'} (exit ${evaluation.exitCode})`);
  return lines.join('\n');
}
