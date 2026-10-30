// SPEC-PD-EXAMINER-001 v0.7 §4 — experiment isolation contracts.
//
// Three designs are DEFINED here; only the verification contract is
// implemented. The 2×2 factorial EXECUTION system is explicitly out of scope
// this round (SPEC §10 Phase 3): its effect formulas live in
// challenge-statistics.mjs#computeFactorialEffect.
//
// verifyIsolationContract is a PURE, fail-closed gate: it inspects DECLARED
// arm conditions plus their ACTUAL-LOAD evidence and refuses (EXPERIMENT_
// INVALID) before any execution action can be taken. A configuration file
// declaration is never accepted as load evidence — each frozen variable must
// carry an observation attestation (SPEC §4.5: "配置文件声明不能替代宿主
// 实际加载证据").
//
// Zero network, zero clock, zero side effects.

export const ISOLATION_FROZEN_VARIABLES = [
  'model', 'host', 'memory', 'hook', 'tools', 'initialState', 'budget',
  'provider', 'systemPrompt', 'plugin', 'commonContext',
];

export const EXPERIMENT_DESIGNS = {
  principleOnly: {
    designId: 'principle-only-ab',
    purpose: 'measure the natural-language Principle\'s behavior increment with NO target RuleCode execution constraint',
    reference: 'SPEC v0.7 §4.2',
    arms: {
      control: { targetPrinciple: 'OFF', targetRuleCode: 'OFF' },
      treatment: { targetPrinciple: 'ON', targetRuleCode: 'OFF' },
    },
    rule: 'the ONLY treatment variable is the injection of the target Principle',
  },
  ruleCodeOnly: {
    designId: 'rulecode-only-ab',
    purpose: 'measure the machine-executed RuleCode\'s behavior effect with the Principle absent',
    reference: 'SPEC v0.7 §4.3',
    arms: {
      control: { targetPrinciple: 'OFF', targetRuleCode: 'OFF' },
      treatment: { targetPrinciple: 'OFF', targetRuleCode: 'ON' },
    },
    rule: 'separate engineering/behavior research — not required this round and not authorized by any current grant',
  },
  factorial2x2: {
    designId: 'factorial-2x2',
    purpose: 'separate Principle main effect, RuleCode main effect and their interaction',
    reference: 'SPEC v0.7 §4.4',
    arms: {
      P0R0: { targetPrinciple: 'OFF', targetRuleCode: 'OFF' },
      P1R0: { targetPrinciple: 'ON', targetRuleCode: 'OFF' },
      P0R1: { targetPrinciple: 'OFF', targetRuleCode: 'ON' },
      P1R1: { targetPrinciple: 'ON', targetRuleCode: 'ON' },
    },
    effects: 'computeFactorialEffect in challenge-statistics.mjs (Δ_P^R0, Δ_P^R1, interaction I)',
    rule: 'computation contract only — the 2×2 execution system is out of scope this round',
  },
};

const JUDGE_SIDE_LEAK_KEYS = [
  'goldTruth', 'implies', 'acceptableVerdicts', 'supportRules', 'expectedMode',
  'ownerAnswers', 'principlePredicates', 'costEnvelope', 'pathConstraints',
];

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Fail-closed verification of a declared experiment against its design.
 *
 * @param {string} input.design — one of EXPERIMENT_DESIGNS
 * @param {Record<string, object>} input.arms — declared arm conditions
 *   ({ targetPrinciple, targetRuleCode, model, host, memory, hook, tools,
 *      initialState, budget, provider, systemPrompt, plugin, commonContext,
 *      sessionId, workspaceId })
 * @param {object} input.evidence — actual-load evidence:
 *   { <variable>: { <armId>: attestationRef } } for model/host/memory/hook/tools,
 *     principleDelivery: { treatmentPrincipleHash, controlPayloadText },
 *     actorInputs: { <armId>: serialized actor-visible input } }
 * @param {object} input.execution — { orderStrategy: 'randomized'|'balanced',
 *   orderEvidence, repetitionsPlanned, preregistrationRef }
 *
 * Returns { ok, status: ISOLATION_VERIFIED | EXPERIMENT_INVALID, problems,
 * checks } — never throws for contract violations; malformed input throws.
 */
export function verifyIsolationContract({ design, arms, evidence, execution }) {
  const problems = [];
  const checks = [];
  const check = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    if (!ok) problems.push(detail);
  };
  if (!Object.hasOwn(EXPERIMENT_DESIGNS, design)) throw new Error(`verifyIsolationContract: unknown design '${String(design)}'`);
  if (!arms || typeof arms !== 'object' || Array.isArray(arms)) throw new Error('verifyIsolationContract: arms object required');
  if (!evidence || typeof evidence !== 'object') throw new Error('verifyIsolationContract: evidence object required');
  const spec = EXPERIMENT_DESIGNS[design];
  const armIds = Object.keys(spec.arms);
  for (const armId of armIds) {
    if (!arms[armId] || typeof arms[armId] !== 'object') throw new Error(`verifyIsolationContract: arms.${armId} required for design ${spec.designId}`);
  }
  // Extra arms beyond the design are a plan violation, not silently ignored.
  for (const armId of Object.keys(arms)) {
    if (!armIds.includes(armId)) check('arm_out_of_design', false, `arm '${armId}' does not belong to design ${spec.designId}`);
  }

  // 1. treatment-variable matrix must match the design exactly
  for (const armId of armIds) {
    for (const variable of ['targetPrinciple', 'targetRuleCode']) {
      const declared = arms[armId][variable];
      const expected = spec.arms[armId][variable];
      check(`matrix_${armId}_${variable}`, declared === expected, `arm ${armId}: ${variable} must be ${expected} (declared ${String(declared)})`);
    }
  }

  // 2. every frozen variable identical across arms
  for (const variable of ISOLATION_FROZEN_VARIABLES) {
    const values = armIds.map((armId) => arms[armId][variable]);
    if (values.some((value) => value === undefined)) {
      check(`frozen_${variable}_declared`, false, `frozen variable '${variable}' missing on at least one arm — an undeclared confound cannot be verified`);
      continue;
    }
    const identical = values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]));
    check(`frozen_${variable}_identical`, identical, `frozen variable '${variable}' differs across arms (${armIds.map((armId, i) => `${armId}=${JSON.stringify(values[i])}`).join(', ')})`);
  }

  // 3. actual-load evidence for the runtime-shaping variables (declaration ≠ load)
  for (const variable of ['model', 'host', 'memory', 'hook', 'tools']) {
    const perArm = evidence[variable];
    for (const armId of armIds) {
      const attestation = perArm && perArm[armId];
      check(`load_evidence_${variable}_${armId}`, text(attestation), `no actual-load evidence for '${variable}' on arm ${armId} — a configuration declaration is not load evidence (SPEC §4.5)`);
      if (variable === 'model' && text(attestation) && text(arms[armId].model) && !String(attestation).includes(String(arms[armId].model))) {
        check(`load_evidence_model_binding_${armId}`, false, `arm ${armId}: model load evidence '${attestation}' does not attest the declared model '${arms[armId].model}'`);
      }
    }
  }

  // 4. Principle leak into the control arm: the control payload must be empty
  //    (hash-bound emptiness), never the treatment's principle text.
  if (design === 'principleOnly' || design === 'ruleCodeOnly') {
    const control = armIds[0];
    const delivery = evidence.principleDelivery || {};
    if (!text(delivery.treatmentPrincipleHash)) {
      check('principle_identity_binding', false, 'treatmentPrincipleHash missing — the injected Principle content is not identity-bound');
    }
    const controlPayload = delivery.controlPayloadText;
    check('principle_leak_control', controlPayload === '' || controlPayload === undefined || controlPayload === null,
      `arm ${control} delivers a non-empty Principle payload (${JSON.stringify(String(controlPayload).slice(0, 40))}…) — the control arm must not carry the target Principle`);
    const markers = (delivery.normativeMarkers || []);
    for (const marker of markers) {
      if (String(controlPayload || '').includes(marker)) {
        check('principle_marker_leak', false, `control payload contains normative marker '${marker}'`);
      }
    }
  }

  // 5. Gold leak into any actor input
  for (const armId of armIds) {
    const serialized = evidence.actorInputs && evidence.actorInputs[armId];
    if (typeof serialized !== 'string') {
      check(`actor_input_present_${armId}`, false, `no actor-visible input recorded for arm ${armId} — the leak check cannot run, so the gate fails closed`);
      continue;
    }
    for (const key of JUDGE_SIDE_LEAK_KEYS) {
      if (serialized.includes(`"${key}"`)) {
        check(`gold_leak_${armId}`, false, `actor input of arm ${armId} leaks judge-side key '${key}'`);
      }
    }
  }

  // 6. independent sessions and workspaces per arm
  const sessionIds = new Map();
  const workspaceIds = new Map();
  for (const armId of armIds) {
    if (!text(arms[armId].sessionId)) check(`session_declared_${armId}`, false, `arm ${armId} declares no sessionId`);
    else if (sessionIds.has(arms[armId].sessionId)) check('session_shared', false, `sessionId '${arms[armId].sessionId}' shared by arms ${sessionIds.get(arms[armId].sessionId)} and ${armId}`);
    else sessionIds.set(arms[armId].sessionId, armId);
    if (!text(arms[armId].workspaceId)) check(`workspace_declared_${armId}`, false, `arm ${armId} declares no workspaceId`);
    else if (workspaceIds.has(arms[armId].workspaceId)) check('workspace_shared', false, `workspaceId '${arms[armId].workspaceId}' shared by arms ${workspaceIds.get(arms[armId].workspaceId)} and ${armId}`);
    else workspaceIds.set(arms[armId].workspaceId, armId);
  }

  // 7. execution order randomized or balanced, with evidence
  const order = execution && execution.orderStrategy;
  check('execution_order_strategy', order === 'randomized' || order === 'balanced', `execution.orderStrategy must be 'randomized' or 'balanced' (got ${String(order)})`);
  if (order === 'randomized' || order === 'balanced') {
    check('execution_order_evidence', text(execution.orderEvidence), 'execution order declared without evidence (seed record or balance table)');
  }

  // 8. repetitions from a preregistration — never derived from results
  const reps = execution && execution.repetitionsPlanned;
  check('repetitions_preregistered', Number.isInteger(reps) && reps > 0 && text(execution.preregistrationRef),
    'repetitions must be preregistered (positive integer + preregistration reference) — post-hoc sample selection is forbidden');

  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? 'ISOLATION_VERIFIED' : 'EXPERIMENT_INVALID',
    design: spec.designId,
    problems,
    checks,
    rule: 'EXPERIMENT_INVALID excludes the study from primary effect analysis (SPEC §4.5) — this gate runs before any execution action',
  };
}
