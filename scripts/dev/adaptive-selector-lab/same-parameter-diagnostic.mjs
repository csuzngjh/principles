// One additional request explicitly approved by Owner; never resumes the pilot.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ROOT, MODELS, URLS, loadFixture, buildInputs, hash,
  createBoundary, validateDecision, localFailureCode } from './diagnostic.mjs';

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute-approved-one-diagnostic') throw new Error('APPROVAL_FLAG_REQUIRED');
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('MISSING_CREDENTIAL_REFERENCE');
  const previousPath = path.join(ROOT, 'docs/implementation-reports/aa-selector-experiments/2026-11-05T16-09-17-735Z/results.json');
  const previousBytes = fs.readFileSync(previousPath);
  const previous = JSON.parse(previousBytes.toString('utf8'));
  if (previous.status !== 'STOPPED' || previous.counts.decision !== 1 || previous.counts.glm !== 0) throw new Error('UNEXPECTED_PREVIOUS_RUN');
  const fixture = loadFixture();
  const input = buildInputs(fixture.cases[0], fixture);
  const body = JSON.stringify({ model: MODELS.decision, state: [JSON.stringify(input.state)],
    questions: fixture.questions, provider: { only: ['Respan'], allow_fallbacks: false } });
  if (hash(body) !== previous.requests[0].inputHash) throw new Error('REQUEST_CHANGED');
  const parent = path.dirname(path.dirname(previousPath));
  const out = path.join(parent, new Date().toISOString().replace(/[:.]/g, '-') + '-one-diagnostic');
  // Separate immutable claim; do not erase or repurpose the original run claim.
  fs.writeFileSync(path.join(parent, 'APPROVAL-20261106-ONE-DIAGNOSTIC-CLAIM.json'), JSON.stringify({
    approval: 'Owner: 批准一次同参数诊断', out, maxAdditionalDecisionAttempts: 1, glmAllowed: false,
    inputHash: hash(body), claimedAt: new Date().toISOString(),
  }), { flag: 'wx', flush: true });
  fs.mkdirSync(out);
  const ledger = { schemaVersion: 'pd-aa-selector-one-diagnostic/v1', status: 'RUNNING',
    startedAt: new Date().toISOString(), approval: 'Owner: 批准一次同参数诊断',
    previousEvidence: previousPath, previousEvidenceHash: hash(previousBytes),
    codeHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    runnerHash: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    inheritedCounts: { decision: 1, glm: 0 }, counts: { decision: 1, glm: 0 },
    requests: [], result: null, limitation: 'One identical request only; no GLM or automatic continuation.' };
  const persist = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(ledger, null, 2) + '\n', { flush: true });
  persist();
  try {
    const send = createBoundary({ ledger, persist, keys: { decision: key }, endAt: Date.now() + 30000 })('decision', 'dev-01', 'D');
    const response = await send(URLS.decision, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    ledger.result = validateDecision(await response.json());
    ledger.status = 'DIAGNOSTIC_COMPLETED_NO_CONTINUATION';
  } catch (error) {
    ledger.status = 'STOPPED';
    ledger.stopReason = ledger.requests.at(-1)?.failure ?? localFailureCode(error);
    process.exitCode = 1;
  } finally {
    ledger.endedAt = new Date().toISOString();
    ledger.thisRunAttempts = { decision: ledger.requests.length, glm: 0 };
    ledger.previousEvidenceUnchanged = hash(fs.readFileSync(previousPath)) === ledger.previousEvidenceHash;
    persist();
    console.log(JSON.stringify({ status: ledger.status, cumulativeCounts: ledger.counts,
      providerError: ledger.requests[0]?.providerError ?? null, evidence: out }));
  }
}

main().catch(() => { console.error('ONE_DIAGNOSTIC_PRECONDITION_FAILED_NO_REQUEST_RETRY'); process.exitCode = 1; });
