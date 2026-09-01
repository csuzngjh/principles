/**
 * PD-Owned Config Contract — PRI-304
 *
 * Pure types and constants for `.pd/config.yaml`.
 * No I/O — YAML loading lives in pd-cli / plugin boundary.
 *
 * ADR-0016: PD owns exactly one user config file.
 * .pd/feature-flags.yaml is retired into this contract.
 * .state/workflows.yaml is not a compatibility input.
 * PD does not own provider secrets.
 */

// ── Config Version ──────────────────────────────────────────────────────────

export const PD_CONFIG_VERSION = 1;
export type PdConfigVersion = 1;

// ── Feature Flag Category ───────────────────────────────────────────────────

export const VALID_FEATURE_CATEGORIES = ['core', 'quiet', 'gone', 'legacy_retire'] as const;
export type FeatureCategory = (typeof VALID_FEATURE_CATEGORIES)[number];

// ── Feature Flag Override Source (PRI-637) ──────────────────────────────────
//
// Provenance of a feature flag override entry in `.pd/config.yaml`. This is
// the minimal fact needed for lifecycle decisions — no setBy/setAt/version.
//
// - `owner`  — an authenticated Owner action created/edited this override
//              (currently the Console feature-flag toggle). STRONG signal: the
//              only value backed by machine evidence of Owner intent.
//              Graduation / cleanup must never remove it.
// - `system` — PD machinery originally created this override (installer
//              template, `pd runtime init`, host-flag migration). It is an
//              ORIGIN HINT ONLY: it does NOT prove the current value was not
//              later edited by an Owner. Direct `.pd/config.yaml` editing is a
//              supported path ("Edit to configure feature flags…"), so a
//              system entry may carry Owner intent by the time it is read.
//              Normalization keyed on this label therefore requires preview /
//              explicit Owner confirmation — it is NEVER an automatic
//              deterministic-delete license.
// - absent   — LEGACY_UNKNOWN. The entry predates provenance. Per PRI-637 it
//              MUST NOT be auto-normalized or guessed from its boolean alone:
//              preserve uncertainty instead of inventing provenance. An
//              explicit future Owner action converts it to `owner`.
export const FEATURE_FLAG_SOURCES = ['owner', 'system'] as const;
export type FeatureFlagSource = (typeof FEATURE_FLAG_SOURCES)[number];

// ── Feature Flag Entry ──────────────────────────────────────────────────────

export interface FeatureFlagEntry {
  category: FeatureCategory;
  enabled: boolean;
  /** PRI-637 override provenance. Absent = LEGACY_UNKNOWN. */
  source?: FeatureFlagSource;
}

// ── Runtime Profile Types ───────────────────────────────────────────────────

export const VALID_PROFILE_TYPES = ['openclaw', 'pi-ai'] as const;
export type RuntimeProfileType = (typeof VALID_PROFILE_TYPES)[number];

/** OpenClaw profile: references only, no secrets */
export interface OpenClawRuntimeProfile {
  type: 'openclaw';
  /** Optional provider label (e.g. "lmstudio") */
  provider?: string;
  /** Optional model label (e.g. "qwen3.6-27b-mtp") */
  model?: string;
  /** Optional source identifier (e.g. "default") */
  source?: string;
}

/** PD-local pi-ai profile: non-secret fields + apiKeyEnv name */
export interface PdLocalRuntimeProfile {
  type: 'pi-ai';
  provider: string;
  model: string;
  /** Environment variable name containing the API key — never the key value itself */
  apiKeyEnv: string;
  /** Optional base URL override */
  baseUrl?: string;
  /** Optional timeout in milliseconds */
  timeoutMs?: number;
  /** Optional maximum number of retries */
  maxRetries?: number;
  /**
   * Optional maximum output tokens for LLM completion (max_tokens).
   * Applies to all pi-ai adapter calls (probe, complete, repair).
   * When unset, the adapter falls back to a safe default.
   * For reasoning/thinking models (e.g. DeepSeek V4), set this high enough
   * to cover chain-of-thought + final output (reasoning_content and content
   * share the same max_tokens budget).
   */
  maxTokens?: number;
  /**
   * Optional system prompt passed to pi-ai Context.systemPrompt.
   * Enables Anthropic system-prompt caching and OpenAI developer-role priority.
   * Design intent: "system prompt is agent profile's responsibility" (DPB-07).
   */
  systemPrompt?: string;
}

export type RuntimeProfile = OpenClawRuntimeProfile | PdLocalRuntimeProfile;

// ── Internal Agent Names ────────────────────────────────────────────────────

export const INTERNAL_AGENT_NAMES = [
  'diagnostician',
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
  'rolloutReviewer',
  'correctionObserver',
  'empathyObserver',
  'signalCollector',
] as const;

export type InternalAgentName = (typeof INTERNAL_AGENT_NAMES)[number];

// ── Internal Agent Binding ──────────────────────────────────────────────────

export interface InternalAgentBinding {
  enabled: boolean;
  /** Runtime profile ID referencing a profile in runtimeProfiles */
  runtimeProfile?: string;
  /** Optional total timeout for the split diagnostician pipeline (3 stages). Default: 3 × timeoutMs */
  splitPipelineTimeoutMs?: number;
}

// ── Internal Agents Config ──────────────────────────────────────────────────

export interface InternalAgentsConfig {
  /** Default runtime profile for all agents without explicit override */
  defaultRuntime: string;
  /** Per-agent overrides */
  agents: Record<InternalAgentName, InternalAgentBinding>;
}

// ── UI Config ───────────────────────────────────────────────────────────────

export const VALID_DIAGNOSTICS_MODES = ['simple', 'advanced'] as const;
export type DiagnosticsMode = (typeof VALID_DIAGNOSTICS_MODES)[number];

export interface UiConfig {
  diagnostics: {
    mode: DiagnosticsMode;
  };
}

// ── Principles Config (PRI-336) ──────────────────────────────────────────────

import type { OutputLanguage } from '../language-directive.js';

/** Configuration for principle generation behavior. */
export interface PrinciplesConfig {
  /** Preferred language for generated principle text. Source of truth for generation. */
  outputLanguage?: OutputLanguage;
}

// ── Workspace Config ────────────────────────────────────────────────────────

/**
 * Workspace path configuration.
 * Declares the single source of truth for the PD home workspace.
 * Optional — unconfigured setups continue to require explicit --workspace or env var.
 */
export interface WorkspaceConfig {
  /** Absolute path to the default PD workspace directory. */
  default: string;
  /**
   * Environment classification of this workspace (PRI-587).
   * Absent is legal and means "unknown" — no default is assumed.
   */
  environment?: WorkspaceEnvironment;
}

/** Legal workspace environment values (PRI-587; mirrors WorkspaceEnvironmentSchema in governance-experience-contract.ts). */
export const WORKSPACE_ENVIRONMENTS = ['production', 'development', 'demo', 'test'] as const;
export type WorkspaceEnvironment = (typeof WORKSPACE_ENVIRONMENTS)[number];

// ── Profile Config (PRI-304 / PRI-466) ───────────────────────────────────────

export const PROFILE_AUDIT_LEVELS = ['low', 'medium', 'high'] as const;
export type ProfileAuditLevel = (typeof PROFILE_AUDIT_LEVELS)[number];

export const PROFILE_EVOLUTION_MODES = ['realtime', 'async'] as const;
export type ProfileEvolutionMode = (typeof PROFILE_EVOLUTION_MODES)[number];

export const PROFILE_TEST_LEVELS = ['smoke', 'unit', 'full'] as const;
export type ProfileTestLevel = (typeof PROFILE_TEST_LEVELS)[number];

// PRI-286 retirement cleanup (2026-08-19): ProfileGateConfig,
// ProfilePlanApprovalsConfig, ProfileProgressiveGateConfig, and
// ProfileThinkingCheckpointConfig were removed. The built-in PLAN/
// confirm-first gate and the thinking-checkpoint gate no longer exist in
// the runtime; these keys are accepted as no-op legacy input with a
// deprecation warning (see pd-validate-profile.ts) and are NOT part of
// the canonical profile contract anymore.

export interface ProfileTestsConfig {
  on_change: ProfileTestLevel;
  on_risk_change: ProfileTestLevel;
  commands: Record<string, string>;
}

export interface ProfileAdaptivePainConfig {
  enabled: boolean;
  spiral_boost: number;
  min_threshold: number;
  max_threshold: number;
  backlog_trigger: number;
  hard_failure_trigger: number;
  low_recent_success_boost: number;
  high_recent_pain_boost: number;
}

export interface ProfilePainConfig {
  soft_capture_threshold: number;
  adaptive: ProfileAdaptivePainConfig;
}

export interface ProfileLifecycleConfig {
  enabled: boolean;
  heartbeat_stale_hours: number;
}

export interface ProfileEditVerificationConfig {
  enabled: boolean;
  max_file_size_bytes: number;
  fuzzy_match_enabled: boolean;
  fuzzy_match_threshold: number;
  skip_large_file_action: 'warn' | 'block';
}

export interface ProfileCustomGuard {
  pattern: string;
  message: string;
  severity: string;
}

export interface ProfileConfig {
  audit_level: ProfileAuditLevel;
  risk_paths: string[];
  evolution_mode: ProfileEvolutionMode;
  tests: ProfileTestsConfig;
  pain: ProfilePainConfig;
  lifecycle: ProfileLifecycleConfig;
  edit_verification: ProfileEditVerificationConfig;
  custom_guards: ProfileCustomGuard[];
}

// ── Context Injection Config (PR-xxx) ─────────────────────────────

export const VALID_PROJECT_FOCUS_MODES = ['full', 'summary', 'off'] as const;
export type ProjectFocusMode = (typeof VALID_PROJECT_FOCUS_MODES)[number];

export interface EvolutionContextConfig {
  /** Enable conversation context in evolution task (default: true) */
  enabled: boolean;
  /** Max recent messages included in evolution task (default: 4) */
  maxMessages: number;
  /** Max chars per message snippet (default: 200) */
  maxCharsPerMessage: number;
}

/** Context injection — what runtime content gets injected into the LLM prompt. */
export interface ContextInjectionConfig {
  /** Thinking OS (mental models) injection toggle. */
  thinkingOs: boolean;
  /** Project context (CURRENT_FOCUS.md) injection mode. */
  projectFocus: ProjectFocusMode;
  /** Evolution task context injection settings. */
  evolutionContext: EvolutionContextConfig;
}

/** Partial context injection config — for user input, defaults resolved in effective config. */
export type PartialContextInjectionConfig = {
  thinkingOs?: boolean;
  projectFocus?: ProjectFocusMode;
  evolutionContext?: Partial<EvolutionContextConfig>;
};

// ── Top-Level Config ────────────────────────────────────────────────────────

export interface PdConfig {
  version: PdConfigVersion;
  /** Workspace path configuration (optional). */
  workspace?: WorkspaceConfig;
  features: Record<string, FeatureFlagEntry>;
  runtimeProfiles: Record<string, RuntimeProfile>;
  internalAgents: InternalAgentsConfig;
  ui: UiConfig;
  /** Principle generation preferences (PRI-336). */
  principles?: PrinciplesConfig;
  /** Agent behavioral profile — partial user input; defaults resolved in effective config (PRI-304). */
  profile?: Partial<ProfileConfig>;
  /** Context injection configuration — partial user input; defaults resolved in effective config. */
  contextInjection?: PartialContextInjectionConfig;
}

// ── Validation Result ───────────────────────────────────────────────────────

export interface PdConfigValidationError {
  path: string;
  reason: string;
  nextAction: string;
}

export interface PdConfigValidationResultOk {
  ok: true;
  value: PdConfig;
}

export interface PdConfigValidationResultErr {
  ok: false;
  errors: PdConfigValidationError[];
}

export type PdConfigValidationResult =
  | PdConfigValidationResultOk
  | PdConfigValidationResultErr;

// ── Effective Config ────────────────────────────────────────────────────────

export interface EffectivePdConfig {
  config: PdConfig;
  source: 'defaults' | 'user_config';
  warnings: string[];
  featuresChangedFromDefault?: string[];
  /** Fully resolved behavioural profile — always present after effective config computation (PRI-304). */
  resolvedProfile: ProfileConfig;
  /** Fully resolved context injection config — always present after effective config computation. */
  resolvedContextInjection: ContextInjectionConfig;
}

// ── Redacted Summary ────────────────────────────────────────────────────────

export interface RedactedRuntimeProfileSummary {
  id: string;
  type: RuntimeProfileType;
  /** Safe label for display (e.g. "openclaw: lmstudio/qwen3.6-27b-mtp") */
  label: string;
  /** For pi-ai profiles: the env var name, never the value */
  apiKeyEnv?: string;
  /** Provider name (e.g. "lmstudio") — not sensitive, safe to expose */
  provider?: string;
  /** Model ID (e.g. "qwen3.6-27b-mtp") — not sensitive, safe to expose */
  model?: string;
  /** Whether the profile appears ready (has required fields) */
  readiness: 'ready' | 'not_ready' | 'needs_setup' | 'disabled' | 'unknown';
}

export interface RedactedAgentSummary {
  name: InternalAgentName;
  enabled: boolean;
  runtimeProfileId: string;
  runtimeProfileLabel: string;
  readiness: 'ready' | 'not_ready' | 'needs_setup' | 'disabled' | 'unknown';
}

export interface RedactedFeatureSummary {
  id: string;
  category: FeatureCategory;
  enabled: boolean;
}

export interface RedactedProfileSummary {
  audit_level: ProfileAuditLevel;
  evolution_mode: ProfileEvolutionMode;
  risk_path_count: number;
  custom_guard_count: number;
}

export interface RedactedPdConfigSummary {
  version: PdConfigVersion;
  source: 'defaults' | 'user_config';
  workspace?: WorkspaceConfig;
  features: RedactedFeatureSummary[];
  runtimeProfiles: RedactedRuntimeProfileSummary[];
  defaultRuntime: string;
  agents: RedactedAgentSummary[];
  ui: UiConfig;
  profile?: RedactedProfileSummary;
  contextInjection?: ContextInjectionConfig;
  warnings: string[];
}

// ── Dangerous Keys ──────────────────────────────────────────────────────────

export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Conversation Access Config Key (PRI-343) ────────────────────────────────
// Shared constant for the allowConversationAccess field in plugin hooks.
// Used by both the installer and the plugin health check to ensure consistency.
export const CONVERSATION_ACCESS_CONFIG_KEY = 'allowConversationAccess' as const;
