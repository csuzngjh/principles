import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SOUND_CONFIG } from '../../src/ui/hooks/useNotificationSound.js';
import { diffNotificationCounts } from '../../src/ui/components/notifications/notification-reducer.js';
import { loadSoundEnabled, saveSoundEnabled, SOUND_ENABLED_KEY } from '../../src/ui/components/notifications/sound-storage.js';

describe('SOUND_CONFIG', () => {
  it('pending sound uses sine wave at 880 Hz for 150 ms', () => {
    expect(SOUND_CONFIG.pending).toEqual({
      waveform: 'sine',
      frequency: 880,
      durationMs: 150,
      volume: 0.3,
    });
  });

  it('degraded sound uses triangle wave at 440 Hz for 200 ms', () => {
    expect(SOUND_CONFIG.degraded).toEqual({
      waveform: 'triangle',
      frequency: 440,
      durationMs: 200,
      volume: 0.3,
    });
  });
});

function createMockStorage(): Storage {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const key of Object.keys(store)) delete store[key]; },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
}

describe('sound-storage', () => {
  let mockStorage: Storage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    vi.stubGlobal('window', { localStorage: mockStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to true when no value is stored', () => {
    expect(loadSoundEnabled()).toBe(true);
  });

  it('reads false from localStorage', () => {
    saveSoundEnabled(false);
    expect(loadSoundEnabled()).toBe(false);
    expect(mockStorage.getItem(SOUND_ENABLED_KEY)).toBe('false');
  });

  it('reads true from localStorage', () => {
    saveSoundEnabled(true);
    expect(loadSoundEnabled()).toBe(true);
    expect(mockStorage.getItem(SOUND_ENABLED_KEY)).toBe('true');
  });
});

describe('diffNotificationCounts', () => {
  it('detects pending increase', () => {
    const result = diffNotificationCounts(
      { pendingCount: 3, degradedCount: 0 },
      { pendingCount: 1, degradedCount: 0 },
    );
    expect(result).toEqual({ pendingIncreased: true, degradedIncreased: false });
  });

  it('detects degraded increase', () => {
    const result = diffNotificationCounts(
      { pendingCount: 0, degradedCount: 2 },
      { pendingCount: 0, degradedCount: 1 },
    );
    expect(result).toEqual({ pendingIncreased: false, degradedIncreased: true });
  });

  it('ignores no change', () => {
    const result = diffNotificationCounts(
      { pendingCount: 1, degradedCount: 1 },
      { pendingCount: 1, degradedCount: 1 },
    );
    expect(result).toEqual({ pendingIncreased: false, degradedIncreased: false });
  });

  it('ignores decreases', () => {
    const result = diffNotificationCounts(
      { pendingCount: 1, degradedCount: 0 },
      { pendingCount: 3, degradedCount: 2 },
    );
    expect(result).toEqual({ pendingIncreased: false, degradedIncreased: false });
  });
});

describe('Notification components can be imported', () => {
  it('imports NotificationProvider', async () => {
    const mod = await import('../../src/ui/components/notifications/NotificationProvider.js');
    expect(mod.NotificationProvider).toBeDefined();
    expect(typeof mod.NotificationProvider).toBe('function');
  });

  it('imports useNotifications', async () => {
    const mod = await import('../../src/ui/components/notifications/useNotifications.js');
    expect(mod.useNotifications).toBeDefined();
    expect(typeof mod.useNotifications).toBe('function');
  });
});
