import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockSchemaCheck = vi.hoisted(() => vi.fn());
const mockHealthSnapshot = vi.hoisted(() => vi.fn());
const mockHealthClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockOrphanCandidates = vi.hoisted(() => vi.fn());
const mockQueueSnapshot = vi.hoisted(() => vi.fn());
const mockQueueClose = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAuditConsistency = vi.hoisted(() => vi.fn());
const mockBuildGfiSnapshot = vi.hoisted(() => vi.fn());
const mockIntegrityCheck = vi.hoisted(() => vi.fn());

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('@principles/core/runtime-v2', () => ({
  SchemaConformanceReadModel: vi.fn().mockImplementation(function () {
    return { check: mockSchemaCheck };
  }),
  OperatorHealthReadModel: vi.fn().mockImplementation(function () {
    return { getSnapshot: mockHealthSnapshot, close: mockHealthClose };
  }),
  PruningReadModel: vi.fn().mockImplementation(function () {
    return { getOrphanDerivedCandidates: mockOrphanCandidates };
  }),
  createInternalizationQueueReadModel: vi.fn().mockResolvedValue({
    readModel: { getSnapshot: mockQueueSnapshot },
    close: mockQueueClose,
  }),
  InternalizationChainIntegrityReadModel: vi.fn().mockImplementation(function () {
    return { check: mockIntegrityCheck };
  }),
  auditCandidateLedgerConsistency: mockAuditConsistency,
  buildGfiWorkspaceSnapshot: mockBuildGfiSnapshot,
  resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
}));

vi.mock('../../src/commands/runtime-canary.js', () => ({
  runCanaryChecks: vi.fn().mockResolvedValue({
    overallStatus: 'healthy',
    checks: [],
    recommendedNextActions: [],
    generatedAt: new Date().toISOString(),
  }),
}));

import { exportDiagnosticsBundle } from '../../src/commands/runtime-diagnostics-export.js';

function healthySchemaResult() {
  return {
    overallStatus: 'ok' as const,
    checkedDatabasePath: '/fake/workspace/.pd/state.db',
    tables: { tasks: { exists: true, missingColumns: [] } },
    indexes: { missingIndexes: [] },
    migrationsNeeded: [],
    generatedAt: new Date().toISOString(),
  };
}

function healthyIntegrityResult() {
  return {
    overallStatus: 'ok' as const,
    brokenLinks: [],
    chainSummaries: { totalCandidates: 0, totalDreamerTasks: 0, totalPhilosopherTasks: 0, totalPIArtifacts: 0, chainsWithBrokenLinks: 0 },
    generatedAt: new Date().toISOString(),
  };
}

describe('exportDiagnosticsBundle', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));

    mockSchemaCheck.mockReturnValue(healthySchemaResult());
    mockHealthSnapshot.mockResolvedValue({ overallStatus: 'healthy', generatedAt: new Date().toISOString() });
    mockHealthClose.mockResolvedValue(undefined);
    mockOrphanCandidates.mockReturnValue({ candidates: [], dbReadable: true });
    mockQueueSnapshot.mockResolvedValue({ pendingCount: 0, readyTasks: [] });
    mockQueueClose.mockResolvedValue(undefined);
    mockAuditConsistency.mockResolvedValue({ status: 'ok', consumedCount: 0, orphanCandidateCount: 0, missingLedgerCount: 0 });
    mockBuildGfiSnapshot.mockReturnValue({ active: null, staleSessionCount: 0, totalSessionCount: 0, activeSessionCount: 0, generatedAt: new Date().toISOString() });
    mockIntegrityCheck.mockReturnValue(healthyIntegrityResult());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates bundle with all artifacts', async () => {
    const outDir = path.join(tempDir, 'snapshots');
    const manifest = await exportDiagnosticsBundle(tempDir, outDir);

    expect(manifest.artifacts.length).toBeGreaterThanOrEqual(8);
    expect(manifest.artifacts.every(a => a.status === 'ok')).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'schema-conformance.json'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'canary.json'))).toBe(true);
  });

  it('still generates manifest when sub-check fails', async () => {
    mockHealthSnapshot.mockRejectedValue(new Error('DB error'));

    const outDir = path.join(tempDir, 'snapshots');
    const manifest = await exportDiagnosticsBundle(tempDir, outDir);

    expect(manifest.artifacts.length).toBeGreaterThanOrEqual(8);
    const failedArtifact = manifest.artifacts.find(a => a.name === 'runtime-health');
    expect(failedArtifact?.status).toBe('failed');
    expect(fs.existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
  });

  it('rejects output path outside workspace', async () => {
    await expect(
      exportDiagnosticsBundle(tempDir, '/tmp/outside-workspace'),
    ).rejects.toThrow('Output path must be within workspace directory');
  });

  it('rejects sibling path that starts with workspace prefix', async () => {
    const siblingDir = tempDir + '-backup';
    await expect(
      exportDiagnosticsBundle(tempDir, siblingDir),
    ).rejects.toThrow('Output path must be within workspace directory');
  });

  it('manifest contains path and status for each artifact', async () => {
    const outDir = path.join(tempDir, 'snapshots');
    const manifest = await exportDiagnosticsBundle(tempDir, outDir);

    for (const artifact of manifest.artifacts) {
      expect(artifact.path).toBeTruthy();
      expect(artifact.status).toMatch(/^(ok|failed)$/);
    }
  });

  it('does not include sensitive env/API key content', async () => {
    mockSchemaCheck.mockReturnValue({
      ...healthySchemaResult(),
      // Redaction test fixture: value need not look like a real secret — the
      // assertion is that exportDiagnosticsBundle redacts whatever is set.
      // (String built at runtime so the fixture is not a static credential
      // literal; the field exists solely to exercise the redaction path.)
      apiKey: ['redaction-test-', 'fixture-key'].join(''),
      config: { token: 'plain-test-token-value', safeValue: 'hello' },
    });

    const outDir = path.join(tempDir, 'snapshots');
    await exportDiagnosticsBundle(tempDir, outDir);

    const schemaContent = fs.readFileSync(path.join(outDir, 'schema-conformance.json'), 'utf8');
    const parsed = JSON.parse(schemaContent);
    expect(parsed.apiKey).toBe('[REDACTED]');
    expect(parsed.config.token).toBe('[REDACTED]');
    expect(parsed.config.safeValue).toBe('hello');
  });

  it('uses createInternalizationQueueReadModel with readonly: true (no RuntimeStateManager)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(require.resolve('../../src/commands/runtime-diagnostics-export.ts'), 'utf-8');
    expect(src).not.toContain('RuntimeStateManager');
    expect(src).toContain('createInternalizationQueueReadModel');
    expect(src).toMatch(/createInternalizationQueueReadModel\(\{[^}]*readonly:\s*true/);
  });

  it('calls queue close once on main path', async () => {
    const outDir = path.join(tempDir, 'snapshots');
    await exportDiagnosticsBundle(tempDir, outDir);
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
  });
});
