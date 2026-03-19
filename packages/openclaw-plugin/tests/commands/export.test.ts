import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleExportCommand } from '../../src/commands/export.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('../../src/core/workspace-context.js');

describe('Export Command', () => {
  const mockTrajectory = {
    exportCorrections: vi.fn().mockReturnValue({ filePath: '/tmp/corrections.jsonl', count: 2, mode: 'raw' }),
    exportAnalytics: vi.fn().mockReturnValue({ filePath: '/tmp/analytics.json', count: 4 }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
      trajectory: mockTrajectory,
    } as any);
  });

  it('exports approved raw correction samples by default', () => {
    const result = handleExportCommand({
      args: 'corrections',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(mockTrajectory.exportCorrections).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'raw',
      approvedOnly: true,
    }));
    expect(result.text).toContain('/tmp/corrections.jsonl');
  });

  it('supports redacted correction exports', () => {
    handleExportCommand({
      args: 'corrections --redacted',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(mockTrajectory.exportCorrections).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'redacted',
      approvedOnly: true,
    }));
  });

  it('exports analytics snapshots', () => {
    const result = handleExportCommand({
      args: 'analytics',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(mockTrajectory.exportAnalytics).toHaveBeenCalled();
    expect(result.text).toContain('/tmp/analytics.json');
  });

  it('rejects invalid export targets', () => {
    const result = handleExportCommand({
      args: 'unknown',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(mockTrajectory.exportAnalytics).not.toHaveBeenCalled();
    expect(mockTrajectory.exportCorrections).not.toHaveBeenCalled();
    expect(result.text).toContain('Invalid export target');
  });

  it('returns a user-facing error when export throws', () => {
    mockTrajectory.exportCorrections.mockImplementation(() => {
      throw new Error('disk full');
    });

    const result = handleExportCommand({
      args: 'corrections',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(result.text).toContain('Export failed');
  });
});
