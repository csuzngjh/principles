import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCandidateShow, mockResolveWorkspaceDir } = vi.hoisted(() => ({
  mockCandidateShow: vi.fn(),
  mockResolveWorkspaceDir: vi.fn().mockReturnValue('/fake/workspace'),
}));

vi.mock('../../src/resolve-workspace.js', () => ({
  resolveWorkspaceDir: mockResolveWorkspaceDir,
}));

vi.mock('../../src/commands/candidate.js', () => ({
  handleCandidateShow: mockCandidateShow,
  handleCandidateIntake: vi.fn(),
  handleCandidateRoute: vi.fn(),
  handleCandidateInternalize: vi.fn(),
  handleCandidateAudit: vi.fn(),
  handleCandidateInternalizationBackfill: vi.fn(),
}));

import { Command } from 'commander';

function createTestProgram(): Command {
  const program = new Command();
  program.exitOverride();

  const candidateCmd = program.command('candidate');

  candidateCmd
    .command('show [candidateId]')
    .description('Show detail for a single principle candidate')
    .requiredOption('-w, --workspace <path>', 'Workspace directory')
    .option('--candidate-id <id>', 'Candidate ID (alternative to positional arg)')
    .option('--json', 'Output raw JSON')
    .action(async (candidateId, opts) => {
      const resolvedId = opts.candidateId ?? candidateId;
      if (!resolvedId) {
        throw new Error('candidate ID is required (positional or --candidate-id)');
      }
      if (candidateId && opts.candidateId && candidateId !== opts.candidateId) {
        throw new Error(`conflicting candidate IDs: positional="${candidateId}", --candidate-id="${opts.candidateId}"`);
      }
      await mockCandidateShow({ candidateId: resolvedId, ...opts });
    });

  return program;
}

describe('candidate show CLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCandidateShow.mockResolvedValue(undefined);
  });

  it('positional candidateId works', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'show', 'c_123', '-w', '/ws']);

    expect(mockCandidateShow).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'c_123' }),
    );
  });

  it('--candidate-id works', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'show', '-w', '/ws', '--candidate-id', 'c_456']);

    expect(mockCandidateShow).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'c_456' }),
    );
  });

  it('both positional and --candidate-id with same value works', async () => {
    const program = createTestProgram();
    await program.parseAsync(['node', 'pd', 'candidate', 'show', 'c_789', '-w', '/ws', '--candidate-id', 'c_789']);

    expect(mockCandidateShow).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'c_789' }),
    );
  });

  it('conflicting positional and --candidate-id throws error', async () => {
    const program = createTestProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'candidate', 'show', 'c_a', '-w', '/ws', '--candidate-id', 'c_b']),
    ).rejects.toThrow('conflicting candidate IDs');
  });

  it('neither positional nor --candidate-id throws error', async () => {
    const program = createTestProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'candidate', 'show', '-w', '/ws']),
    ).rejects.toThrow('candidate ID is required');
  });
});
