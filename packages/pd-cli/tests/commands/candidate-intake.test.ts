import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCandidateIntake } from '../../src/commands/candidate.js';

// Use vi.hoisted to define mocks that can be referenced in vi.mock factory
const { mockStateManager, mockAdapter, mockService, MockRuntimeStateManager, MockCandidateIntakeService, MockPrincipleTreeLedgerAdapter, MockCandidateIntakeError } = vi.hoisted(() => {
  const mockStateManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getCandidate: vi.fn(),
    getArtifact: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    connection: {
      getDb: () => ({
        prepare: () => ({
          run: vi.fn(),
        }),
      }),
    },
  };

  const mockAdapter = {
    writeProbationEntry: vi.fn(),
    existsForCandidate: vi.fn().mockReturnValue(null),
  };

  const mockService = {
    intake: vi.fn(),
  };

  // Mock error class
  class MockCandidateIntakeError extends Error {
    code: string;
    context?: Record<string, unknown>;
    constructor(message: string, code: string, context?: Record<string, unknown>) {
      super(message);
      this.name = 'CandidateIntakeError';
      this.code = code;
      this.context = context;
    }
  }

  // Create mock constructors
  function MockRuntimeStateManager(this: any) {
    return mockStateManager;
  }
  MockRuntimeStateManager.prototype = {};

  function MockCandidateIntakeService(this: any) {
    return mockService;
  }
  MockCandidateIntakeService.prototype = {};

  function MockPrincipleTreeLedgerAdapter(this: any) {
    return mockAdapter;
  }
  MockPrincipleTreeLedgerAdapter.prototype = {};

  return {
    mockStateManager,
    mockAdapter,
    mockService,
    MockRuntimeStateManager,
    MockCandidateIntakeService,
    MockPrincipleTreeLedgerAdapter,
    MockCandidateIntakeError,
  };
});

// Mock modules
vi.mock('@principles/core/runtime-v2', () => ({
  CandidateIntakeService: MockCandidateIntakeService,
  CandidateIntakeError: MockCandidateIntakeError,
  RuntimeStateManager: MockRuntimeStateManager,
}));

vi.mock('../../src/principle-tree-ledger-adapter.js', () => ({
  PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

describe('pd candidate intake', () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;
  let exitSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset mock implementations
    mockStateManager.getCandidate.mockReset();
    mockStateManager.getArtifact.mockReset();
    mockAdapter.writeProbationEntry.mockReset();
    mockAdapter.existsForCandidate.mockReset();
    mockService.intake.mockReset();

    // Set default mock implementations
    mockStateManager.initialize.mockResolvedValue(undefined);
    mockStateManager.close.mockResolvedValue(undefined);
    mockAdapter.existsForCandidate.mockReturnValue(null);

    // Spy on console methods
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  // Test 1: Happy path JSON
  it('Test 1 (happy path JSON): returns JSON with candidateId, status: consumed, ledgerEntryId', async () => {
    const mockCandidate = {
      candidateId: 'valid-id',
      artifactId: 'artifact-1',
      taskId: 'task-1',
      title: 'Test Principle',
      description: 'Test description',
      status: 'pending',
    };

    const mockEntry = {
      id: 'ledger-entry-1',
      title: 'Test Principle',
      text: 'Test text',
      triggerPattern: 'test pattern',
      action: 'test action',
      status: 'probation',
      evaluability: 'weak_heuristic',
      sourceRef: 'candidate://valid-id',
      artifactRef: 'artifact://artifact-1',
      taskRef: 'task://task-1',
      createdAt: '2026-02-26T00:00:00.000Z',
    };

    mockStateManager.getCandidate.mockResolvedValue(mockCandidate);
    mockService.intake.mockResolvedValue(mockEntry);

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
      json: true,
    });

    // Verify service.intake was called
    expect(mockService.intake).toHaveBeenCalledWith('valid-id');

    // Verify JSON output
    const jsonOutput = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.candidateId === 'valid-id' && parsed.status === 'consumed';
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.candidateId).toBe('valid-id');
    expect(parsed.status).toBe('consumed');
    expect(parsed.ledgerEntryId).toBe('ledger-entry-1');

    // Verify exit was not called with 1
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  // Test 2: Happy path human-readable
  it('Test 2 (happy path human-readable): prints human-readable format with "Intake complete" message', async () => {
    const mockCandidate = {
      candidateId: 'valid-id',
      artifactId: 'artifact-1',
      taskId: 'task-1',
      title: 'Test Principle',
      description: 'Test description',
      status: 'pending',
    };

    const mockEntry = {
      id: 'ledger-entry-1',
      title: 'Test Principle',
      text: 'Test text',
      status: 'probation',
    };

    mockStateManager.getCandidate.mockResolvedValue(mockCandidate);
    mockService.intake.mockResolvedValue(mockEntry);

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
      json: false,
    });

    // Verify human-readable output
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Principle Candidate Intake:'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Intake complete.'));

    // Verify no JSON.parse error (not JSON output)
    const allOutput = consoleLogSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allOutput).toContain('valid-id');
    expect(allOutput).toContain('ledger-entry-1');

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  // Test 3: Dry-run with complete 11-field entry (JSON output)
  it('Test 3 (dry-run JSON): returns complete 11-field entry without writing to ledger', async () => {
    const mockCandidate = {
      candidateId: 'valid-id',
      artifactId: 'artifact-1',
      taskId: 'task-1',
      title: 'Test Principle',
      description: 'Test description',
      status: 'pending',
    };

    const mockArtifact = {
      artifactId: 'artifact-1',
      contentJson: JSON.stringify({
        recommendation: {
          title: 'Test Principle',
          text: 'Test text',
          triggerPattern: 'test pattern',
          action: 'test action',
        },
      }),
    };

    mockStateManager.getCandidate.mockResolvedValue(mockCandidate);
    mockStateManager.getArtifact.mockResolvedValue(mockArtifact);

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
      dryRun: true,
      json: true,
    });

    // Verify service.intake was NOT called (dry-run skips service)
    expect(mockService.intake).not.toHaveBeenCalled();

    // Verify adapter.writeProbationEntry was NOT called
    expect(mockAdapter.writeProbationEntry).not.toHaveBeenCalled();

    // Verify JSON output has all 11 fields
    const jsonOutput = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.id && parsed.title && parsed.sourceRef === 'candidate://valid-id';
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const entry = JSON.parse((jsonOutput as [string])[0]);

    // Check all 11 fields exist
    expect(entry.id).toBeDefined();
    expect(entry.title).toBe('Test Principle');
    expect(entry.text).toBe('Test text');
    expect(entry.triggerPattern).toBe('test pattern');
    expect(entry.action).toBe('test action');
    expect(entry.status).toBe('probation');
    expect(entry.evaluability).toBe('weak_heuristic');
    expect(entry.sourceRef).toBe('candidate://valid-id');
    expect(entry.artifactRef).toBe('artifact://artifact-1');
    expect(entry.taskRef).toBe('task://task-1');
    expect(entry.createdAt).toBeDefined();

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  // Test 3b: Dry-run with human-readable output (covers lines 193-194)
  it('Test 3b (dry-run human-readable): outputs human-readable format without writing', async () => {
    const mockCandidate = {
      candidateId: 'valid-id',
      artifactId: 'artifact-1',
      taskId: 'task-1',
      title: 'Test Principle',
      description: 'Test description',
      status: 'pending',
    };

    const mockArtifact = {
      artifactId: 'artifact-1',
      contentJson: JSON.stringify({
        recommendation: {
          title: 'Test Principle',
          text: 'Test text',
        },
      }),
    };

    mockStateManager.getCandidate.mockResolvedValue(mockCandidate);
    mockStateManager.getArtifact.mockResolvedValue(mockArtifact);

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
      dryRun: true,
      json: false,
    });

    // Verify human-readable output (covers lines 193-194)
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Dry-run: would write entry for candidate valid-id'));

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  // Test 3c: Dry-run when candidate not found (covers line 165)
  it('Test 3c (dry-run candidate not found): exits with error', async () => {
    mockStateManager.getCandidate.mockResolvedValue(null);

    await handleCandidateIntake({
      candidateId: 'invalid-id',
      workspace: '/tmp/test-workspace',
      dryRun: true,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Candidate not found: invalid-id');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Test 3d: Dry-run when artifact not found (covers line 165)
  it('Test 3d (dry-run artifact not found): exits with error', async () => {
    const mockCandidate = {
      candidateId: 'valid-id',
      artifactId: 'artifact-1',
      title: 'Test',
      description: 'Test',
      status: 'pending',
    };

    mockStateManager.getCandidate.mockResolvedValue(mockCandidate);
    mockStateManager.getArtifact.mockResolvedValue(null);

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
      dryRun: true,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith('Artifact not found for candidate: valid-id');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Test 4: Non-existent candidate
  it('Test 4 (non-existent candidate): throws CANDIDATE_NOT_FOUND error', async () => {
    // Setup: service.intake throws CANDIDATE_NOT_FOUND when candidate doesn't exist
    mockService.intake.mockImplementation(() => {
      throw new MockCandidateIntakeError(
        `Candidate invalid-id not found`,
        'CANDIDATE_NOT_FOUND',
        { candidateId: 'invalid-id' }
      );
    });

    await handleCandidateIntake({
      candidateId: 'invalid-id',
      workspace: '/tmp/test-workspace',
    });

    // Verify error output contains CANDIDATE_NOT_FOUND
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('CANDIDATE_NOT_FOUND')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Test 5: Invalid candidateId (empty string)
  it('Test 5 (invalid candidateId): empty string throws INPUT_INVALID error', async () => {
    // Setup: service.intake throws INPUT_INVALID for empty candidateId
    mockService.intake.mockImplementation(() => {
      throw new MockCandidateIntakeError(
        'candidateId must be a non-empty string',
        'INPUT_INVALID',
        { candidateId: '' }
      );
    });

    await handleCandidateIntake({
      candidateId: '',
      workspace: '/tmp/test-workspace',
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('INPUT_INVALID')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Test 6: Already consumed candidate (human-readable)
  it('Test 6 (already consumed human-readable): outputs info message and exits successfully', async () => {
    const mockCandidate = {
      candidateId: 'valid-id',
      artifactId: 'artifact-1',
      taskId: 'task-1',
      title: 'Test Principle',
      description: 'Test description',
      status: 'consumed', // Already consumed
    };

    const mockEntry = {
      id: 'ledger-entry-1',
      title: 'Test Principle',
      text: 'Test text',
      status: 'probation',
    };

    mockStateManager.getCandidate.mockResolvedValue(mockCandidate);
    mockService.intake.mockResolvedValue(mockEntry);

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
      json: false,
    });

    // Verify info message about already consumed
    const allOutput = consoleLogSpy.mock.calls.map(call => call[0]).join('\n');
    expect(allOutput).toContain('already consumed');
    expect(allOutput).toContain('ledger-entry-1');

    // Verify exit was not called with 1 (successful exit)
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  // Test 6b: Already consumed candidate (JSON output, covers line 208)
  it('Test 6b (already consumed JSON): outputs JSON with already_consumed status', async () => {
    const mockCandidate = {
      candidateId: 'valid-id',
      artifactId: 'artifact-1',
      taskId: 'task-1',
      title: 'Test Principle',
      description: 'Test description',
      status: 'consumed', // Already consumed
    };

    const mockEntry = {
      id: 'ledger-entry-1',
      title: 'Test Principle',
      text: 'Test text',
      status: 'probation',
    };

    mockStateManager.getCandidate.mockResolvedValue(mockCandidate);
    mockService.intake.mockResolvedValue(mockEntry);

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
      json: true,
    });

    // Verify JSON output for already consumed (covers line 208)
    const jsonOutput = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.status === 'already_consumed';
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.candidateId).toBe('valid-id');
    expect(parsed.ledgerEntryId).toBe('ledger-entry-1');
    expect(parsed.status).toBe('already_consumed');
    expect(parsed.message).toContain('already consumed');

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  // Test 7: Generic error (non-CandidateIntakeError, covers line 247)
  it('Test 7 (generic error): handles non-CandidateIntakeError errors', async () => {
    // Setup: service.intake throws a generic Error (not CandidateIntakeError)
    mockService.intake.mockImplementation(() => {
      throw new Error('Some unexpected error');
    });

    await handleCandidateIntake({
      candidateId: 'valid-id',
      workspace: '/tmp/test-workspace',
    });

    // Verify generic error output (covers line 247)
    // String(err) produces "Error: Some unexpected error"
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Intake failed: Error: Some unexpected error')
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
