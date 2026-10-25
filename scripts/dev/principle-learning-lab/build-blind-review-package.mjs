#!/usr/bin/env node
// Stage G round7 → blind-review package builder (workflow A).
// Extracts the 12 adopted E candidates, strips ALL generation metadata
// (candidateId/provenance/strategy/model identity/request ids), assigns
// deterministic blind RV ids (seed pinned), and emits reviewer-facing packets
// containing ONLY actor-visible-equivalent content. Gold/judge-only fields
// never enter packets (structural: built from the actor-visible projection).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assignBlindReviewIds } from './lib/challenge-validator.mjs';
import { canonicalJson } from './lib/challenge-freeze.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const outDir = path.join(studyDir, 'blind-review-package');
const SEED = 20261025; // pre-registered seed (date-derived, fixed before any review)

fs.mkdirSync(path.join(outDir, 'packets'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'judge-only'), { recursive: true });

const lines = fs.readFileSync(path.join(studyDir, 'stage-g-execution', 'round7', 'examiner-draft-log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const adopted = lines.filter((d) => d.adoptedEnvelope);
if (adopted.length !== 12) throw new Error(`expected 12 adopted candidates, got ${adopted.length}`);

// ---- actor-visible-equivalent reviewer view (NO gold/judge-only, NO metadata) ----
function reviewerView(envelope) {
  const cd = envelope.caseDef;
  return {
    taskText: cd.taskText,
    facts: cd.facts.map((f) => ({ factId: f.factId, statement: f.statement })), // no goldTruth/observability/stakes
    observations: cd.observations.map((o) => ({ obsId: o.obsId, label: o.label, output: o.output, costUnits: o.costUnits, timeUnits: o.timeUnits })), // no implies
    constraints: cd.constraints,
    hasOwnerAnswers: Object.keys(cd.ownerAnswers || {}).length > 0,
  };
}

// ---- strip generation metadata from a full envelope for the integrity record ----
function strippedEnvelope(envelope) {
  const e = JSON.parse(JSON.stringify(envelope));
  delete e.provenance; // mergeBase/generator/modelCalls reveal E-arm & pipeline
  if (e.draft) {
    delete e.draft.strategy; // 'e-expressive-merge-v1' reveals the arm
    delete e.draft.slot;
  }
  return e;
}

const ids = adopted.map((d, i) => d.adoptedEnvelope.candidateId || `E-candidate-${i + 1}`);
const blind = assignBlindReviewIds(ids, SEED);

// judge-only mapping (source id → RV id) + full integrity record
const judgeMapping = adopted.map((d, i) => {
  const stripped = strippedEnvelope(d.adoptedEnvelope);
  const envelopeHash = 'sha256:' + crypto.createHash('sha256').update(canonicalJson(stripped)).digest('hex');
  return {
    rvId: blind.assignments[ids[i]],
    sourceCandidateId: ids[i],
    requestId: d.requestId,
    baselineCandidateId: d.baselineCandidateId || null,
    envelopeHash,
  };
});

// reviewer-facing packets: RV id + reviewer view ONLY
for (let i = 0; i < adopted.length; i++) {
  const rv = blind.assignments[ids[i]];
  const packet = {
    schema: 'blind-review-packet.v1',
    rvId: rv,
    candidate: reviewerView(adopted[i].adoptedEnvelope),
  };
  fs.writeFileSync(path.join(outDir, 'packets', `${rv}.json`), JSON.stringify(packet, null, 2) + '\n');
}

// leakage self-check: no packet may contain gold fields or generation metadata
const leakTerms = ['goldTruth', 'gold', 'implies', 'acceptableVerdicts', 'expectedMode', 'provenance', 'sourceBinding', 'e-expressive', 'deepseek', 'GLM', 'intern-ai', 'E-ENUM', 'mergeBase', 'strategy'];
let leaks = 0;
for (const f of fs.readdirSync(path.join(outDir, 'packets'))) {
  const t = fs.readFileSync(path.join(outDir, 'packets', f), 'utf8');
  for (const term of leakTerms) if (t.includes(term)) { leaks++; console.error(`LEAK in ${f}: ${term}`); }
}
if (leaks > 0) process.exit(1);

const manifest = {
  schema: 'blind-review-package.v1',
  studyId: 'CEB-001',
  builtAt: new Date().toISOString(),
  seed: SEED,
  candidateCount: adopted.length,
  slotsContext: '12/36（部分预算轮——阶段性问题批，非完整 36 槽实验）',
  stripped: ['candidateId', 'provenance(mergeBase/generator/modelCalls)', 'draft.strategy', 'requestId', 'observedModelIdentity', 'timestamps'],
  leakCheckTerms: leakTerms,
  leakCheckResult: leaks === 0 ? 'CLEAN' : 'FAILED',
  files: { packets: fs.readdirSync(path.join(outDir, 'packets')).sort(), judgeMapping: 'judge-only/rv-to-source.json' },
  reviewers: { R1: 'PENDING', R2: 'PENDING', arbitrator: 'PENDING' },
  scoring: '八维评分契约（冻结 scoring-contract）+三关键门槛一票否决；双评审→分歧仲裁；kappa≥0.6 采信',
  status: 'PACKAGE_READY_REVIEWERS_PENDING',
};
fs.writeFileSync(path.join(outDir, 'package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'judge-only', 'rv-to-source.json'), JSON.stringify({ seed: SEED, mapping: judgeMapping }, null, 2) + '\n');
console.log(`blind-review package: ${adopted.length} packets, leak check ${leaks === 0 ? 'CLEAN' : 'FAILED'}, seed=${SEED}`);
