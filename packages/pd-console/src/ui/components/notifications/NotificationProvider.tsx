import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fetchGovernanceQueue, fetchOwnerDecisions } from '../../api.js';
import { useNotificationSound } from '../../hooks/useNotificationSound.js';
import { diffNotificationCounts } from './notification-reducer.js';
import { loadSoundEnabled, saveSoundEnabled } from './sound-storage.js';
import { resetFaviconAndTitle, updateFaviconAndTitle } from './favicon-badge.js';

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
  const prevCountsRef = useRef<{ pendingCount: number; degradedCount: number } | null>(null);
  const hasSuccessfulPollRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const pendingAlertWhileHiddenRef = useRef(false);
  const degradedAlertWhileHiddenRef = useRef(false);

  const setSoundEnabled = useCallback((enabled: boolean) => {
    saveSoundEnabled(enabled);
    setState((prev) => ({ ...prev, soundEnabled: enabled }));
  }, []);

  const poll = useCallback(async () => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    try {
      const result = await fetchGovernanceQueue();
      if (!result.success) {
        console.warn('Notification poll failed:', result.error);
        return;
      }

      const degradedCount = result.data.degradedSignals?.length ?? 0;

      // PRI-629 (SPEC §27): 侧边栏徽标 N = 真实可执行 Owner 决策数
      // (OwnerDecisionItem.length) — 不是 approvals pending / candidate /
      // needs_human_review 计数。投影失败时回退 approvals pending (保守)。
      const decisionsResult = await fetchOwnerDecisions();
      const pendingCount = decisionsResult.success
        ? decisionsResult.data.total
        : result.data.pendingReviewCount;

      hasSuccessfulPollRef.current = true;
      setState((prev) => ({
        ...prev,
        pendingCount,
        degradedCount,
      }));
    } finally {
      pollInFlightRef.current = false;
    }
  }, []);

  // Initial poll + interval
  useEffect(() => {
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

  // Play sounds when counts increase (respect hidden state)
  useEffect(() => {
    if (!hasSuccessfulPollRef.current) return;

    if (typeof document !== 'undefined' && document.hidden) {
      const diff = diffNotificationCounts(state, prevCountsRef.current);
      if (state.soundEnabled && diff.pendingIncreased) pendingAlertWhileHiddenRef.current = true;
      if (state.soundEnabled && diff.degradedIncreased) degradedAlertWhileHiddenRef.current = true;
      prevCountsRef.current = {
        pendingCount: state.pendingCount,
        degradedCount: state.degradedCount,
      };
      return;
    }

    if (!state.soundEnabled || !audioUnlocked) {
      if (!state.soundEnabled) {
        pendingAlertWhileHiddenRef.current = false;
        degradedAlertWhileHiddenRef.current = false;
      }
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

  useEffect(() => () => {
    resetFaviconAndTitle();
  }, []);

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
