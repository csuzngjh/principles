import { describe, it, expect } from 'vitest';
import { handleEvolveTask } from '../../src/commands/evolver';

describe('Evolver Synergy Module', () => {
  it('should handle /evolve-task command', () => {
    const mockCtx = { 
        workspaceDir: '/mock/workspace',
        commandBody: '/evolve-task',
        channel: 'cli',
        isAuthorizedSender: true,
        config: {} as any,
        args: 'Fix tests'
    };

    const result = handleEvolveTask(mockCtx as any);

    expect(result).toBeDefined();
    expect(result.text).toContain('Evolver Handoff Requested');
    expect(result.text).toContain('sessions_spawn');
    expect(result.text).toContain('Fix tests');
  });
});