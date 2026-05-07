/**
 * Correction cue detection — detects when user signals frustration/correction.
 *
 * Phase: PRI-75 Prompt Injection SDK Migration Phase 1
 */

const CORRECTION_CUES = [
  '不是这个',
  '不对',
  '错了',
  '搞错了',
  '理解错了',
  '你理解错了',
  '重新来',
  '再试一次',
  'you are wrong',
  'wrong file',
  'not this',
  'redo',
  'try again',
  'again',
  'please redo',
  'please try again',
] as const;

/**
 * Detects if text contains a correction/cue phrase.
 *
 * Uses substring matching — may produce false positives for short cues
 * like 'again' (e.g., "once again" would match).
 *
 * Returns the matched cue string, or null if none detected.
 */
export function detectCorrectionCue(text: string): string | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:，。！？；：]/g, '');
  return CORRECTION_CUES.find((cue) => normalized.includes(cue)) ?? null;
}