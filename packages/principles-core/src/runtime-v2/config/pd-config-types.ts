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

export interface RedactedPdConfigSummary {
  version: PdConfigVersion;
  source: 'defaults' | 'user_config';
  workspace?: WorkspaceConfig;
  features: RedactedFeatureSummary[];
  runtimeProfiles: RedactedRuntimeProfileSummary[];
  defaultRuntime: string;
  agents: RedactedAgentSummary[];
  ui: UiConfig;
  warnings: string[];
}

// ── Dangerous Keys ──────────────────────────────────────────────────────────

export const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Conversation Access Config Key (PRI-343) ────────────────────────────────
// Shared constant for the allowConversationAccess field in plugin hooks.
// Used by both the installer and the plugin health check to ensure consistency.
export const CONVERSATION_ACCESS_CONFIG_KEY = 'allowConversationAccess' as const;
