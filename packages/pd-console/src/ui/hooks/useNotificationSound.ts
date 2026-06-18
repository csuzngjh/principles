import { useCallback, useRef, useState } from 'react';

export type NotificationSoundType = 'pending' | 'degraded';

export const SOUND_CONFIG: Record<NotificationSoundType, {
  waveform: OscillatorType;
  frequency: number;
  durationMs: number;
  volume: number;
}> = {
  pending: { waveform: 'sine', frequency: 880, durationMs: 150, volume: 0.3 },
  degraded: { waveform: 'triangle', frequency: 440, durationMs: 200, volume: 0.3 },
};

export function useNotificationSound() {
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);

  const unlockAudio = useCallback(() => {
    if (audioUnlocked) return;
    if (typeof window === 'undefined' || !window.AudioContext) return;

    try {
      const ctx = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = ctx;
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          setAudioUnlocked(true);
        }).catch(() => {
          // Autoplay policy blocked; remain locked.
        });
      } else {
        setAudioUnlocked(true);
      }
    } catch (err) {
      console.warn('Failed to unlock audio:', err);
    }
  }, [audioUnlocked]);

  const playSound = useCallback((type: NotificationSoundType) => {
    if (!audioUnlocked) return;
    if (typeof window === 'undefined' || !window.AudioContext) return;

    try {
      const ctx = audioContextRef.current ?? new AudioContext();
      audioContextRef.current = ctx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
        return;
      }

      const config = SOUND_CONFIG[type];
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.type = config.waveform;
      oscillator.frequency.setValueAtTime(config.frequency, ctx.currentTime);

      gainNode.gain.setValueAtTime(config.volume, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(
        0.001,
        ctx.currentTime + config.durationMs / 1000,
      );

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + config.durationMs / 1000);
    } catch (err) {
      console.warn('Failed to play notification sound:', err);
    }
  }, [audioUnlocked]);

  return { playSound, unlockAudio, audioUnlocked };
}
