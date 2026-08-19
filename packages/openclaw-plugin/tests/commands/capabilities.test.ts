import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBootstrapTools } from '../../src/commands/capabilities.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

vi.mock('../../src/core/workspace-context.js');

describe('Capabilities Command (pd-bootstrap)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns environment perception summary on success', () => {
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
      resolve: vi.fn().mockReturnValue('/tmp/SYSTEM_CAPABILITIES.json'),
    } as any);

    const result = handleBootstrapTools({
      args: '',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(result.text).toContain('Environment perception complete');
    expect(result.text).toContain('Platform');
  });

  it('returns pd-bootstrap failure text when scanning fails (no throw)', () => {
    vi.mocked(WorkspaceContext.fromHookContext).mockReturnValue({
      resolve: vi.fn().mockImplementation(() => {
        throw new Error('mock disk full');
      }),
    } as any);

    const result = handleBootstrapTools({
      args: '',
      config: { workspaceDir: '/mock/workspace', language: 'en' },
    } as any);

    expect(result.text).toContain('pd-bootstrap failed');
    expect(result.text).toContain('mock disk full');
  });
});
