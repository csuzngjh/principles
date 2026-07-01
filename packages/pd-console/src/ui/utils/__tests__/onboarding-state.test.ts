import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

import { getOnboardingState, setOnboardingState, resetOnboardingState, ONBOARDING_STORAGE_KEY_PREFIX } from '../onboarding-state.js';

describe('Onboarding state with workspaceId dimension', () => {
  beforeEach(() => {
    localStorageMock.clear();
    localStorageMock.getItem.mockClear();
    localStorageMock.setItem.mockClear();
    localStorageMock.removeItem.mockClear();
  });

  it('reports write and reset failures so callers cannot show false success', () => {
    localStorageMock.setItem.mockImplementationOnce(() => { throw new Error('quota'); });
    expect(setOnboardingState('ws-full', { completed: true, step: 3, status: 'demo' })).toBe(false);
    localStorageMock.removeItem.mockImplementationOnce(() => { throw new Error('blocked'); });
    expect(resetOnboardingState('ws-full')).toBe(false);
  });

  it('Given new workspace, When getOnboardingState called, Then returns default incomplete state', () => {
    const state = getOnboardingState('ws-123');
    expect(state.completed).toBe(false);
    expect(state.step).toBe(0);
    expect(state.status).toBe('pending');
  });

  it('Given onboarding completed, When setOnboardingState called with demo status, Then state persisted with workspaceId key', () => {
    setOnboardingState('ws-123', { completed: true, step: 3, status: 'demo' });
    const state = getOnboardingState('ws-123');
    expect(state.completed).toBe(true);
    expect(state.status).toBe('demo');
    expect(state.step).toBe(3);
  });

  it('Given two workspaces, When state set for ws-A, Then ws-B state is independent (no cross-workspace leakage)', () => {
    setOnboardingState('ws-A', { completed: true, step: 3, status: 'demo' });
    const stateB = getOnboardingState('ws-B');
    expect(stateB.completed).toBe(false);
    expect(stateB.status).toBe('pending');
  });

  it('Given completed onboarding, When resetOnboardingState called, Then state returns to default', () => {
    setOnboardingState('ws-123', { completed: true, step: 3, status: 'skipped' });
    resetOnboardingState('ws-123');
    const state = getOnboardingState('ws-123');
    expect(state.completed).toBe(false);
    expect(state.step).toBe(0);
    expect(state.status).toBe('pending');
  });

  it('Given malformed localStorage data, When getOnboardingState called, Then returns safe default (rc-1 treat as unknown)', () => {
    localStorageMock.getItem.mockReturnValueOnce('not-json');
    const state = getOnboardingState('ws-broken');
    expect(state.completed).toBe(false);
    expect(state.status).toBe('pending');
  });

  it('Given non-string completedAt, When state is loaded, Then rejects the malformed contract', () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({
      completed: true, step: 3, status: 'evidence_found', completedAt: 123,
    }));
    expect(getOnboardingState('ws-invalid-date')).toEqual({
      completed: false, step: 0, status: 'pending',
    });
  });

  it('Given localStorage key prefix, Then key format is pd_onboarding_<workspaceId>', () => {
    setOnboardingState('ws-123', { completed: true, step: 3, status: 'demo' });
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      `${ONBOARDING_STORAGE_KEY_PREFIX}_ws-123`,
      expect.any(String)
    );
  });
});
