import { describe, it, expect, vi } from 'vitest';
import { AgentScheduler } from '../agent-scheduler.js';

// Sample payload/output fixtures use the only scheduler-routed agent contract
// ('correction-observer') — the 'empathy-observer' entry was removed in PRI-819.
const samplePayload = {
  parentSessionId: 'sess-1',
  workspaceDir: '/tmp/ws',
  keywordStoreSummary: {
    totalKeywords: 1,
    terms: [{ term: 'retry', weight: 1, truePositiveCount: 2, falsePositiveCount: 0 }],
  },
  recentMessages: ['again it failed'],
  trajectoryHistory: [
    { sessionId: 'sess-1', timestamp: '2026-09-17T00:00:00.000Z', term: 'retry', userMessage: 'again it failed' },
  ],
};

describe('AgentScheduler', () => {
  it('registers and dispatches agents with strong typing', async () => {
    const scheduler = new AgentScheduler();

    const mockCorrectionRunner = {
      run: vi.fn().mockResolvedValue({
        updated: true,
        summary: 'Keyword trigger matched',
      }),
    };

    scheduler.register({
      agentId: 'correction-observer',
      mode: 'realtime',
      runner: mockCorrectionRunner,
    });

    const registered = scheduler.getRegisteredAgents();
    expect(registered).toEqual([
      { agentId: 'correction-observer', mode: 'realtime' },
    ]);

    const result = await scheduler.dispatch('correction-observer', samplePayload);
    expect(mockCorrectionRunner.run).toHaveBeenCalledWith(samplePayload);
    expect(result.updated).toBe(true);
  });

  it('throws error when dispatching non-registered agent', async () => {
    const scheduler = new AgentScheduler();
    await expect(
      scheduler.dispatch('correction-observer', samplePayload)
    ).rejects.toThrow('Agent correction-observer is not registered in AgentScheduler');
  });

  it('allows overriding an existing agent registration (Map.set override)', async () => {
    const scheduler = new AgentScheduler();
    const runner1 = { run: vi.fn().mockResolvedValue({ updated: false, summary: 'r1' }) };
    const runner2 = { run: vi.fn().mockResolvedValue({ updated: true, summary: 'r2' }) };

    scheduler.register({ agentId: 'correction-observer', mode: 'realtime', runner: runner1 });
    scheduler.register({ agentId: 'correction-observer', mode: 'realtime', runner: runner2 });

    const result = await scheduler.dispatch('correction-observer', samplePayload);
    expect(runner1.run).not.toHaveBeenCalled();
    expect(runner2.run).toHaveBeenCalledWith(samplePayload);
    expect(result.updated).toBe(true);
  });

  it('returns empty array when no agents are registered', () => {
    const scheduler = new AgentScheduler();
    expect(scheduler.getRegisteredAgents()).toEqual([]);
  });
});
