import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleNocturnalReviewCommand } from '../../src/commands/nocturnal-review.js';
import type { PluginCommandContext } from '../../src/openclaw-sdk.js';
import {
  registerSample,
  updateReviewStatus,
  getDatasetRecord,
} from '../../src/core/nocturnal-dataset.js';
import type { NocturnalArtifact } from '../../src/core/nocturnal-arbiter.js';

// ---------------------------------------------------------------------------
// Fixtures
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-review-test-'));
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

function makeCtx(workspaceDir: string, args = ''): PluginCommandContext {
  return {
    config: { workspaceDir, language: 'en' },
    args,
  } as unknown as PluginCommandContext;
}

function setupSample(
  workspaceDir: string,
  artifactId: string,
  family: string | null = 'gpt-4'
): { fingerprint: string; artifactPath: string } {
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
  const result = registerSample(workspaceDir, artifact, artifactPath, family);
  return { fingerprint: result.record.sampleFingerprint, artifactPath };
}

// ---------------------------------------------------------------------------
// Tests: list
// ---------------------------------------------------------------------------

describe('NocturnalReviewCommand list', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('shows pending samples', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-pending-list');

    const result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'list'));

    expect(result.text).toContain('pending_review');
    expect(result.text).toContain(fingerprint.substring(0, 16));
  });

  it('shows empty when no pending samples', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-approved-list');
    updateReviewStatus(tmpDir, fingerprint, 'approved_for_training', 'Approved');

    const result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'list'));

    expect(result.text).toContain('No pending');
  });
});

// ---------------------------------------------------------------------------
// Tests: approve
// ---------------------------------------------------------------------------

describe('NocturnalReviewCommand approve', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('approves a pending sample', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-approve-test');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `approve ${fingerprint} Looks good for training`)
    );

    expect(result.text).toContain('approved for training');
    const record = getDatasetRecord(tmpDir, fingerprint);
    expect(record?.reviewStatus).toBe('approved_for_training');
    expect(record?.reviewReason).toBe('Looks good for training');
  });

  it('approves with default reason if not provided', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-approve-default');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `approve ${fingerprint}`)
    );

    expect(result.text).toContain('approved for training');
    const record = getDatasetRecord(tmpDir, fingerprint);
    expect(record?.reviewStatus).toBe('approved_for_training');
    expect(record?.reviewReason).toBeTruthy();
  });

  it('rejects already approved sample', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-already-approved');
    updateReviewStatus(tmpDir, fingerprint, 'approved_for_training', 'Already approved');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `approve ${fingerprint}`)
    );

    expect(result.text).toContain('already approved');
  });

  it('rejects rejected sample without reset', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-already-rejected');
    updateReviewStatus(tmpDir, fingerprint, 'rejected', 'Rejected');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `approve ${fingerprint}`)
    );

    expect(result.text).toContain('rejected');
  });

  it('rejects superseded sample', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-superseded');
    updateReviewStatus(tmpDir, fingerprint, 'approved_for_training', 'Approved');
    updateReviewStatus(tmpDir, fingerprint, 'superseded', 'Superseded by better');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `approve ${fingerprint}`)
    );

    expect(result.text).toContain('superseded');
  });

  it('returns error for unknown fingerprint', () => {
    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, 'approve unknown-fingerprint')
    );

    expect(result.text).toContain('not found');
  });

  it('returns error when missing fingerprint', () => {
    const result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'approve'));

    expect(result.text).toContain('Usage');
  });
});

// ---------------------------------------------------------------------------
// Tests: reject
// ---------------------------------------------------------------------------

describe('NocturnalReviewCommand reject', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('rejects a pending sample', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-reject-test');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `reject ${fingerprint} Not suitable for training`)
    );

    expect(result.text).toContain('rejected');
    const record = getDatasetRecord(tmpDir, fingerprint);
    expect(record?.reviewStatus).toBe('rejected');
    expect(record?.reviewReason).toBe('Not suitable for training');
  });

  it('rejects with default reason if not provided', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-reject-default');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `reject ${fingerprint}`)
    );

    expect(result.text).toContain('rejected');
    const record = getDatasetRecord(tmpDir, fingerprint);
    expect(record?.reviewStatus).toBe('rejected');
  });

  it('rejects already rejected sample', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-already-rejected');
    updateReviewStatus(tmpDir, fingerprint, 'rejected', 'Already rejected');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `reject ${fingerprint}`)
    );

    expect(result.text).toContain('already rejected');
  });

  it('rejects superseded sample', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-superseded-reject');
    updateReviewStatus(tmpDir, fingerprint, 'approved_for_training', 'Approved');
    updateReviewStatus(tmpDir, fingerprint, 'superseded', 'Superseded');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `reject ${fingerprint}`)
    );

    expect(result.text).toContain('superseded');
  });

  it('returns error for unknown fingerprint', () => {
    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, 'reject unknown-fingerprint')
    );

    expect(result.text).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// Tests: show
// ---------------------------------------------------------------------------

describe('NocturnalReviewCommand show', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('shows sample details', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-show-test');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `show ${fingerprint}`)
    );

    expect(result.text).toContain(fingerprint.substring(0, 16));
    expect(result.text).toContain('T-08');
    expect(result.text).toContain('session-abc123');
  });

  it('returns error for unknown fingerprint', () => {
    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, 'show unknown-fingerprint')
    );

    expect(result.text).toContain('not found');
  });

  it('returns error when missing fingerprint', () => {
    const result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'show'));

    expect(result.text).toContain('Usage');
  });
});

// ---------------------------------------------------------------------------
// Tests: set-family
// ---------------------------------------------------------------------------

describe('NocturnalReviewCommand set-family', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('sets target model family', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-family-test', null);

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `set-family ${fingerprint} claude-3`)
    );

    expect(result.text).toContain('claude-3');
    const record = getDatasetRecord(tmpDir, fingerprint);
    expect(record?.targetModelFamily).toBe('claude-3');
  });

  it('updates existing family', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-family-update-test', 'gpt-4');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `set-family ${fingerprint} gpt-4o`)
    );

    expect(result.text).toContain('gpt-4o');
    const record = getDatasetRecord(tmpDir, fingerprint);
    expect(record?.targetModelFamily).toBe('gpt-4o');
  });

  it('returns error for unknown fingerprint', () => {
    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, 'set-family unknown-fingerprint gpt-4')
    );

    expect(result.text).toContain('not found');
  });

  it('returns error when missing args', () => {
    const { fingerprint } = setupSample(tmpDir, 'art-family-missing-test');

    const result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `set-family ${fingerprint}`)
    );

    expect(result.text).toContain('Usage');
  });
});

// ---------------------------------------------------------------------------
// Tests: stats
// ---------------------------------------------------------------------------

describe('NocturnalReviewCommand stats', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('shows dataset statistics', () => {
    setupSample(tmpDir, 'art-stats-1', 'gpt-4');
    const { fingerprint: fp2 } = setupSample(tmpDir, 'art-stats-2', 'gpt-4');
    updateReviewStatus(tmpDir, fp2, 'approved_for_training', 'Approved');

    const result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'stats'));

    expect(result.text).toContain('Total');
    expect(result.text).toContain('2');
  });

  it('shows export-ready counts by family', () => {
    const { fingerprint: fp1 } = setupSample(tmpDir, 'art-stats-family-1', 'gpt-4');
    updateReviewStatus(tmpDir, fp1, 'approved_for_training', 'Approved');

    const result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'stats'));

    expect(result.text).toContain('gpt-4');
    expect(result.text).toContain('1');
  });
});

// ---------------------------------------------------------------------------
// Integration: full review flow
// ---------------------------------------------------------------------------

describe('NocturnalReviewCommand full review flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmdir(tmpDir);
  });

  it('full flow: list → set-family → approve → export-ready', () => {
    // 1. Register sample without family
    const { fingerprint } = setupSample(tmpDir, 'art-full-flow', null);

    // 2. Verify it's pending
    let result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'list'));
    expect(result.text).toContain(fingerprint.substring(0, 16));

    // 3. Set family
    result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `set-family ${fingerprint} gpt-4`)
    );
    expect(result.text).toContain('gpt-4');

    // 4. Approve
    result = handleNocturnalReviewCommand(
      makeCtx(tmpDir, `approve ${fingerprint} Good sample`)
    );
    expect(result.text).toContain('approved for training');

    // 5. Verify stats show approved
    result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'stats'));
    expect(result.text).toContain('Approved for training');

    // 6. Verify not in pending list anymore
    result = handleNocturnalReviewCommand(makeCtx(tmpDir, 'list'));
    expect(result.text).not.toContain(fingerprint.substring(0, 16));
  });
});
