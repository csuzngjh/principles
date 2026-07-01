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

// ── Feature Flag Entry ──────────────────────────────────────────────────────

export interface FeatureFlagEntry {
  category: FeatureCategory;
  enabled: boolean;
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
}

// ── Profile Config (PRI-304 / PRI-466) ───────────────────────────────────────

export const PROFILE_AUDIT_LEVELS = ['low', 'medium', 'high'] as const;
export type ProfileAuditLevel = (typeof PROFILE_AUDIT_LEVELS)[number];

export const PROFILE_EVOLUTION_MODES = ['realtime', 'async'] as const;
export type ProfileEvolutionMode = (typeof PROFILE_EVOLUTION_MODES)[number];

export const PROFILE_TEST_LEVELS = ['smoke', 'unit', 'full'] as const;
export type ProfileTestLevel = (typeof PROFILE_TEST_LEVELS)[number];

export interface ProfileGateConfig {
  require_plan_for_risk_paths: boolean;
  require_audit_before_write: boolean;
  require_reviewer_after_write: boolean;
}

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

export interface ProfilePlanApprovalsConfig {
  enabled: boolean;
  max_lines_override: number;
  allowed_patterns: string[];
  allowed_operations: string[];
}

export interface ProfileProgressiveGateConfig {
  enabled: boolean;
  plan_approvals: ProfilePlanApprovalsConfig;
}

export interface ProfileEditVerificationConfig {
  enabled: boolean;
  max_file_size_bytes: number;
  fuzzy_match_enabled: boolean;
  fuzzy_match_threshold: number;
  skip_large_file_action: 'warn' | 'block';
}

export interface ProfileThinkingCheckpointConfig {
  enabled: boolean;
  window_ms: number;
  high_risk_tools: string[];
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
  gate: ProfileGateConfig;
  tests: ProfileTestsConfig;
  pain: ProfilePainConfig;
  lifecycle: ProfileLifecycleConfig;
  progressive_gate: ProfileProgressiveGateConfig;
  edit_verification: ProfileEditVerificationConfig;
  thinking_checkpoint: ProfileThinkingCheckpointConfig;
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
  contextInjection?: Partial<ContextInjectionConfig>;
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
