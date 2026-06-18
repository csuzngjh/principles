/* eslint-env browser */
export const SOUND_ENABLED_KEY = 'pd-sound-enabled';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function loadSoundEnabled(): boolean {
  const storage = getStorage();
  if (!storage) return true;
  const stored = storage.getItem(SOUND_ENABLED_KEY);
  return stored === null ? true : stored === 'true';
}

export function saveSoundEnabled(enabled: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(SOUND_ENABLED_KEY, String(enabled));
}
