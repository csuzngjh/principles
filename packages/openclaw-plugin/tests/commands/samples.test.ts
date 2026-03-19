import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSamplesCommand } from '../../src/commands/samples.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('../../src/core/workspace-context.js');

describe('Samples Command', () => {
  const mockTrajectory = {
    listCorrectionSamples: vi.fn().mockReturnValue([
      { sampleId: 'sample-1', sessionId: 's1', reviewStatus: 'pending', qualityScore: 88 },
    ]),
    reviewCorrectionSample: vi.fn().mockReturnValue({ sampleId: 'sample-1', reviewStatus: 'approved' }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
      trajectory: mockTrajectory,
    } as any);
  });

  it('lists pending samples by default', () => {
    const result = handleSamplesCommand({
      args: '',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(mockTrajectory.listCorrectionSamples).toHaveBeenCalledWith('pending');
    expect(result.text).toContain('sample-1');
  });

  it('approves a pending sample', () => {
    const result = handleSamplesCommand({
      args: 'review approve sample-1 useful-fix',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(mockTrajectory.reviewCorrectionSample).toHaveBeenCalledWith('sample-1', 'approved', 'useful-fix');
    expect(result.text).toContain('sample-1');
    expect(result.text).toContain('approved');
  });

  it('rejects invalid review decisions before writing', () => {
    const result = handleSamplesCommand({
      args: 'review maybe sample-1',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(mockTrajectory.reviewCorrectionSample).not.toHaveBeenCalled();
    expect(result.text).toContain('Invalid review action');
  });

  it('returns a user-facing error when the sample is missing', () => {
    mockTrajectory.reviewCorrectionSample.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = handleSamplesCommand({
      args: 'review reject sample-404',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(result.text).toContain('Failed to review sample');
  });
});
