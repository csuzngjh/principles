/**
 * Feature Flag Contract — PRI-239
 *
 * Pure types and validators for the MVP-Quiet feature flag registry.
 * No I/O — YAML loading lives in pd-cli.
 */

export const VALID_CATEGORIES = ['core', 'quiet', 'gone', 'legacy_retire'] as const;
export type FeatureFlagCategory = (typeof VALID_CATEGORIES)[number];

export interface FeatureFlagDefinition {
  id: string;
  category: FeatureFlagCategory;
  enabled: boolean;
  since: string;
  description?: string;
}

export interface EffectiveFeatureFlags {
  flags: Record<string, FeatureFlagDefinition>;
  source: 'defaults' | 'workspace_file';
  configPath: string;
  warnings: string[];
}

export interface ValidationResultOk {
  ok: true;
  value: FeatureFlagDefinition;
}

export interface ValidationResultErr {
  ok: false;
  errors: string[];
  source: string;
}

export type ValidationResult = ValidationResultOk | ValidationResultErr;

export function validateFeatureFlagRaw(raw: unknown, source: string): ValidationResult {
  const errors: string[] = [];

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['input must be a non-null object'], source };
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    errors.push('id must be a non-empty string');
  }

  if (!VALID_CATEGORIES.includes(obj.category as FeatureFlagCategory)) {
    errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  if (typeof obj.enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  if (typeof obj.since !== 'string' || obj.since.length === 0) {
    errors.push('since must be a non-empty string');
  }

  if (obj.description !== undefined && typeof obj.description !== 'string') {
    errors.push('description must be a string when present');
  }

  if (errors.length > 0) {
    return { ok: false, errors, source };
  }

  const value: FeatureFlagDefinition = {
    id: obj.id as string,
    category: obj.category as FeatureFlagCategory,
    enabled: obj.enabled as boolean,
    since: obj.since as string,
  };

  if (obj.description !== undefined) {
    value.description = obj.description as string;
  }

  return { ok: true, value };
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlagDefinition[] = [
  // MVP-Core — always enabled, cannot be disabled
  { id: 'prompt', category: 'core', enabled: true, since: '2026-05-24', description: 'Prompt injection for principle application' },
  { id: 'code_tool_hook', category: 'core', enabled: true, since: '2026-05-24', description: 'Code tool hook for rule host enforcement' },
  { id: 'defer_archive', category: 'core', enabled: true, since: '2026-05-24', description: 'Defer/archive activation writer' },

  // MVP-Quiet — default disabled, opt-in via config
  { id: 'gfi', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Global Friction Index session scoring' },
  { id: 'thinking_os', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Thinking OS injection in prompts' },
  { id: 'focus_history', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Focus history compression for context' },
  { id: 'empathy_keyword', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Empathy keyword matching system' },
  { id: 'philosopher', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Philosopher peer runner for principle extraction' },
  { id: 'evaluator', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Evaluator peer runner for principle review' },
  { id: 'rollout_reviewer', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Rollout reviewer peer runner for L2 registration' },
  { id: 'shadow_observation', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Shadow observation registry for passive learning' },
  { id: 'local_worker_routing', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Local worker routing for task dispatch' },
  { id: 'central_sync', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Central sync for cross-workspace coordination' },
  { id: 'message_sanitize', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Message sanitization for LLM output safety' },
  { id: 'trajectory_collector', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Trajectory collector for session replay' },
  { id: 'skill_channel', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Skill channel for internalization pipeline' },

  // MVP-Gone — permanently disabled, cannot be re-enabled
  { id: 'nocturnal', category: 'gone', enabled: false, since: '2026-05-24', description: 'Nocturnal trinity pipeline (retired)' },
  { id: 'idle_trigger', category: 'gone', enabled: false, since: '2026-05-24', description: 'Idle trigger for background processing (retired)' },
  { id: 'model_training', category: 'gone', enabled: false, since: '2026-05-24', description: 'Model training channel (retired)' },
  { id: 'trainer', category: 'gone', enabled: false, since: '2026-05-24', description: 'Trainer peer runner (retired)' },
];

export function computeEffectiveFlags(
  userFlags: Record<string, unknown>,
  defaults: FeatureFlagDefinition[],
  configPath: string,
): EffectiveFeatureFlags {
  const warnings: string[] = [];
  const flags: Record<string, FeatureFlagDefinition> = {};
  const hasUserFlags = Object.keys(userFlags).length > 0;

  for (const def of defaults) {
    const userEntry = userFlags[def.id];

    // No user override → use default as-is
    if (userEntry === undefined) {
      flags[def.id] = { ...def };
      continue;
    }

    // Validate user override — user config provides {enabled, since}, not full definition
    const override = userEntry as Record<string, unknown> | null | undefined;
    const enabledValue = override && typeof override === 'object' && !Array.isArray(override)
      ? (override).enabled
      : undefined;

    if (typeof enabledValue !== 'boolean') {
      flags[def.id] = { ...def };
      warnings.push(`flag '${def.id}': malformed override kept default (enabled must be boolean)`);
      continue;
    }

    // Gone flags can never be re-enabled
    if (def.category === 'gone') {
      flags[def.id] = { ...def };
      if (enabledValue) {
        warnings.push(`flag '${def.id}': gone flag cannot be re-enabled`);
      }
      continue;
    }

    // Core flags can never be disabled
    if (def.category === 'core') {
      flags[def.id] = { ...def };
      if (!enabledValue) {
        warnings.push(`flag '${def.id}': core flag cannot be disabled`);
      }
      continue;
    }

    // Quiet flags: accept valid user override
    flags[def.id] = {
      ...def,
      enabled: enabledValue,
    };
  }

  // Warn about unknown flags
  for (const key of Object.keys(userFlags)) {
    if (!flags[key]) {
      warnings.push(`flag '${key}': unknown flag ignored`);
    }
  }

  return {
    flags,
    source: hasUserFlags ? 'workspace_file' : 'defaults',
    configPath,
    warnings,
  };
}
