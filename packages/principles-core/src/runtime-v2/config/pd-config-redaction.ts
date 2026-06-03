/**
 * PD Config Redaction — PRI-304
 *
 * Produces safe summaries for CLI/Console display.
 * Never includes token/API key values or raw OpenClaw provider objects.
 * Uses safe serialization for previews (ERR-014, ERR-016, ERR-017).
 * Redaction uses ANY-segment logic for sensitive keys (ERR-045).
 * String values run through full redaction pipeline before truncation (ERR-046).
 */

import {
  type EffectivePdConfig,
  type RedactedPdConfigSummary,
  type RedactedFeatureSummary,
  type RedactedRuntimeProfileSummary,
  type RedactedAgentSummary,
  type RuntimeProfile,
  type InternalAgentName,
  DANGEROUS_KEYS,
} from './pd-config-types.js';

// ── Sensitive Key Detection ─────────────────────────────────────────────────

const SENSITIVE_KEY_SEGMENTS = new Set([
  'key', 'token', 'secret', 'password', 'auth', 'credential', 'apikey', 'api_key',
  'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'private', 'certificate', 'signature',
]);

function isSensitiveKey(key: string): boolean {
  const segments = key.toLowerCase().split(/[_\-.]/);
  if (segments.length === 0) return false;
  // ANY-segment match (ERR-045): flag if any segment is sensitive
  return segments.some(seg => SENSITIVE_KEY_SEGMENTS.has(seg));
}

// ── Safe String Redaction ───────────────────────────────────────────────────

const TOKEN_PATTERN = /\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/g;
const KEY_ASSIGN_PATTERN = /\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?([^\s'",}{]{4,})['"]?/gi;

function redactString(value: string): string {
  return value
    .replace(TOKEN_PATTERN, '[REDACTED]')
    .replace(BEARER_PATTERN, '[REDACTED]')
    .replace(KEY_ASSIGN_PATTERN, (_m, key: string) => `${key}=[REDACTED]`);
}

function safeTruncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '…';
}

// ── Profile Label ───────────────────────────────────────────────────────────

function buildProfileLabel(id: string, profile: RuntimeProfile): string {
  if (profile.type === 'openclaw') {
    const oc = profile;
    const parts: string[] = ['openclaw'];
    if (oc.provider) parts.push(oc.provider);
    if (oc.model) parts.push(oc.model);
    if (oc.source && !oc.provider && !oc.model) parts.push(oc.source);
    return parts.join(': ');
  }
  // pi-ai
  const pd = profile;
  return `pi-ai: ${pd.provider}/${pd.model}`;
}

// ── Profile Readiness ───────────────────────────────────────────────────────

function assessProfileReadiness(profile: RuntimeProfile): RedactedRuntimeProfileSummary['readiness'] {
  if (profile.type === 'openclaw') {
    const oc = profile;
    // OpenClaw profile with source=default is always "ready" (delegated to OpenClaw)
    if (oc.source === 'default') return 'ready';
    // OpenClaw profile with provider+model may be ready
    if (oc.provider && oc.model) return 'ready';
    return 'needs_setup';
  }
  // pi-ai: needs apiKeyEnv set
  const pd = profile;
  if (!pd.provider || !pd.model || !pd.apiKeyEnv) return 'needs_setup';
  return 'not_ready'; // has config but runtime availability unknown
}

// ── Agent Readiness ─────────────────────────────────────────────────────────

function assessAgentReadiness(
  enabled: boolean,
  profileId: string,
  profiles: Record<string, RuntimeProfile>,
): RedactedAgentSummary['readiness'] {
  if (!enabled) return 'disabled';
  if (!Object.hasOwn(profiles, profileId)) return 'needs_setup';
  const profile = profiles[profileId];
  if (!profile) return 'needs_setup';
  const profileReadiness = assessProfileReadiness(profile);
  return profileReadiness;
}

// ── Redact Config ───────────────────────────────────────────────────────────

/**
 * Produce a redacted summary of the effective PD config.
 * Safe for CLI output, Console display, and diagnostics copy.
 * Never includes token/API key values or raw provider objects.
 */
export function redactPdConfig(effective: EffectivePdConfig): RedactedPdConfigSummary {
  const { config, source, warnings } = effective;

  // Features
  const features: RedactedFeatureSummary[] = [];
  for (const [id, entry] of Object.entries(config.features)) {
    if (DANGEROUS_KEYS.has(id)) continue;
    features.push({
      id,
      category: entry.category,
      enabled: entry.enabled,
    });
  }

  // Runtime profiles — redacted
  const runtimeProfiles: RedactedRuntimeProfileSummary[] = [];
  for (const [id, profile] of Object.entries(config.runtimeProfiles)) {
    if (DANGEROUS_KEYS.has(id)) continue;

    const summary: RedactedRuntimeProfileSummary = {
      id,
      type: profile.type,
      label: buildProfileLabel(id, profile),
      readiness: assessProfileReadiness(profile),
    };

    // For pi-ai profiles: show apiKeyEnv name, never the value
    if (profile.type === 'pi-ai') {
      const pd = profile;
      summary.apiKeyEnv = pd.apiKeyEnv;
    }

    runtimeProfiles.push(summary);
  }

  // Agents — redacted
  const agents: RedactedAgentSummary[] = [];
  for (const name of Object.keys(config.internalAgents.agents) as InternalAgentName[]) {
    const binding = config.internalAgents.agents[name];
    const profileId = binding.runtimeProfile ?? config.internalAgents.defaultRuntime;
    const profile = config.runtimeProfiles[profileId];

    agents.push({
      name,
      enabled: binding.enabled,
      runtimeProfileId: profileId,
      runtimeProfileLabel: profile ? buildProfileLabel(profileId, profile) : `unknown:${profileId}`,
      readiness: assessAgentReadiness(binding.enabled, profileId, config.runtimeProfiles),
    });
  }

  return {
    version: config.version,
    source,
    features,
    runtimeProfiles,
    defaultRuntime: config.internalAgents.defaultRuntime,
    agents,
    ui: config.ui,
    warnings,
  };
}

/**
 * Redact an arbitrary value for safe display.
 * Runs through sensitive key detection and string redaction.
 */
export function redactConfigValue(value: unknown, key?: string): unknown {
  // If the key itself is sensitive, redact the entire value
  if (key !== undefined && isSensitiveKey(key)) {
    return '[REDACTED]';
  }

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return safeTruncate(redactString(value), 200);
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redactConfigValue(v, undefined));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const keys = Object.keys(obj).slice(0, 30);
    for (const k of keys) {
      if (DANGEROUS_KEYS.has(k)) continue;
      result[k] = redactConfigValue(obj[k], k);
    }
    return result;
  }

  return '[REDACTED]';
}
