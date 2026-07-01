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
  { id: 'signal_collector', category: 'quiet', enabled: false, since: '2026-06-30', description: 'Unified signal collection host (correction + empathy upstream merge). NOTE: keyword detection (high-precision phrases) runs regardless of this flag; this flag only gates the LLM deep-judgment path (ambiguous terms / missed keywords). Quiet flag: dogfood-only until validated.' },
  { id: 'internalization_auto_consumer', category: 'quiet', enabled: true, since: '2026-06-13', description: 'Bounded auto-consumer for dreamer internalization tasks — prevents ready tasks from pending forever (PRI-381; quiet flag, default on, disableable via config)' },
  // PRI-408: Story A approval-completion orchestrator. Replaces the demo direct-writer
  // activation path with a formal ApprovalCompletionService that validates approval state,
  // enforces idempotency, and dispatches via ActivationDispatcher with rolloutDecision='approved'.
  // Registered as quiet (default on, disableable) so operators can turn off the new orchestrator
  // without affecting already-activated data — falling back to manual dispatch.
  { id: 'story_a_approval_completion', category: 'quiet', enabled: true, since: '2026-06-18', description: 'Story A approval-completion orchestrator (PRI-408) — formal service replacing demo direct-writer activation; quiet flag, default on, disableable via config' },

  // MVP-Quiet — opt-in or opt-out via config; enabled value varies per flag
  // Only flags with real consumption paths are registered (PRI-239 constraint)
  { id: 'feedback_channel', category: 'quiet', enabled: true, since: '2026-06-01', description: 'MVP seed feedback channel — privacy-preserving report drafts' },
  { id: 'gfi', category: 'quiet', enabled: false, since: '2026-05-24', description: 'Global Friction Index session scoring' },
  { id: 'evolution_worker', category: 'quiet', enabled: false, since: '2026-06-01', description: 'Legacy evolution worker heartbeat (MVP-Quiet per ADR-0014 §2.5)' },
  { id: 'empathy_observer', category: 'quiet', enabled: false, since: '2026-06-02', description: 'Empathy observer service for sentiment checking (MVP-Quiet)' },
  // PRI-454: painEvidenceAdmission flipped to default-on. Gate B (TriggerController)
  // is now the primary admission gate. Roll back = set painEvidenceAdmissionDefault to false.
  { id: 'painEvidenceAdmission', category: 'quiet', enabled: true, since: '2026-06-06', description: 'Pre-diagnosis evidence triage for pain signals (PEAT-B1). PRI-454: default-on, Gate B is primary gate.' },
  // PRI-404: snake_case alias for painEvidenceAdmission — config.yaml uses snake_case convention;
  // registering both avoids "unknown flag accepted" warning while production code references camelCase key
  { id: 'pain_evidence_admission', category: 'quiet', enabled: true, since: '2026-06-15', description: 'Snake-case alias for painEvidenceAdmission — same functionality, matches config.yaml key convention. PRI-454: default-on.' },
  // PRI-454: Global kill switch for Gate B migration. When ON (default), Gate B owns admission.
  // When OFF (rollback), Gate A (PainDiagnosticGate) is re-activated on all paths.
  { id: 'painEvidenceAdmissionDefault', category: 'quiet', enabled: true, since: '2026-06-24', description: 'PRI-454: Global kill switch for Gate B migration. When ON (default), Gate B (TriggerController) owns admission. When OFF (rollback), Gate A (PainDiagnosticGate) is re-activated.' },
  // PRI-454: snake_case alias for painEvidenceAdmissionDefault
  { id: 'pain_evidence_admission_default', category: 'quiet', enabled: true, since: '2026-06-24', description: 'PRI-454: Snake-case alias for painEvidenceAdmissionDefault — global kill switch, matches config.yaml key convention' },
  { id: 'diagnostician_async_cli', category: 'quiet', enabled: false, since: '2026-06-11', description: 'Async pain-record CLI — submit and return immediately, diagnosis runs in background. Default: false until orchestrator exists.' },
  { id: 'diagnostician_core_grounding', category: 'quiet', enabled: true, since: '2026-06-11', description: 'Core principle grounding in diagnostician prompt (Arm 2)' },
  { id: 'internalization_core_grounding', category: 'quiet', enabled: true, since: '2026-06-16', description: 'Core principle grounding in internalization prompt builders (dreamer, philosopher, scribe)' },
  { id: 'diagnostician_split_pipeline', category: 'quiet', enabled: true, since: '2026-06-11', description: '3-stage split diagnostician pipeline (RootCause→Distiller→Router)' },
  // PRI-419: L2 multi-turn agent loop for the dreamer runner. Scoped single-runner exception
  // per ADR-0014 amendment (mirrors the 2026-06-10 diagnostician-split owner exception).
  // Default off; flips dreamer from one-shot completeSimple to a multi-turn agentLoop with
  // read-only tools. Roll back = flip flag, reverts to PiAiRuntimeAdapter with zero migration.
  { id: 'l2_dreamer', category: 'quiet', enabled: false, since: '2026-06-16', description: 'L2 multi-turn agent loop for the dreamer runner (PRI-419) — read-only tools + submit_output, scoped to dreamer only' },
  // PRI-435: Code-rule capability promoted to MVP-Core, default ON.
  // Atomic: ArtificerL2 + Evaluator. The RuleHost pipeline runs the adversarial
  // write-test-fix loop with the ArtificerL2Adapter when enabled. As a core flag
  // it defaults ON and cannot be disabled by omission; explicit emergency disable
  // via `enabled: false` is honored with a warning (see computeEffectiveFlags).
  // The CLI handler still checks per-agent config (artificer + evaluator enabled)
  // before invoking the pipeline; misconfigured agents fail the readiness gate.
  { id: 'code_rule_capability', category: 'core', enabled: true, since: '2026-06-18', description: 'Code-rule capability (atomic: ArtificerL2 + Evaluator) for RuleHost pipeline — MVP-Core, default ON (PRI-435)' },


  // PRI-465: Intent Engineering MVP — default off; quiet flag.
  { id: 'intent_engineering', category: 'quiet', enabled: false, since: '2026-06-25', description: 'INTENT.md-grounded constructive friction and Stage-A intent tension diagnosis (PRI-465). Default off; flag-off = no INTENT read, no prompt injection, no intentTension.' },
  // PRI-479: RuleContext v2 — foundation flag for the rule-code context vision
  // (spec: docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md).
  // Quiet + default off: registering the flag does NOT change any production
  // behavior. Subsequent phases gate new RuleHostInput fields and context
  // builders behind this flag; v1 rule behavior is unchanged while the flag
  // is off. Roll back = leave the flag off (or set enabled: false in config).
  { id: 'rulecode_context_v2', category: 'quiet', enabled: false, since: '2026-06-27', description: 'RuleContext v2 — rule-code context vision (PRI-479). Foundation flag; default off, v1 rule behavior unchanged. See docs/superpowers/specs/2026-06-27-rulecode-context-vision-design.md' },
  // MVP-Gone — permanently disabled, cannot be re-enabled
  { id: 'nocturnal', category: 'gone', enabled: false, since: '2026-05-24', description: 'Nocturnal trinity pipeline (retired)' },
  { id: 'idle_trigger', category: 'gone', enabled: false, since: '2026-05-24', description: 'Idle trigger for background processing (retired)' },
  // New user onboarding wizard — first-visit redirect to /welcome + demo story-a
  // trigger endpoint. P1-D: registered as MVP-Quiet with default-off per AGENTS.md
  // ("Adding a new feature to MVP-Core REQUIRES maintainer's explicit approval").
  // No approval was obtained for this PR, so the safe default applies. The feature
  // will not run until a maintainer explicitly enables it via .pd/config.yaml
  // (new_user_onboarding: { enabled: true }) or approves it as MVP-Core in a
  // follow-up PR that flips category to 'core'.
  { id: 'new_user_onboarding', category: 'quiet', enabled: false, since: '2026-07-01', description: 'New user onboarding wizard — first-visit redirect to /welcome + demo story-a trigger endpoint. Requires maintainer approval to enable as MVP-Core; default-off (MVP-Quiet) until approved. Enable via .pd/config.yaml: new_user_onboarding: { enabled: true }.' },
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

    // PRI-435: Core flags default ON and cannot be disabled by omission.
    // However, operators may explicitly set `enabled: false` for emergency disable
    // (e.g. `code_rule_capability.enabled: false` to halt the RuleHost pipeline).
    // This deliberate override is honored with a warning so the disable is observable
    // in logs/telemetry. Per-rule rollback remains `deactivate`.
    if (def.category === 'core') {
      if (enabledValue) {
        flags[def.id] = { ...def };
      } else {
        flags[def.id] = { ...def, enabled: false };
        warnings.push(`flag '${def.id}': core flag explicitly disabled via config (emergency disable)`);
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
