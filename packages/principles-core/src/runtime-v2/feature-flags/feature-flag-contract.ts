/**
 * Feature Flag Contract — PRI-239
 *
 * Pure types and validators for the MVP-Quiet feature flag registry.
 * No I/O — YAML loading lives in pd-cli.
 */

export const VALID_CATEGORIES = ['core', 'quiet', 'gone', 'legacy_retire'] as const;
export type FeatureFlagCategory = (typeof VALID_CATEGORIES)[number];

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

  const obj = raw;

  const id = Object.hasOwn(obj, 'id') ? (obj as Record<string, unknown>).id : undefined;
  if (typeof id !== 'string' || id.length === 0) {
    errors.push('id must be a non-empty string');
  }

  const category = Object.hasOwn(obj, 'category') ? (obj as Record<string, unknown>).category : undefined;
  if (typeof category !== 'string' || !VALID_CATEGORIES.includes(category as FeatureFlagCategory)) {
    errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  const enabled = Object.hasOwn(obj, 'enabled') ? (obj as Record<string, unknown>).enabled : undefined;
  if (typeof enabled !== 'boolean') {
    errors.push('enabled must be a boolean');
  }

  const since = Object.hasOwn(obj, 'since') ? (obj as Record<string, unknown>).since : undefined;
  if (typeof since !== 'string' || since.length === 0) {
    errors.push('since must be a non-empty string');
  }

  const description = Object.hasOwn(obj, 'description') ? (obj as Record<string, unknown>).description : undefined;
  if (description !== undefined && typeof description !== 'string') {
    errors.push('description must be a string when present');
  }

  if (errors.length > 0) {
    return { ok: false, errors, source };
  }

  const value: FeatureFlagDefinition = {
    id: id as string,
    category: category as FeatureFlagCategory,
    enabled: enabled as boolean,
    since: since as string,
  };

  if (description !== undefined) {
    value.description = description as string;
  }

  return { ok: true, value };
}

export const DEFAULT_FEATURE_FLAGS: FeatureFlagDefinition[] = [
  // MVP-Core — always enabled, cannot be disabled
  { id: 'prompt', category: 'core', enabled: true, since: '2026-05-24', description: 'Prompt injection for principle application' },
  { id: 'code_tool_hook', category: 'core', enabled: true, since: '2026-05-24', description: 'Code tool hook for rule host enforcement' },
  { id: 'defer_archive', category: 'core', enabled: true, since: '2026-05-24', description: 'Defer/archive activation writer' },
  { id: 'correction_observer', category: 'quiet', enabled: true, since: '2026-06-02', description: 'Independent correction observer service for keyword self-correction (MVP-Core per ADR-0014 amendment, PRI-293; quiet flag to allow runtime disable)' },
  { id: 'internalization_auto_consumer', category: 'quiet', enabled: true, since: '2026-06-13', description: 'Bounded auto-consumer for dreamer internalization tasks — prevents ready tasks from pending forever (PRI-381; quiet flag, default on, disableable via config)' },

  // MVP-Quiet — opt-in or opt-out via config; enabled value varies per flag
  // Only flags with real consumption paths are registered (PRI-239 constraint)
  { id: 'feedback_channel', category: 'quiet', enabled: true, since: '2026-06-01', description: 'MVP seed feedback channel — privacy-preserving report drafts' },
  { id: 'gfi', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Global Friction Index session scoring' },
  { id: 'evolution_worker', category: 'quiet', enabled: false, since: '2026-06-01', description: 'Legacy evolution worker heartbeat (MVP-Quiet per ADR-0014 §2.5)' },
  { id: 'empathy_observer', category: 'quiet', enabled: false, since: '2026-06-02', description: 'Empathy observer service for sentiment checking (MVP-Quiet)' },
  { id: 'painEvidenceAdmission', category: 'quiet', enabled: false, since: '2026-06-06', description: 'Pre-diagnosis evidence triage for pain signals (PEAT-B1)' },
  // PRI-404: snake_case alias for painEvidenceAdmission — config.yaml uses snake_case convention;
  // registering both avoids "unknown flag accepted" warning while production code references camelCase key
  { id: 'pain_evidence_admission', category: 'quiet', enabled: false, since: '2026-06-15', description: 'Snake-case alias for painEvidenceAdmission — same functionality, matches config.yaml key convention' },
  { id: 'diagnostician_async_cli', category: 'quiet', enabled: false, since: '2026-06-11', description: 'Async pain-record CLI — submit and return immediately, diagnosis runs in background. Default: false until orchestrator exists.' },
  { id: 'diagnostician_core_grounding', category: 'quiet', enabled: true, since: '2026-06-11', description: 'Core principle grounding in diagnostician prompt (Arm 2)' },
  { id: 'internalization_core_grounding', category: 'quiet', enabled: true, since: '2026-06-16', description: 'Core principle grounding in internalization prompt builders (dreamer, philosopher, scribe)' },
  { id: 'diagnostician_split_pipeline', category: 'quiet', enabled: true, since: '2026-06-11', description: '3-stage split diagnostician pipeline (RootCause→Distiller→Router)' },
  // PRI-419: L2 multi-turn agent loop for the dreamer runner. Scoped single-runner exception
  // per ADR-0014 amendment (mirrors the 2026-06-10 diagnostician-split owner exception).
  // Default off; flips dreamer from one-shot completeSimple to a multi-turn agentLoop with
  // read-only tools. Roll back = flip flag, reverts to PiAiRuntimeAdapter with zero migration.
  { id: 'l2_dreamer', category: 'quiet', enabled: false, since: '2026-06-16', description: 'L2 multi-turn agent loop for the dreamer runner (PRI-419) — read-only tools + submit_output, scoped to dreamer only' },

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

  const safeKeys = Object.keys(userFlags).filter(key => {
    if (DANGEROUS_KEYS.has(key)) {
      warnings.push(`flag '${key}': dangerous key rejected`);
      return false;
    }
    return true;
  });
  const hasUserFlags = safeKeys.length > 0;

  for (const def of defaults) {
    if (!Object.hasOwn(userFlags, def.id) || DANGEROUS_KEYS.has(def.id)) {
      flags[def.id] = { ...def };
      continue;
    }

    const override = userFlags[def.id];
    const isPlainObj = override !== null && override !== undefined && typeof override === 'object' && !Array.isArray(override);
    const enabledValue = isPlainObj && Object.hasOwn(override, 'enabled')
      ? (override as Record<string, unknown>).enabled
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
  for (const key of safeKeys) {
    if (!Object.hasOwn(flags, key)) {
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
