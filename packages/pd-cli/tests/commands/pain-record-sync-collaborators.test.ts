/**
 * D1 CLI wiring red-first test — SPEC-PD-PIPELINE-SPINE-001 v0.9 §3.1.1 #1
 * (PRI-1291 Phase 1A).
 *
 * `pd pain record --wait` runs the diagnosis SYNCHRONOUSLY inside the CLI
 * process, so the constructed PainToPrincipleService must carry the two
 * sync-mode collaborators (trajectory turn reader + source-material
 * authorization). Pre-fix reality: neither is passed and the sync diagnosis
 * silently runs with a deny-all authorization and no session material.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PainToPrincipleOutput } from '@principles/core/runtime';

let lastServiceOpts: Record<string, unknown> | null = null;
let mockIsFeatureEnabledReturn = false;

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/fake-ws-d1'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

vi.mock('../../src/commands/build-trajectory-evidence.js', () => ({
  buildTrajectoryEvidenceFromDb: vi.fn().mockReturnValue([
    { sourceRef: 'owner_reported:cli', note: 'No session context available' },
  ]),
}));

vi.mock('@principles/core/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/core/runtime')>();
  return {
    ...actual,
    PainToPrincipleService: vi.fn().mockImplementation(function (this: unknown, opts: Record<string, unknown>) {
      lastServiceOpts = opts;
      return {
        recordPain: vi.fn(async () => SUCCEEDED),
      };
    }),
    PrincipleTreeLedgerAdapter: vi.fn().mockImplementation(function () { return {}; }),
    computeEffectivePdConfig: vi.fn().mockReturnValue({
      runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEST_KEY',
      timeoutMs: 300000, agentId: 'main', language: 'zh-CN', warnings: [],
    }),
    resolveRuntimeConfig: vi.fn().mockReturnValue({
      runtimeKind: 'pi-ai', provider: 'test-provider', model: 'test-model', apiKeyEnv: 'TEST_KEY',
      timeoutMs: 300000, agentId: 'main',
    }),
    isRuntimeConfigError: vi.fn().mockReturnValue(false),
    resolveOutputLanguage: vi.fn().mockReturnValue({ outputLanguage: 'zh-CN' }),
    isFeatureEnabled: vi.fn().mockImplementation(() => mockIsFeatureEnabledReturn),
  };
});

vi.mock('../../src/services/pd-config-loader.js', () => ({
  loadPdConfig: vi.fn().mockReturnValue({
    ok: true, effective: { config: {}, source: 'defaults', warnings: [] }, source: 'defaults',
    configPath: '/tmp/fake-ws-d1/.pd/config.yaml', warnings: [], legacyFilesDetected: [],
  }),
  computeFlagsFromLoadResult: vi.fn().mockReturnValue({ flags: {}, enabledChannels: [], warnings: [] }),
}));

const SUCCEEDED: PainToPrincipleOutput = {
  status: 'succeeded', painId: 'manual_123_abc', taskId: 'diagnosis_manual_123_abc',
  runId: 'run-001', artifactId: 'art-001', candidateIds: ['c1'], ledgerEntryIds: ['l1'],
  observabilityWarnings: [], latencyMs: 42000,
};

import { handlePainRecord } from '../../src/commands/pain-record.js';

describe('D1 — pd pain record --wait wires the sync collaborators', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('--wait constructs the service with BOTH sourceMaterialAuthorization and trajectoryTurnReader', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    try {
      await handlePainRecord({ reason: 'sync wiring probe', wait: true, json: true });
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(lastServiceOpts).toBeTruthy();
    expect(lastServiceOpts!.asyncMode).toBe(false);
    const authz = lastServiceOpts!.sourceMaterialAuthorization as { isHostSourceMaterialAuthorized?: unknown } | undefined;
    expect(authz).toBeTruthy();
    expect(typeof authz!.isHostSourceMaterialAuthorized).toBe('function');
    const reader = lastServiceOpts!.trajectoryTurnReader as Record<string, unknown> | undefined;
    expect(reader).toBeTruthy();
    expect(typeof reader!.listUserTurnsForSession).toBe('function');
    expect(typeof reader!.listAssistantTurns).toBe('function');
  });

  it('async mode (flag on, no --wait) does not require the sync collaborators', async () => {
    mockIsFeatureEnabledReturn = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
    try {
      await handlePainRecord({ reason: 'async probe', json: true });
    } finally {
      logSpy.mockRestore();
      exitSpy.mockRestore();
    }
    expect(lastServiceOpts).toBeTruthy();
    expect(lastServiceOpts!.asyncMode).toBe(true);
  });
});
