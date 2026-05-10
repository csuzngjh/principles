import { describe, it, expect } from 'vitest';
import { classifyGfiWorkspaceHealth } from '../gfi/gfi-read-model.js';
import type { GfiWorkspaceSnapshot } from '../gfi/gfi-read-model.js';

function makeSnapshot(overrides: Partial<GfiWorkspaceSnapshot>): GfiWorkspaceSnapshot {
  return {
    active: null,
    staleSessionCount: 0,
    staleGfiRange: null,
    totalSessionCount: 0,
    activeSessionCount: 0,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('classifyGfiWorkspaceHealth', () => {
  it('0 active + stale low GFI → healthy', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 0,
      staleSessionCount: 40,
      staleGfiRange: { min: 0, max: 4.6875 },
      totalSessionCount: 40,
    });

    const result = classifyGfiWorkspaceHealth(snapshot);

    expect(result.status).toBe('healthy');
    expect(result.reason).toContain('low GFI');
  });

  it('0 active + stale high GFI → degraded', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 0,
      staleSessionCount: 25,
      staleGfiRange: { min: 10, max: 55 },
      totalSessionCount: 25,
    });

    const result = classifyGfiWorkspaceHealth(snapshot);

    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('high GFI');
  });

  it('active session with elevated GFI → degraded', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 1,
      staleSessionCount: 0,
      totalSessionCount: 1,
      active: {
        currentGfi: 65,
        stage: 'elevated' as const,
        sources: {},
        dominantSource: null,
        consecutiveErrors: 3,
        lastErrorSource: 'tool_failure',
        policy: {
          elevatedThreshold: 40,
          criticalThreshold: 70,
          saturatedThreshold: 100,
          repeatedFailureMultiplierMax: 3.0,
        },
        consumers: { attitudeMode: 'conciliatory' as const, painDiagnosticReason: 'high_gfi' as const },
      },
    });

    const result = classifyGfiWorkspaceHealth(snapshot);

    expect(result.status).toBe('degraded');
    expect(result.reason).toContain('elevated GFI');
  });

  it('active session with stable GFI → healthy', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 1,
      staleSessionCount: 5,
      staleGfiRange: { min: 0, max: 3 },
      totalSessionCount: 6,
      active: {
        currentGfi: 5,
        stage: 'stable' as const,
        sources: {},
        dominantSource: null,
        consecutiveErrors: 0,
        policy: {
          elevatedThreshold: 40,
          criticalThreshold: 70,
          saturatedThreshold: 100,
          repeatedFailureMultiplierMax: 3.0,
        },
        consumers: { attitudeMode: 'efficient' as const, painDiagnosticReason: 'none' as const },
      },
    });

    const result = classifyGfiWorkspaceHealth(snapshot);

    expect(result.status).toBe('healthy');
  });

  it('0 active + 0 stale → healthy', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 0,
      staleSessionCount: 0,
      totalSessionCount: 0,
    });

    const result = classifyGfiWorkspaceHealth(snapshot);

    expect(result.status).toBe('healthy');
  });

  it('respects custom staleGfiDegradedThreshold', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 0,
      staleSessionCount: 30,
      staleGfiRange: { min: 5, max: 15 },
      totalSessionCount: 30,
    });

    const resultDefault = classifyGfiWorkspaceHealth(snapshot);
    expect(resultDefault.status).toBe('healthy');

    const resultLowThreshold = classifyGfiWorkspaceHealth(snapshot, { staleGfiDegradedThreshold: 10 });
    expect(resultLowThreshold.status).toBe('degraded');
  });

  it('0 active + stale GFI exactly at threshold → degraded', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 0,
      staleSessionCount: 25,
      staleGfiRange: { min: 0, max: 40 },
      totalSessionCount: 25,
    });

    const result = classifyGfiWorkspaceHealth(snapshot);

    expect(result.status).toBe('degraded');
  });

  it('0 active + stale GFI just below threshold → healthy', () => {
    const snapshot = makeSnapshot({
      activeSessionCount: 0,
      staleSessionCount: 25,
      staleGfiRange: { min: 0, max: 39.9 },
      totalSessionCount: 25,
    });

    const result = classifyGfiWorkspaceHealth(snapshot);

    expect(result.status).toBe('healthy');
  });
});
