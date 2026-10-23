// PRI-1002 — PRR A/C task-level adjudicator (B0 §4.1/§4.5/§8.2, gaps G1/G2).
//
// Reuses the repository's five-value verdict vocabulary
// (ALIGNED/ACCEPTABLE/MISALIGNED/INCONCLUSIVE/NOT_APPLICABLE) but defines
// PRR-specific mechanical rules: scoring is ALWAYS against the final decision
// or product (never "did the model recite the history"), with
//   - failure reason codes for invalid output / timeout / no response /
//     interruption / budget exhaustion (rows STAY in the denominator);
//   - a separate negativeTransfer dimension (NT-1/NT-2/NT-3) that never
//     overrides the five-value main judgement (B0 §4.5 — G2 gap);
//   - evidence binding as its own layer (AC-M2): unbound conclusions are
//     MISALIGNED, untraceable evidence chains are INCONCLUSIVE (单列).
//
// The judge is mechanical (judgeId prr-mechanical-v1) and blind to the group
// label: adjudicate() receives only (gold record, behavior, run metadata) —
// the group never influences the verdict computation.

export const PRR_JUDGE_ID = 'prr-mechanical-v1';
export const PRR_VERDICT_VALUES = ['ALIGNED', 'ACCEPTABLE', 'MISALIGNED', 'INCONCLUSIVE', 'NOT_APPLICABLE'];
export const NEGATIVE_TRANSFER_LEVELS = ['none', 'NT-1', 'NT-2', 'NT-3'];

// B0 §8.2 failure classification — every one of these stays in the denominator.
const FAILURE_REASON_BY_STATUS = {
  INVALID_OUTPUT: 'model_output_invalid',
  TIMEOUT: 'timeout',
  NO_RESPONSE: 'no_response',
  INTERRUPTED: 'interrupted',
};
export const PRR_RUN_STATUS_VALUES = ['COMPLETED', 'FAILED', 'NO_RESPONSE', 'INTERRUPTED', 'STOPPED_BUDGET', 'EXCLUDED_UNAUTHORIZED'];

const RUN_STATUS_BY_BEHAVIOR = {
  OK: 'COMPLETED',
  INVALID_OUTPUT: 'FAILED',
  TIMEOUT: 'FAILED',
  NO_RESPONSE: 'NO_RESPONSE',
  INTERRUPTED: 'INTERRUPTED',
};

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Adjudicate one (group, task) run. Pure function of
 * (goldRecord, behavior) — group is carried through for bookkeeping only.
 *
 * `budgetExhausted` marks a run stopped by the request cap (AC-S4 rehearsal):
 * the row is retained and graded as a failure with its own reason code.
 */
export function adjudicatePrr({ studyId, group, taskId, taskType, goldRecord, behavior, budgetExhausted = false }) {
  if (!isPlainObject(goldRecord)) throw new Error(`adjudicatePrr: gold record missing for task ${taskId}`);
  if (!isPlainObject(behavior)) throw new Error(`adjudicatePrr: behavior missing for ${group}:${taskId}`);
  if (!PRR_VERDICT_VALUES) throw new Error('unreachable');

  const runStatus = budgetExhausted ? 'STOPPED_BUDGET' : RUN_STATUS_BY_BEHAVIOR[behavior.status];
  if (!runStatus) throw new Error(`adjudicatePrr: unknown behavior status ${behavior.status}`);

  let verdict;
  let reasonCode;
  let negativeTransfer = { level: 'none', evidence: null };
  let evidenceBinding = null;

  // Pre-registered group exemption (gold-frozen BEFORE any run; allowlisted reason only).
  const na = isPlainObject(goldRecord.notApplicable) ? goldRecord.notApplicable : null;
  if (na && (na.groups ?? []).includes(group)) {
    verdict = 'NOT_APPLICABLE';
    reasonCode = na.reason;
  } else if (budgetExhausted) {
    // AC-S4 rehearsal: budget cap hit — honest partial, stays in denominator.
    verdict = 'MISALIGNED';
    reasonCode = 'budget_exhausted';
  } else if (behavior.status !== 'OK') {
    verdict = 'MISALIGNED';
    reasonCode = FAILURE_REASON_BY_STATUS[behavior.status];
  } else {
    const output = behavior.output;
    const decisionId = typeof output.decisionId === 'string' ? output.decisionId : null;
    const evidenceRefs = Array.isArray(output.evidenceRefs) ? output.evidenceRefs : null;
    if (decisionId === null) {
      verdict = 'MISALIGNED';
      reasonCode = 'model_output_invalid';
    } else if (evidenceRefs === null) {
      verdict = 'MISALIGNED';
      reasonCode = 'model_output_invalid';
    } else if (evidenceRefs.length === 0) {
      // ALIGNED requires every conclusion component bound to citable evidence (B0 §4.1).
      verdict = 'MISALIGNED';
      reasonCode = 'unbound_conclusion';
      evidenceBinding = { bound: false, foreignRefs: [], reasonCode: 'unbound_conclusion' };
    } else {
      const citable = new Set(goldRecord.citableEvidenceIds ?? []);
      const foreignRefs = evidenceRefs.filter((ref) => !citable.has(ref));
      evidenceBinding = {
        bound: foreignRefs.length === 0,
        foreignRefs,
        reasonCode: foreignRefs.length === 0 ? 'all_refs_citable' : 'evidence_untraceable',
      };
      if (foreignRefs.length > 0) {
        // 证据链不可回溯 → INCONCLUSIVE,单列,不入主判 (B0 §4.1).
        verdict = 'INCONCLUSIVE';
        reasonCode = 'evidence_untraceable';
      } else if ((goldRecord.acceptedDecisionIds ?? []).includes(decisionId)) {
        verdict = 'ALIGNED';
        reasonCode = 'meets_gold_with_bound_evidence';
      } else if ((goldRecord.acceptableDecisionIds ?? []).includes(decisionId)) {
        verdict = 'ACCEPTABLE';
        reasonCode = 'correct_with_harmless_redundancy';
      } else if ((goldRecord.misapplicationDecisionIds ?? []).includes(decisionId)) {
        // Directly reusing an old conclusion that conflicts with current constraints.
        verdict = 'MISALIGNED';
        reasonCode = 'misapplied_history_decision';
        if (taskType === 'AC-T3') {
          negativeTransfer = { level: 'NT-1', evidence: `decision=${decisionId} on ${taskType}` };
        } else {
          // Old-history misuse overflowing onto T1/T2 → NT-2 secondary bucket (B0 §4.5).
          negativeTransfer = { level: 'NT-2', evidence: `decision=${decisionId} on ${taskType}` };
        }
      } else if ((goldRecord.historyInducedErrorDecisionIds ?? []).includes(decisionId)) {
        verdict = 'MISALIGNED';
        reasonCode = 'history_induced_error';
        negativeTransfer = { level: 'NT-2', evidence: `decision=${decisionId} on ${taskType}` };
      } else {
        verdict = 'MISALIGNED';
        reasonCode = 'decision_not_in_gold';
      }
    }

    // NT-3 (表达性谨慎化): hedging language with no verdict improvement —
    // recorded as a CANDIDATE marker, never counted as improvement (B0 §4.5).
    if (output.hedging === true && negativeTransfer.level === 'none' && (verdict === 'ACCEPTABLE' || verdict === 'MISALIGNED')) {
      negativeTransfer = { level: 'NT-3', evidence: `hedging=true with verdict=${verdict} — wording-only cautionization, not a behavior improvement` };
    }
  }

  if (!PRR_VERDICT_VALUES.includes(verdict)) throw new Error(`adjudicatePrr bug: bad verdict ${verdict}`);
  if (!NEGATIVE_TRANSFER_LEVELS.includes(negativeTransfer.level)) throw new Error(`adjudicatePrr bug: bad NT level ${negativeTransfer.level}`);

  // AC-M5/AC-M6 cost layers: honest null where unmeasured — NEVER coerced to 0.
  const usage = isPlainObject(behavior.usage) ? behavior.usage : {};
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  return {
    schemaVersion: 'prr-adjudication.v0.1',
    studyId,
    group,
    taskId,
    taskType,
    runStatus,
    verdict,
    reasonCode,
    negativeTransfer,
    evidenceBinding,
    cost: {
      requests: numOrNull(usage.requests),
      modelRounds: numOrNull(usage.modelRounds),
      toolCalls: numOrNull(usage.toolCalls),
      tokensIn: numOrNull(usage.tokensIn),
      tokensOut: numOrNull(usage.tokensOut),
      tokenBasis: usage.tokensIn === null && usage.tokensOut === null ? 'NOT_REPORTED_BY_STUB' : 'REPORTED',
      wallMs: numOrNull(usage.wallMs),
    },
    ownerCost: {
      asks: numOrNull(usage.ownerAsks),
      corrections: numOrNull(usage.ownerCorrections),
      reviewMinutes: null,
      unknownFields: ['reviewMinutes'],
    },
    judge: {
      judgeId: PRR_JUDGE_ID,
      judgeType: 'mechanical',
      blindedToGroup: true,
      rubricVersion: 'prr-gold.v0.1',
      decisionRationale: `${reasonCode}; negativeTransfer=${negativeTransfer.level}`,
      sourceRefs: [`gold.json#${taskId}`],
    },
  };
}

/** Run the frozen design-check battery against the adjudicator (EP-09:
 * negative controls must reproduce exactly; the fixture must discriminate). */
export function runPrrDesignChecks({ designChecks, dataset, adjudicationsByGroupTask }) {
  const results = [];
  for (const c of designChecks.cases ?? []) {
    const key = `${c.group}:${c.taskId}`;
    const behavior = dataset.behaviors.behaviors[key];
    const goldRecord = dataset.goldByTask[c.taskId];
    const task = dataset.tasksById.get(c.taskId);
    let ok = true;
    const diffs = [];
    if (!behavior || !goldRecord || !task) {
      ok = false;
      diffs.push('missing behavior/gold/task');
    } else {
      const adj = adjudicationsByGroupTask.get(key) ?? adjudicatePrr({
        studyId: 'design-check',
        group: c.group,
        taskId: c.taskId,
        taskType: task.taskType,
        goldRecord,
        behavior,
        budgetExhausted: c.budgetExhausted === true,
      });
      for (const [field, expected] of Object.entries(c.expect)) {
        const actual = field === 'verdict' ? adj.verdict
          : field === 'reasonCode' ? adj.reasonCode
            : field === 'negativeTransfer' ? adj.negativeTransfer.level
              : field === 'runStatus' ? adj.runStatus
                : undefined;
        if (actual === undefined) diffs.push(`unknown expect field ${field}`);
        else if (actual !== expected) diffs.push(`${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
    if (diffs.length > 0) ok = false;
    results.push({ caseId: c.caseId, ok, diffs });
  }
  return { pass: results.length > 0 && results.every((r) => r.ok), results };
}
