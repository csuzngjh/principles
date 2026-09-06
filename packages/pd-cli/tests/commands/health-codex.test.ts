/**
 * pd health --host codex command tests — §15 health surface (Slice D).
 *
 * Module-boundary mock style (the handler is a read-model aggregator): every
 * collaborator is mocked, the handler logic (§15 ready conjunction, consent
 * states, blockers, exit codes) is exercised for real.
 *
 * Covers:
 * - cli-1: --json outputs exactly one parseable JSON object.
 * - §15 ready conjunction: full green ⇒ ready + exit 0.
 * - "unknown is not healthy": a degraded section ⇒ not ready + blocker.
 * - consent: flag_on_without_consent blocker; stale disclosure; decline.
 * - admissions without task ⇒ blocker with `pd codex reconcile` nextAction.
 * - hooks trust untrusted ⇒ blocker + exit 1.
 * - legacy dual registration ⇒ migration nextAction (§17 retirement).
 * - worker mode manual_action_required/degraded ⇒ not ready.
 * - per-rollout lag detection from checkpoint + transcript stat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveNearestPdWorkspace,
  mockLoadPdConfigForPlugin,
  mockComputeFeatureFlagsFromConfig,
  mockIsFeatureEnabled,
  mockReadCodexIngestionConsent,
  mockDeriveConsentState,
  mockListGovernanceCheckpoints,
  mockReadObservationStats,
  mockReadAdmissionCounts,
  mockComputeWorkerMode,
  mockLocateTranscript,
  mockGetInstallLayoutPaths,
  mockParseInstallManifest,
  mockExistsSync,
  mockReadFileSync,
  mockStatSync,
  mockHomedir,
  mockRequireResolve,
  mockConsoleLog,
  mockConsoleWarn,
} = vi.hoisted(() => ({
  mockResolveNearestPdWorkspace: vi.fn(),
  mockLoadPdConfigForPlugin: vi.fn(),
  mockComputeFeatureFlagsFromConfig: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
  mockReadCodexIngestionConsent: vi.fn(),
  mockDeriveConsentState: vi.fn(),
  mockListGovernanceCheckpoints: vi.fn(),
  mockReadObservationStats: vi.fn(),
  mockReadAdmissionCounts: vi.fn(),
  mockComputeWorkerMode: vi.fn(),
  mockLocateTranscript: vi.fn(),
  mockGetInstallLayoutPaths: vi.fn(),
  mockParseInstallManifest: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockHomedir: vi.fn(),
  mockRequireResolve: vi.fn(),
  mockConsoleLog: vi.fn(),
  mockConsoleWarn: vi.fn(),
}));

vi.mock('@principles/host-runtime', () => ({
  loadPdConfigForPlugin: mockLoadPdConfigForPlugin,
  resolveNearestPdWorkspace: mockResolveNearestPdWorkspace,
  readCodexIngestionConsent: mockReadCodexIngestionConsent,
  deriveCodexIngestionConsentState: mockDeriveConsentState,
  listGovernanceCheckpoints: mockListGovernanceCheckpoints,
  readGovernanceObservationStats: mockReadObservationStats,
  readGovernanceAdmissionCounts: mockReadAdmissionCounts,
  CODEX_INGESTION_DISCLOSURE_VERSION: 'g2a-2026-08-28',
}));

vi.mock('@principles/codex-adapter', () => ({
  computeCodexWorkerStatusMode: mockComputeWorkerMode,
  locateCodexTranscriptByRolloutIdentity: mockLocateTranscript,
  CODEX_INGESTION_MIN_VERSION: '0.148.0',
}));

vi.mock('@principles/install-layout', () => ({
  getInstallLayoutPaths: mockGetInstallLayoutPaths,
  parseInstallManifest: mockParseInstallManifest,
}));

vi.mock('@principles/core/runtime-v2', () => ({
  SqliteConnection: class {},
  SqliteTaskStore: class {
    listTasks = vi.fn().mockResolvedValue([]);
  },
  computeFeatureFlagsFromConfig: mockComputeFeatureFlagsFromConfig,
  isFeatureEnabled: mockIsFeatureEnabled,
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
}));

vi.mock('os', () => ({
  default: { homedir: mockHomedir, userInfo: vi.fn().mockReturnValue({ username: 'tester' }) },
  homedir: mockHomedir,
  userInfo: vi.fn().mockReturnValue({ username: 'tester' }),
}));

vi.mock('module', () => ({
  createRequire: () => ({ resolve: mockRequireResolve }),
}));

import { handleHealthCodex } from '../../src/commands/health-codex.js';

function flagMap(): Record<string, { enabled: boolean }> {
  return {
    'host.codex': { enabled: true },
    codex_conversation_ingestion: { enabled: true },
  };
}

function grantedConsentRecord(): Record<string, unknown> {
  return { decision: 'granted', disclosureVersion: 'g2a-2026-08-28', decidedAt: '2026-09-06T00:00:00.000Z', decidedVia: 'pd_codex_setup', schemaVersion: '1' };
}

function greenSetup(): void {
  mockResolveNearestPdWorkspace.mockReturnValue({ ok: true, workspaceDir: '/fake/workspace', configPath: '/fake/workspace/.pd/config.yaml', source: 'nearest' });
  mockLoadPdConfigForPlugin.mockReturnValue({ ok: true, source: 'user_config', effective: {}, configPath: '/fake/workspace/.pd/config.yaml', warnings: [], errors: [] });
  mockComputeFeatureFlagsFromConfig.mockReturnValue({ flags: flagMap() });
  mockIsFeatureEnabled.mockImplementation((_flags: unknown, id: string) => (flagMap())[id]?.enabled ?? false);
  mockReadCodexIngestionConsent.mockReturnValue({ ok: true, existed: true, record: grantedConsentRecord() });
  mockDeriveConsentState.mockReturnValue('granted');
  mockListGovernanceCheckpoints.mockReturnValue({ checkpoints: [] });
  mockReadObservationStats.mockReturnValue({ ok: true, stats: { operational: 3, promoted: 1, quarantined: 0, terminalOther: 0, nextExpiryAt: '2026-09-07T00:00:00.000Z', lastObservationAt: '2026-09-06T00:00:00.000Z' } });
  mockReadAdmissionCounts.mockReturnValue({ ok: true, counts: { admitted: 1, admittedWithoutTask: 0, pendingTails: 0, staleTails: 0, completedTails: 1, lastAdmissionAt: '2026-09-06T00:00:00.000Z' } });
  mockComputeWorkerMode.mockReturnValue({ mode: 'ready' });
  mockLocateTranscript.mockReturnValue({ ok: false, reason: 'not_found' });
  mockGetInstallLayoutPaths.mockReturnValue({ manifest: '/fake/manifest.json' });
  mockParseInstallManifest.mockReturnValue({ manifest: { workspaces: ['/fake/workspace'] } });
  // Green hooks environment: ~/.codex exists with config.toml hooks = true.
  // NOTE: the handler joins paths with the REAL path module, so on Windows
  // the separators are backslashes — match by suffix, never full equality.
  mockHomedir.mockReturnValue('/fake/home');
  mockExistsSync.mockImplementation((candidate: string | Buffer) => {
    const value = String(candidate);
    return value.endsWith('.codex') || value.endsWith('config.toml');
  });
  mockRequireResolve.mockImplementation((name: string) => `/fake/node_modules/${name}/package.json`);
  mockReadFileSync.mockImplementation((candidate: string | Buffer) => {
    const value = String(candidate);
    if (value.endsWith('config.toml')) return '[features]\nhooks = true\n';
    if (value.includes('package.json')) return JSON.stringify({ version: '0.1.0' });
    return '';
  });
  mockStatSync.mockReturnValue({ size: 0 });
}

async function runJson(): Promise<Record<string, unknown>> {
  await handleHealthCodex({ json: true });
  expect(mockConsoleLog).toHaveBeenCalledTimes(1);
  return JSON.parse(mockConsoleLog.mock.calls[0]?.[0] as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  greenSetup();
  vi.spyOn(console, 'log').mockImplementation(mockConsoleLog);
  vi.spyOn(console, 'warn').mockImplementation(mockConsoleWarn);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('pd health --host codex — §15 ready semantics', () => {
  it('cli-1 + full green ⇒ ready true, exit 0, one JSON object with §15 fields', async () => {
    const report = await runJson();
    expect(report.ready, JSON.stringify(report.readyBlockers)).toBe(true);
    expect(report.readyBlockers).toHaveLength(0);
    expect(report.host).toBe('codex');
    expect(report.codexIngestionMinVersion).toBe('0.148.0');
    expect((report.consent as { state: string }).state).toBe('granted');
    expect((report.workspaceInit as { initialized: boolean }).initialized).toBe(true);
    expect((report.observations as { operational: number }).operational).toBe(3);
    expect((report.diagnosticianTasks as { pending: number }).pending).toBe(0);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('untrusted hooks ⇒ not ready with blocker and exit 1', async () => {
    mockExistsSync.mockImplementation((candidate: string | Buffer) => String(candidate).endsWith('config.toml'));
    mockReadFileSync.mockImplementation((candidate: string | Buffer) => (String(candidate).endsWith('config.toml') ? '[features]\nhooks = false\n' : ''));
    const report = await runJson();
    expect(report.ready).toBe(false);
    expect((report.readyBlockers as string[]).some((blocker) => blocker.startsWith('hooks_trust'))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  it('degraded admission counts ⇒ unknown is not healthy (§15)', async () => {
    mockReadAdmissionCounts.mockReturnValue({ ok: false, reason: 'governance_admission_counts_unavailable', nextAction: 'inspect trajectory.db' });
    const report = await runJson();
    expect(report.ready).toBe(false);
    expect((report.readyBlockers as string[]).some((blocker) => blocker.startsWith('admissions'))).toBe(true);
    expect((report.admissions as { reason: string }).reason).toBe('governance_admission_counts_unavailable');
  });

  it('admitted pains without task ⇒ blocker recommending reconcile', async () => {
    mockReadAdmissionCounts.mockReturnValue({ ok: true, counts: { admitted: 2, admittedWithoutTask: 1, pendingTails: 0, staleTails: 0, completedTails: 0, lastAdmissionAt: null } });
    const report = await runJson();
    expect(report.ready).toBe(false);
    const blocker = (report.readyBlockers as string[]).find((entry) => entry.startsWith('admissions'));
    expect(blocker).toContain('reconcile');
  });

  it('worker degraded ⇒ not ready', async () => {
    mockComputeWorkerMode.mockReturnValue({ mode: 'degraded', reason: 'workspace_missing', nextAction: 'restore the workspace' });
    const report = await runJson();
    expect(report.ready).toBe(false);
    expect((report.worker as { mode: string }).mode).toBe('degraded');
  });

  it('no Companion worker ⇒ manual_action_required, never ready (no automatic closure)', async () => {
    mockParseInstallManifest.mockReturnValue({ manifest: { workspaces: [] } });
    mockComputeWorkerMode.mockReturnValue({ mode: 'manual_action_required', reason: 'workspace_not_in_install_manifest' });
    const report = await runJson();
    expect((report.worker as { mode: string }).mode).toBe('manual_action_required');
    expect(report.ready).toBe(false);
  });

  it('diagnostician needs_human_review tasks ⇒ not ready with review blocker', async () => {
    // Override the task store default via the mocked class instance.
    const coreModule = (await vi.importMock('@principles/core/runtime-v2')) as { SqliteTaskStore: new () => { listTasks: (filter: { status: string }) => Promise<unknown[]> } };
    const original = coreModule.SqliteTaskStore;
    class FakeStore {
      listTasks(filter: { status: string }): Promise<unknown[]> {
        return Promise.resolve(filter.status === 'needs_human_review' ? [{ id: 't1' }] : []);
      }
    }
    vi.doMock('@principles/core/runtime-v2', () => ({ SqliteConnection: class {}, SqliteTaskStore: FakeStore, computeFeatureFlagsFromConfig: mockComputeFeatureFlagsFromConfig, isFeatureEnabled: mockIsFeatureEnabled }));
    void original;
    vi.resetModules();
    const { handleHealthCodex: freshHandler } = await import('../../src/commands/health-codex.js');
    await freshHandler({ json: true });
    const output = mockConsoleLog.mock.calls[mockConsoleLog.mock.calls.length - 1]?.[0] as string;
    const report = JSON.parse(output) as { ready: boolean; readyBlockers: string[] };
    expect(report.ready).toBe(false);
    expect(report.readyBlockers.some((blocker) => blocker.includes('human review'))).toBe(true);
    process.exitCode = undefined;
  });
});

describe('pd health --host codex — consent surface (no captured text)', () => {
  it('flag on without consent record ⇒ governance blocker with setup nextAction', async () => {
    mockReadCodexIngestionConsent.mockReturnValue({ ok: true, existed: false, record: null });
    mockDeriveConsentState.mockReturnValue('flag_on_without_consent');
    const report = await runJson();
    const consent = report.consent as { state: string; nextAction?: string };
    expect(consent.state).toBe('flag_on_without_consent');
    expect(consent.nextAction).toContain('pd codex setup');
    expect(report.ready).toBe(false);
  });

  it('declined consent with flag off does not block readiness on consent', async () => {
    mockIsFeatureEnabled.mockImplementation((_flags: unknown, id: string) => id === 'host.codex');
    mockReadCodexIngestionConsent.mockReturnValue({ ok: true, existed: true, record: { ...grantedConsentRecord(), decision: 'declined' } });
    mockDeriveConsentState.mockReturnValue('declined');
    const report = await runJson();
    expect((report.consent as { state: string }).state).toBe('declined');
    expect((report.readyBlockers as string[]).some((blocker) => blocker.startsWith('consent'))).toBe(false);
  });

  it('stale disclosure version is surfaced as re-consent nextAction', async () => {
    mockReadCodexIngestionConsent.mockReturnValue({ ok: true, existed: true, record: { ...grantedConsentRecord(), disclosureVersion: 'g2a-2020-01-01' } });
    const report = await runJson();
    expect((report.consent as { disclosureStale: boolean }).disclosureStale).toBe(true);
  });
});

describe('pd health --host codex — legacy registration (§17 retirement)', () => {
  it('legacy async PostToolUse registration ⇒ migration nextAction', async () => {
    mockHomedir.mockReturnValue('/fake/home');
    mockExistsSync.mockImplementation((candidate: string | Buffer) => {
      const value = String(candidate);
      return value.endsWith('.codex') || value.endsWith('hooks.json') || value.endsWith('config.toml');
    });
    mockReadFileSync.mockImplementation((candidate: string | Buffer) => {
      const value = String(candidate);
      if (value.endsWith('hooks.json')) {
        return JSON.stringify({ __pd_marker: 'pd-owned', hooks: { PostToolUse: [{ command: 'node pd-hook.cjs', async: true }] } });
      }
      if (value.endsWith('config.toml')) return '[features]\nhooks = true\n';
      if (value.includes('package.json')) return JSON.stringify({ version: '0.1.0' });
      return '';
    });
    const report = await runJson();
    expect((report.dualRegistration as { detected: boolean; legacyAsyncPostToolUse: boolean }).legacyAsyncPostToolUse, JSON.stringify(report.dualRegistration)).toBe(true);
    expect((report.dualRegistration as { nextAction?: string }).nextAction).toContain('Marketplace');
  });
});

describe('pd health --host codex — per-rollout lag', () => {
  it('checkpoint lag over zero ⇒ rollout blocker with byte lag', async () => {
    mockListGovernanceCheckpoints.mockReturnValue({
      checkpoints: [{ hostKind: 'codex', rolloutIdentity: 'r-1', byteOffset: 10, lastOrdinal: 1, cliVersion: null, rootSessionId: 'root', incompleteTail: false, lastDegradationReason: null, lastDegradationOrdinal: null, updatedAt: '2026-09-06T00:00:00.000Z' }],
    });
    mockLocateTranscript.mockReturnValue({ ok: true, transcriptPath: '/fake/home/.codex/sessions/r-1.jsonl' });
    mockStatSync.mockReturnValue({ size: 512 });
    const report = await runJson();
    expect(report.ready).toBe(false);
    expect(((report.rollouts as { checkpoints: { lagBytes: number | null }[] }).checkpoints[0]?.lagBytes) ?? -1).toBe(502);
    expect((report.readyBlockers as string[]).some((blocker) => blocker.includes('r-1'))).toBe(true);
  });
});
