// Read-only offline review intake. It never signs, authorizes experiments,
// writes governance state, creates real transports or changes frozen assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineReviewSubjectHash, hashOfCanonical, verifyExaminerSourceBundle } from './lib/challenge-freeze.mjs';
import { verifyIndependentGoldReview } from './lib/challenge-validator.mjs';
import { replayExmPackage } from './run-exm-mvp-offline.mjs';

export async function verifyExmHumanReviews({ packageDir, receipts = null, authority = null, authorityPin = null, now = new Date().toISOString() }) {
  const replay = await replayExmPackage(packageDir);
  const expected = JSON.parse(fs.readFileSync(path.join(packageDir, 'expected-replay.json'), 'utf8'));
  if (replay.reportHash !== expected.reportHash || hashOfCanonical(replay.executions) !== expected.executionsHash) throw new Error('FROZEN_REPLAY_MISMATCH');
  const subjectHash = offlineReviewSubjectHash(packageDir);
  const input = JSON.parse(fs.readFileSync(path.join(packageDir, 'inputs.json'), 'utf8'));
  const missing = { ok: false, status: 'GOLD_REVIEW_PENDING', subjectHash,
    reasonCode: 'INDEPENDENT_HUMAN_REVIEW_REQUIRED', nextAction: 'Owner designates a human reviewer; supply signed mapping/Gold receipts and the independently pinned authority file.' };
  if (!receipts || !authority || !authorityPin) return missing;
  if (!Array.isArray(receipts.goldReviews) || receipts.goldReviews.length !== input.samples.length || new Set(receipts.goldReviews.map((review) => review?.caseId)).size !== input.samples.length) return { ...missing, reasonCode: 'REVIEW_SET_INCOMPLETE' };
  const reviewTrust = { authority, trustedAuthorityHash: authorityPin, subjectHash, now };
  const bundle = { ...input.fixture.sourceBundle, mappingReview: receipts.mappingReview };
  const source = verifyExaminerSourceBundle({ bundle, mappingId: input.fixture.spec.mappingId, mappingHash: input.fixture.spec.mappingHash,
    inputManifestHash: input.fixture.spec.inputManifestHash, mode: 'formal', reviewTrust });
  const reviews = input.samples.map((sample) => {
    const review = receipts.goldReviews.find((entry) => entry?.caseId === sample.caseDef.caseId);
    const result = verifyIndependentGoldReview({ caseDef: sample.caseDef, review, sourceArtifacts: bundle.sourceArtifacts, mode: 'formal', reviewTrust });
    return { caseId: sample.caseDef.caseId, ...result };
  });
  const ok = source.ok && reviews.every((review) => review.ok);
  return { ok, status: ok ? 'OFFLINE_GOLD_REVIEW_VERIFIED' : 'GOLD_REVIEW_PENDING', subjectHash,
    authorityHash: authorityPin, receiptsHash: hashOfCanonical(receipts), source, reviews,
    experimentAuthorization: 'NOT_AUTHORIZED', realExaminerQuality: 'NOT_VERIFIED' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const flag = process.argv[i];
      if (!['--package', '--receipts', '--authority', '--authority-pin'].includes(flag) || !process.argv[i + 1] || Object.hasOwn(args, flag)) throw new Error('invalid/duplicate argument');
      args[flag] = process.argv[i + 1];
    }
    const read = (file) => file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const packageDir = args['--package'] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'challenge-studies/EXM-MVP-001-v4');
    const result = await verifyExmHumanReviews({ packageDir, receipts: read(args['--receipts']), authority: read(args['--authority']), authorityPin: args['--authority-pin'] });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, status: 'REFUSED', reasonCode: 'REVIEW_INPUT_INVALID', detail: error.message }));
    process.exitCode = 1;
  }
}
