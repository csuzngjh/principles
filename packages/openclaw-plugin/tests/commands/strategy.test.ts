import { describe, it, expect } from 'vitest';
import { handleInitStrategy } from '../../src/commands/strategy';

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
    expect(result.text).toContain('Principle Context 初始化访谈');
    // Interview + draft output only: the command must not instruct file writes.
    expect(result.text).toContain('禁止');
    expect(result.text).not.toContain('Generate CURRENT_FOCUS');
  });
});
