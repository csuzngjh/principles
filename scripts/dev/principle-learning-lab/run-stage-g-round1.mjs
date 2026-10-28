#!/usr/bin/env node
// SPEC-PD-EXAMINER-001 v0.4 — Stage G round-1 E-arm execution driver.
// Runs the pre-registered 16-request serial plan against the REAL AMD
// transport under the issued Stage G authorization. Serial, fail-soft:
// every outcome (SUCCEEDED/FAILED_KNOWN/RESULT_UNKNOWN/refusals) is recorded
// by the ledger; the driver never auto-retries and stops at the request cap.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { runExaminerRequest } from './lib/challenge-examiner.mjs';
import { createAmdRadeonTransport, AMD_REQUESTED_MODEL_IDENTITY } from './lib/challenge-amd-transport.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const workDir = path.join(studyDir, 'stage-g-execution', 'round4');
fs.mkdirSync(workDir, { recursive: true });

const auth = JSON.parse(fs.readFileSync(path.join(studyDir, 'generation-authorization.json'), 'utf8'));
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
  pricePerMillion: { input: null, output: null }, // free tier — request-count reservation is the hard cap
  dataTransferPermit: auth.dataTransferPermit,
  desensitizationStatus: auth.desensitizationStatus,
  requestedModelIdentity: auth.requestedModelIdentity,
};

// Pre-registered slicing plan (execution-preregistration.json): R1-R6 coverage
// sweep, R7-R16 refinement sweep. Fixed formula — never results-adjusted.
const sliceFor = (r) => (r <= 6 ? (r - 1) * 6 : ((r - 7) * 6) % 36);

const summary = [];
for (let r = 1; r <= 16; r++) {
  const spec = { ...baseSpec, combinationSlice: { offset: sliceFor(r), limit: 6 } };
  const requestId = `stage-g-r4-req-${String(r).padStart(2, '0')}`;
  const t0 = Date.now();
  let out;
  try {
    out = await runExaminerRequest({
      spec, workDir, requestId, transport: 'real', now: Date.now(),
      authorizationRecord: auth,
      transportFactory: () => createAmdRadeonTransport({ baseUrl: 'https://developer.amd.com.cn/radeon/api/v1' }),
    });
  } catch (e) {
    console.log(`R${r} ${requestId}: CRASH-SIMULATED/INTERRUPTED ${e.message}`);
    summary.push({ r, requestId, state: 'INTERRUPTED', error: e.message });
    continue;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (out.refused) {
    console.log(`R${r} ${requestId}: REFUSED at ${out.stage} (${JSON.stringify(out.reasons || out.reason || out.problems || out.code).slice(0, 220)}) [${elapsed}s]`);
    summary.push({ r, requestId, state: `REFUSED_${out.stage}`, detail: out.reasons || out.reason || out.code || out.problems });
    if (out.stage === 'authorization' || out.stage === 'budget') break; // caps/window exhausted → stop the round
    continue;
  }
  const adopted = (out.candidates || []).filter((c) => c.eligibleForValidSet && c.ok).length;
  console.log(`R${r} ${requestId}: ${out.result} — candidates=${(out.candidates || []).length} adopted=${adopted} usage=${JSON.stringify(out.usage && { in: out.usage.inputTokens, out: out.usage.outputTokens, nominal: out.usage.nominalServerCost })} model=${out.usage && 'observed-in-draft-log'} [${elapsed}s]`);
  summary.push({ r, requestId, state: out.result, parsed: (out.candidates || []).length, adopted, elapsedS: Number(elapsed) });
}
fs.writeFileSync(path.join(workDir, 'round4-summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), summary }, null, 2) + '\n');
console.log('ROUND4 DONE — summary written.');
