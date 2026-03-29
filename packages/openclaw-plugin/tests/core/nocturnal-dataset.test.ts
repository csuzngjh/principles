import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateSampleFingerprint,
  generateFingerprintFromArtifact,
  registerSample,
  getDatasetRecord,
  getDatasetRecordByArtifactId,
  listDatasetRecords,
  updateReviewStatus,
  updateTargetModelFamily,
  isExportReady,
  listExportReadyRecords,
  getArtifactPath,
  readDatasetArtifact,
  getDatasetStats,
  migrateSampleArtifacts,
  type NocturnalDatasetRecord,
  type NocturnalReviewStatus,
} from '../../src/core/nocturnal-dataset.js';
import type { NocturnalArtifact } from '../../src/core/nocturnal-arbiter.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeArtifact(overrides: Partial<NocturnalArtifact> = {}): NocturnalArtifact {
  return {
    artifactId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    sessionId: 'session-abc123',
    principleId: 'T-08',
    sourceSnapshotRef: 'snapshot-2026-03-27-001',
    badDecision: 'After bash command failed, immediately retried without diagnosing',
    betterDecision: 'Check the error message before retrying',
    rationale: 'Diagnosing failures prevents repeated failures',
    createdAt: '2026-03-27T12:00:00.000Z',
    ...overrides,
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-dataset-test-'));
}

function rmdir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Tests: generateSampleFingerprint
// ---------------------------------------------------------------------------

describe('NocturnalDataset generateSampleFingerprint', () => {
  it('produces deterministic fingerprint', () => {
    const fp1 = generateSampleFingerprint('art-1', 'T-01', 'sess-1');
    const fp2 = generateSampleFingerprint('art-1', 'T-01', 'sess-1');
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprints for different inputs', () => {
    const fp1 = generateSampleFingerprint('art-1', 'T-01', 'sess-1');
    const fp2 = generateSampleFingerprint('art-2', 'T-01', 'sess-1');
    const fp3 = generateSampleFingerprint('art-1', 'T-02', 'sess-1');
    const fp4 = generateSampleFingerprint('art-1', 'T-01', 'sess-2');
    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp1).not.toBe(fp4);
  });

  it('produces 64-char hex string (SHA-256)', () => {
    const fp = generateSampleFingerprint('art-1', 'T-01', 'sess-1');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Tests: generateFingerprintFromArtifact
// ---------------------------------------------------------------------------

describe('NocturnalDataset generateFingerprintFromArtifact', () => {
  it('produces same fingerprint as separate args', () => {
    const artifact = makeArtifact();
    const fp1 = generateFingerprintFromArtifact(artifact);
    const fp2 = generateSampleFingerprint(
      artifact.artifactId,
      artifact.principleId,
      artifact.sessionId
    );
    expect(fp1).toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Tests: registerSample
// ---------------------------------------------------------------------------

describe('NocturnalDataset registerSample', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('registers a new sample and returns isNew=true', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);

    // Create artifact file
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');

    const result = registerSample(tmpDir, artifact, artifactPath, 'gpt-4');

    expect(result.isNew).toBe(true);
    expect(result.record.sampleFingerprint).toBe(
      generateFingerprintFromArtifact(artifact)
    );
    expect(result.record.artifactId).toBe(artifact.artifactId);
    expect(result.record.sessionId).toBe(artifact.sessionId);
    expect(result.record.principleId).toBe(artifact.principleId);
    expect(result.record.reviewStatus).toBe('pending_review');
    expect(result.record.targetModelFamily).toBe('gpt-4');
    expect(result.record.artifactPath).toBe(artifactPath);
  });

  it('registers sample with null targetModelFamily', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');

    const result = registerSample(tmpDir, artifact, artifactPath, null);

    expect(result.isNew).toBe(true);
    expect(result.record.targetModelFamily).toBeNull();
  });

  it('returns isNew=false for duplicate registration', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');

    const result1 = registerSample(tmpDir, artifact, artifactPath, 'gpt-4');
    const result2 = registerSample(tmpDir, artifact, artifactPath, 'gpt-4');

    expect(result1.isNew).toBe(true);
    expect(result2.isNew).toBe(false);
    expect(result2.existingRecord?.sampleFingerprint).toBe(result1.record.sampleFingerprint);
  });

  it('persists record to registry file', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');

    registerSample(tmpDir, artifact, artifactPath, 'gpt-4');

    // Read registry directly
    const records = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.state', 'nocturnal', 'dataset-registry.json'), 'utf-8')
    );
    expect(records).toHaveLength(1);
    expect(records[0].artifactId).toBe(artifact.artifactId);
  });

  it('creates createdAt and updatedAt timestamps', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');

    const before = new Date().toISOString();
    const result = registerSample(tmpDir, artifact, artifactPath);
    const after = new Date().toISOString();

    expect(result.record.createdAt).toBeDefined();
    expect(result.record.updatedAt).toBeDefined();
    expect(result.record.createdAt >= before).toBe(true);
    expect(result.record.createdAt <= after).toBe(true);
    expect(result.record.createdAt).toBe(result.record.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// Tests: getDatasetRecord / getDatasetRecordByArtifactId
// ---------------------------------------------------------------------------

describe('NocturnalDataset getDatasetRecord', () => {
  let tmpDir: string;
  let artifact: NocturnalArtifact;
  let artifactPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    artifact = makeArtifact();
    artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('returns null for non-existent fingerprint', () => {
    const result = getDatasetRecord(tmpDir, 'nonexistent-fingerprint');
    expect(result).toBeNull();
  });

  it('returns record for existing fingerprint', () => {
    const registered = registerSample(tmpDir, artifact, artifactPath, 'gpt-4');
    const result = getDatasetRecord(tmpDir, registered.record.sampleFingerprint);
    expect(result).not.toBeNull();
    expect(result!.artifactId).toBe(artifact.artifactId);
  });

  it('returns null for corrupted registry', () => {
    const registryPath = path.join(tmpDir, '.state', 'nocturnal', 'dataset-registry.json');
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, 'not valid json', 'utf-8');

    const result = getDatasetRecord(tmpDir, 'any');
    expect(result).toBeNull();
  });
});

describe('NocturnalDataset getDatasetRecordByArtifactId', () => {
  let tmpDir: string;
  let artifact: NocturnalArtifact;
  let artifactPath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    artifact = makeArtifact();
    artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('returns null for non-existent artifactId', () => {
    const result = getDatasetRecordByArtifactId(tmpDir, 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns record for existing artifactId', () => {
    registerSample(tmpDir, artifact, artifactPath, 'gpt-4');
    const result = getDatasetRecordByArtifactId(tmpDir, artifact.artifactId);
    expect(result).not.toBeNull();
    expect(result!.artifactId).toBe(artifact.artifactId);
  });
});

// ---------------------------------------------------------------------------
// Tests: listDatasetRecords + filtering
// ---------------------------------------------------------------------------

describe('NocturnalDataset listDatasetRecords', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  function registerSampleWithStatus(
    artifactId: string,
    status: NocturnalReviewStatus,
    family: string | null = 'gpt-4'
  ): NocturnalDatasetRecord {
    const artifact = makeArtifact({ artifactId });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const result = registerSample(tmpDir, artifact, artifactPath, family);
    if (result.record.reviewStatus !== status) {
      updateReviewStatus(tmpDir, result.record.sampleFingerprint, status, 'test reason');
    }
    return getDatasetRecord(tmpDir, result.record.sampleFingerprint)!;
  }

  it('returns all records sorted by createdAt descending', () => {
    const r1 = registerSampleWithStatus('art-1', 'pending_review');
    const r2 = registerSampleWithStatus('art-2', 'approved_for_training');
    const r3 = registerSampleWithStatus('art-3', 'rejected');

    const records = listDatasetRecords(tmpDir);
    expect(records).toHaveLength(3);
    // Newest first
    expect(records[0].artifactId).toBe('art-3');
    expect(records[1].artifactId).toBe('art-2');
    expect(records[2].artifactId).toBe('art-1');
  });

  it('filters by reviewStatus (single)', () => {
    registerSampleWithStatus('art-1', 'pending_review');
    registerSampleWithStatus('art-2', 'approved_for_training');
    registerSampleWithStatus('art-3', 'approved_for_training');

    const approved = listDatasetRecords(tmpDir, { reviewStatus: 'approved_for_training' });
    expect(approved).toHaveLength(2);
    expect(approved.every((r) => r.reviewStatus === 'approved_for_training')).toBe(true);
  });

  it('filters by reviewStatus (array)', () => {
    registerSampleWithStatus('art-1', 'pending_review');
    registerSampleWithStatus('art-2', 'approved_for_training');
    registerSampleWithStatus('art-3', 'rejected');

    const filtered = listDatasetRecords(tmpDir, {
      reviewStatus: ['pending_review', 'rejected'],
    });
    expect(filtered).toHaveLength(2);
    expect(filtered.every((r) =>
      r.reviewStatus === 'pending_review' || r.reviewStatus === 'rejected'
    )).toBe(true);
  });

  it('filters by targetModelFamily (specific family)', () => {
    registerSampleWithStatus('art-1', 'approved_for_training', 'gpt-4');
    registerSampleWithStatus('art-2', 'approved_for_training', 'gpt-4');
    registerSampleWithStatus('art-3', 'approved_for_training', 'claude-3');

    const gpt4 = listDatasetRecords(tmpDir, { targetModelFamily: 'gpt-4' });
    expect(gpt4).toHaveLength(2);
    expect(gpt4.every((r) => r.targetModelFamily === 'gpt-4')).toBe(true);
  });

  it('filters by targetModelFamily (null = unassigned)', () => {
    registerSampleWithStatus('art-1', 'pending_review', null);
    registerSampleWithStatus('art-2', 'pending_review', 'gpt-4');

    const unassigned = listDatasetRecords(tmpDir, { targetModelFamily: null });
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0].targetModelFamily).toBeNull();
  });

  it('returns empty array when no records exist', () => {
    const records = listDatasetRecords(tmpDir);
    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: updateReviewStatus
// ---------------------------------------------------------------------------

describe('NocturnalDataset updateReviewStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  function registerAndGet(
    artifactId: string,
    family: string | null = 'gpt-4'
  ): NocturnalDatasetRecord {
    const artifact = makeArtifact({ artifactId });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    return registerSample(tmpDir, artifact, artifactPath, family).record;
  }

  it('updates reviewStatus and reviewReason', () => {
    const record = registerAndGet('art-1');
    const updated = updateReviewStatus(
      tmpDir,
      record.sampleFingerprint,
      'approved_for_training',
      'Looks good for training'
    );

    expect(updated.reviewStatus).toBe('approved_for_training');
    expect(updated.reviewReason).toBe('Looks good for training');
    expect(updated.updatedAt).not.toBe(record.createdAt);
  });

  it('updates updatedAt timestamp', () => {
    const record = registerAndGet('art-1');
    const before = new Date().toISOString();
    const updated = updateReviewStatus(
      tmpDir,
      record.sampleFingerprint,
      'rejected',
      'Not suitable'
    );

    expect(updated.updatedAt >= before).toBe(true);
  });

  it('throws for invalid transition (pending_review → approved_for_training without reason)', () => {
    const record = registerAndGet('art-1');
    expect(() =>
      updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training')
    ).toThrow('reviewReason is required');
  });

  it('throws for invalid transition (approved_for_training → rejected)', () => {
    const record = registerAndGet('art-1');
    // First go to approved
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training', 'approved');
    // Then try to reject (invalid)
    expect(() =>
      updateReviewStatus(tmpDir, record.sampleFingerprint, 'rejected', 'changed mind')
    ).toThrow(/Invalid review status transition/);
  });

  it('throws for non-existent fingerprint', () => {
    expect(() =>
      updateReviewStatus(tmpDir, 'nonexistent', 'approved_for_training', 'reason')
    ).toThrow('Dataset record not found');
  });

  it('allows superseded from approved_for_training', () => {
    const record = registerAndGet('art-1');
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training', 'looks good');
    const updated = updateReviewStatus(
      tmpDir,
      record.sampleFingerprint,
      'superseded',
      'Superseded by better sample'
    );
    expect(updated.reviewStatus).toBe('superseded');
  });

  it('allows rejected → pending_review (re-review)', () => {
    const record = registerAndGet('art-1');
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'rejected', 'Not good');
    const updated = updateReviewStatus(
      tmpDir,
      record.sampleFingerprint,
      'pending_review'
    );
    expect(updated.reviewStatus).toBe('pending_review');
  });
});

// ---------------------------------------------------------------------------
// Tests: updateTargetModelFamily
// ---------------------------------------------------------------------------

describe('NocturnalDataset updateTargetModelFamily', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('updates targetModelFamily', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, null).record;

    const updated = updateTargetModelFamily(tmpDir, record.sampleFingerprint, 'claude-3');
    expect(updated.targetModelFamily).toBe('claude-3');
  });

  it('can set targetModelFamily back to null', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;

    const updated = updateTargetModelFamily(tmpDir, record.sampleFingerprint, null);
    expect(updated.targetModelFamily).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: isExportReady + listExportReadyRecords
// ---------------------------------------------------------------------------

describe('NocturnalDataset isExportReady', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  function setupExportReady(
    artifactId: string,
    family: string | null = 'gpt-4'
  ): NocturnalDatasetRecord {
    const artifact = makeArtifact({ artifactId });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, family).record;
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training', 'ready for training');
    return getDatasetRecord(tmpDir, record.sampleFingerprint)!;
  }

  it('returns true for fully configured record', () => {
    const record = setupExportReady('art-1', 'gpt-4');
    expect(isExportReady(tmpDir, record.sampleFingerprint)).toBe(true);
  });

  it('returns false for rejected record', () => {
    const artifact = makeArtifact({ artifactId: 'art-rejected' });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'rejected', 'not suitable');

    expect(isExportReady(tmpDir, record.sampleFingerprint)).toBe(false);
  });

  it('returns false for pending_review record', () => {
    const artifact = makeArtifact({ artifactId: 'art-pending' });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;

    expect(isExportReady(tmpDir, record.sampleFingerprint)).toBe(false);
  });

  it('returns false for record with null targetModelFamily', () => {
    const record = setupExportReady('art-1', null);
    expect(isExportReady(tmpDir, record.sampleFingerprint)).toBe(false);
  });

  it('returns false when artifact file is missing', () => {
    const artifact = makeArtifact({ artifactId: 'art-missing' });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training', 'ready');
    // Delete artifact file
    fs.unlinkSync(artifactPath);

    expect(isExportReady(tmpDir, record.sampleFingerprint)).toBe(false);
  });

  it('returns false for non-existent fingerprint', () => {
    expect(isExportReady(tmpDir, 'nonexistent')).toBe(false);
  });
});

describe('NocturnalDataset listExportReadyRecords', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  function setup(
    artifactId: string,
    family: string | null,
    status: NocturnalReviewStatus
  ): void {
    const artifact = makeArtifact({ artifactId });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, family).record;
    if (status !== 'pending_review') {
      updateReviewStatus(tmpDir, record.sampleFingerprint, status, 'test');
    }
  }

  it('returns only approved_for_training records with target family and artifact', () => {
    setup('art-1', 'gpt-4', 'approved_for_training');
    setup('art-2', 'gpt-4', 'pending_review');
    setup('art-3', 'claude-3', 'approved_for_training');
    setup('art-4', 'gpt-4', 'rejected');

    const gpt4 = listExportReadyRecords(tmpDir, 'gpt-4');
    expect(gpt4).toHaveLength(1);
    expect(gpt4[0].artifactId).toBe('art-1');
    expect(gpt4[0].targetModelFamily).toBe('gpt-4');
  });

  it('returns all export-ready records when no family specified', () => {
    setup('art-1', 'gpt-4', 'approved_for_training');
    setup('art-2', 'claude-3', 'approved_for_training');

    const all = listExportReadyRecords(tmpDir);
    expect(all).toHaveLength(2);
  });

  it('returns empty array when no export-ready records', () => {
    setup('art-1', 'gpt-4', 'pending_review');

    const records = listExportReadyRecords(tmpDir, 'gpt-4');
    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: getArtifactPath + readDatasetArtifact
// ---------------------------------------------------------------------------

describe('NocturnalDataset getArtifactPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('returns path when record exists and artifact file exists', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;

    const pathResult = getArtifactPath(tmpDir, record.sampleFingerprint);
    expect(pathResult).toBe(artifactPath);
  });

  it('returns null when record does not exist', () => {
    const pathResult = getArtifactPath(tmpDir, 'nonexistent');
    expect(pathResult).toBeNull();
  });

  it('returns null when artifact file is missing', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;
    fs.unlinkSync(artifactPath);

    const pathResult = getArtifactPath(tmpDir, record.sampleFingerprint);
    expect(pathResult).toBeNull();
  });
});

describe('NocturnalDataset readDatasetArtifact', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('reads and returns artifact for existing record', () => {
    const artifact = makeArtifact();
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;

    const readArtifact = readDatasetArtifact(tmpDir, record.sampleFingerprint);
    expect(readArtifact).not.toBeNull();
    expect(readArtifact!.artifactId).toBe(artifact.artifactId);
    expect(readArtifact!.sessionId).toBe(artifact.sessionId);
    expect(readArtifact!.principleId).toBe(artifact.principleId);
  });

  it('throws for non-existent record', () => {
    expect(() => readDatasetArtifact(tmpDir, 'nonexistent')).toThrow('Artifact file not found');
  });
});

// ---------------------------------------------------------------------------
// Tests: getDatasetStats
// ---------------------------------------------------------------------------

describe('NocturnalDataset getDatasetStats', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  function setup(
    artifactId: string,
    status: NocturnalReviewStatus,
    family: string | null = 'gpt-4'
  ): void {
    const artifact = makeArtifact({ artifactId });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, family).record;
    if (status !== 'pending_review') {
      updateReviewStatus(tmpDir, record.sampleFingerprint, status, 'test');
    }
  }

  it('returns correct counts', () => {
    setup('art-1', 'pending_review');
    setup('art-2', 'approved_for_training');
    setup('art-3', 'approved_for_training');
    setup('art-4', 'rejected');
    setup('art-5', 'superseded');

    const stats = getDatasetStats(tmpDir);
    expect(stats.total).toBe(5);
    expect(stats.pendingReview).toBe(1);
    expect(stats.approvedForTraining).toBe(2);
    expect(stats.rejected).toBe(1);
    expect(stats.superseded).toBe(1);
  });

  it('counts export-ready by family', () => {
    setup('art-1', 'approved_for_training', 'gpt-4');
    setup('art-2', 'approved_for_training', 'gpt-4');
    setup('art-3', 'approved_for_training', 'claude-3');
    setup('art-4', 'pending_review', 'gpt-4');

    const stats = getDatasetStats(tmpDir);
    expect(stats.exportReadyByFamily['gpt-4']).toBe(2);
    expect(stats.exportReadyByFamily['claude-3']).toBe(1);
  });

  it('returns zero counts when empty', () => {
    const stats = getDatasetStats(tmpDir);
    expect(stats.total).toBe(0);
    expect(stats.pendingReview).toBe(0);
    expect(stats.approvedForTraining).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: migrateSampleArtifacts
// ---------------------------------------------------------------------------

describe('NocturnalDataset migrateSampleArtifacts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('registers approved samples not yet in registry', () => {
    // Create artifact files directly in samples directory
    const samplesDir = path.join(tmpDir, '.state', 'nocturnal', 'samples');
    fs.mkdirSync(samplesDir, { recursive: true });

    const artifact1 = { ...makeArtifact({ artifactId: 'art-migrate-1' }), status: 'approved' };
    const artifact2 = { ...makeArtifact({ artifactId: 'art-migrate-2' }), status: 'approved' };
    const artifact3 = { ...makeArtifact({ artifactId: 'art-migrate-3' }), status: 'rejected' }; // wrong status

    fs.writeFileSync(
      path.join(samplesDir, 'art-migrate-1.json'),
      JSON.stringify(artifact1)
    );
    fs.writeFileSync(
      path.join(samplesDir, 'art-migrate-2.json'),
      JSON.stringify(artifact2)
    );
    fs.writeFileSync(
      path.join(samplesDir, 'art-rejected.json'),
      JSON.stringify(artifact3)
    );

    const count = migrateSampleArtifacts(tmpDir, 'gpt-4');

    expect(count).toBe(2);
    const records = listDatasetRecords(tmpDir);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.artifactId).sort()).toEqual(['art-migrate-1', 'art-migrate-2']);
  });

  it('does not duplicate already registered samples', () => {
    const samplesDir = path.join(tmpDir, '.state', 'nocturnal', 'samples');
    fs.mkdirSync(samplesDir, { recursive: true });

    const artifact = { ...makeArtifact({ artifactId: 'art-dup' }), status: 'approved' };
    fs.writeFileSync(
      path.join(samplesDir, 'art-dup.json'),
      JSON.stringify(artifact)
    );

    // First migration
    const count1 = migrateSampleArtifacts(tmpDir, 'gpt-4');
    expect(count1).toBe(1);

    // Second migration (should be no-op)
    const count2 = migrateSampleArtifacts(tmpDir, 'gpt-4');
    expect(count2).toBe(0);

    // Still only one record
    const records = listDatasetRecords(tmpDir);
    expect(records).toHaveLength(1);
  });

  it('skips malformed sample files', () => {
    const samplesDir = path.join(tmpDir, '.state', 'nocturnal', 'samples');
    fs.mkdirSync(samplesDir, { recursive: true });

    fs.writeFileSync(path.join(samplesDir, 'bad.json'), 'not valid json');
    fs.writeFileSync(path.join(samplesDir, 'missing-fields.json'), JSON.stringify({ artifactId: 'art-x' }));

    const count = migrateSampleArtifacts(tmpDir, 'gpt-4');
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: full lineage tracing
// ---------------------------------------------------------------------------

describe('NocturnalDataset lineage tracing integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('traces sample back to artifact + session + principle', () => {
    const artifact = makeArtifact({
      artifactId: 'art-lineage-001',
      sessionId: 'session-lineage-001',
      principleId: 'T-08',
    });
    const artifactPath = path.join(tmpDir, 'samples', `${artifact.artifactId}.json`);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');

    // Register
    const registered = registerSample(tmpDir, artifact, artifactPath, 'gpt-4');

    // Trace back
    const byFingerprint = getDatasetRecord(tmpDir, registered.record.sampleFingerprint);
    const byArtifactId = getDatasetRecordByArtifactId(tmpDir, artifact.artifactId);
    const pathResult = getArtifactPath(tmpDir, registered.record.sampleFingerprint);
    const readArtifact = readDatasetArtifact(tmpDir, registered.record.sampleFingerprint);

    expect(byFingerprint).not.toBeNull();
    expect(byArtifactId).not.toBeNull();
    expect(pathResult).toBe(artifactPath);
    expect(readArtifact).not.toBeNull();
    expect(readArtifact!.sessionId).toBe('session-lineage-001');
    expect(readArtifact!.principleId).toBe('T-08');
  });
});
