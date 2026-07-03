/**
 * Onboarding state persistence with workspaceId dimension.
 * Prevents cross-workspace state leakage (spec §6.3 改动 1).
 * localStorage is the single source of truth (no cross-device sync — YAGNI).
 */

export interface OnboardingState {
  completed: boolean;
  step: number; // 0=not started, 1=welcome, 2=demo, 3=commands, 4=invite
  status: 'pending' | 'demo' | 'skipped' | 'evidence_found';
  completedAt?: string; // ISO timestamp
}

const DEFAULT_STATE: OnboardingState = {
  completed: false,
  step: 0,
  status: 'pending',
};

export const ONBOARDING_STORAGE_KEY_PREFIX = 'pd_onboarding';

function storageKey(workspaceId: string): string {
  return `${ONBOARDING_STORAGE_KEY_PREFIX}_${workspaceId}`;
}

/**
 * Type guard for OnboardingState (rc-2: no `as` bypass).
 */
function isOnboardingState(value: unknown): value is OnboardingState {
  if (typeof value !== 'object' || value === null) return false;
  const completed = Object.hasOwn(value, 'completed') ? Reflect.get(value, 'completed') : undefined;
  const step = Object.hasOwn(value, 'step') ? Reflect.get(value, 'step') : undefined;
  const status = Object.hasOwn(value, 'status') ? Reflect.get(value, 'status') : undefined;
  const completedAt = Object.hasOwn(value, 'completedAt') ? Reflect.get(value, 'completedAt') : undefined;
  return (
    typeof completed === 'boolean' &&
    typeof step === 'number' &&
    (status === 'pending' || status === 'demo' || status === 'skipped' || status === 'evidence_found') &&
    (!Object.hasOwn(value, 'completedAt') || typeof completedAt === 'string')
  );
}

/**
 * Get onboarding state for a specific workspace.
 * Treats localStorage data as unknown (rc-1) — validates shape before use.
 */
export function getOnboardingState(workspaceId: string): OnboardingState {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) return DEFAULT_STATE;
    // rc-1: treat parsed JSON as unknown, validate shape
    const parsed: unknown = JSON.parse(raw);
    if (!isOnboardingState(parsed)) return DEFAULT_STATE;
    return parsed;
  } catch (err) {
    // rc-9: surface the failure — don't silently swallow.
    console.error('[onboarding-state] Failed to read onboarding state:', err);
    return DEFAULT_STATE;
  }
}

/**
 * Set onboarding state for a specific workspace.
 */
export function setOnboardingState(workspaceId: string, state: OnboardingState): boolean {
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state));
    return true;
  } catch (err) {
    // rc-9: surface the failure — don't silently swallow.
    console.error('[onboarding-state] Failed to save onboarding state:', err);
    return false;
  }
}

/**
 * Reset onboarding state for a specific workspace (Settings page "reset" button).
 */
export function resetOnboardingState(workspaceId: string): boolean {
  try {
    localStorage.removeItem(storageKey(workspaceId));
    return true;
  } catch (err) {
    console.error('[onboarding-state] Failed to reset onboarding state:', err);
    return false;
  }
}
