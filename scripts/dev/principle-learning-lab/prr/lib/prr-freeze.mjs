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
 * Fail-closed REAL-RUN gate (B0 §5/§6). Returns { problems, minPairsEligible }.
 *
 * `verifyOwnerApproval` is a trusted, caller-supplied resolver:
 *   ({ decisionRef }) => { verified: boolean, approved: boolean, reason?: string }
 * In production it resolves the Owner decision record from the authoritative
 * store; nothing in this module substitutes a default for it. If it is not a
 * function, real-run validation fails closed.
 *
 * `dataset` (optional) cross-checks FZ-01: the frozen taskSetHash must equal
 * the loaded dataset's fixtureHash — a study may not run on data other than
 * what was frozen.
 */
export function validateFreezeForRealRun({ freeze, preregBody, verifyOwnerApproval, dataset }) {
  const problems = validateFreezeRecord(freeze);
  const p = (msg) => problems.push(msg);

  if (problems.length > 0) return { problems, minPairsEligible: null };

  if (freeze.status !== PRR_FREEZE_FROZEN_STATUS) {
    p(`freeze.status must be ${PRR_FREEZE_FROZEN_STATUS} before any real A/C run (current: ${freeze.status})`);
  }
  if (preregBody !== undefined && preregBody !== null) {
    const actualHash = preregBodyHash(preregBody);
    if (freeze.prereg.canonicalSha256 !== actualHash) {
      p(`FZ-15: preregistration body hash mismatch (record=${freeze.prereg.canonicalSha256.slice(0, 12)}…, actual=${actualHash.slice(0, 12)}…) — the body changed after freezing: INVALID_PROTOCOL, start a new studyId`);
    }
  }
  if (typeof verifyOwnerApproval !== 'function') {
    p('FZ-15: trusted Owner-approval verifier missing — real-run authorization cannot be established without an authoritative decision-record resolver');
  } else if (isPlainObject(freeze.ownerApproval)) {
    let evidence;
    try {
      evidence = verifyOwnerApproval({ decisionRef: freeze.ownerApproval.decisionRef });
    } catch (error) {
      p(`FZ-15: Owner approval verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (evidence && evidence.verified !== true) {
      p(`FZ-15: Owner decision ref was not verified (${evidence.reason ?? 'no reason given'})`);
    }
    if (evidence && evidence.verified === true && evidence.approved !== true) {
      p('FZ-15: referenced Owner decision is not an approval');
    }
  }

  const missing = [];
  for (const item of freeze.items) {
    if (item.status !== 'VALUE_FROZEN') missing.push(item.id);
  }
  if (missing.length > 0) {
    p(`real run refused — freeze items not frozen: ${missing.join(', ')} (every FZ item needs an Owner-approved value before any real A/C result exists)`);
  }

  // FZ-01 cross-check against the actually loaded dataset.
  if (dataset) {
    const fz01 = freeze.items.find((i) => i.id === 'FZ-01');
    const frozenHash = fz01 && isPlainObject(fz01.value) ? fz01.value.taskSetHash : null;
    if (typeof frozenHash === 'string') {
      if (frozenHash !== dataset.fixtureHash) {
        p(`FZ-01: frozen taskSetHash ${frozenHash.slice(0, 12)}… does not equal the loaded dataset hash ${dataset.fixtureHash.slice(0, 12)}… — the study would run on different tasks than approved`);
      }
    }
  }

  // FZ-11: N must be derived from FZ-09's detectable difference, and the
  // actual task count must not fall below the declared minimum paired count
  // (below minimum → UNPROVEN by AC-S7, never a silent pass).
  let minPairsEligible = null;
  const fz11 = freeze.items.find((i) => i.id === 'FZ-11');
  if (fz11 && isPlainObject(fz11.value)) {
    const minPairs = fz11.value.minPairs;
    const basis = fz11.value.derivationBasis;
    if (!Number.isSafeInteger(minPairs) || minPairs < 1) {
      p('FZ-11: value.minPairs must be a positive integer derived from the FZ-09 detectable difference');
    }
    if (typeof basis !== 'string' || basis.trim() === '') {
      p('FZ-11: value.derivationBasis must state how minPairs was derived from FZ-09 (B0 §5.1 rule 2 — no unexplained N)');
    }
    if (Number.isSafeInteger(minPairs) && minPairs >= 1 && basis && dataset) {
      const pairCount = dataset.tasks?.tasks?.length ?? 0;
      minPairsEligible = pairCount >= minPairs;
      if (minPairsEligible === false) {
        p(`FZ-11: available task pairs (${pairCount}) fall below the declared minimum (${minPairs}) — by AC-S7 the study outcome is UNPROVEN, not a pass`);
      }
    }
  }

  return { problems, minPairsEligible };
}
