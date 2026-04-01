import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  exportORPOSamples,
  verifyExportIntegrity,
  listExports,
  getExportManifest,
} from '../../src/core/nocturnal-export.js';
import type { NocturnalArtifact } from '../../src/core/nocturnal-arbiter.js';
import {
  registerSample,
  listDatasetRecords,
  updateReviewStatus,
  getDatasetRecord,
} from '../../src/core/nocturnal-dataset.js';
import type { NocturnalDatasetRecord } from '../../src/core/nocturnal-dataset.js';

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
    rationale: 'Diagnosing failures prevents repeated failures and respects cost of each attempt',
    createdAt: '2026-03-27T12:00:00.000Z',
    ...overrides,
  };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-export-test-'));
}

function rmdir(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Helper: Setup fully export-ready sample
// ---------------------------------------------------------------------------

function setupExportReady(
  workspaceDir: string,
  artifactId: string,
  family: string = 'gpt-4'
): NocturnalDatasetRecord {
  const artifact = makeArtifact({ artifactId });
  const artifactPath = path.join(
    workspaceDir,
    '.state',
    'nocturnal',
    'samples',
    `${artifactId}.json`
  );
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');

  const registered = registerSample(workspaceDir, artifact, artifactPath, family).record;
  updateReviewStatus(
    workspaceDir,
    registered.sampleFingerprint,
    'approved_for_training',
    'Approved for ORPO export test'
  );
  return getDatasetRecord(workspaceDir, registered.sampleFingerprint)!;
}

// ---------------------------------------------------------------------------
// Tests: exportORPOSamples — basic
// ---------------------------------------------------------------------------

describe('NocturnalExport exportORPOSamples', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('exports approved samples to JSONL', () => {
    setupExportReady(tmpDir, 'art-export-1', 'gpt-4');
    setupExportReady(tmpDir, 'art-export-2', 'gpt-4');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.sampleCount).toBe(2);
    expect(result.manifest!.targetModelFamily).toBe('gpt-4');
    expect(result.manifest!.exportId).toBeDefined();
    expect(result.manifest!.datasetFingerprint).toHaveLength(64);

    // Verify JSONL file exists
    const jsonlPath = result.manifest!.exportPath;
    expect(fs.existsSync(jsonlPath)).toBe(true);

    // Verify JSONL is parseable
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const sample = JSON.parse(line);
      expect(sample.prompt).toBeTruthy();
      expect(sample.chosen).toBeTruthy();
      expect(sample.rejected).toBeTruthy();
      expect(sample.rationale).toBeTruthy();
      expect(sample.datasetMetadata.exportId).toBe(result.manifest!.exportId);
    }
  });

  it('writes manifest alongside JSONL', () => {
    setupExportReady(tmpDir, 'art-manifest-1', 'gpt-4');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(true);
    expect(fs.existsSync(result.manifest!.manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(result.manifest!.manifestPath, 'utf-8'));
    expect(manifest.exportId).toBe(result.manifest!.exportId);
    expect(manifest.sampleCount).toBe(1);
    expect(manifest.datasetFingerprint).toBe(result.manifest!.datasetFingerprint);
  });

  it('returns empty result when no approved samples', () => {
    // Register but don't approve
    const artifact = makeArtifact({ artifactId: 'art-not-approved' });
    const artifactPath = path.join(
      tmpDir,
      '.state',
      'nocturnal',
      'samples',
      'art-not-approved.json'
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    registerSample(tmpDir, artifact, artifactPath, 'gpt-4');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(false);
    expect(result.emptyReason).toBe('no_approved_samples');
  });

  it('filters by targetModelFamily', () => {
    setupExportReady(tmpDir, 'art-gpt4', 'gpt-4');
    setupExportReady(tmpDir, 'art-claude', 'claude-3');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(true);
    expect(result.manifest!.sampleCount).toBe(1);
    expect(result.manifest!.samples[0].artifactId).toBe('art-gpt4');
  });

  it('returns empty for family mismatch', () => {
    setupExportReady(tmpDir, 'art-claude', 'claude-3');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(false);
    expect(result.emptyReason).toBe('family_mismatch');
  });

  it('exports all families when targetModelFamily is undefined', () => {
    setupExportReady(tmpDir, 'art-family-1', 'gpt-4');
    setupExportReady(tmpDir, 'art-family-2', 'claude-3');

    const result = exportORPOSamples(tmpDir);

    expect(result.success).toBe(true);
    expect(result.manifest!.sampleCount).toBe(2);
    expect(result.manifest!.targetModelFamily).toBe('all');
  });

  it('computes deterministic datasetFingerprint', () => {
    setupExportReady(tmpDir, 'art-det-1', 'gpt-4');
    setupExportReady(tmpDir, 'art-det-2', 'gpt-4');

    const result1 = exportORPOSamples(tmpDir, 'gpt-4');
    const manifest1 = result1.manifest!;

    // Export again — should get same datasetFingerprint
    const result2 = exportORPOSamples(tmpDir, 'gpt-4');
    const manifest2 = result2.manifest!;

    expect(manifest1.datasetFingerprint).toBe(manifest2.datasetFingerprint);
  });

  it('null-family samples cannot be exported — family binding is required', () => {
    // Register approved but with null family — should NOT be exported
    const artifact = makeArtifact({ artifactId: 'art-null-family' });
    const artifactPath = path.join(
      tmpDir,
      '.state',
      'nocturnal',
      'samples',
      'art-null-family.json'
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, null).record;
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training', 'no family');

    // Export with explicit null family — null-family records must be skipped
    const result = exportORPOSamples(tmpDir, null);

    // All eligible records had null family and were skipped (all_samples_missing_artifacts)
    expect(result.success).toBe(false);
    expect(result.emptyReason).toBe('all_samples_missing_artifacts');
  });

  it('rejected samples are not exported', () => {
    // Register and reject
    const artifact = makeArtifact({ artifactId: 'art-rejected' });
    const artifactPath = path.join(
      tmpDir,
      '.state',
      'nocturnal',
      'samples',
      'art-rejected.json'
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'rejected', 'Rejected for test');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(false);
    expect(result.emptyReason).toBe('no_approved_samples');
  });

  it('superseded samples are not exported', () => {
    const artifact = makeArtifact({ artifactId: 'art-superseded' });
    const artifactPath = path.join(
      tmpDir,
      '.state',
      'nocturnal',
      'samples',
      'art-superseded.json'
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ ...artifact, status: 'approved' }), 'utf-8');
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training', 'ready');
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'superseded', 'Superseded by newer sample');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(false);
    expect(result.emptyReason).toBe('no_approved_samples');
  });

  it('missing artifact file excludes sample', () => {
    // Register record but don't create artifact file
    const artifact = makeArtifact({ artifactId: 'art-missing-file' });
    const artifactPath = path.join(
      tmpDir,
      '.state',
      'nocturnal',
      'samples',
      'art-missing-file.json'
    );
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    // Don't write the file
    const record = registerSample(tmpDir, artifact, artifactPath, 'gpt-4').record;
    updateReviewStatus(tmpDir, record.sampleFingerprint, 'approved_for_training', 'missing file');

    const result = exportORPOSamples(tmpDir, 'gpt-4');

    expect(result.success).toBe(false);
    expect(result.emptyReason).toBe('all_samples_missing_artifacts');
  });
});

// ---------------------------------------------------------------------------
// Tests: verifyExportIntegrity
// ---------------------------------------------------------------------------

describe('NocturnalExport verifyExportIntegrity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('returns valid for intact export', () => {
    setupExportReady(tmpDir, 'art-verify-1', 'gpt-4');

    const exportResult = exportORPOSamples(tmpDir, 'gpt-4');
    const verification = verifyExportIntegrity(tmpDir, exportResult.manifest!.exportId);

    expect(verification).not.toBeNull();
    expect(verification!.valid).toBe(true);
    expect(verification!.computedFingerprint).toBe(verification!.manifestFingerprint);
  });

  it('returns null for non-existent export', () => {
    const verification = verifyExportIntegrity(tmpDir, 'nonexistent-export-id');
    expect(verification).toBeNull();
  });

  it('returns invalid if manifest is corrupted', () => {
    setupExportReady(tmpDir, 'art-corrupt', 'gpt-4');

    const exportResult = exportORPOSamples(tmpDir, 'gpt-4');
    const manifestPath = exportResult.manifest!.manifestPath;
    fs.writeFileSync(manifestPath, 'not valid json', 'utf-8');

    const verification = verifyExportIntegrity(tmpDir, exportResult.manifest!.exportId);
    expect(verification).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: listExports + getExportManifest
// ---------------------------------------------------------------------------

describe('NocturnalExport listExports + getExportManifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('lists all exports sorted by date', () => {
    setupExportReady(tmpDir, 'art-list-1', 'gpt-4');
    const r1 = exportORPOSamples(tmpDir, 'gpt-4');

    setupExportReady(tmpDir, 'art-list-2', 'gpt-4');
    const r2 = exportORPOSamples(tmpDir, 'gpt-4');

    const exports = listExports(tmpDir);
    expect(exports).toHaveLength(2);
    // Newest first
    expect(exports[0].exportId).toBe(r2.manifest!.exportId);
    expect(exports[1].exportId).toBe(r1.manifest!.exportId);
  });

  it('returns empty array when no exports', () => {
    const exports = listExports(tmpDir);
    expect(exports).toHaveLength(0);
  });

  it('getExportManifest returns correct manifest', () => {
    setupExportReady(tmpDir, 'art-getm', 'gpt-4');
    const exportResult = exportORPOSamples(tmpDir, 'gpt-4');

    const manifest = getExportManifest(tmpDir, exportResult.manifest!.exportId);
    expect(manifest).not.toBeNull();
    expect(manifest!.exportId).toBe(exportResult.manifest!.exportId);
    expect(manifest!.sampleCount).toBe(1);
  });

  it('getExportManifest returns null for non-existent', () => {
    const manifest = getExportManifest(tmpDir, 'nonexistent');
    expect(manifest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: JSONL parseability + ORPO structure
// ---------------------------------------------------------------------------

describe('NocturnalExport JSONL parseability', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('every JSONL line is parseable and has ORPO structure', () => {
    setupExportReady(tmpDir, 'art-parse-1', 'gpt-4');
    setupExportReady(tmpDir, 'art-parse-2', 'gpt-4');

    const result = exportORPOSamples(tmpDir, 'gpt-4');
    const content = fs.readFileSync(result.manifest!.exportPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    expect(lines.length).toBe(2);

    for (const line of lines) {
      const sample = JSON.parse(line);

      // ORPO required fields
      expect(typeof sample.sampleFingerprint).toBe('string');
      expect(typeof sample.artifactId).toBe('string');
      expect(typeof sample.sessionId).toBe('string');
      expect(typeof sample.principleId).toBe('string');
      expect(typeof sample.targetModelFamily).toBe('string');
      expect(typeof sample.prompt).toBe('string');
      expect(typeof sample.chosen).toBe('string');
      expect(typeof sample.rejected).toBe('string');
      expect(typeof sample.rationale).toBe('string');
      expect(typeof sample.datasetMetadata).toBe('object');

      // Metadata fields
      expect(typeof sample.datasetMetadata.sampleFingerprint).toBe('string');
      expect(typeof sample.datasetMetadata.artifactPath).toBe('string');
      expect(typeof sample.datasetMetadata.createdAt).toBe('string');
      expect(typeof sample.datasetMetadata.exportedAt).toBe('string');
      expect(typeof sample.datasetMetadata.exportId).toBe('string');
      expect(typeof sample.datasetMetadata.datasetFingerprint).toBe('string');
    }
  });

  it('prompt equals rejected (ORPO teaches to avoid badDecision)', () => {
    setupExportReady(tmpDir, 'art-orpo-check', 'gpt-4');

    const result = exportORPOSamples(tmpDir, 'gpt-4');
    const content = fs.readFileSync(result.manifest!.exportPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const sample = JSON.parse(lines[0]);

    expect(sample.prompt).toBe(sample.rejected);
    expect(sample.chosen).not.toBe(sample.rejected);
  });

  it('export is reproducible with same dataset', () => {
    setupExportReady(tmpDir, 'art-repro-1', 'gpt-4');
    setupExportReady(tmpDir, 'art-repro-2', 'gpt-4');

    const r1 = exportORPOSamples(tmpDir, 'gpt-4');
    const r2 = exportORPOSamples(tmpDir, 'gpt-4');
    const r3 = exportORPOSamples(tmpDir, 'gpt-4');

    expect(r1.manifest!.datasetFingerprint).toBe(r2.manifest!.datasetFingerprint);
    expect(r2.manifest!.datasetFingerprint).toBe(r3.manifest!.datasetFingerprint);
    expect(r1.manifest!.sampleCount).toBe(r2.manifest!.sampleCount);
  });
});
