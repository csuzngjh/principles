import { describe, it, expect, vi } from 'vitest';
import { AgentScheduler } from '../agent-scheduler.js';

describe('AgentScheduler', () => {
  it('registers and dispatches agents with strong typing', async () => {
    const scheduler = new AgentScheduler();

    const mockEmpathyRunner = {
      run: vi.fn().mockResolvedValue({
        damageDetected: true,
        severity: 'mild' as const,
        confidence: 0.7,
        reason: 'Keyword trigger matched',
      }),
    };

    scheduler.register({
      agentId: 'empathy-observer',
      mode: 'realtime',
      runner: mockEmpathyRunner,
    });

    const registered = scheduler.getRegisteredAgents();
    expect(registered).toEqual([
      { agentId: 'empathy-observer', mode: 'realtime' },
    ]);

    const result = await scheduler.dispatch('empathy-observer', { userMessage: 'test message' });
    expect(mockEmpathyRunner.run).toHaveBeenCalledWith({ userMessage: 'test message' });
    expect(result.damageDetected).toBe(true);
    expect(result.severity).toBe('mild');
  });

  it('throws error when dispatching non-registered agent', async () => {
    const scheduler = new AgentScheduler();
    await expect(
      scheduler.dispatch('empathy-observer', { userMessage: 'test' })
    ).rejects.toThrow('Agent empathy-observer is not registered in AgentScheduler');
  });
});
