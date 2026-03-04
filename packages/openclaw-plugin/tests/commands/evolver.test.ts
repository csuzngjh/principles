import { describe, it, expect, vi } from 'vitest';
import { handleEvolveTask, triggerEvolverHandoff } from '../../src/commands/evolver';

describe('Evolver Synergy Module', () => {
  it('should handle /evolve-task command', () => {
    const mockCtx = { 
        workspaceDir: '/mock/workspace',
        commandBody: '/evolve-task',
        channel: 'cli',
        isAuthorizedSender: true,
        config: {} as any
    };

    const result = handleEvolveTask(mockCtx as any);

    expect(result).toBeDefined();
    expect(result.text).toContain('Evolver handoff initiated');
  });

  it('should generate sessions_spawn payload', () => {
    const payload = triggerEvolverHandoff('/mock/workspace', 'Fix failing unit tests in core logic');
    expect(payload).toContain('sessions_spawn');
    expect(payload).toContain('Fix failing unit tests');
    expect(payload).toContain('evolver');
  });
});