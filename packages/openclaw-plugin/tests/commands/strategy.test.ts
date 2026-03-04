import { describe, it, expect } from 'vitest';
import { handleInitStrategy, handleManageOkr } from '../../src/commands/strategy';

describe('Slash Commands Hook', () => {
  it('should handle /init-strategy command', () => {
    const mockCtx = { 
        workspaceDir: '/mock/workspace',
        commandBody: '/init-strategy',
        channel: 'cli',
        isAuthorizedSender: true,
        config: {} as any
    };

    const result = handleInitStrategy(mockCtx as any);

    expect(result).toBeDefined();
    expect(result.text).toContain('Strategy Initialization');
  });

  it('should handle /manage-okr command', () => {
    const mockCtx = { 
        workspaceDir: '/mock/workspace',
        commandBody: '/manage-okr',
        channel: 'cli',
        isAuthorizedSender: true,
        config: {} as any
    };

    const result = handleManageOkr(mockCtx as any);

    expect(result).toBeDefined();
    expect(result.text).toContain('OKR Management');
  });
});