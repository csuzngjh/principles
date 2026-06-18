export const SOUND_ENABLED_KEY = 'pd-sound-enabled';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    // eslint-disable-next-line no-undef
    return window.localStorage;
  } catch (error: unknown) {
    console.warn('Sound preference storage is unavailable:', error);
    return null;
  }
}

export function loadSoundEnabled(): boolean {
  const storage = getStorage();
  if (!storage) return true;
  try {
    const stored = storage.getItem(SOUND_ENABLED_KEY);
    return stored === null ? true : stored === 'true';
  } catch (error: unknown) {
    console.warn('Failed to read sound preference:', error);
    return true;
  }
}

export function saveSoundEnabled(enabled: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(SOUND_ENABLED_KEY, String(enabled));
  } catch (error: unknown) {
    console.warn('Failed to save sound preference:', error);
  }
}
