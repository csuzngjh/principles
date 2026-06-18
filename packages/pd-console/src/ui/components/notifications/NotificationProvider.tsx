import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchGovernanceQueue } from '../../api.js';
import { useNotificationSound } from '../../hooks/useNotificationSound.js';
import { diffNotificationCounts } from './notification-reducer.js';
import { loadSoundEnabled, saveSoundEnabled } from './sound-storage.js';
import { updateFaviconAndTitle } from './favicon-badge.js';

export type NotificationState = {
  pendingCount: number;
  degradedCount: number;
  soundEnabled: boolean;
};

export type NotificationContextValue = NotificationState & {
  setSoundEnabled: (enabled: boolean) => void;
  audioUnlocked: boolean;
};

const POLL_INTERVAL_MS = 30000;

export const NotificationContext = createContext<NotificationContextValue | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NotificationState>({
    pendingCount: 0,
    degradedCount: 0,
    soundEnabled: loadSoundEnabled(),
  });

  const { playSound, unlockAudio, audioUnlocked } = useNotificationSound();
  const prevCountsRef = useRef({ pendingCount: 0, degradedCount: 0 });
  const pendingAlertWhileHiddenRef = useRef(false);
  const degradedAlertWhileHiddenRef = useRef(false);

  const setSoundEnabled = useCallback((enabled: boolean) => {
    saveSoundEnabled(enabled);
    setState((prev) => ({ ...prev, soundEnabled: enabled }));
  }, []);

  const poll = useCallback(async () => {
    const result = await fetchGovernanceQueue();
    if (!result.success) {
      console.warn('Notification poll failed:', result.error);
      return;
    }

    const pendingCount = result.data.pendingReviewCount;
    const degradedCount = result.data.degradedSignals?.length ?? 0;

    setState((prev) => ({
      ...prev,
      pendingCount,
      degradedCount,
    }));
  }, []);

  // Initial poll + interval
  useEffect(() => {
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

  // Play sounds when counts increase (respect hidden state)
  useEffect(() => {
    if (typeof document !== 'undefined' && document.hidden) {
      const diff = diffNotificationCounts(state, prevCountsRef.current);
      if (diff.pendingIncreased) pendingAlertWhileHiddenRef.current = true;
      if (diff.degradedIncreased) degradedAlertWhileHiddenRef.current = true;
      prevCountsRef.current = {
        pendingCount: state.pendingCount,
        degradedCount: state.degradedCount,
      };
      return;
    }

    if (!state.soundEnabled || !audioUnlocked) {
      prevCountsRef.current = {
        pendingCount: state.pendingCount,
        degradedCount: state.degradedCount,
      };
      return;
    }

    const diff = diffNotificationCounts(state, prevCountsRef.current);

    if (diff.pendingIncreased || pendingAlertWhileHiddenRef.current) {
      playSound('pending');
      pendingAlertWhileHiddenRef.current = false;
    }
    if (diff.degradedIncreased || degradedAlertWhileHiddenRef.current) {
      playSound('degraded');
      degradedAlertWhileHiddenRef.current = false;
    }

    prevCountsRef.current = {
      pendingCount: state.pendingCount,
      degradedCount: state.degradedCount,
    };
  }, [state, playSound, audioUnlocked]);

  // Update favicon + title
  useEffect(() => {
    updateFaviconAndTitle(state.pendingCount, state.degradedCount);
  }, [state.pendingCount, state.degradedCount]);

  // Unlock audio on first user interaction
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleInteraction = () => {
      unlockAudio();
    };

    window.addEventListener('click', handleInteraction, { once: true });
    window.addEventListener('keydown', handleInteraction, { once: true });

    return () => {
      window.removeEventListener('click', handleInteraction);
      window.removeEventListener('keydown', handleInteraction);
    };
  }, [unlockAudio]);

  // Re-poll immediately when tab becomes visible
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [poll]);

  return (
    <NotificationContext.Provider value={{ ...state, setSoundEnabled, audioUnlocked }}>
      {children}
    </NotificationContext.Provider>
  );
}
