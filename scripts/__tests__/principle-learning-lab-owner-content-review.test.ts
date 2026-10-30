import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileCase } from '../dev/principle-learning-lab/lib/challenge-compile.mjs';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab/challenge-studies/EXM-MVP-001-v4');
const ledgerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/research/examiner-productization-20261029/owner-content-review');

const readJson = (file, base = packageDir) => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8'));

describe('EXM-MVP-001-v4 Owner content review ledger', () => {
  const ledger = readJson('records.v1.json', ledgerDir);
  const inputs = readJson('inputs.json');
  const goldReview = readJson('gold-review.json');
  const receipts = readJson('blind-review/receipts.template.json');
  const sums = readJson('SHA256SUMS.json', ledgerDir);

  it('is a structurally complete append-only ledger of ten OWNER records', () => {
    expect(ledger.schema).toBe('examiner-owner-content-review-ledger.v1');
    expect(ledger.studyId).toBe('EXM-MVP-001-v4');
    expect(ledger.records).toHaveLength(10);
    expect(ledger.records[0].subjectKind).toBe('MAPPING');
    const caseRecords = ledger.records.slice(1);
    expect(caseRecords.map((record) => record.subjectId)).toEqual(inputs.samples.map((sample) => sample.caseDef.caseId));
    const reviewIds = ledger.records.map((record) => record.reviewId);
    expect(new Set(reviewIds).size).toBe(10);
    for (const record of ledger.records) {
      expect(record.reviewerRole).toBe('OWNER');
      expect(record.decision).toBe('APPROVED');
      expect(record.ownerComment.length).toBeGreaterThan(0);
      expect(record.reviewedAt).toBe('2026-10-30');
      expect(record.packageVersion).toBe('v4');
      expect(record.schemaVersion).toBe('examiner-owner-content-review.v1');
      expect(record.sourceReference.length).toBeGreaterThan(0);
      expect(Object.hasOwn(record, 'signature')).toBe(false);
    }
  });

  it('never masquerades as an independent human review receipt', () => {
    expect(ledger.explicitlyNot).toContain('不是独立人工审核');
    for (const record of ledger.records) {
      expect(record.reviewerRole).not.toBe('INDEPENDENT_REVIEWER');
      expect(Object.hasOwn(record, 'signature')).toBe(false);
    }
    expect(readJson('review-subject.json').status).toBe('PENDING');
  });

  it('binds every mapping and case record to the current package content hashes', () => {
    const mappingRecord = ledger.records[0];
    expect(mappingRecord.mappingHash).toBe(receipts.mappingReview.mappingHash);
    expect(mappingRecord.goldHash).toBeNull();
    for (const record of ledger.records.slice(1)) {
      expect(record.goldHash).toBe(receipts.goldReviews.find((row) => row.caseId === record.subjectId).goldHash);
      expect(record.goldHash).toBe(goldReview.reviews.find((row) => row.caseId === record.subjectId).goldHash);
      const sample = inputs.samples.find((entry) => entry.caseDef.caseId === record.subjectId);
      expect(record.goldHash).toBe(compileCase(sample.caseDef).goldHash);
      expect(record.mappingHash).toBeNull();
    }
  });

  it('records the binding context provenance consistently', () => {
    const context = ledger.bindingContext;
    expect(context.packageHash).toBe(readJson('package-manifest.json').packageHash);
    expect(context.subjectHash).toBe(readJson('review-subject.json').subjectHash);
    expect(context.mappingHash).toBe(receipts.mappingReview.mappingHash);
    expect(context.bindingNote).toContain('内容绑定');
    for (const record of ledger.records) expect(record.subjectHash).toBe(context.subjectHash);
  });

  it('carries an independent integrity hash for the ledger bytes', () => {
    const entry = sums.find((row) => row.path === 'records.v1.json');
    expect(entry).toBeDefined();
    const bytes = fs.readFileSync(path.join(ledgerDir, 'records.v1.json'));
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    for (const row of sums) expect(fs.existsSync(path.join(ledgerDir, row.path))).toBe(true);
  });
});
