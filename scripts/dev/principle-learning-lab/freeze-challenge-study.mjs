#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.3 — Phase 1A freeze CLI for challenge studies.
//
// Compiles challenge-studies/<studyId>/challenge-suite.draft.json into the
// frozen SPEC §10 layout (actor-visible/, judge-only/, suite-manifest.json,
// examiner-draft-log.jsonl), freezes the mapping (mappingHash), binds the
// grader/suite/prereg hashes, builds + statically audits the A/B/C arm
// configs, and writes hashes.json.
//
//   node freeze-challenge-study.mjs --study CEB-001           # freeze
//   node freeze-challenge-study.mjs --study CEB-001 --verify  # recompute & assert
//
// Deterministic: no clock, no randomness, no network, no DB access. Hashes
// are computed over PARSED object graphs (canonical JSON), never over file
// bytes — formatting changes cannot alter any hash.
//
// FAIL-CLOSED: expected source hashes are recomputed from the frozen
// principle content and compared against input-manifest.expectedSourceHashes;
// any mismatch aborts without writing anything.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256, hashOfCanonical, freezeMapping, CANONICALIZATION_RULE } from './lib/challenge-freeze.mjs';
import { validateChallengeDraft, compileCase, compileSuite } from './lib/challenge-compile.mjs';
import { scoringContractHash } from './lib/claim-evidence-scorer.mjs';
import { buildStudyArms, auditArmIsolation } from './lib/challenge-arms.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const studiesRoot = path.join(labRoot, 'challenge-studies');

function readJson(dir, rel) {
  return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
}
function writeJson(dir, rel, value) {
  fs.writeFileSync(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function fail(message) {
  console.error(`freeze-challenge-study: FAIL — ${message}`);
  process.exit(1);
}

function freezeStudy(studyId, { verifyOnly = false } = {}) {
  const dir = path.join(studiesRoot, studyId);
  if (!fs.existsSync(dir)) fail(`study dir not found: ${dir}`);

  // 1. Source hash verification (recompute from frozen content, compare to expected).
  const inputManifest = readJson(dir, 'input-manifest.json');
  const principleFrozen = readJson(dir, 'principle-frozen.json');
  const recomputed = {
    contentHash: hashOfCanonical(principleFrozen.contentJson),
    statementHash: sha256(principleFrozen.contentJson.principleDraft.statement),
  };
  const expected = inputManifest.expectedSourceHashes;
  if (recomputed.contentHash !== expected.principleContentHash) fail(`principleContentHash mismatch: recomputed ${recomputed.contentHash} != expected ${expected.principleContentHash}`);
  if (recomputed.statementHash !== expected.statementSha256) fail(`statementSha256 mismatch: recomputed ${recomputed.statementHash} != expected ${expected.statementSha256}`);
  if (recomputed.contentHash !== principleFrozen.computedHashes.contentJsonCanonicalSha256) fail('principle-frozen.json recorded contentJsonCanonicalSha256 inconsistent with recomputation');
  if (recomputed.statementHash !== principleFrozen.computedHashes.statementSha256) fail('principle-frozen.json recorded statementSha256 inconsistent with recomputation');

  // painEvent/diagnosis row hashes: source rows live in gitignored snapshot DBs —
  // they are VERIFIED BASELINES (Phase 0 + this freeze session recomputed equal),
  // not recomputable from inside the study dir. Recorded as such.
  const painEventVerified = inputManifest.expectedSourceHashes.painEventRowSha256;
  const diagnosisVerified = inputManifest.expectedSourceHashes.diagnosisRowsSha256;

  // 2. Mapping freeze.
  const mapping = readJson(dir, 'pain-mechanism-mapping.json');
  const mappingFrozen = freezeMapping(mapping);
  if (verifyOnly) {
    if (mapping.mappingHash !== mappingFrozen.mappingHash) fail(`mappingHash mismatch: recorded ${mapping.mappingHash} != recomputed ${mappingFrozen.mappingHash}`);
  } else {
    mapping.mappingHash = mappingFrozen.mappingHash;
    writeJson(dir, 'pain-mechanism-mapping.json', mapping);
  }
  const mappingHash = mappingFrozen.mappingHash;
  if (mapping.principleContentHash !== recomputed.contentHash) fail('mapping.principleContentHash != frozen principle content hash');

  // 3. Scoring contract → graderHash.
  const scoringContract = readJson(dir, 'scoring-contract.json');
  const graderHash = scoringContractHash(scoringContract);

  // 4. Draft validation + case compilation.
  const draftDoc = readJson(dir, 'challenge-suite.draft.json');
  const drafts = draftDoc.drafts || [];
  const caseDefs = draftDoc.cases || [];
  if (drafts.length !== caseDefs.length) fail(`drafts (${drafts.length}) and cases (${caseDefs.length}) must pair 1:1`);
  const caseById = new Map(caseDefs.map((c) => [c.caseId, c]));
  for (const d of drafts) {
    try {
      validateChallengeDraft(d);
    } catch (e) {
      fail(e.message);
    }
    if (!caseById.has(d.parameters.caseId)) fail(`draft ${d.scenarioId} references unknown case ${d.parameters.caseId}`);
  }

  const { manifest, suiteHash } = compileSuite({ studyId, mappingHash, graderHash, caseDefs });

  // 5. Arms (A/B/C) build + static isolation audit.
  const summaryPayload = readJson(dir, 'arm-payload-experience-summary.json');
  const preregDraft = readJson(dir, 'preregistration.draft.json');
  const built = buildStudyArms({
    commonContextText: preregDraft.commonContext.text,
    principleStatement: principleFrozen.contentJson.principleDraft.statement,
    summaryText: summaryPayload.text,
    budgetChars: preregDraft.delivery.budgetChars,
  });
  if (built.arms.B.delivery.payloadHash !== recomputed.statementHash) fail('arm B payloadHash != statementSha256 (B must deliver the exact frozen statement)');
  const sampleTaskText = caseDefs[0].taskText;
  const armAudit = auditArmIsolation({ arms: built.arms, commonContextText: preregDraft.commonContext.text, taskText: sampleTaskText, normativeMarkers: summaryPayload.normativeMarkersThatMustNotAppear });
  if (!armAudit.ok) fail(`arm isolation audit failed: ${armAudit.problems.join('; ')}`);
  const summaryPayloadHash = built.arms.C.delivery.payloadHash;
  const commonContextHash = built.commonContextHash;

  // 6. Prereg final.
  const prereg = JSON.parse(JSON.stringify(preregDraft));
  prereg.commonContext.hash = commonContextHash;
  prereg.arms[2].payloadHash = summaryPayloadHash;
  prereg.freezeReferences = {
    mappingHash,
    suiteHash,
    graderHash,
    principleContentHash: recomputed.contentHash,
    summaryPayloadHash,
    commonContextHash,
    note: '由 freeze-challenge-study.mjs 填充并在 hashes.json 汇总；suiteHash 绑定 mappingHash+graderHash+全部题对哈希。',
  };
  const preregistrationHash = hashOfCanonical(prereg);
  const inputManifestHash = hashOfCanonical(inputManifest);

  const hashes = {
    schema: 'challenge-study-hashes.v1',
    studyId,
    algorithm: 'sha256',
    canonicalization: CANONICALIZATION_RULE,
    hashInputNote: '所有哈希基于解析后的对象图（canonical JSON），与文件排版无关；同一内容重复计算必得同一哈希。',
    mappingHash: { value: mappingHash, rule: 'sha256(canonicalJson(pain-mechanism-mapping.json 内容, 去除 mappingHash 字段))' },
    principleContentHash: { value: recomputed.contentHash, rule: 'sha256(canonicalJson(principle-frozen.json contentJson))；与 input-manifest.expectedSourceHashes 一致（复算断言）' },
    statementSha256: { value: recomputed.statementHash, rule: 'sha256(statement 原文 utf8)；同时是 B 臂 payloadHash' },
    painEventRowSha256: { value: painEventVerified, rule: 'VERIFIED BASELINE——源行在 gitignored 快照 DB，Phase 0 与 2026-10-24 双库只读复算相等；仓内不可复算，修改冻结资产不会触及该值' },
    diagnosisRowsSha256: { value: diagnosisVerified, rule: '同上（pain_diagnoses 行集）' },
    graderHash: { value: graderHash, rule: 'sha256(canonicalJson(scoring-contract.json 内容))——评分语义契约整体指纹' },
    suiteHash: { value: suiteHash, rule: 'sha256(canonicalJson(suite-manifest 核心, 去除 suiteHash 字段))；绑定 mappingHash+graderHash+templateId/Version+每题 inputHash/goldHash+familyCounts' },
    summaryPayloadHash: { value: summaryPayloadHash, rule: 'sha256(C 臂摘要原文 utf8)' },
    commonContextHash: { value: commonContextHash, rule: 'sha256(共同基线原文 utf8)；三臂必须一致' },
    inputManifestHash: { value: inputManifestHash, rule: 'sha256(canonicalJson(input-manifest.json 内容))' },
    preregistrationHash: { value: preregistrationHash, rule: 'sha256(canonicalJson(preregistration.json 内容))' },
    verification: {
      sourceHashesMatchExpected: true,
      armBIsExactFrozenStatement: true,
      armIsolationAuditOk: true,
    },
    referenceChain: {
      'suiteHash → mappingHash + graderHash + cases[]': '题集冻结后任何对题面/Gold/映射/评分契约的改动都会破坏 suiteHash',
      'armB.payloadHash == statementSha256 == principleContentHash 所指产物的 statement 字段': 'B 臂注入的正是冻结原则原文',
      'preregistration.freezeReferences': '预注册引用上述全部哈希',
      'goldHash per case': '每题 judge-only 内容（含 Gold 真值）独立指纹，写入 suite-manifest cases[]',
    },
  };

  if (verifyOnly) {
    const onDiskManifest = readJson(dir, 'suite-manifest.json');
    if (onDiskManifest.suiteHash !== suiteHash) fail(`suiteHash mismatch: disk ${onDiskManifest.suiteHash} != recomputed ${suiteHash}`);
    const onDiskHashes = readJson(dir, 'hashes.json');
    for (const key of ['mappingHash', 'graderHash', 'suiteHash', 'preregistrationHash', 'inputManifestHash']) {
      if (onDiskHashes[key].value !== hashes[key].value) fail(`hashes.json ${key} mismatch`);
    }
    for (const c of manifest.cases) {
      const j = readJson(path.join(dir, 'judge-only'), `${c.caseId}.json`);
      if (j.inputHash !== c.inputHash || j.goldHash !== c.goldHash) fail(`case ${c.caseId}: judge-only hash fields mismatch manifest`);
    }
    console.log(`freeze-challenge-study: VERIFY OK — ${studyId} (cases=${manifest.caseCount}, families=${JSON.stringify(manifest.familyCounts)})`);
    return;
  }

  // 7. Write frozen artifacts.
  fs.mkdirSync(path.join(dir, 'actor-visible'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'judge-only'), { recursive: true });
  for (const cd of caseDefs) {
    const compiled = compileCase(cd);
    writeJson(path.join(dir, 'actor-visible'), `${cd.caseId}.json`, compiled.actorVisible);
    writeJson(path.join(dir, 'judge-only'), `${cd.caseId}.json`, compiled.judgeOnly);
  }
  const draftLogLines = drafts.map((d) => JSON.stringify({ ...d, generator: 'deterministic-enumeration', modelCalls: 0 }));
  fs.writeFileSync(path.join(dir, 'examiner-draft-log.jsonl'), `${draftLogLines.join('\n')}\n`, 'utf8');
  writeJson(dir, 'suite-manifest.json', manifest);
  writeJson(dir, 'preregistration.json', prereg);
  writeJson(dir, 'arm-configs.json', {
    schema: 'challenge-arm-configs.v1',
    studyId,
    commonContextText: preregDraft.commonContext.text,
    commonContextHash,
    delivery: preregDraft.delivery,
    arms: {
      A: { armId: 'A', name: 'BASELINE_NO_ADDED_PRINCIPLE', contentMode: 'none', delivery: built.arms.A.delivery },
      B: { armId: 'B', name: 'TARGET_PRINCIPLE', contentMode: 'policy', delivery: built.arms.B.delivery, frozenCandidate: built.arms.B.frozenCandidate },
      C: { armId: 'C', name: 'EXPERIENCE_SUMMARY', contentMode: 'summary', delivery: built.arms.C.delivery, frozenCandidate: built.arms.C.frozenCandidate },
    },
    isolationAudit: armAudit,
    executionStatus: 'NOT_RUN',
  });
  writeJson(dir, 'hashes.json', hashes);
  for (const emptyFile of ['budget-ledger.jsonl', 'events.jsonl', 'adjudications.jsonl']) {
    if (!fs.existsSync(path.join(dir, emptyFile))) fs.writeFileSync(path.join(dir, emptyFile), '', 'utf8');
  }

  console.log(`freeze-challenge-study: FROZEN — ${studyId}`);
  console.log(`  cases=${manifest.caseCount} families=${JSON.stringify(manifest.familyCounts)}`);
  console.log(`  mappingHash=${mappingHash}`);
  console.log(`  graderHash=${graderHash}`);
  console.log(`  suiteHash=${suiteHash}`);
  console.log(`  preregistrationHash=${preregistrationHash}`);
}

const args = process.argv.slice(2);
const studyIdx = args.indexOf('--study');
const studyId = studyIdx >= 0 ? args[studyIdx + 1] : null;
if (!studyId) fail('--study <studyId> required (e.g. CEB-001)');
freezeStudy(studyId, { verifyOnly: args.includes('--verify') });
