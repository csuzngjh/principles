/**
 * PD Profile Defaults — PRI-304 / PRI-466
 *
 * Deterministic defaults for agent behavioral profile config.
 * Matches existing PROFILE_DEFAULTS in openclaw-plugin/src/core/profile.ts
 * for backward compatibility with the transition to core types.
 *
 * All defaults are testable and explicit.
 *
 * PRI-286 retirement cleanup (2026-08-19): the gate / progressive_gate /
 * thinking_checkpoint defaults were removed. The runtime no longer executes
 * any built-in gate from these keys (RuleHost is the sole gate); workspaces
 * that still carry the legacy keys get a deprecation warning from
 * pd-validate-profile.ts, not a resolved default.
 */

import {
  type ProfileConfig,
  type ProfileTestsConfig,
  type ProfileAdaptivePainConfig,
  type ProfilePainConfig,
  type ProfileLifecycleConfig,
  type ProfileEditVerificationConfig,
  type ProfileCustomGuard,
} from './pd-config-types.js';

// ── Default Sub-Configs ─────────────────────────────────────────────────────

export const PROFILE_DEFAULT_TESTS: ProfileTestsConfig = {
  on_change: 'smoke',
  on_risk_change: 'unit',
  commands: {},
};

export const PROFILE_DEFAULT_ADAPTIVE_PAIN: ProfileAdaptivePainConfig = {
  enabled: true,
  spiral_boost: 20,
  min_threshold: 15,
  max_threshold: 70,
  backlog_trigger: 6,
  hard_failure_trigger: 1,
  low_recent_success_boost: 15,
  high_recent_pain_boost: 10,
};

export const PROFILE_DEFAULT_PAIN: ProfilePainConfig = {
  soft_capture_threshold: 30,
  adaptive: { ...PROFILE_DEFAULT_ADAPTIVE_PAIN },
};

export const PROFILE_DEFAULT_LIFECYCLE: ProfileLifecycleConfig = {
  enabled: true,
  heartbeat_stale_hours: 72,
};

export const PROFILE_DEFAULT_EDIT_VERIFICATION: ProfileEditVerificationConfig = {
  enabled: true,
  max_file_size_bytes: 10 * 1024 * 1024, // 10MB
  fuzzy_match_enabled: true,
  fuzzy_match_threshold: 0.8,
  skip_large_file_action: 'warn',
};

export const PROFILE_DEFAULT_CUSTOM_GUARDS: ProfileCustomGuard[] = [];

// ── Full Profile Defaults ───────────────────────────────────────────────────

export const PROFILE_DEFAULTS: ProfileConfig = {
  audit_level: 'medium',
  risk_paths: [],
  evolution_mode: 'realtime',
  tests: { ...PROFILE_DEFAULT_TESTS },
  pain: {
    soft_capture_threshold: PROFILE_DEFAULT_PAIN.soft_capture_threshold,
    adaptive: { ...PROFILE_DEFAULT_ADAPTIVE_PAIN },
  },
  lifecycle: { ...PROFILE_DEFAULT_LIFECYCLE },
  edit_verification: { ...PROFILE_DEFAULT_EDIT_VERIFICATION },
  custom_guards: [],
};

/**
 * Deep-merge a partial user profile with PROFILE_DEFAULTS.
 * Returns a fully resolved ProfileConfig.
 *
 * Legacy keys (gate / progressive_gate / thinking_checkpoint) are ignored:
 * they are not part of the canonical contract and are flagged with a
 * deprecation warning by validateProfileConfig before this merge runs.
 */
export function resolveProfile(userProfile: Partial<ProfileConfig> | undefined): ProfileConfig {
  if (!userProfile) {
    return { ...PROFILE_DEFAULTS };
  }

  return {
    audit_level: userProfile.audit_level ?? PROFILE_DEFAULTS.audit_level,
    risk_paths: userProfile.risk_paths ?? PROFILE_DEFAULTS.risk_paths,
    evolution_mode: userProfile.evolution_mode ?? PROFILE_DEFAULTS.evolution_mode,
    tests: {
      on_change: userProfile.tests?.on_change ?? PROFILE_DEFAULTS.tests.on_change,
      on_risk_change: userProfile.tests?.on_risk_change ?? PROFILE_DEFAULTS.tests.on_risk_change,
      commands: { ...PROFILE_DEFAULTS.tests.commands, ...(userProfile.tests?.commands ?? {}) },
    },
    pain: {
      soft_capture_threshold: userProfile.pain?.soft_capture_threshold ?? PROFILE_DEFAULTS.pain.soft_capture_threshold,
      adaptive: {
        enabled: userProfile.pain?.adaptive?.enabled ?? PROFILE_DEFAULTS.pain.adaptive.enabled,
        spiral_boost: userProfile.pain?.adaptive?.spiral_boost ?? PROFILE_DEFAULTS.pain.adaptive.spiral_boost,
        min_threshold: userProfile.pain?.adaptive?.min_threshold ?? PROFILE_DEFAULTS.pain.adaptive.min_threshold,
        max_threshold: userProfile.pain?.adaptive?.max_threshold ?? PROFILE_DEFAULTS.pain.adaptive.max_threshold,
        backlog_trigger: userProfile.pain?.adaptive?.backlog_trigger ?? PROFILE_DEFAULTS.pain.adaptive.backlog_trigger,
        hard_failure_trigger: userProfile.pain?.adaptive?.hard_failure_trigger ?? PROFILE_DEFAULTS.pain.adaptive.hard_failure_trigger,
        low_recent_success_boost: userProfile.pain?.adaptive?.low_recent_success_boost ?? PROFILE_DEFAULTS.pain.adaptive.low_recent_success_boost,
        high_recent_pain_boost: userProfile.pain?.adaptive?.high_recent_pain_boost ?? PROFILE_DEFAULTS.pain.adaptive.high_recent_pain_boost,
      },
    },
    lifecycle: {
      enabled: userProfile.lifecycle?.enabled ?? PROFILE_DEFAULTS.lifecycle.enabled,
      heartbeat_stale_hours: userProfile.lifecycle?.heartbeat_stale_hours ?? PROFILE_DEFAULTS.lifecycle.heartbeat_stale_hours,
    },
    edit_verification: {
      enabled: userProfile.edit_verification?.enabled ?? PROFILE_DEFAULTS.edit_verification.enabled,
      max_file_size_bytes: userProfile.edit_verification?.max_file_size_bytes ?? PROFILE_DEFAULTS.edit_verification.max_file_size_bytes,
      fuzzy_match_enabled: userProfile.edit_verification?.fuzzy_match_enabled ?? PROFILE_DEFAULTS.edit_verification.fuzzy_match_enabled,
      fuzzy_match_threshold: userProfile.edit_verification?.fuzzy_match_threshold ?? PROFILE_DEFAULTS.edit_verification.fuzzy_match_threshold,
      skip_large_file_action: userProfile.edit_verification?.skip_large_file_action ?? PROFILE_DEFAULTS.edit_verification.skip_large_file_action,
    },
    custom_guards: userProfile.custom_guards ?? PROFILE_DEFAULTS.custom_guards,
  };
}
