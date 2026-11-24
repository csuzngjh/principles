import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeState, fakeLedger, MockRuntimeStateManager, MockPrincipleTreeLedgerAdapter } = vi.hoisted(() => {
  const fakeState = {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    authorizeInvalidKindPostProcessingRecovery: vi.fn().mockResolvedValue({
      status: 'authorized',
      document: { processing: { state: 'in_progress' } },
      recovery: {
        recoveryId: 'cpr_test123',
        candidateId: 'candidate-recovery-test',
        rawRecommendationKind: 'principle',
        priorBlockedReason: 'candidate_kind_invalid:wizardry',
        ownerId: 'owner-from-env',
        identitySource: 'env',
        reason: 'Restored source kind',
        authorizedAt: '2026-11-24T00:00:00.000Z',
        policyVersion: 'candidate-post-processing-recovery@1',
      },
    }),
  };
  const fakeLedger = {
    withCandidateCoordination: vi.fn(async (_candidateId: string, operation: () => Promise<unknown>) => operation()),
  };
  return {
    fakeState,
    fakeLedger,
    MockRuntimeStateManager: vi.fn().mockImplementation(() => fakeState),
    MockPrincipleTreeLedgerAdapter: vi.fn().mockImplementation(() => fakeLedger),
  };
});

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/pd-recovery-test-workspace'),
}));

vi.mock('@principles/core/runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RuntimeStateManager: MockRuntimeStateManager,
  PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
}));

import { handleCandidatePostProcessingRecovery } from '../../src/commands/candidate.js';

describe('pd candidate resume-post-processing', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalOwnerId: string | undefined;
  let originalCredentialId: string | undefined;
  let originalExperimentRoot: string | undefined;
  let originalExitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalOwnerId = process.env.PD_OWNER_ID;
    originalCredentialId = process.env.PD_OWNER_CREDENTIAL_ID;
    originalExperimentRoot = process.env.PD_EXPERIMENT_ROOT;
    originalExitCode = process.exitCode;
    delete process.env.PD_OWNER_ID;
    delete process.env.PD_OWNER_CREDENTIAL_ID;
    process.env.PD_EXPERIMENT_ROOT = '/tmp/pd-recovery-test-home';
    process.exitCode = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalOwnerId === undefined) delete process.env.PD_OWNER_ID;
    else process.env.PD_OWNER_ID = originalOwnerId;
    if (originalCredentialId === undefined) delete process.env.PD_OWNER_CREDENTIAL_ID;
    else process.env.PD_OWNER_CREDENTIAL_ID = originalCredentialId;
    if (originalExperimentRoot === undefined) delete process.env.PD_EXPERIMENT_ROOT;
    else process.env.PD_EXPERIMENT_ROOT = originalExperimentRoot;
    process.exitCode = originalExitCode;
  });

  it('does not mutate without the explicit --confirm flag', async () => {
    await handleCandidatePostProcessingRecovery({
      candidateId: 'candidate-recovery-test',
      reason: 'Restored source kind',
      confirm: false,
      json: true,
    });
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(output).toMatchObject({ status: 'confirmation_required', reason: 'explicit_owner_confirmation_required' });
    expect(MockRuntimeStateManager).not.toHaveBeenCalled();
    expect(fakeState.authorizeInvalidKindPostProcessingRecovery).not.toHaveBeenCalled();
  });

  it('fails closed when no ADR-0022 Owner identity is registered', async () => {
    await handleCandidatePostProcessingRecovery({
      candidateId: 'candidate-recovery-test',
      reason: 'Restored source kind',
      confirm: true,
      json: true,
    });
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(output.status).toBe('refused');
    expect(output.reason).toMatch(/verified_owner_identity_required|owner_identity/);
    expect(MockRuntimeStateManager).not.toHaveBeenCalled();
  });

  it('uses the verified Owner identity and candidate coordination lock before authorizing', async () => {
    process.env.PD_OWNER_ID = 'owner-from-env';
    process.env.PD_OWNER_CREDENTIAL_ID = 'credential-from-env';
    await handleCandidatePostProcessingRecovery({
      candidateId: 'candidate-recovery-test',
      reason: 'Restored source kind',
      confirm: true,
      json: true,
    });
    expect(fakeLedger.withCandidateCoordination).toHaveBeenCalledTimes(1);
    expect(fakeLedger.withCandidateCoordination.mock.calls[0]?.[0]).toBe('candidate-recovery-test');
    expect(fakeState.authorizeInvalidKindPostProcessingRecovery).toHaveBeenCalledWith('candidate-recovery-test', expect.objectContaining({
      ownerId: 'owner-from-env',
      identitySource: 'env',
      reason: 'Restored source kind',
      authorizedAt: expect.any(String),
    }));
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(output).toMatchObject({
      status: 'authorized',
      recoveryId: 'cpr_test123',
      processingState: 'in_progress',
      rawRecommendationKind: 'principle',
    });
    expect(output.nextAction).toContain('does not create a Dreamer task');
    expect(fakeState.close).toHaveBeenCalledTimes(1);
  });
});
