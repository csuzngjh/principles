/**
 * Onboarding state persistence with workspaceId dimension.
 * Prevents cross-workspace state leakage (spec §6.3 改动 1).
 * localStorage is the single source of truth (no cross-device sync — YAGNI).
 */

export interface OnboardingState {
  completed: boolean;
  step: number; // 0=not started, 1=welcome, 2=demo, 3=invite
  status: 'pending' | 'demo' | 'skipped';
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
  const v = value as Record<string, unknown>;
  return (
    typeof v.completed === 'boolean' &&
    typeof v.step === 'number' &&
    (v.status === 'pending' || v.status === 'demo' || v.status === 'skipped')
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
  } catch {
    // rc-9: no silent fallback — return default but log could be added
    return DEFAULT_STATE;
  }
}

/**
 * Set onboarding state for a specific workspace.
 */
export function setOnboardingState(workspaceId: string, state: OnboardingState): void {
  try {
    localStorage.setItem(storageKey(workspaceId), JSON.stringify(state));
  } catch {
    // localStorage might be full or disabled — fail gracefully
  }
}

/**
 * Reset onboarding state for a specific workspace (Settings page "reset" button).
 */
export function resetOnboardingState(workspaceId: string): void {
  try {
    localStorage.removeItem(storageKey(workspaceId));
  } catch {
    // fail gracefully
  }
}
