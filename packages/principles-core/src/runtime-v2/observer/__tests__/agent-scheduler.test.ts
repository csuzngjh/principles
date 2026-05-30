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

  it('allows overriding an existing agent registration (Map.set override)', async () => {
    const scheduler = new AgentScheduler();
    const runner1 = { run: vi.fn().mockResolvedValue({ damageDetected: false, severity: 'mild' as const, confidence: 0.1, reason: 'r1' }) };
    const runner2 = { run: vi.fn().mockResolvedValue({ damageDetected: true, severity: 'severe' as const, confidence: 0.9, reason: 'r2' }) };

    scheduler.register({ agentId: 'empathy-observer', mode: 'realtime', runner: runner1 });
    scheduler.register({ agentId: 'empathy-observer', mode: 'realtime', runner: runner2 });

    const result = await scheduler.dispatch('empathy-observer', { userMessage: 'test' });
    expect(runner1.run).not.toHaveBeenCalled();
    expect(runner2.run).toHaveBeenCalledWith({ userMessage: 'test' });
    expect(result.damageDetected).toBe(true);
    expect(result.severity).toBe('severe');
  });

  it('returns empty array when no agents are registered', () => {
    const scheduler = new AgentScheduler();
    expect(scheduler.getRegisteredAgents()).toEqual([]);
  });
});
