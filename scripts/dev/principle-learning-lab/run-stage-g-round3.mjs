#!/usr/bin/env node
// Stage G round-3: E-arm on intern-s2 (preregistered fallback provider).
// Same plan/discipline as round1/2 — serial 16 requests, ledger bookkeeping,
// no auto-retry, halt on cap/window.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runExaminerRequest } from './lib/challenge-examiner.mjs';
import { createInternS2Transport } from './lib/challenge-amd-transport.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const workDir = path.join(studyDir, 'stage-g-execution', 'round3');
fs.mkdirSync(workDir, { recursive: true });

const auth = JSON.parse(fs.readFileSync(path.join(studyDir, 'generation-authorization.json'), 'utf8'));
if (auth.requestedModelIdentity !== 'intern-ai-discovery/intern-s2') {
  console.error('round3: live authorization does not bind intern-s2 — refusing (no model mixing).');
  process.exit(1);
}
const baseSpec = {
  schema: 'examiner-run-spec.v1',
  studyId: 'CEB-001',
  mappingId: 'PMM-001-ASSERT-EVIDENCE-V1',
  mappingHash: auth.mappingHash,
  inputManifestHash: auth.inputManifestHash,
  templateId: auth.templateId,
  templateVersion: auth.templateVersion,
  schemaVersion: auth.schemaVersion,
  valueDomainVersion: auth.valueDomainVersion,
  allowedExpressionFields: ['taskText', 'facts[].statement', 'observations[].label', 'observations[].output'],
  candidateCap: 36,
  requestCap: auth.requestCap,
  perRequestCandidateCap: 6,
  inputTokenCap: auth.inputTokenCap,
  outputTokenCap: auth.outputTokenCap,
  costCapUsd: auth.costCapUsd,
  pricePerMillion: { input: null, output: null },
  dataTransferPermit: auth.dataTransferPermit,
  desensitizationStatus: auth.desensitizationStatus,
  requestedModelIdentity: auth.requestedModelIdentity,
};
const sliceFor = (r) => (r <= 6 ? (r - 1) * 6 : ((r - 7) * 6) % 36);

const summary = [];
for (let r = 1; r <= 16; r++) {
  const spec = { ...baseSpec, combinationSlice: { offset: sliceFor(r), limit: 6 } };
  const requestId = `stage-g-r3-req-${String(r).padStart(2, '0')}`;
  const t0 = Date.now();
  let out;
  try {
    out = await runExaminerRequest({
      spec, workDir, requestId, transport: 'real', now: Date.now(),
      authorizationRecord: auth,
      transportFactory: () => createInternS2Transport(),
    });
  } catch (e) {
    console.log(`R${r} ${requestId}: INTERRUPTED ${e.message}`);
    summary.push({ r, requestId, state: 'INTERRUPTED', error: e.message });
    continue;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (out.refused) {
    console.log(`R${r} ${requestId}: REFUSED at ${out.stage} (${JSON.stringify(out.reasons || out.reason || out.code || out.problems).slice(0, 220)}) [${elapsed}s]`);
    summary.push({ r, requestId, state: `REFUSED_${out.stage}`, detail: out.reasons || out.reason || out.code || out.problems });
    if (out.stage === 'authorization' || out.stage === 'budget') break;
    continue;
  }
  const adopted = (out.candidates || []).filter((c) => c.eligibleForValidSet && c.ok).length;
  console.log(`R${r} ${requestId}: ${out.result} — candidates=${(out.candidates || []).length} adopted=${adopted} outputField=${out.outputField || '-'} usage=${JSON.stringify(out.usage && { in: out.usage.inputTokens, out: out.usage.outputTokens, nominal: out.usage.nominalServerCost })} [${elapsed}s]`);
  summary.push({ r, requestId, state: out.result, parsed: (out.candidates || []).length, adopted, elapsedS: Number(elapsed) });
}
fs.writeFileSync(path.join(workDir, 'round3-summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), summary }, null, 2) + '\n');
console.log('ROUND3 DONE — summary written.');
