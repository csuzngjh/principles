// PRI-1002 — B0 G7 freeze-record contract + fail-closed validator (FZ-01~FZ-15).
//
// SPEC-PD-PRR-001 Gate B0 preregistration §5 defines fifteen freeze items.
// This module makes them machine-checkable:
//
//   - buildDraftFreeze() produces the honest DRAFT: all fifteen items present,
//     every one OWNER_DECISION_REQUIRED, no values fabricated;
//   - validateFreezeRecord() checks structure + status vocabulary and rejects
//     any attempt to claim Owner approval without an approval record
//     (mirrors validatePrereg()'s "no fabricated approval" discipline);
//   - validateFreezeForRealRun() is the fail-closed REAL-RUN gate: every item
//     must be VALUE_FROZEN with an ownerApprovalRef, the preregistration body
//     hash (FZ-15, canonical-JSON SHA-256 of a SEPARATE body — the hash can
//     never be embedded in the hashed body itself) must match, and the Owner
//     approval must be verified by a CALLER-SUPPLIED trusted verifier.
//     Nothing here reads env vars, defaults or script arguments to fill an
//     authorization gap; a missing field is reported by FZ id, never guessed.
//
// A draft passing structure validation authorizes NOTHING. Real A/C runs are
// refused until validateFreezeForRealRun() returns zero problems.

import { canonicalJson, sha256 } from '../../lib/fixture.mjs';
import { verifyDatasetIntegrity } from './prr-dataset.mjs';

export const PRR_FREEZE_SCHEMA = 'prr-b0-freeze.v0.1';
export const PRR_FREEZE_DRAFT_STATUS = 'DRAFT_NOT_OWNER_APPROVED';
export const PRR_FREEZE_FROZEN_STATUS = 'OWNER_APPROVED_FROZEN';
export const FREEZE_ITEM_STATUSES = ['OWNER_DECISION_REQUIRED', 'VALUE_FROZEN'];

// B0 §5 — the fifteen items, with their ownership class. OWNER_EXCLUSIVE items
// additionally require the value itself to have come from the Owner (checked
// via ownerApprovalRef on every item at real-run time).
export const FZ_ITEMS = [
  { id: 'FZ-01', title: '任务清单与任务身份（datasetId/version/contentHash）', ownerExclusive: false },
  { id: 'FZ-02', title: '原则集与注入文本（逐字节）', ownerExclusive: false },
  { id: 'FZ-03', title: 'C 组历史材料（来源/授权/脱敏文本/长度/hash）', ownerExclusive: true },
  { id: 'FZ-04', title: '模型/端点/版本/推理参数', ownerExclusive: true },
  { id: 'FZ-05', title: '工具权限与白名单', ownerExclusive: false },
  { id: 'FZ-06', title: '调用/Token/费用/时延/截止上限', ownerExclusive: true },
  { id: 'FZ-07', title: '评分 rubric 与 gold（逐任务）', ownerExclusive: false },
  { id: 'FZ-08', title: '盲评协议与分歧率阈值', ownerExclusive: false },
  { id: 'FZ-09', title: '最低有意义改善标准（最小可检测差）', ownerExclusive: true },
  { id: 'FZ-10', title: '负迁移判据（NT-1/NT-2/NT-3）', ownerExclusive: false },
  { id: 'FZ-11', title: '样本规模 N/配对方式/重复次数', ownerExclusive: true },
  { id: 'FZ-12', title: '异常/缺失/排除分类', ownerExclusive: false },
  { id: 'FZ-13', title: 'STOP 条件（AC-S1~AC-S8）', ownerExclusive: false },
  { id: 'FZ-14', title: '历史数据保留与销毁规则', ownerExclusive: false },
  { id: 'FZ-15', title: '预注册内容 hash 与 Owner 批准记录', ownerExclusive: true },
];
export const FZ_IDS = FZ_ITEMS.map((i) => i.id);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Canonical-JSON SHA-256 of a preregistration body (FZ-15 §5.2 rule 1). */
export function preregBodyHash(preregBody) {
  return sha256(canonicalJson(preregBody));
}

/**
 * Canonical-JSON SHA-256 over the FULL freeze items array (every FZ value,
 * status and approval ref). Component of the protocol approval digest.
 */
export function freezeItemsHash(freeze) {
  return sha256(canonicalJson(freeze.items));
}

/**
 * COMPLETE protocol approval digest (owner review round 3, P1-1): binds the
 * Owner approval to
 *   - the studyId,
 *   - the canonical SHA-256 of the preregistration body, AND
 *   - the canonical content of ALL freeze items (values, statuses, approval refs).
 * Deterministic and order-insensitive (canonical JSON). ANY meaningful change
 * to the protocol changes this digest, so an approval saved against one
 * protocol can never authorize a mutated one.
 */
export function protocolApprovalDigest({ freeze, preregBody }) {
  return sha256(canonicalJson({
    digestVersion: 'prr-protocol-approval.v1',
    studyId: freeze.studyId,
    preregCanonicalSha256: preregBodyHash(preregBody),
    freezeItemsSha256: freezeItemsHash(freeze),
  }));
}

/**
 * Build the honest DRAFT freeze record: all fifteen items enumerated with
 * OWNER_DECISION_REQUIRED and null values. `preregBody` is the preregistration
 * document as a plain object; its canonical hash is recorded so any later
 * edit of the body invalidates the record (INVALID_PROTOCOL).
 */
export function buildDraftFreeze({ studyId, preregBody, note }) {
  return {
    schemaVersion: PRR_FREEZE_SCHEMA,
    studyId,
    status: PRR_FREEZE_DRAFT_STATUS,
    note: note ?? 'Draft freeze record: enumerates FZ-01~FZ-15 with no values. Preparing this draft is NOT Owner approval and authorizes nothing.',
    prereg: {
      canonicalSha256: preregBodyHash(preregBody),
      bodyNote: 'The hash lives in this record, never in the hashed body (self-reference is unsatisfiable).',
    },
    items: FZ_ITEMS.map((item) => ({
      id: item.id,
      title: item.title,
      ownerExclusive: item.ownerExclusive,
      status: 'OWNER_DECISION_REQUIRED',
      value: null,
      ownerApprovalRef: null,
    })),
    ownerApproval: null,
  };
}

/** Structural validation — safe for drafts; returns problems[]. */
export function validateFreezeRecord(freeze) {
  const problems = [];
  const p = (msg) => problems.push(msg);

  if (!isPlainObject(freeze)) return ['freeze record must be a JSON object'];
  if (freeze.schemaVersion !== PRR_FREEZE_SCHEMA) p(`freeze.schemaVersion must be ${PRR_FREEZE_SCHEMA}`);
  if (typeof freeze.studyId !== 'string' || freeze.studyId === '') p('freeze.studyId must be a non-empty string');
  if (freeze.status !== PRR_FREEZE_DRAFT_STATUS && freeze.status !== PRR_FREEZE_FROZEN_STATUS) {
    p(`freeze.status must be ${PRR_FREEZE_DRAFT_STATUS} or ${PRR_FREEZE_FROZEN_STATUS}`);
  }
  if (freeze.status === PRR_FREEZE_FROZEN_STATUS && !isPlainObject(freeze.ownerApproval)) {
    p('freeze.status claims FROZEN but ownerApproval record is missing — Owner approval cannot be fabricated by tooling');
  }

  if (!Array.isArray(freeze.items)) {
    p('freeze.items must be an array');
    return problems;
  }
  const byId = new Map();
  for (const item of freeze.items) {
    if (!isPlainObject(item)) { p('freeze.items entries must be objects'); continue; }
    if (!FZ_IDS.includes(item.id)) p(`freeze.items carries unknown id ${String(item.id)} — the FZ namespace is closed`);
    if (byId.has(item.id)) p(`duplicate freeze item ${item.id}`);
    byId.set(item.id, item);
    if (!FREEZE_ITEM_STATUSES.includes(item.status)) p(`freeze item ${item.id} status must be one of ${FREEZE_ITEM_STATUSES.join('|')}`);
    if (item.status === 'VALUE_FROZEN') {
      if (item.value === null || item.value === undefined) p(`freeze item ${item.id} is VALUE_FROZEN but carries no value`);
      if (typeof item.ownerApprovalRef !== 'string' || item.ownerApprovalRef.trim() === '') {
        p(`freeze item ${item.id} is VALUE_FROZEN but carries no ownerApprovalRef`);
      }
    }
    if (item.status === 'OWNER_DECISION_REQUIRED' && item.value != null) {
      p(`freeze item ${item.id} is OWNER_DECISION_REQUIRED yet carries a value — draft records must not fabricate values`);
    }
  }
  for (const id of FZ_IDS) {
    if (!byId.has(id)) p(`freeze record is missing item ${id}`);
  }

  if (!isPlainObject(freeze.prereg)) p('freeze.prereg must be an object');
  else if (typeof freeze.prereg.canonicalSha256 !== 'string' || freeze.prereg.canonicalSha256.length !== 64) {
    p('freeze.prereg.canonicalSha256 must be a 64-hex-char SHA-256 of the preregistration body');
  }

  if (isPlainObject(freeze.ownerApproval)) {
    const approval = freeze.ownerApproval;
    if (approval.approvedBy !== 'owner') p('ownerApproval.approvedBy must be the literal "owner" — AI sessions cannot approve');
    if (typeof approval.decisionRef !== 'string' || approval.decisionRef.trim() === '') p('ownerApproval.decisionRef must name the Owner decision record');
    if (typeof approval.frozenCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(approval.frozenCommitSha)) {
      p('ownerApproval.frozenCommitSha must be the 40-hex commit SHA the freeze binds to');
    }
  }

  return problems;
}

/**
 * Fail-closed REAL-RUN gate (B0 §5/§6). Returns { problems, minPairsEligible,
 * pairDenominator }.
 *
 * REQUIRED INPUTS — any missing one is a hard refusal, never a skipped check:
 *   - freeze: the freeze record itself;
 *   - preregBody: the preregistration body; its canonical SHA-256 AND its
 *     studyId must match the freeze record (omitting it can never skip a check);
 *   - dataset: the actually loaded dataset — its CURRENT contents are
 *     re-hashed at gate time (the load-time cached fixtureHash is never
 *     trusted alone) and cross-checked against FZ-01.taskSetHash;
 *   - verifyOwnerApproval: a trusted resolver that queries the ACTUAL Owner
 *     decision record by decisionRef and returns the bindings SAVED AT
 *     APPROVAL TIME — never a digest recomputed from the submitted record:
 *       ({ decisionRef }) => {
 *         verified, approved,
 *         frozenCommitSha,        // commit the Owner approval was bound to
 *         approvedProtocolDigest, // protocolApprovalDigest of the approved protocol
 *       }
 *     undefined/null/{}/wrong-shape/verified:false/approved:false/throwing/
 *     old-format records without approvedProtocolDigest are ALL refusals.
 *   - runningCommitSha: the commit the run ACTUALLY executes from, from a
 *     trusted execution context (verified runner / CI checkout). REQUIRED —
 *     missing/malformed/differing-from-approved all refuse. Copying
 *     freeze.ownerApproval.frozenCommitSha into it is not a trusted source.
 *
 * Nothing here reads env vars, defaults or script arguments to fill an
 * authorization gap. A DRAFT record is refused; offline rehearsals must not
 * fabricate Owner approval (the rehearsal gate relies on the refusal).
 * NOTE: this repository currently has NO real A/C execution entry point — the
 * only in-repo caller is the offline rehearsal, which relies on this gate
 * REFUSING its draft. Wiring a real runner is B1 work and must pass this gate
 * with a trusted runningCommitSha.
 */
export function validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval, dataset, runningCommitSha }) {
  const problems = [];
  const p = (msg) => problems.push(msg);

  // Required-input gate: a missing input refuses the run outright.
  if (freeze === undefined || freeze === null) {
    p('freeze record missing — real run refused');
    return { problems, minPairsEligible: null, pairDenominator: null };
  }
  if (preregBody === undefined || preregBody === null) {
    p('FZ-15: preregBody missing — the preregistration body hash check cannot be skipped; real run refused');
  }
  if (dataset === undefined || dataset === null) {
    p('FZ-01: dataset missing — the frozen taskSetHash cannot be cross-checked without the actually loaded dataset; real run refused');
  }
  if (typeof verifyOwnerApproval !== 'function') {
    p('FZ-15: trusted Owner-approval verifier missing — real-run authorization cannot be established without an authoritative decision-record resolver; real run refused');
  }
  // P1-2: the actual execution commit is MANDATORY and must be a well-formed
  // Git SHA from a trusted execution context.
  if (typeof runningCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(runningCommitSha)) {
    p(`FZ-15: runningCommitSha missing or not a 40-hex commit SHA (got ${runningCommitSha === undefined ? 'undefined' : typeof runningCommitSha}) — a real run must declare the commit it actually executes from, from a trusted runner/CI context; real run refused`);
  }

  const problemsBeforeFreezeChecks = problems.length;
  problems.push(...validateFreezeRecord(freeze));
  // Only bail when the freeze record itself cannot be inspected further;
  // otherwise run EVERY remaining check so one refusal surfaces all its
  // problems (missing input reports must not mask the item-level verdicts).
  if (!isPlainObject(freeze) || !Array.isArray(freeze.items)) {
    return { problems, minPairsEligible: null, pairDenominator: null };
  }
  // A run with ANY missing required input is refused outright and must not
  // also emit a sample-size verdict (no partial authorization semantics).
  const requiredInputMissing = problemsBeforeFreezeChecks > 0;

  if (freeze.status !== PRR_FREEZE_FROZEN_STATUS) {
    p(`freeze.status must be ${PRR_FREEZE_FROZEN_STATUS} before any real A/C run (current: ${freeze.status})`);
  }

  // P1-1: the submitted preregistration body must belong to THIS study —
  // studyId identity between body and freeze record is part of the protocol.
  if (preregBody !== undefined && preregBody !== null) {
    if (typeof preregBody.studyId !== 'string' || preregBody.studyId === '') {
      p('FZ-15: preregBody.studyId missing — the preregistration body must name the study it belongs to; real run refused');
    } else if (preregBody.studyId !== freeze.studyId) {
      p(`FZ-15: studyId mismatch between the preregistration body (${preregBody.studyId}) and the freeze record (${freeze.studyId}) — real run refused`);
    }
    if (isPlainObject(freeze.prereg)) {
      const actualHash = preregBodyHash(preregBody);
      if (freeze.prereg.canonicalSha256 !== actualHash) {
        p(`FZ-15: preregistration body hash mismatch (record=${freeze.prereg.canonicalSha256.slice(0, 12)}…, actual=${actualHash.slice(0, 12)}…) — the body changed after freezing: INVALID_PROTOCOL, start a new studyId`);
      }
    }
  }

  // FZ-15 — trusted verifier verdict. Only verified===true AND approved===true
  // together (plus commit and COMPLETE protocol digest bindings) authorize.
  if (typeof verifyOwnerApproval === 'function' && isPlainObject(freeze.ownerApproval)) {
    let evidence;
    try {
      evidence = verifyOwnerApproval({ decisionRef: freeze.ownerApproval.decisionRef });
    } catch (error) {
      p(`FZ-15: Owner approval verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (evidence === undefined || evidence === null) {
      p('FZ-15: Owner-approval verifier returned no evidence (undefined/null) — fail-closed refusal');
    } else if (!isPlainObject(evidence)) {
      p('FZ-15: Owner-approval verifier returned a non-object evidence — fail-closed refusal');
    } else if (evidence.verified !== true || evidence.approved !== true) {
      p(`FZ-15: Owner decision not BOTH verified and approved (verified=${JSON.stringify(evidence.verified)}, approved=${JSON.stringify(evidence.approved)}${evidence.reason ? `; reason: ${evidence.reason}` : ''}) — fail-closed refusal`);
    } else if (typeof evidence.frozenCommitSha !== 'string' || !/^[0-9a-f]{40}$/.test(evidence.frozenCommitSha)) {
      p('FZ-15: verified approval carries no frozenCommitSha binding — the authoritative decision record must pin the frozen commit; real run refused');
    } else if (evidence.frozenCommitSha !== freeze.ownerApproval.frozenCommitSha) {
      p(`FZ-15: frozenCommitSha mismatch between the freeze record (${freeze.ownerApproval.frozenCommitSha.slice(0, 8)}…) and the authoritative Owner decision (${evidence.frozenCommitSha.slice(0, 8)}…) — the freeze is not bound to the approved protocol; real run refused`);
    } else if (typeof evidence.approvedProtocolDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidence.approvedProtocolDigest)) {
      // Old-format approval records without the complete protocol digest are
      // refused — never auto-completed or interpreted as approved (P1-1).
      p('FZ-15: verified approval carries no approvedProtocolDigest — the authoritative decision record must pin the COMPLETE protocol approval digest (studyId + prereg hash + all freeze items); records saved in an older format without it are not valid for a real run; real run refused');
    } else if (preregBody === undefined || preregBody === null) {
      // The body is a required input and its absence was already refused; the
      // digest simply cannot be computed against it, so nothing reconciles.
    } else {
      // COMPLETE protocol reconciliation against the INDEPENDENTLY SAVED
      // digest: any change to studyId, the prereg body, or ANY freeze item
      // (budget, minPairs, STOP, gold, approval refs…) breaks this even when
      // decisionRef and commitSha are kept (SPEC §5.2).
      const actualDigest = protocolApprovalDigest({ freeze, preregBody });
      if (evidence.approvedProtocolDigest !== actualDigest) {
        p(`FZ-15: protocol approval reconciliation FAILED — submitted protocol digest ${actualDigest.slice(0, 12)}… does not equal the Owner-approved digest ${evidence.approvedProtocolDigest.slice(0, 12)}…; the studyId, preregistration body, or a frozen value was changed after approval: INVALID_PROTOCOL, start a new studyId`);
      }
    }
    // P1-2: the actual execution commit must equal the approved one.
    if (typeof runningCommitSha === 'string' && isPlainObject(evidence) && evidence.verified === true && evidence.approved === true && typeof evidence.frozenCommitSha === 'string') {
      if (runningCommitSha !== evidence.frozenCommitSha) {
        p(`FZ-15: running commit ${runningCommitSha.slice(0, 8)}… differs from the Owner-approved frozen commit ${evidence.frozenCommitSha.slice(0, 8)}… — the run would not execute the approved code state; real run refused`);
      }
    }
  }

  const missing = [];
  for (const item of freeze.items) {
    if (item.status !== 'VALUE_FROZEN') missing.push(item.id);
  }
  if (missing.length > 0) {
    p(`real run refused — freeze items not frozen: ${missing.join(', ')} (every FZ item needs an Owner-approved value before any real A/C result exists)`);
  }

  // FZ-01 cross-check (P1-4): the gate RECOMPUTES the dataset hash from its
  // current contents and verifies the CONSUMED structures ARE the hashed
  // snapshot (a cloned/rebuilt dataset breaks shared references and is
  // refused even when its byFile bytes still hash to the cached value).
  if (dataset) {
    let integrity = null;
    try {
      integrity = verifyDatasetIntegrity(dataset);
    } catch (error) {
      p(`FZ-01: dataset integrity could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (integrity && !integrity.hashUnchanged) {
      p(`FZ-01: dataset integrity FAILED — content changed after loading (cached fixtureHash ${integrity.cachedHash.slice(0, 12)}…, recomputed ${integrity.currentHash.slice(0, 12)}…); the run would consume data different from the loaded snapshot; real run refused`);
    }
    if (integrity && !integrity.consumedIdentityShared) {
      p('FZ-01: dataset integrity FAILED — the structures a run consumes (tasks/gold/behaviors/…) are not the same objects as the hashed snapshot (cloned or rebuilt dataset); refusing to run on unverified data');
    }
    if (integrity && !integrity.derivedIndexesBound) {
      p('FZ-01: dataset integrity FAILED — derived lookup indexes (tasksById/principlesById/goldByTask) no longer reference the verified snapshot entries; real run refused');
    }
    if (integrity && integrity.ok) {
      const fz01 = freeze.items.find((i) => i.id === 'FZ-01');
      const frozenHash = fz01 && isPlainObject(fz01.value) ? fz01.value.taskSetHash : undefined;
      if (typeof frozenHash !== 'string' || !/^[0-9a-f]{64}$/.test(frozenHash)) {
        p('FZ-01: value.taskSetHash missing or not a 64-hex SHA-256 — real run refused (the frozen task identity is a mandatory freeze value)');
      } else if (frozenHash !== integrity.currentHash) {
        p(`FZ-01: frozen taskSetHash ${frozenHash.slice(0, 12)}… does not equal the RECOMPUTED dataset hash ${integrity.currentHash.slice(0, 12)}… — the study would run on different tasks than approved`);
      }
    }
  }

  // FZ-11: the sample-size gate can NEVER be skipped by an ill-formed value.
  // A present FZ-11 item whose value is not the contract object is a refusal,
  // not a silent bypass (owner review round 2).
  let minPairsEligible = null;
  let pairDenominator = null;
  const fz11 = freeze.items.find((i) => i.id === 'FZ-11');
  if (fz11) {
    if (!isPlainObject(fz11.value)) {
      p(`FZ-11: value must be an object { minPairs, derivationBasis } (got ${fz11.value === null ? 'null' : typeof fz11.value}${Array.isArray(fz11.value) ? ' array' : ''}) — the minimum-pairs gate cannot be skipped by replacing the value with another type; real run refused`);
    } else {
      const minPairs = fz11.value.minPairs;
      const basis = fz11.value.derivationBasis;
      const basisValid = typeof basis === 'string' && basis.trim() !== '';
      if (!Number.isSafeInteger(minPairs) || minPairs < 1) {
        p(`FZ-11: value.minPairs must be a positive integer derived from the FZ-09 detectable difference (got ${JSON.stringify(minPairs ?? null)})`);
      }
      if (!basisValid) {
        p('FZ-11: value.derivationBasis must state how minPairs was derived from FZ-09 (B0 §5.1 rule 2 — no unexplained N)');
      }
      // The count comparison only runs when BOTH declared fields are valid
      // AND no required input is missing — a partially valid value or a
      // refused run must not yield a sample-size verdict.
      if (Number.isSafeInteger(minPairs) && minPairs >= 1 && basisValid && !requiredInputMissing && dataset) {
        const allTasks = dataset.tasks?.tasks ?? [];
        const unauthorized = allTasks.filter((t) => t?.historyMaterial?.disclosureStatus === 'unauthorized');
        pairDenominator = {
          totalTasks: allTasks.length,
          completePairs: allTasks.length - unauthorized.length,
          excludedUnauthorizedTasks: unauthorized.length,
        };
        minPairsEligible = pairDenominator.completePairs >= minPairs;
        if (minPairsEligible === false) {
          p(`FZ-11: complete A/C pairs (${pairDenominator.completePairs} of ${pairDenominator.totalTasks} tasks; ${pairDenominator.excludedUnauthorizedTasks} excluded pre-exposure) fall below the declared minimum (${minPairs}) — by AC-S7 the study outcome is UNPROVEN, not a pass; original data and exclusion records are retained and the frozen threshold is never lowered`);
        }
      }
    }
  }

  return { problems, minPairsEligible, pairDenominator };
}
