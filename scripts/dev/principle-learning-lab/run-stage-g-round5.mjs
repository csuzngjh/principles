#!/usr/bin/env node
// round8: continuation re-run (continuation-round8.json)
// round8: continuation re-run (continuation-round8.json)
// Stage G round-5: E-arm formal generation on deepseek-v4.1-flash-1017
// (intern-ai discovery platform, points-metered). Same plan/discipline as
// prior rounds: serial 16 requests, ledger bookkeeping, no auto-retry of
// RESULT_UNKNOWN, halt on cap/window. Pre-registered rate-limit handling:
// on 429 → FAILED_KNOWN + deterministic 90s wait before the next request
// (still counted against the 16-request cap).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runExaminerRequest } from './lib/challenge-examiner.mjs';
import { createAmdRadeonTransport, resolveInternS2ApiKey, INTERN_S2_BASE_URL } from './lib/challenge-amd-transport.mjs';

const labRoot = path.dirname(fileURLToPath(import.meta.url));
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');
const workDir = path.join(studyDir, 'stage-g-execution', 'round9');
fs.mkdirSync(workDir, { recursive: true });

const MODEL_ID = 'deepseek-v4.1-flash-1017';
const auth = JSON.parse(fs.readFileSync(path.join(studyDir, 'generation-authorization.json'), 'utf8'));
if (auth.requestedModelIdentity !== `intern-ai-discovery/${MODEL_ID}`) {
  console.error('round5: live authorization does not bind deepseek-v4.1-flash-1017 — refusing (no model mixing).');
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
  pricePerMillion: { input: null, output: null }, // points-metered — request-count reservation is the hard cap
  dataTransferPermit: auth.dataTransferPermit,
  desensitizationStatus: auth.desensitizationStatus,
  requestedModelIdentity: auth.requestedModelIdentity,
};
const sliceFor = (r) => (r <= 6 ? (r - 1) * 6 : ((r - 7) * 6) % 36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const summary = [];
let rateLimitedStreak = 0;
for (let r = 1; r <= 16; r++) {
  if (rateLimitedStreak >= 6) {
    console.log(`R${r}: pre-registered stop — 6 consecutive rate-limited requests (channel saturated); preserving remaining budget.`);
    summary.push({ r, state: 'STOPPED_RATE_LIMIT_SATURATED' });
    break;
  }
  const spec = { ...baseSpec, combinationSlice: { offset: sliceFor(r), limit: 6 } };
  const requestId = `stage-g-r9-req-${String(r).padStart(2, '0')}`;
  const t0 = Date.now();
  let out;
  try {
    out = await runExaminerRequest({
      spec, workDir, requestId, transport: 'real', now: Date.now(),
      authorizationRecord: auth,
      transportFactory: () => createAmdRadeonTransport({
        baseUrl: INTERN_S2_BASE_URL,
        modelId: MODEL_ID,
        apiKeyProvider: resolveInternS2ApiKey,
        reasoningEffort: null, // unverified parameter — never sent
        treatReasoningContentAsOutput: false, // deepseek returns standard content layout
      }),
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
  const rateLimited = out.result === 'FAILED_KNOWN' && /rate_limit/.test(out.error || '');
  console.log(`R${r} ${requestId}: ${out.result} — candidates=${(out.candidates || []).length} adopted=${adopted} usage=${JSON.stringify(out.usage && { in: out.usage.inputTokens, out: out.usage.outputTokens, nominal: out.usage.nominalServerCost })} [${elapsed}s]${rateLimited ? ' ⚠429' : ''}${out.error ? ' err=' + String(out.error).slice(0, 120) : ''}`);
  summary.push({ r, requestId, state: out.result, parsed: (out.candidates || []).length, adopted, elapsedS: Number(elapsed), rateLimited });
  if (rateLimited) {
    rateLimitedStreak += 1;
    await sleep(90_000); // pre-registered deterministic spacing on rate-limit
  } else {
    rateLimitedStreak = 0;
  }
}
fs.writeFileSync(path.join(workDir, 'round9-summary.json'), JSON.stringify({ finishedAt: new Date().toISOString(), summary }, null, 2) + '\n');
console.log('ROUND9 DONE — summary written.');
