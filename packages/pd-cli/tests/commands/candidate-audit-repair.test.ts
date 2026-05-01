import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleCandidateAudit, handleCandidateRepair } from '../../src/commands/candidate.js';

// Use vi.hoisted to define mocks
const { mockStateManager, mockAdapter, mockService, mockDb, mockLoadLedger, mockGetLedgerFilePath, MockRuntimeStateManager, MockCandidateIntakeService, MockPrincipleTreeLedgerAdapter } = vi.hoisted(() => {
  const mockDbRows: Record<string, unknown[]> = {};

  const mockDb = {
    getDb: () => ({
      prepare: (sql: string) => {
        // Return rows based on SQL pattern
        const key = sql.trim();
        const rows = mockDbRows[key] ?? [];
        return {
          get: (..._args: unknown[]) => rows[0] ?? undefined,
          all: () => rows,
          run: vi.fn(),
        };
      },
    }),
    setRows: (sql: string, rows: unknown[]) => {
      mockDbRows[sql.trim()] = rows;
    },
    clearRows: () => {
      for (const key of Object.keys(mockDbRows)) {
        delete mockDbRows[key];
      }
    },
  };

  const mockStateManager = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getCandidate: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    connection: mockDb,
  };

  const mockAdapter = {
    writeProbationEntry: vi.fn(),
    existsForCandidate: vi.fn().mockReturnValue(null),
  };

  const mockService = {
    intake: vi.fn(),
  };

  function MockRuntimeStateManager(this: unknown) {
    return mockStateManager;
  }
  MockRuntimeStateManager.prototype = {};

  function MockCandidateIntakeService(this: unknown) {
    return mockService;
  }
  MockCandidateIntakeService.prototype = {};

  function MockPrincipleTreeLedgerAdapter(this: unknown) {
    return mockAdapter;
  }
  MockPrincipleTreeLedgerAdapter.prototype = {};

  const mockLoadLedger = vi.fn();
  const mockGetLedgerFilePath = vi.fn().mockReturnValue('/tmp/test-workspace/.state/principle_training_state.json');

  return {
    mockStateManager,
    mockAdapter,
    mockService,
    mockDb,
    mockLoadLedger,
    mockGetLedgerFilePath,
    MockRuntimeStateManager,
    MockCandidateIntakeService,
    MockPrincipleTreeLedgerAdapter,
  };
});

vi.mock('@principles/core/runtime-v2', () => ({
  CandidateIntakeService: MockCandidateIntakeService,
  CandidateIntakeError: class CandidateIntakeError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'CandidateIntakeError';
      this.code = code;
    }
  },
  RuntimeStateManager: MockRuntimeStateManager,
  loadLedger: mockLoadLedger,
  getLedgerFilePathPublic: mockGetLedgerFilePath,
}));

vi.mock('../../src/principle-tree-ledger-adapter.js', () => ({
  PrincipleTreeLedgerAdapter: MockPrincipleTreeLedgerAdapter,
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
}));

describe('pd candidate audit', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStateManager.initialize.mockResolvedValue(undefined);
    mockStateManager.close.mockResolvedValue(undefined);
    mockLoadLedger.mockReset();
    mockGetLedgerFilePath.mockReturnValue('/tmp/test-workspace/.state/principle_training_state.json');
    mockDb.clearRows();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('audit ok: all consumed candidates have ledger entries', async () => {
    // DB returns one consumed candidate
    mockDb.setRows(
      "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'",
      [{ candidate_id: 'c1' }],
    );

    // Ledger contains a principle with derivedFromPainIds matching c1
    mockLoadLedger.mockReturnValue({
      tree: {
        principles: {
          p1: { id: 'p1', derivedFromPainIds: ['c1'] },
        },
      },
    });

    await handleCandidateAudit({ workspace: '/tmp/test-workspace', json: true });

    const jsonOutput = consoleLogSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.status === 'ok';
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('ok');
    expect(parsed.consumedCount).toBe(1);
    expect(parsed.missingLedgerEntryIds).toEqual([]);

    // ok audit should NOT call process.exit(1)
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('audit degraded: consumed candidate missing from ledger exits 1', async () => {
    mockDb.setRows(
      "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'",
      [{ candidate_id: 'c1' }],
    );

    // Ledger has no matching derivedFromPainIds
    mockLoadLedger.mockReturnValue({
      tree: {
        principles: {
          p1: { id: 'p1', derivedFromPainIds: ['other-candidate'] },
        },
      },
    });

    await handleCandidateAudit({ workspace: '/tmp/test-workspace', json: true });

    const jsonOutput = consoleLogSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.status === 'degraded';
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('degraded');
    expect(parsed.missingLedgerEntryIds).toEqual(['c1']);

    // degraded audit must exit 1
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('pd candidate repair', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStateManager.initialize.mockResolvedValue(undefined);
    mockStateManager.close.mockResolvedValue(undefined);
    mockStateManager.getCandidate.mockReset();
    mockAdapter.existsForCandidate.mockReset();
    mockService.intake.mockReset();
    mockDb.clearRows();

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('repair already_consistent with null consumed_at: sets consumed_at', async () => {
    mockStateManager.getCandidate.mockResolvedValue({
      candidateId: 'c1',
      status: 'consumed',
      artifactId: 'a1',
      title: 'Test',
      description: 'desc',
    });

    // Ledger entry exists
    mockAdapter.existsForCandidate.mockReturnValue({ id: 'ledger-1', derivedFromPainIds: ['c1'] });

    // consumed_at is null in DB
    mockDb.setRows(
      'SELECT consumed_at FROM principle_candidates WHERE candidate_id = ?',
      [{ consumed_at: null }],
    );

    await handleCandidateRepair({ candidateId: 'c1', workspace: '/tmp/test-workspace', json: true });

    const jsonOutput = consoleLogSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.status === 'already_consistent';
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('already_consistent');
    expect(parsed.ledgerEntryId).toBe('ledger-1');
    // consumedAt should be a freshly written ISO timestamp
    expect(parsed.consumedAt).toBeDefined();
    expect(typeof parsed.consumedAt).toBe('string');
    // Should not exit 1
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('repair missing ledger: re-intakes and sets consumed_at', async () => {
    mockStateManager.getCandidate.mockResolvedValue({
      candidateId: 'c2',
      status: 'consumed',
      artifactId: 'a2',
      title: 'Test 2',
      description: 'desc 2',
    });

    // No ledger entry exists
    mockAdapter.existsForCandidate.mockReturnValue(null);

    // intake returns new entry
    mockService.intake.mockResolvedValue({
      id: 'new-ledger-entry',
      title: 'Test 2',
      text: 'text',
      status: 'probation',
    });

    // consumed_at is null
    mockDb.setRows(
      'SELECT consumed_at FROM principle_candidates WHERE candidate_id = ?',
      [{ consumed_at: null }],
    );

    await handleCandidateRepair({ candidateId: 'c2', workspace: '/tmp/test-workspace', json: true });

    // intake was called to restore ledger
    expect(mockService.intake).toHaveBeenCalledWith('c2');

    const jsonOutput = consoleLogSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.status === 'repaired';
      } catch {
        return false;
      }
    });
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse((jsonOutput as [string])[0]);
    expect(parsed.status).toBe('repaired');
    expect(parsed.ledgerEntryId).toBe('new-ledger-entry');
    expect(parsed.consumedAt).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('repair non-consumed candidate exits 1', async () => {
    mockStateManager.getCandidate.mockResolvedValue({
      candidateId: 'c3',
      status: 'pending',
      artifactId: 'a3',
      title: 'Test 3',
      description: 'desc 3',
    });

    await handleCandidateRepair({ candidateId: 'c3', workspace: '/tmp/test-workspace', json: true });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('is not consumed'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
