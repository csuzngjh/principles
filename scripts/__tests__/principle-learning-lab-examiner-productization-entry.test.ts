import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeExaminerProductizationFixture } from './fixtures/examiner-productization-fixture.mjs';
import { runExaminerRequest, createGenerationLedger, buildConstrainedInput } from '../dev/principle-learning-lab/lib/challenge-examiner.mjs';
import { dedupeProductizationCandidates, verifyIndependentGoldReview } from '../dev/principle-learning-lab/lib/challenge-validator.mjs';
import { SimulatedCrashError } from '../dev/principle-learning-lab/lib/challenge-actor.mjs';

const workdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'exm-v05-entry-'));
const sourceCheck = async (change) => {
  const fixture = makeExaminerProductizationFixture();
  change(fixture);
  const dir = workdir();
  const result = await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'r1' });
  expect(result.refused).toBe(true);
  expect(result.transportCalls).toBe(0);
  expect(fs.readdirSync(dir)).toEqual([]);
};

describe('v0.5 source and review admission through the request entry', () => {
  it.each([
    ['Pain source absent', (f) => { f.sourceBundle.sourceArtifacts = f.sourceBundle.sourceArtifacts.filter((a) => a.ref !== 'fixture:pain'); }],
    ['Principle source absent', (f) => { f.sourceBundle.sourceArtifacts = f.sourceBundle.sourceArtifacts.filter((a) => a.ref !== 'principle'); }],
    ['wrong actual source hash', (f) => { f.sourceBundle.sourceArtifacts[0].content.text = 'tampered'; }],
    ['mapping hash mismatch', (f) => { f.spec.mappingHash = 'f'.repeat(64); }],
    ['Scribe artifact absent', (f) => { f.sourceBundle.sourceArtifacts = f.sourceBundle.sourceArtifacts.filter((a) => a.ref !== 'fixture:scribe'); }],
    ['mapping review absent', (f) => { f.sourceBundle.mappingReview = null; }],
    ['Gold review absent', (f) => { f.goldReviews = []; }],
    ['input manifest absent', (f) => { f.sourceBundle.sourceArtifacts = f.sourceBundle.sourceArtifacts.filter((a) => a.ref !== 'input-manifest'); }],
    ['library hash drift', (f) => { f.spec.libraryHash = 'f'.repeat(64); }],
  ])('refuses %s before reserving or generating', async (_name, change) => sourceCheck(change));

  it('a fixture receipt cannot become formal approval by changing a role string', async () => {
    await sourceCheck((f) => {
      f.spec.pipelineMode = 'formal';
      f.sourceBundle.mappingReview.reviewerRole = 'INDEPENDENT_REVIEWER';
      f.goldReviews.forEach((r) => { r.reviewerRole = 'INDEPENDENT_REVIEWER'; });
    });
  });

  it('cannot construct a real transport even with caller-supplied approval', async () => {
    const fixture = makeExaminerProductizationFixture();
    let constructed = 0;
    const result = await runExaminerRequest({ ...fixture, workDir: workdir(), requestId: 'real', transport: 'real', authorizationRecord: { status: 'APPROVED' }, transportFactory: () => { constructed += 1; throw new Error('must never construct'); } });
    expect(result.stage).toBe('offline_only');
    expect(constructed).toBe(0);
  });

  it('retains raw model input and rejects no evidence as independent Gold', () => {
    const fixture = makeExaminerProductizationFixture();
    const result = verifyIndependentGoldReview({ caseDef: fixture.registeredCandidates[0].caseDef, review: fixture.goldReviews[0], sourceArtifacts: [], mode: 'calibration' });
    expect(result.ok).toBe(false);
    expect(result.eligibleForFormalSet).toBe(false);
  });
});

describe('v0.5 raw expression contract', () => {
  it.each([
    ['self-authored Gold', (r) => { r.gold = { truth: true }; }],
    ['arbitrary command', (r) => { r.command = 'write-production'; }],
    ['path escape', (r) => { r.path = '../../production'; }],
    ['unknown action', (r) => { r.action = 'deploy'; }],
    ['unknown template', (r) => { r.templateVersion = '99'; }],
    ['unknown baseline', (r) => { r.baselineCandidateId = 'missing'; }],
    ['wrong object', (r) => { r.expression.facts[0].factId = 'F-OTHER'; }],
    ['unknown expression field', (r) => { r.expression.script = 'run'; }],
    ['unknown observation', (r) => { r.expression.observations[0].obsId = 'OBS-OTHER'; }],
    ['hidden output edit', (r) => { r.expression.observations[0].output = 'invented'; }],
    ['unregistered decision constraint', (r) => { r.parameters.budgetUnits = 5; }],
    ['unsafe candidate ID', (r) => { r.candidateId = '../../x'; }],
  ])('preserves and rejects %s instead of silently stripping it', async (_name, change) => {
    const fixture = makeExaminerProductizationFixture();
    change(fixture.rawCandidates[0]);
    const before = structuredClone(fixture.rawCandidates[0]);
    const dir = workdir();
    const result = await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'bad' });
    expect(result.candidates[0].ok).toBe(false);
    expect(result.candidates[0].problems.length).toBeGreaterThan(0);
    expect(fixture.rawCandidates[0]).toEqual(before);
    const log = createGenerationLedger(dir).draftEntries();
    expect(log.find((e) => e.type === 'RAW_RESPONSE').rawResponse.candidates[0]).toEqual(before);
    expect(log.find((e) => e.rawDraftEnvelope).rawDraftEnvelope).toEqual(before);
  });

  it('does not expose hidden Gold or observation outputs in generation input', () => {
    const fixture = makeExaminerProductizationFixture();
    const input = JSON.stringify(buildConstrainedInput(fixture.spec, fixture));
    for (const forbidden of ['goldTruth', 'supportRules', 'contentHash', 'acceptableVerdicts', 'fixture config: interval_ms=2000']) expect(input).not.toContain(forbidden);
  });

  it('expression changes require a new external review of the final goldHash', async () => {
    const fixture = makeExaminerProductizationFixture();
    fixture.rawCandidates[0].expression.facts[0].statement = 'The fixture config interval_ms is 1.';
    const result = await runExaminerRequest({ ...fixture, workDir: workdir(), requestId: 'changed' });
    expect(result.candidates[0].ok).toBe(false);
    expect(result.candidates[0].tier).toBe('GOLD_REVIEW_PENDING');
  });
});

describe('v0.5 shared ledger lifecycle and honest candidate denominators', () => {
  it('executes Mock through existing admission and tags every result as calibration only', async () => {
    const fixture = makeExaminerProductizationFixture();
    const result = await runExaminerRequest({ ...fixture, workDir: workdir(), requestId: 'ok' });
    expect(result.result).toBe('SUCCEEDED');
    expect(result.candidates[0]).toMatchObject({ ok: true, eligibleForFormalSet: false, tier: 'CALIBRATION_ONLY' });
    expect(result.usage.simulatedUsage).toBe(true);
  });

  it('reserves all candidate slots including rejected responses, before transport, without returning them', async () => {
    const fixture = makeExaminerProductizationFixture();
    fixture.spec.candidateCap = 1;
    fixture.rawCandidates[0].gold = {};
    const dir = workdir();
    await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'r1' });
    const next = await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'r2' });
    expect(next).toMatchObject({ refused: true, code: 'candidate_cap_exhausted', transportCalls: 0 });
    expect(createGenerationLedger(dir).entries().filter((e) => e.type === 'REQUEST_RESERVE')).toHaveLength(1);
  });

  it('keeps an oversized or malformed response available for denominator recomputation', async () => {
    const fixture = makeExaminerProductizationFixture();
    for (const candidates of [[...fixture.rawCandidates, ...fixture.rawCandidates], 'not-an-array']) {
      const dir = workdir();
      const response = { ok: true, candidates };
      const result = await runExaminerRequest({ ...fixture, response, workDir: dir, requestId: 'bad-shape' });
      expect(result.result).toBe('FAILED_KNOWN');
      expect(createGenerationLedger(dir).draftEntries()[0].rawResponse).toEqual(response);
    }
  });

  it('RESULT_UNKNOWN cannot auto-retry or recover its reserved candidate slots', async () => {
    const fixture = makeExaminerProductizationFixture();
    fixture.spec.candidateCap = 1;
    const dir = workdir();
    await expect(runExaminerRequest({ ...fixture, response: { crash: true }, workDir: dir, requestId: 'crashed' })).rejects.toBeInstanceOf(SimulatedCrashError);
    expect(await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'crashed' })).toMatchObject({ refused: true, stage: 'recovery', transportCalls: 0 });
    expect(await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'new' })).toMatchObject({ refused: true, code: 'candidate_cap_exhausted' });
  });

  it('budget/source bindings cannot be widened through a reused ledger', async () => {
    const fixture = makeExaminerProductizationFixture();
    const dir = workdir();
    await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'r1' });
    fixture.spec.candidateCap += 1;
    expect(await runExaminerRequest({ ...fixture, workDir: dir, requestId: 'r2' })).toMatchObject({ refused: true, stage: 'binding', transportCalls: 0 });
  });

  it('wording-only edits are duplicates while unresolved decision semantics remain pending', () => {
    const fixture = makeExaminerProductizationFixture();
    const original = fixture.registeredCandidates[0];
    const renamed = structuredClone(original);
    renamed.candidateId = 'RENAMED';
    renamed.caseDef.caseId = 'RENAMED';
    renamed.caseDef.taskText = 'Reworded task';
    const changedDecision = structuredClone(original);
    changedDecision.candidateId = 'OTHER';
    changedDecision.caseDef.constraints.budgetUnits += 1;
    const result = dedupeProductizationCandidates([original, renamed, changedDecision]);
    expect(result.structuralDuplicatePairs).toContainEqual([0, 1]);
    // v2's only mutation axis is expression, so there is no third tier: a
    // skeleton list would just restate structural.
    expect(result).not.toHaveProperty('skeletonDuplicatePairs');
    expect(result.unresolvedSemantic).toContainEqual({ candidateIds: [original.candidateId, 'OTHER'], reason: 'semantic equivalence requires independent review', status: 'PENDING' });
  });
});
