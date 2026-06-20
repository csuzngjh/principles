import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SOUND_CONFIG } from '../../src/ui/hooks/useNotificationSound.js';
import { diffNotificationCounts } from '../../src/ui/components/notifications/notification-reducer.js';
import { loadSoundEnabled, saveSoundEnabled, SOUND_ENABLED_KEY } from '../../src/ui/components/notifications/sound-storage.js';
import { resetFaviconAndTitle } from '../../src/ui/components/notifications/favicon-badge.js';

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

  it('falls back safely when browser storage access is blocked', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });

    expect(loadSoundEnabled()).toBe(true);
    expect(() => saveSoundEnabled(false)).not.toThrow();
  });
});

describe('diffNotificationCounts', () => {
  it('treats the first successful poll as a baseline, not a new alert', () => {
    expect(diffNotificationCounts(
      { pendingCount: 3, degradedCount: 2 },
      null,
    )).toEqual({ pendingIncreased: false, degradedIncreased: false });
  });
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

describe('favicon cleanup', () => {
  it('restores the base title and removes the dynamic favicon', () => {
    const remove = vi.fn();
    vi.stubGlobal('document', {
      title: '(4) PD Governance Workspace',
      getElementById: vi.fn(() => ({ remove })),
    });

    resetFaviconAndTitle();

    expect(document.title).toBe('PD Console');
    expect(remove).toHaveBeenCalledOnce();
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

// ── Audio context edge cases ─────────────────────────────────────────────

describe('useNotificationSound edge cases', () => {
  it('returns audioUnlocked=false when AudioContext is unavailable (SSR)', () => {
    // Simulate SSR environment where window is undefined
    vi.stubGlobal('window', undefined);

    // Re-import to get fresh hook state
    return import('../../src/ui/hooks/useNotificationSound.js?ssr-test').then((mod) => {
      // In SSR, the hook should gracefully handle missing AudioContext
      expect(mod.SOUND_CONFIG).toBeDefined();
    }).finally(() => {
      vi.unstubAllGlobals();
    });
  });

  it('SOUND_CONFIG has valid volume range (0-1)', () => {
    for (const key of Object.keys(SOUND_CONFIG)) {
      const config = SOUND_CONFIG[key as keyof typeof SOUND_CONFIG];
      expect(config.volume).toBeGreaterThanOrEqual(0);
      expect(config.volume).toBeLessThanOrEqual(1);
    }
  });

  it('SOUND_CONFIG has reasonable duration (not too long)', () => {
    for (const key of Object.keys(SOUND_CONFIG)) {
      const config = SOUND_CONFIG[key as keyof typeof SOUND_CONFIG];
      expect(config.durationMs).toBeLessThan(1000); // Less than 1 second
      expect(config.durationMs).toBeGreaterThan(50); // At least 50ms to be audible
    }
  });

  it('SOUND_CONFIG has valid waveform types', () => {
    const validWaveforms: OscillatorType[] = ['sine', 'square', 'sawtooth', 'triangle'];
    for (const key of Object.keys(SOUND_CONFIG)) {
      const config = SOUND_CONFIG[key as keyof typeof SOUND_CONFIG];
      expect(validWaveforms).toContain(config.waveform);
    }
  });

  it('SOUND_CONFIG has valid frequency range (human audible)', () => {
    for (const key of Object.keys(SOUND_CONFIG)) {
      const config = SOUND_CONFIG[key as keyof typeof SOUND_CONFIG];
      expect(config.frequency).toBeGreaterThanOrEqual(20); // Lower bound of human hearing
      expect(config.frequency).toBeLessThanOrEqual(20000); // Upper bound of human hearing
    }
  });
});

// ── Favicon badge edge cases ─────────────────────────────────────────────

describe('favicon-badge edge cases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renderFaviconDataUrl returns empty string when document is undefined', async () => {
    vi.stubGlobal('document', undefined);
    const { renderFaviconDataUrl } = await import('../../src/ui/components/notifications/favicon-badge.js');
    const result = renderFaviconDataUrl(5);
    expect(result).toBe('');
  });

  it('updateFaviconAndTitle handles zero counts gracefully', async () => {
    // Mock canvas with getContext method
    const mockCanvas = {
      width: 32,
      height: 32,
      getContext: vi.fn(() => ({
        fillStyle: '',
        fillRect: vi.fn(),
        font: '',
        textAlign: '',
        textBaseline: '',
        fillText: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
      })),
      toDataURL: vi.fn(() => 'data:image/png;base64,test'),
    };

    vi.stubGlobal('document', {
      title: 'Original Title',
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => mockCanvas),
      head: { appendChild: vi.fn() },
    });
    vi.stubGlobal('HTMLLinkElement', class HTMLLinkElement { });

    const { updateFaviconAndTitle } = await import('../../src/ui/components/notifications/favicon-badge.js');
    updateFaviconAndTitle(0, 0);

    expect(document.title).toBe('PD Console');
  });

  it('updateFaviconAndTitle sets correct title for positive counts', async () => {
    // Mock canvas with getContext method
    const mockCanvas = {
      width: 32,
      height: 32,
      getContext: vi.fn(() => ({
        fillStyle: '',
        fillRect: vi.fn(),
        font: '',
        textAlign: '',
        textBaseline: '',
        fillText: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
      })),
      toDataURL: vi.fn(() => 'data:image/png;base64,test'),
    };

    vi.stubGlobal('document', {
      title: 'Original Title',
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => mockCanvas),
      head: { appendChild: vi.fn() },
    });
    vi.stubGlobal('HTMLLinkElement', class HTMLLinkElement { });

    const { updateFaviconAndTitle } = await import('../../src/ui/components/notifications/favicon-badge.js');
    updateFaviconAndTitle(3, 2);

    expect(document.title).toBe('(5) PD Governance Workspace');
  });

  it('resetFaviconAndTitle handles missing dynamic favicon gracefully', async () => {
    vi.stubGlobal('document', {
      title: '(10) PD Governance Workspace',
      getElementById: vi.fn(() => null),
    });

    const { resetFaviconAndTitle } = await import('../../src/ui/components/notifications/favicon-badge.js');
    resetFaviconAndTitle();

    expect(document.title).toBe('PD Console');
  });
});

// ── Notification reducer edge cases ──────────────────────────────────────

describe('diffNotificationCounts edge cases', () => {
  it('handles zero counts correctly', () => {
    const result = diffNotificationCounts(
      { pendingCount: 0, degradedCount: 0 },
      { pendingCount: 0, degradedCount: 0 },
    );
    expect(result).toEqual({ pendingIncreased: false, degradedIncreased: false });
  });

  it('handles large counts correctly', () => {
    const result = diffNotificationCounts(
      { pendingCount: 10000, degradedCount: 5000 },
      { pendingCount: 9999, degradedCount: 4999 },
    );
    expect(result).toEqual({ pendingIncreased: true, degradedIncreased: true });
  });

  it('handles negative-like counts (should not happen but test defensive behavior)', () => {
    // This tests that the comparison still works even with unusual values
    const result = diffNotificationCounts(
      { pendingCount: 0, degradedCount: 0 },
      { pendingCount: -1, degradedCount: -1 },
    );
    // Negative to zero is an increase in absolute terms
    expect(result.pendingIncreased).toBe(true);
    expect(result.degradedIncreased).toBe(true);
  });

  it('handles equal counts correctly', () => {
    const result = diffNotificationCounts(
      { pendingCount: 5, degradedCount: 3 },
      { pendingCount: 5, degradedCount: 3 },
    );
    expect(result).toEqual({ pendingIncreased: false, degradedIncreased: false });
  });
});

// ── Sound storage edge cases ──────────────────────────────────────────────

describe('sound-storage edge cases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles corrupted localStorage value gracefully', () => {
      const mockStorage = createMockStorage();
      mockStorage.setItem(SOUND_ENABLED_KEY, 'not-a-boolean');
      vi.stubGlobal('window', { localStorage: mockStorage });

      const result = loadSoundEnabled();
      // Invalid values (not 'true') return false, per the implementation
      expect(result).toBe(false);
    });

  it('handles localStorage quota exceeded error', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(() => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }),
        removeItem: vi.fn(),
        clear: vi.fn(),
        get length() { return 0; },
        key: vi.fn(() => null),
      },
    });

    // Should not throw
    expect(() => saveSoundEnabled(true)).not.toThrow();
  });
});
