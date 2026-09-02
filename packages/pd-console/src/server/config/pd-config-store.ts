/**
 * PD Config Store — PRI-309
 *
 * I/O boundary for reading and writing `.pd/config.yaml`.
 * Uses core validation and effective config computation.
 * Safe partial writes: validate before write, preserve unrelated sections,
 * reject malformed existing file.
 *
 * ERR entries:
 * - ERR-001/ERR-005: No `as` bypasses on untrusted parsed YAML
 * - ERR-002: Graceful degradation includes reason
 * - ERR-009/ERR-010: Required fields fail loud
 * - ERR-013: Object.hasOwn() for untrusted keys
 * - ERR-045: ANY-segment redaction for sensitive keys
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import {
  validatePdConfig,
  computeEffectivePdConfig,
  computeFeatureFlagsFromConfig,
  redactPdConfig,
  checkAgentRuntimeReadiness,
  resolveAgentRuntimeBinding,
  INTERNAL_AGENT_NAMES,
  VALID_PROFILE_TYPES,
} from '@principles/core/runtime-v2';
import type {
  EffectivePdConfig,
  PdConfigValidationResult,
  RedactedPdConfigSummary,
  InternalAgentName,
  AgentRuntimeReadinessResult,
  RuntimeProfile,
  FeatureFlagsResult,
} from '@principles/core/runtime-v2';

// ── Constants ────────────────────────────────────────────────────────────────

const PD_CONFIG_DIR = '.pd';
const PD_CONFIG_FILENAME = 'config.yaml';

/** Allowed top-level keys in PATCH /agents/:name/binding payload */
const ALLOWED_PAYLOAD_KEYS = new Set(['runtimeProfile', 'enabled']);

/** Secret-like key segments for ANY-segment detection (ERR-045) */
const SECRET_KEY_SEGMENTS = [
  'apikey', 'api_key', 'key', 'token', 'secret', 'password', 'auth',
  'credential', 'gatewaytoken', 'gateway_token', 'accesstoken', 'access_token',
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConfigLoadResultOk {
  ok: true;
  effective: EffectivePdConfig;
  source: 'defaults' | 'user_config';
  configPath: string;
  warnings: string[];
}

export interface ConfigLoadResultErr {
  ok: false;
  source: 'malformed';
  configPath: string;
  errors: { path: string; reason: string; nextAction: string }[];
  defaults: EffectivePdConfig;
  warnings: string[];
}

export type ConfigLoadResult = ConfigLoadResultOk | ConfigLoadResultErr;

export interface AgentBindingUpdate {
  runtimeProfile: string;
  enabled: boolean;
}

export interface AgentBindingUpdateResultOk {
  ok: true;
  agent: InternalAgentName;
  runtimeProfile: string;
  enabled: boolean;
  /**
   * PRI-638 (reviewer P1): set when the write retired a conflicting legacy
   * `diagnostician_split_pipeline=false` override so the canonical toggle is
   * authoritative after reload.
   */
  warning?: string;
}

export interface AgentBindingUpdateResultErr {
  ok: false;
  statusCode: number;
  error: string;
  message: string;
}

export type AgentBindingUpdateResult = AgentBindingUpdateResultOk | AgentBindingUpdateResultErr;

export interface ReadinessError {
  ok: false;
  statusCode: number;
  error: string;
  message: string;
}

export interface ReadinessResult {
  ok: true;
  agent: InternalAgentName;
  readiness: 'ready' | 'not_ready' | 'needs_setup' | 'disabled' | 'unknown';
  profileId: string;
  profileLabel: string;
  reason?: string;
  nextAction?: string;
}

// ── Private Helpers (defined before public functions) ────────────────────────

function buildProfileLabel(_id: string, profile: RuntimeProfile): string {
  if (profile.type === 'openclaw') {
    const parts: string[] = ['openclaw'];
    if (profile.provider) parts.push(profile.provider);
    if (profile.model) parts.push(profile.model);
    if (profile.source && !profile.provider && !profile.model) parts.push(profile.source);
    return parts.join(': ');
  }
  return `pi-ai: ${profile.provider}/${profile.model}`;
}

interface AgentBindingEntry {
  enabled: boolean;
  runtimeProfile?: string;
}

function writeConfigAtomic(configPath: string, config: Record<string, unknown>): void {
  // Ensure directory exists
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  // Serialize to YAML
  const content = yaml.dump(config, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  // Atomic write: tmp → rename
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, configPath);
}

function isValidAgentName(name: string): name is InternalAgentName {
  return (INTERNAL_AGENT_NAMES as readonly string[]).includes(name);
}

/**
 * Type guard: is `value` a plain Record<string, unknown>?
 * Replaces `payload as Record<string, unknown>` (ERR-001/ERR-005).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ANY-segment secret key detection (ERR-045).
 * Checks if any segment of a dotted key path matches a secret-like pattern.
 * E.g. "provider.api_key" → detected; "runtimeProfile" → not detected.
 */
function containsSecretSegment(key: string): boolean {
  const lower = key.toLowerCase();
  const segments = lower.split(/[._-]/);
  return segments.some(seg => SECRET_KEY_SEGMENTS.includes(seg));
}

/**
 * Recursively scan an object for secret-like keys at any depth (ERR-045).
 */
function hasSecretLikeKeyDeep(obj: Record<string, unknown>, prefix = ''): string | null {
  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (containsSecretSegment(key)) {
      return fullPath;
    }
    const val = obj[key];
    if (isRecord(val)) {
      const nested = hasSecretLikeKeyDeep(val, fullPath);
      if (nested) return nested;
    }
  }
  return null;
}

export function validateBindingPayload(payload: unknown): { ok: true; value: AgentBindingUpdate } | { ok: false; error: string; message: string } {
  // Use isRecord() type guard instead of `as` (ERR-001/ERR-005)
  if (!isRecord(payload)) {
    return { ok: false, error: 'bad_request', message: 'Payload must be a JSON object with runtimeProfile and enabled fields' };
  }

  // Strict whitelist: reject unknown top-level keys
  const payloadKeys = Object.keys(payload);
  for (const key of payloadKeys) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
      return { ok: false, error: 'bad_request', message: `Payload contains unknown field '${key}'. Only 'runtimeProfile' and 'enabled' are allowed.` };
    }
  }

  // ANY-segment secret key detection on nested values (ERR-045)
  for (const key of payloadKeys) {
    const val = payload[key];
    if (isRecord(val)) {
      const secretPath = hasSecretLikeKeyDeep(val, key);
      if (secretPath) {
        return { ok: false, error: 'bad_request', message: `Payload contains secret-like field '${secretPath}'. Remove secret fields from the request.` };
      }
    }
  }

  const runtimeProfileRaw = Object.hasOwn(payload, 'runtimeProfile') ? payload.runtimeProfile : undefined;
  if (runtimeProfileRaw === undefined) {
    return { ok: false, error: 'bad_request', message: 'Missing required field: runtimeProfile' };
  }
  if (typeof runtimeProfileRaw !== 'string' || runtimeProfileRaw.length === 0) {
    return { ok: false, error: 'bad_request', message: 'runtimeProfile must be a non-empty string' };
  }

  const enabledRaw = Object.hasOwn(payload, 'enabled') ? payload.enabled : undefined;
  if (enabledRaw === undefined) {
    return { ok: false, error: 'bad_request', message: 'Missing required field: enabled' };
  }
  if (typeof enabledRaw !== 'boolean') {
    return { ok: false, error: 'bad_request', message: 'enabled must be a boolean' };
  }

  return { ok: true, value: { runtimeProfile: runtimeProfileRaw, enabled: enabledRaw } };
}

// ── Config Path ──────────────────────────────────────────────────────────────

export function getPdConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, PD_CONFIG_DIR, PD_CONFIG_FILENAME);
}

// ── Load Config ──────────────────────────────────────────────────────────────

export function loadPdConfig(workspaceDir: string): ConfigLoadResult {
  const configPath = getPdConfigPath(workspaceDir);

  // Missing file → defaults
  if (!fs.existsSync(configPath)) {
    const effective = computeEffectivePdConfig(null);
    return {
      ok: true,
      effective,
      source: 'defaults',
      configPath,
      warnings: effective.warnings,
    };
  }

  // Read
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const defaults = computeEffectivePdConfig(null);
    return {
      ok: false,
      source: 'malformed',
      configPath,
      errors: [{ path: '', reason: `Failed to read .pd/config.yaml: ${message}`, nextAction: 'Check file permissions for .pd/config.yaml' }],
      defaults,
      warnings: [],
    };
  }

  // Parse YAML — treat as unknown (ERR-001)
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const defaults = computeEffectivePdConfig(null);
    return {
      ok: false,
      source: 'malformed',
      configPath,
      errors: [{ path: '', reason: `YAML parse error: ${message}`, nextAction: 'Fix YAML syntax in .pd/config.yaml' }],
      defaults,
      warnings: [],
    };
  }

  // Validate via core (ERR-001, ERR-005)
  const validationResult: PdConfigValidationResult = validatePdConfig(parsed);

  if (!validationResult.ok) {
    const defaults = computeEffectivePdConfig(null);
    return {
      ok: false,
      source: 'malformed',
      configPath,
      errors: validationResult.errors.map(e => ({
        path: e.path,
        reason: e.reason,
        nextAction: e.nextAction,
      })),
      defaults,
      warnings: [],
    };
  }

  // Compute effective config
  const effective = computeEffectivePdConfig(validationResult.value);
  return {
    ok: true,
    effective,
    source: 'user_config',
    configPath,
    warnings: effective.warnings,
  };
}

// ── Feature Flags from Config ────────────────────────────────────────────────

/**
 * Compute feature flags from the loaded PD config (PRI-460).
 * Works with both ok and error results (uses defaults for errors).
 * Replaces the legacy `loadWorkspaceFeatureFlags` + `buildFeedbackChannelFlags` path.
 */
export function computeFlagsFromLoadResult(result: ConfigLoadResult): FeatureFlagsResult {
  const effective = result.ok ? result.effective : result.defaults;
  return computeFeatureFlagsFromConfig(effective);
}

// ── Get Redacted Summary ─────────────────────────────────────────────────────

export function getConfigSummary(workspaceDir: string): {
  summary: RedactedPdConfigSummary;
  errors?: { path: string; reason: string; nextAction: string }[];
} {
  const result = loadPdConfig(workspaceDir);
  const effective = result.ok ? result.effective : result.defaults;
  const summary = redactPdConfig(effective);

  if (!result.ok) {
    return { summary, errors: result.errors };
  }
  return { summary };
}

// ── Get Catalog ──────────────────────────────────────────────────────────────

export function getConfigCatalog(workspaceDir: string): {
  profiles: RedactedPdConfigSummary['runtimeProfiles'];
  errors?: { path: string; reason: string; nextAction: string }[];
} {
  const result = loadPdConfig(workspaceDir);
  if (!result.ok) {
    // Surface malformed config errors instead of silently using defaults
    return {
      profiles: [],
      errors: result.errors,
    };
  }
  const summary = redactPdConfig(result.effective);
  return { profiles: summary.runtimeProfiles };
}

// ── Update Agent Binding ─────────────────────────────────────────────────────

export function updateAgentBinding(
  workspaceDir: string,
  agentName: string,
  payload: unknown,
): AgentBindingUpdateResult {
  // 1. Validate agent name
  if (!isValidAgentName(agentName)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Unknown agent name '${agentName}'. Valid agents: ${INTERNAL_AGENT_NAMES.join(', ')}`,
    };
  }

  // 2. Validate payload
  const payloadResult = validateBindingPayload(payload);
  if (!payloadResult.ok) {
    return { ok: false, statusCode: 400, error: payloadResult.error, message: payloadResult.message };
  }
  const { runtimeProfile, enabled } = payloadResult.value;

  // 3. Load existing config
  const loadResult = loadPdConfig(workspaceDir);

  // 4. If malformed, refuse to write (AC: malformed existing config 拒绝写入)
  if (!loadResult.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message: `Cannot update agent binding: existing .pd/config.yaml is malformed. Fix config errors first. Errors: ${loadResult.errors.map(e => e.reason).join('; ')}`,
    };
  }

  const { effective } = loadResult;

  // 5. Validate runtime profile reference exists
  if (!Object.hasOwn(effective.config.runtimeProfiles, runtimeProfile)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Runtime profile '${runtimeProfile}' does not exist. Available profiles: ${Object.keys(effective.config.runtimeProfiles).join(', ')}`,
    };
  }

  // 6. Build updated config — read original file to preserve unknown root entries
  const configPath = getPdConfigPath(workspaceDir);
  let rawConfig: Record<string, unknown>;
  if (fs.existsSync(configPath)) {
    const rawContent = fs.readFileSync(configPath, 'utf8');
    const rawParsed = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA });
    if (isRecord(rawParsed)) {
      rawConfig = { ...rawParsed };
    } else {
      rawConfig = {};
    }
  } else {
    rawConfig = {};
  }

  // PRI-638 (reviewer P1 #2): rebuild only what the Owner explicitly changed.
  // Untouched agents keep their RAW binding from the config file verbatim.
  // Defaults / inheritance resolution / compatibility transforms (e.g. the
  // legacy split=false shim folding effective diagnostician to false) belong
  // to the resolver — materializing them back into config would turn the
  // documented read-time cutover into an implicit persistent migration.
  const rawInternalAgents = isRecord(rawConfig.internalAgents) ? rawConfig.internalAgents : {};
  const rawAgents = isRecord(rawInternalAgents.agents) ? rawInternalAgents.agents : {};

  // Update only the agent binding section
  const agentsMap: Record<string, AgentBindingEntry> = {};
  for (const name of INTERNAL_AGENT_NAMES) {
    if (name === agentName) {
      agentsMap[name] = { enabled, runtimeProfile };
      continue;
    }
    const rawEntry = rawAgents[name];
    if (isRecord(rawEntry) && typeof rawEntry.enabled === 'boolean') {
      agentsMap[name] = {
        enabled: rawEntry.enabled,
        ...(typeof rawEntry.runtimeProfile === 'string' ? { runtimeProfile: rawEntry.runtimeProfile } : {}),
      };
    }
    // Agent absent from raw config → keep it absent (defaults belong to the
    // resolver, never snapshot into config).
  }

  // Merge: start from raw config, overlay known sections, update internalAgents.agents.
  // PRI-637: preserve the file's own `features:` section instead of re-writing
  // the merged effective map. Defaults belong in the registry, not in config —
  // snapshotting `effective.config.features` here would materialize every
  // missing default flag into an immortal override on any agent-binding change.
  // PRI-645: the only reachable fallback is "config file absent" (a malformed
  // features section was already rejected by loadPdConfig above) — an empty
  // map keeps the newly created config sparse; the resolver fills defaults.
  const updatedConfig: Record<string, unknown> = {
    ...rawConfig,
    version: effective.config.version,
    features: isRecord(rawConfig.features) ? rawConfig.features : {},
    runtimeProfiles: { ...effective.config.runtimeProfiles },
    internalAgents: {
      defaultRuntime: effective.config.internalAgents.defaultRuntime,
      agents: agentsMap,
    },
    ui: { ...effective.config.ui },
  };

  // PRI-638 (reviewer P1 #1): an explicit Owner write to the canonical
  // Diagnostician binding supersedes the legacy compatibility override. While
  // `diagnostician_split_pipeline=false` remains in the raw features section,
  // the read-time shim folds the effective binding back to disabled — a
  // Console ON toggle would otherwise return success while a reload silently
  // disables the agent again. Retire the conflicting legacy override in the
  // SAME atomic write; no new authority, DB or migration subsystem is added.
  let retiredLegacySplit = false;
  if (agentName === 'diagnostician') {
    const features = isRecord(updatedConfig.features) ? updatedConfig.features : {};
    const legacySplit = isRecord(features) ? features.diagnostician_split_pipeline : undefined;
    if (isRecord(legacySplit) && legacySplit.enabled === false) {
      delete features.diagnostician_split_pipeline;
      retiredLegacySplit = true;
    }
  }

  // 7. Validate the updated config before writing
  const validation = validatePdConfig(updatedConfig);
  if (!validation.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Updated config would be invalid: ${validation.errors.map(e => e.reason).join('; ')}`,
    };
  }

  // 8. Write to disk (atomic: write to tmp, then rename)
  writeConfigAtomic(configPath, updatedConfig);

  return {
    ok: true,
    agent: agentName,
    runtimeProfile,
    enabled,
    ...(retiredLegacySplit
      ? {
          warning:
            'Retired the conflicting legacy diagnostician_split_pipeline=false override so the canonical ' +
            'Diagnostician toggle is authoritative after reload.',
        }
      : {}),
  };
}

// ── Update Default Runtime ───────────────────────────────────────────────────

export interface DefaultRuntimeUpdateResultOk {
  ok: true;
  defaultRuntime: string;
}

export interface DefaultRuntimeUpdateResultErr {
  ok: false;
  statusCode: number;
  error: string;
  message: string;
}

export type DefaultRuntimeUpdateResult = DefaultRuntimeUpdateResultOk | DefaultRuntimeUpdateResultErr;

export function updateDefaultRuntime(
  workspaceDir: string,
  payload: unknown,
): DefaultRuntimeUpdateResult {
  // 1. Validate payload
  if (!isRecord(payload)) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: 'Payload must be a JSON object with a defaultRuntime field' };
  }

  const defaultRuntimeRaw = Object.hasOwn(payload, 'defaultRuntime') ? payload.defaultRuntime : undefined;
  if (defaultRuntimeRaw === undefined) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: 'Missing required field: defaultRuntime' };
  }
  if (typeof defaultRuntimeRaw !== 'string' || defaultRuntimeRaw.length === 0) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: 'defaultRuntime must be a non-empty string' };
  }

  // ANY-segment secret key detection (ERR-045)
  const secretPath = hasSecretLikeKeyDeep(payload);
  if (secretPath) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: `Payload contains secret-like field '${secretPath}'. Remove secret fields from the request.` };
  }

  // 2. Load existing config
  const loadResult = loadPdConfig(workspaceDir);

  // 3. If malformed, refuse to write
  if (!loadResult.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message: `Cannot update default runtime: existing .pd/config.yaml is malformed. Fix config errors first. Errors: ${loadResult.errors.map(e => e.reason).join('; ')}`,
    };
  }

  const { effective } = loadResult;

  // 4. Validate runtime profile reference exists
  if (!Object.hasOwn(effective.config.runtimeProfiles, defaultRuntimeRaw)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Runtime profile '${defaultRuntimeRaw}' does not exist. Available profiles: ${Object.keys(effective.config.runtimeProfiles).join(', ')}`,
    };
  }

  // 5. Build updated config — read original file to preserve unknown root entries
  //    and preserve agent inheritance (agents without explicit runtimeProfile
  //    should NOT get one written back — they inherit defaultRuntime)
  const configPath = getPdConfigPath(workspaceDir);
  let rawConfig: Record<string, unknown>;
  let rawAgentsMap: Record<string, unknown> | undefined;
  if (fs.existsSync(configPath)) {
    const rawContent = fs.readFileSync(configPath, 'utf8');
    const rawParsed = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA });
    if (isRecord(rawParsed)) {
      rawConfig = { ...rawParsed };
      // Extract the raw agents map from the file to preserve inheritance
      const rawInternalAgents = rawParsed.internalAgents;
      if (isRecord(rawInternalAgents) && Object.hasOwn(rawInternalAgents, 'agents')) {
        const rawAgents = rawInternalAgents.agents;
        if (isRecord(rawAgents)) {
          rawAgentsMap = rawAgents;
        }
      }
    } else {
      rawConfig = {};
    }
  } else {
    rawConfig = {};
  }

  // Build agents map preserving ONLY explicit overrides from the original file.
  // Agents that omit runtimeProfile in the file should continue to inherit
  // defaultRuntime — we must NOT write back the effective (resolved) value.
  // Only write agents that already exist in the file — do not add new ones.
  const agentsMap: Record<string, AgentBindingEntry> = {};
  if (rawAgentsMap) {
    for (const name of Object.keys(rawAgentsMap)) {
      const rawEntry = rawAgentsMap[name];
      if (!isRecord(rawEntry)) continue;

      // Preserve enabled if present, default to true
      const enabledRaw = Object.hasOwn(rawEntry, 'enabled') ? rawEntry.enabled : undefined;
      const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : true;

      // Only include runtimeProfile if the original file had an explicit one
      const hasExplicitProfile = Object.hasOwn(rawEntry, 'runtimeProfile')
        && typeof rawEntry.runtimeProfile === 'string'
        && (rawEntry.runtimeProfile).length > 0;

      agentsMap[name] = {
        enabled,
        ...(hasExplicitProfile ? { runtimeProfile: rawEntry.runtimeProfile as string } : {}),
      };
    }
  } else {
    // No agents in file — write nothing (all agents inherit default)
  }

  // Merge: update only defaultRuntime, preserve agent overrides.
  // PRI-637: preserve the file's own `features:` section (same rationale as
  // updateAgentBinding — never re-snapshot merged defaults into config).
  // PRI-645: config-absent fallback writes an empty map, not a default
  // snapshot — the resolver owns defaults.
  const updatedConfig: Record<string, unknown> = {
    ...rawConfig,
    version: effective.config.version,
    features: isRecord(rawConfig.features) ? rawConfig.features : {},
    runtimeProfiles: { ...effective.config.runtimeProfiles },
    internalAgents: {
      defaultRuntime: defaultRuntimeRaw,
      agents: agentsMap,
    },
    ui: { ...effective.config.ui },
  };

  // 6. Validate the updated config before writing
  const validation = validatePdConfig(updatedConfig);
  if (!validation.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Updated config would be invalid: ${validation.errors.map(e => e.reason).join('; ')}`,
    };
  }

  // 7. Write to disk (atomic)
  writeConfigAtomic(configPath, updatedConfig);

  return {
    ok: true,
    defaultRuntime: defaultRuntimeRaw,
  };
}

// ── Principles Output Language (PRI-332 P1-1) ─────────────────────────────

// PRI-611: the output-language contract derives from the canonical core
// authority (runtime-v2/language-directive.ts). Do NOT re-declare the value
// list or default here — a drift guard test fails on local re-declaration.
import { VALID_OUTPUT_LANGUAGES, DEFAULT_OUTPUT_LANGUAGE } from '@principles/core/runtime-v2';
import type { OutputLanguage } from '@principles/core/runtime-v2';

function isValidOutputLanguage(value: unknown): value is OutputLanguage {
  return typeof value === 'string' && (VALID_OUTPUT_LANGUAGES as readonly string[]).includes(value);
}

export interface OutputLanguageResultOk {
  ok: true;
  outputLanguage: OutputLanguage;
  source: 'user_config' | 'default';
}

export interface OutputLanguageResultErr {
  ok: false;
  error: string;
  statusCode: number;
  message: string;
  nextAction: string;
}

export type OutputLanguageResult = OutputLanguageResultOk | OutputLanguageResultErr;

/**
 * Read principles.outputLanguage from config.yaml.
 * Returns default ('zh-CN') when not set.
 * Fail loud if set to an invalid value (ERR-009).
 */
export function getPrinciplesOutputLanguage(workspaceDir: string): OutputLanguageResult {
  const configPath = getPdConfigPath(workspaceDir);

  if (!fs.existsSync(configPath)) {
    return { ok: true, outputLanguage: DEFAULT_OUTPUT_LANGUAGE, source: 'default' };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'read_error', statusCode: 500, message: `Failed to read config: ${message}`, nextAction: 'Check file permissions for .pd/config.yaml' };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'yaml_error', statusCode: 500, message: `YAML parse error: ${message}`, nextAction: 'Fix YAML syntax in .pd/config.yaml' };
  }

  if (!isRecord(parsed)) {
    return { ok: true, outputLanguage: DEFAULT_OUTPUT_LANGUAGE, source: 'default' };
  }

  // Extract principles section — unknown-first, no `as` bypass (ERR-001)
  const principlesRaw = Object.hasOwn(parsed, 'principles') ? parsed.principles : undefined;
  if (principlesRaw === undefined) {
    return { ok: true, outputLanguage: DEFAULT_OUTPUT_LANGUAGE, source: 'default' };
  }

  if (!isRecord(principlesRaw)) {
    return {
      ok: false,
      error: 'invalid_config',
      statusCode: 500,
      message: 'principles section must be a mapping',
      nextAction: 'Fix principles section in .pd/config.yaml to be a YAML mapping',
    };
  }

  const outputLangRaw = Object.hasOwn(principlesRaw, 'outputLanguage') ? principlesRaw.outputLanguage : undefined;
  if (outputLangRaw === undefined) {
    return { ok: true, outputLanguage: DEFAULT_OUTPUT_LANGUAGE, source: 'default' };
  }

  if (!isValidOutputLanguage(outputLangRaw)) {
    return {
      ok: false,
      error: 'invalid_output_language',
      statusCode: 500,
      message: `principles.outputLanguage must be one of: ${VALID_OUTPUT_LANGUAGES.join(', ')}. Got: ${String(outputLangRaw)}`,
      nextAction: `Set principles.outputLanguage to one of: ${VALID_OUTPUT_LANGUAGES.join(', ')}`,
    };
  }

  return { ok: true, outputLanguage: outputLangRaw, source: 'user_config' };
}

// ── Feedback Maintainer Email ───────────────────────────────────────────────

/**
 * Default maintainer email placeholder when .pd/config.yaml does not set
 * feedback.maintainer_email. Callers MUST surface a clear warning when this
 * default is used instead of silently emitting a mailto link — a real-looking
 * default would leak a placeholder into feedback reports.
 */
const DEFAULT_FEEDBACK_MAINTAINER_EMAIL = 'maintainer@example.com';

/**
 * Read `feedback.maintainer_email` from .pd/config.yaml.
 * Returns the default when the field is absent, empty, or the config is
 * missing/malformed. Treats parsed YAML as unknown (ERR-001/005): no `as`
 * bypasses; uses Object.hasOwn for untrusted key checks (ERR-013).
 */
export function getFeedbackMaintainerEmail(workspaceDir: string): string {
  const configPath = getPdConfigPath(workspaceDir);

  if (!fs.existsSync(configPath)) {
    return DEFAULT_FEEDBACK_MAINTAINER_EMAIL;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return DEFAULT_FEEDBACK_MAINTAINER_EMAIL;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    return DEFAULT_FEEDBACK_MAINTAINER_EMAIL;
  }

  if (!isRecord(parsed)) {
    return DEFAULT_FEEDBACK_MAINTAINER_EMAIL;
  }

  // Extract feedback section — unknown-first, no `as` bypass (ERR-001)
  const feedbackRaw = Object.hasOwn(parsed, 'feedback') ? parsed.feedback : undefined;
  if (feedbackRaw === undefined) {
    return DEFAULT_FEEDBACK_MAINTAINER_EMAIL;
  }

  if (!isRecord(feedbackRaw)) {
    return DEFAULT_FEEDBACK_MAINTAINER_EMAIL;
  }

  const emailRaw = Object.hasOwn(feedbackRaw, 'maintainer_email') ? feedbackRaw.maintainer_email : undefined;
  if (typeof emailRaw !== 'string' || emailRaw.length === 0) {
    return DEFAULT_FEEDBACK_MAINTAINER_EMAIL;
  }

  return emailRaw;
}

// ── Feedback Channel Config (feedback-submit, PRI-543) ──────────────────────

/**
 * Channel-side parameters for the feedback submit ladder (§4 / §10 of
 * docs/superpowers/specs/2026-08-17-feedback-last-mile-submit-design.md).
 *
 * All values are optional-from-config: an empty string means "key not set or
 * not a string" → the corresponding channel reports unavailable. Presence of
 * `ingest_url` enables the primary channel; presence of `github_repo` enables
 * the gh CLI channel.
 *
 * Reads parse YAML as unknown (ERR-001/005: no `as` bypasses) and uses
 * Object.hasOwn for untrusted key checks (ERR-013). Mirrors the
 * `getFeedbackMaintainerEmail` pattern.
 */
export type FeedbackChannelConfig = {
  ingestUrl: string;
  ingestToken: string;
  githubRepo: string;
  githubProxy: string;
};

const EMPTY_FEEDBACK_CHANNEL: FeedbackChannelConfig = {
  ingestUrl: '',
  ingestToken: '',
  githubRepo: '',
  githubProxy: '',
};

/** Read a known string key from an already-validated record, or '' when absent/non-string. */
function readConfigString(record: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(record, key)) return '';
  const v = record[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Read `feedback.ingest_url` / `ingest_token` / `github_repo` / `github_proxy`
 * from `.pd/config.yaml`. Missing/malformed config falls back to all-empty.
 *
 * NOTE: `ingest_token` is returned here but MUST NOT be serialised to any
 * client-facing payload (channels endpoint omits it; only the server submit
 * path uses it). It ships in the release and is an anti-abuse boundary, not a
 * security boundary (spec §9.2).
 */
export function getFeedbackChannelConfig(workspaceDir: string): FeedbackChannelConfig {
  const configPath = getPdConfigPath(workspaceDir);

  if (!fs.existsSync(configPath)) {
    return { ...EMPTY_FEEDBACK_CHANNEL };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { ...EMPTY_FEEDBACK_CHANNEL };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch {
    return { ...EMPTY_FEEDBACK_CHANNEL };
  }

  if (!isRecord(parsed)) {
    return { ...EMPTY_FEEDBACK_CHANNEL };
  }

  const feedbackRaw = Object.hasOwn(parsed, 'feedback') ? parsed.feedback : undefined;
  if (feedbackRaw === undefined || !isRecord(feedbackRaw)) {
    return { ...EMPTY_FEEDBACK_CHANNEL };
  }

  return {
    ingestUrl: readConfigString(feedbackRaw, 'ingest_url'),
    ingestToken: readConfigString(feedbackRaw, 'ingest_token'),
    githubRepo: readConfigString(feedbackRaw, 'github_repo'),
    githubProxy: readConfigString(feedbackRaw, 'github_proxy'),
  };
}

/**
 * Update principles.outputLanguage in config.yaml.
 * Safe partial write: preserves unknown sections, validates before write.
 */
export function updatePrinciplesOutputLanguage(
  workspaceDir: string,
  payload: unknown,
): OutputLanguageResult {
  // 1. Validate payload
  if (!isRecord(payload)) {
    return { ok: false, error: 'bad_request', statusCode: 400, message: 'Payload must be a JSON object with an outputLanguage field', nextAction: 'Send { outputLanguage: "zh-CN" } or { outputLanguage: "en" }' };
  }

  const outputLangRaw = Object.hasOwn(payload, 'outputLanguage') ? payload.outputLanguage : undefined;
  if (outputLangRaw === undefined) {
    return { ok: false, error: 'bad_request', statusCode: 400, message: 'Missing required field: outputLanguage', nextAction: `Send { outputLanguage: "${DEFAULT_OUTPUT_LANGUAGE}" }` };
  }
  if (!isValidOutputLanguage(outputLangRaw)) {
    return {
      ok: false,
      error: 'bad_request',
      statusCode: 400,
      message: `outputLanguage must be one of: ${VALID_OUTPUT_LANGUAGES.join(', ')}. Got: ${String(outputLangRaw)}`,
      nextAction: `Set outputLanguage to one of: ${VALID_OUTPUT_LANGUAGES.join(', ')}`,
    };
  }

  // 2. Read raw config to preserve unknown sections
  const configPath = getPdConfigPath(workspaceDir);
  let rawConfig: Record<string, unknown>;
  if (fs.existsSync(configPath)) {
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: 'read_error', statusCode: 500, message: `Failed to read config for update: ${message}`, nextAction: 'Check file permissions for .pd/config.yaml' };
    }
    let rawParsed: unknown;
    try {
      rawParsed = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: 'yaml_error', statusCode: 500, message: `YAML parse error during update: ${message}`, nextAction: 'Fix YAML syntax in .pd/config.yaml' };
    }
    if (isRecord(rawParsed)) {
      rawConfig = { ...rawParsed };
    } else {
      rawConfig = {};
    }
  } else {
    rawConfig = {};
  }

  // 3. Update principles.outputLanguage
  const existingPrinciples = isRecord(rawConfig.principles) ? { ...rawConfig.principles } : {};
  existingPrinciples.outputLanguage = outputLangRaw;
  rawConfig.principles = existingPrinciples;

  // 4. Validate via core (principles is an unknown section — safe to pass through)
  const validation = validatePdConfig(rawConfig);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'validation_error',
      statusCode: 500,
      message: `Updated config would be invalid: ${validation.errors.map(e => e.reason).join('; ')}`,
      nextAction: 'Fix config validation errors before retrying',
    };
  }

  // 5. Atomic write
  try {
    writeConfigAtomic(configPath, rawConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: 'write_error', statusCode: 500, message: `Failed to write config: ${message}`, nextAction: 'Check disk space and file permissions for .pd/config.yaml' };
  }

  return { ok: true, outputLanguage: outputLangRaw, source: 'user_config' };
}

// ── Update Feature Flag (spec 2026-06-27 §13.4) ────────────────────────────

/**
 * Whitelist of registered feature flag names. A PATCH request may only
 * toggle flags that already exist in the registry. Built from the default
 * effective config's computed flags — this is the authoritative source of
 * registered flag IDs (avoids ambiguity between the array and Record
 * forms of DEFAULT_FEATURE_FLAGS in the core barrel).
 */
const _DEFAULT_FLAGS_RESULT = computeFeatureFlagsFromConfig(
  computeEffectivePdConfig(null),
);
const REGISTERED_FEATURE_FLAG_NAMES: ReadonlySet<string> = new Set(
  Object.keys(_DEFAULT_FLAGS_RESULT.flags),
);
/** Map of flag ID → category, for preserving category when writing. */
const DEFAULT_FLAG_CATEGORY: ReadonlyMap<string, string> = new Map(
  Object.entries(_DEFAULT_FLAGS_RESULT.flags).map(([id, flag]) => [id, flag.category]),
);

export interface FeatureFlagUpdateResultOk {
  ok: true;
  feature: string;
  enabled: boolean;
}

export interface FeatureFlagUpdateResultErr {
  ok: false;
  statusCode: number;
  error: string;
  message: string;
  nextAction?: string;
}

export type FeatureFlagUpdateResult =
  | FeatureFlagUpdateResultOk
  | FeatureFlagUpdateResultErr;

/**
 * Update a feature flag's `enabled` field in .pd/config.yaml.
 *
 * Safe partial write: preserves unknown sections, validates before write.
 * Follows the load → validate → merge → atomic write pattern of
 * updateAgentBinding / updatePrinciplesOutputLanguage.
 *
 * Constraints (spec §13.4):
 * - featureName must be in the registered flag set (DEFAULT_FEATURE_FLAGS)
 * - Does NOT create a new `features:` section if absent (rejects)
 * - Atomic write + validates merged yaml can be re-parsed by loadPdConfig
 *
 * ERR entries (spec §13.9):
 * - ERR-001/ERR-005: enabled strictly typeof === 'boolean'; featureName
 *   strictly checked against whitelist
 * - ERR-009: unknown featureName → ok:false with reason
 * - ERR-013: Object.hasOwn for features section existence check
 * - ERR-015/018/019: load-validate-merge-write-reload, no stale cache
 */
export function updateFeatureFlag(
  workspaceDir: string,
  featureName: string,
  enabled: boolean,
): FeatureFlagUpdateResult {
  // 1. Validate featureName against the registered whitelist
  if (!REGISTERED_FEATURE_FLAG_NAMES.has(featureName)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'unknown_feature',
      message: `Unknown feature flag '${featureName}'. Registered flags: ${Array.from(REGISTERED_FEATURE_FLAG_NAMES).join(', ')}`,
      nextAction: `Use one of: ${Array.from(REGISTERED_FEATURE_FLAG_NAMES).join(', ')}`,
    };
  }

  // 2. Validate enabled is boolean (typeof check, no `as` — ERR-001)
  if (typeof enabled !== 'boolean') {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `enabled must be a boolean. Got: ${typeof enabled}`,
      nextAction: 'Send { enabled: true } or { enabled: false }',
    };
  }

  // 3. Read raw config to preserve unknown sections + check features section
  //    Check features section BEFORE loadPdConfig malformed check: a config
  //    without a features section is rejected with 422 regardless of whether
  //    the rest is valid or malformed (spec §13.4: 不允许新增).
  const configPath = getPdConfigPath(workspaceDir);
  let rawConfig: Record<string, unknown>;
  if (fs.existsSync(configPath)) {
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(configPath, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, statusCode: 500, error: 'read_error', message: `Failed to read config for update: ${message}` };
    }
    let rawParsed: unknown;
    try {
      rawParsed = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA });
    } catch (err) {
      // YAML syntax error = malformed config (409, not 500). Consistent with
      // updateAgentBinding which treats loadPdConfig failures as conflict.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, statusCode: 409, error: 'conflict', message: `Cannot update feature flag: existing .pd/config.yaml is malformed. YAML parse error: ${message}` };
    }
    if (isRecord(rawParsed)) {
      rawConfig = { ...rawParsed };
    } else {
      rawConfig = {};
    }
  } else {
    rawConfig = {};
  }

  // 4. PRI-477 onboarding: auto-create `features:` section ONLY when absent.
  //    Original spec §13.4 "不允许新增" applied to UNREGISTERED flags —
  //    auto-creating the section for registered flags (validated in step 1) is
  //    safe and required for the FlagToggleCard one-click enable flow on fresh
  //    installs where .pd/config.yaml has no features: section yet.
  //
  //    IMPORTANT — Runtime Contract `rc-9-no-silent-fallback` (ERR-002):
  //    If `features` EXISTS but is NOT a record/object, we must NOT silently
  //    overwrite the user's malformed value with defaults — that would hide a
  //    config error and lose the original mistake. Return 409 conflict so the
  //    Owner can fix the config first. Without this guard, a config typo like
  //    `features: "oops"` would be silently reset on the first flag toggle.
  //
  //    Use Object.hasOwn for untrusted key check (ERR-013).
  let featuresSection: Record<string, unknown>;
  if (!Object.hasOwn(rawConfig, 'features')) {
    // Section absent — create an EMPTY features map (PRI-637). Defaults belong
    // in the registry, not in config: seeding the whole registered flag set here
    // would materialize an immortal default snapshot on the first toggle of a
    // fresh install. `features: {}` is fully valid — validatePdConfig only
    // requires the key to be an object, and the effective config merges missing
    // flags from DEFAULT_FEATURE_FLAGS at read time. Step 6 below then writes
    // exactly one flag: the one the Owner toggled.
    featuresSection = {};
    rawConfig.features = featuresSection;
  } else if (isRecord(rawConfig.features)) {
    featuresSection = rawConfig.features;
  } else {
    // features: exists but is malformed (string, array, number, null, etc.).
    // Reject rather than silently resetting — rc-9-no-silent-fallback.
    const gotType = rawConfig.features === null ? 'null' : typeof rawConfig.features;
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message:
        `Cannot update feature flag: .pd/config.yaml has a 'features:' section that ` +
        `is not an object/map (got ${gotType}). Fix the config file so 'features:' ` +
        `is a map of flag objects before retrying, or remove the 'features:' key ` +
        `entirely so PD can seed registered-flag defaults.`,
      nextAction:
        "Open .pd/config.yaml and set 'features: {}' (or remove the 'features:' line).",
    };
  }

  // 5. Validate the in-memory rawConfig (with auto-created features section).
  //    NOTE: We do NOT call loadPdConfig(workspaceDir) here because that reads
  //    from DISK, where the features section may still be missing (the exact
  //    case we just auto-created for). Validating rawConfig in memory gives
  //    the same malformed-config protection without the false-positive on
  //    fresh installs. PRI-477.
  const existingConfigValidation = validatePdConfig(rawConfig);
  if (!existingConfigValidation.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message: `Cannot update feature flag: existing .pd/config.yaml is malformed. Fix config errors first. Errors: ${existingConfigValidation.errors.map(e => e.reason).join('; ')}`,
    };
  }

  // 6. Merge: update features[featureName].enabled, preserving other flags
  const existingFeatures = { ...featuresSection };
  const existingEntry = Object.hasOwn(existingFeatures, featureName)
    ? existingFeatures[featureName]
    : undefined;
  // Preserve existing category if present; otherwise use the registered default
  const category = (isRecord(existingEntry) && Object.hasOwn(existingEntry, 'category') && typeof existingEntry.category === 'string')
    ? existingEntry.category
    : (DEFAULT_FLAG_CATEGORY.get(featureName) ?? 'quiet');
  // PRI-637: the Console toggle is the canonical Owner action — an authenticated
  // server writes this override under an explicit owner intent, so it records
  // `source: 'owner'` (OWNER_PIN). This also upgrades a previously source-less
  // LEGACY_UNKNOWN or system override: an explicit Owner action converts it to
  // OWNER_PIN, which graduation must forever respect.
  existingFeatures[featureName] = { category, enabled, source: 'owner' };
  rawConfig.features = existingFeatures;

  // 7. Validate the updated config before writing
  const validation = validatePdConfig(rawConfig);
  if (!validation.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: 'validation_error',
      message: `Updated config would be invalid: ${validation.errors.map(e => e.reason).join('; ')}`,
      nextAction: 'Fix config validation errors before retrying',
    };
  }

  // 8. Atomic write
  try {
    writeConfigAtomic(configPath, rawConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, statusCode: 500, error: 'write_error', message: `Failed to write config: ${message}`, nextAction: 'Check disk space and file permissions for .pd/config.yaml' };
  }

  // 9. Re-read to confirm actual persisted state (ERR-002: fail loud on re-read failure)
  const confirmResult = loadPdConfig(workspaceDir);
  if (!confirmResult.ok) {
    return {
      ok: false,
      statusCode: 500,
      error: 'confirm_read_failed',
      message: `Write succeeded but re-read failed: config is now malformed`,
      nextAction: 'Inspect .pd/config.yaml manually for corruption',
    };
  }
  // Use computeFlagsFromLoadResult (not computeFeatureFlagsFromConfig) because
  // confirmResult is a ConfigLoadResult, not an EffectivePdConfig.
  const confirmFlags = computeFlagsFromLoadResult(confirmResult);
  const confirmedEnabled = confirmFlags.flags[featureName]?.enabled === true;

  return {
    ok: true,
    feature: featureName,
    enabled: confirmedEnabled,
  };
}

// ── Runtime Profile CRUD ─────────────────────────────────────────────────────

export interface RuntimeProfileCrudResultOk {
  ok: true;
  profileId: string;
  profile: RuntimeProfile;
}

export interface RuntimeProfileCrudResultErr {
  ok: false;
  statusCode: number;
  error: string;
  message: string;
  nextAction?: string;
}

export type RuntimeProfileCrudResult = RuntimeProfileCrudResultOk | RuntimeProfileCrudResultErr;

/**
 * Validate the basic structure of a runtime profile payload (type field).
 * Full field validation is delegated to validatePdConfig after merge.
 * Uses Object.hasOwn() for untrusted key checks (ERR-013).
 */
function validateProfileStructure(
  payload: unknown,
): { ok: true; type: string } | { ok: false; error: string; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, error: 'bad_request', message: 'Profile must be a JSON object with a type field' };
  }
  const typeRaw = Object.hasOwn(payload, 'type') ? payload.type : undefined;
  if (typeRaw === undefined) {
    return { ok: false, error: 'bad_request', message: `Profile missing required field: type (must be one of: ${VALID_PROFILE_TYPES.join(', ')})` };
  }
  if (typeof typeRaw !== 'string' || !(VALID_PROFILE_TYPES as readonly string[]).includes(typeRaw)) {
    return { ok: false, error: 'bad_request', message: `Profile type must be one of: ${VALID_PROFILE_TYPES.join(', ')}. Got: ${String(typeRaw)}` };
  }
  return { ok: true, type: typeRaw };
}

/**
 * Extract only known, correctly-typed fields from a profile payload.
 * Prevents unknown fields from being persisted to .pd/config.yaml.
 * Uses Object.hasOwn() for untrusted key checks (ERR-013).
 */
function extractProfileFields(
  payload: Record<string, unknown>,
  type: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { type };
  if (Object.hasOwn(payload, 'provider') && typeof payload.provider === 'string') {
    result.provider = payload.provider;
  }
  if (Object.hasOwn(payload, 'model') && typeof payload.model === 'string') {
    result.model = payload.model;
  }
  if (type === 'openclaw') {
    if (Object.hasOwn(payload, 'source') && typeof payload.source === 'string') {
      result.source = payload.source;
    }
  } else {
    // pi-ai
    if (Object.hasOwn(payload, 'apiKeyEnv') && typeof payload.apiKeyEnv === 'string') {
      result.apiKeyEnv = payload.apiKeyEnv;
    }
    if (Object.hasOwn(payload, 'baseUrl') && typeof payload.baseUrl === 'string') {
      result.baseUrl = payload.baseUrl;
    }
    if (Object.hasOwn(payload, 'timeoutMs') && typeof payload.timeoutMs === 'number') {
      result.timeoutMs = payload.timeoutMs;
    }
    if (Object.hasOwn(payload, 'maxRetries') && typeof payload.maxRetries === 'number') {
      result.maxRetries = payload.maxRetries;
    }
  }
  return result;
}

/**
 * Read raw config file preserving unknown root sections.
 * Returns an empty record if the file does not exist.
 * Treats parsed YAML as unknown (ERR-001).
 */
function readRawConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const rawContent = fs.readFileSync(configPath, 'utf8');
  const rawParsed = yaml.load(rawContent, { schema: yaml.JSON_SCHEMA });
  if (isRecord(rawParsed)) {
    return { ...rawParsed };
  }
  return {};
}

/**
 * Create a new runtime profile in .pd/config.yaml.
 *
 * - Rejects duplicate profile IDs (400 bad_request)
 * - Validates profile structure (type + required fields via validatePdConfig)
 * - Persists atomically, preserving unknown config sections
 *
 * ERR entries:
 * - ERR-001/ERR-005: No `as` bypasses; payload validated as unknown
 * - ERR-002: Graceful degradation includes reason + nextAction
 * - ERR-009/ERR-010: Required fields fail loud
 * - ERR-013: Object.hasOwn() for untrusted keys
 */
export function createRuntimeProfile(
  workspaceDir: string,
  profileId: string,
  payload: unknown,
): RuntimeProfileCrudResult {
  // 1. Validate profileId
  if (typeof profileId !== 'string' || profileId.length === 0) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: 'profileId must be a non-empty string' };
  }

  // 2. Validate profile structure (type field)
  const structResult = validateProfileStructure(payload);
  if (!structResult.ok) {
    return { ok: false, statusCode: 400, error: structResult.error, message: structResult.message };
  }

  // 3. Load existing config — refuse to write on malformed (rc-9)
  const loadResult = loadPdConfig(workspaceDir);
  if (!loadResult.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message: `Cannot create runtime profile: existing .pd/config.yaml is malformed. Fix config errors first. Errors: ${loadResult.errors.map(e => e.reason).join('; ')}`,
    };
  }

  const { effective } = loadResult;

  // 4. Reject duplicate profile ID
  if (Object.hasOwn(effective.config.runtimeProfiles, profileId)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Runtime profile '${profileId}' already exists. Use PATCH to update it.`,
      nextAction: `Use PATCH /api/v1/config/profiles/${encodeURIComponent(profileId)} to update the existing profile`,
    };
  }

  // 5. Extract only known fields from payload (prevents unknown field persistence)
  const profileRecord = extractProfileFields(payload as Record<string, unknown>, structResult.type);

  // 6. Read raw config to preserve unknown sections, add new profile
  const configPath = getPdConfigPath(workspaceDir);
  const rawConfig = readRawConfig(configPath);
  const profilesMap = isRecord(rawConfig.runtimeProfiles)
    ? { ...rawConfig.runtimeProfiles }
    : { ...effective.config.runtimeProfiles };
  profilesMap[profileId] = profileRecord;
  rawConfig.runtimeProfiles = profilesMap;

  // 7. Validate the full updated config (catches missing required fields etc.)
  const validation = validatePdConfig(rawConfig);
  if (!validation.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Profile validation failed: ${validation.errors.map(e => e.reason).join('; ')}`,
      nextAction: 'Fix profile fields and retry',
    };
  }

  // 8. Atomic write
  try {
    writeConfigAtomic(configPath, rawConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, statusCode: 500, error: 'write_error', message: `Failed to write config: ${message}`, nextAction: 'Check disk space and file permissions for .pd/config.yaml' };
  }

  // 9. Return the validated profile from the config
  // Defensive guard: Object.hasOwn() doesn't narrow TS type, so extract and verify.
  const createdProfile = validation.value.runtimeProfiles[profileId];
  if (!createdProfile) {
    return { ok: false, statusCode: 500, error: 'internal_error',
      message: `Profile '${profileId}' was written but could not be read back from config.`,
      nextAction: 'This is a bug in PD config persistence. Please report it.' };
  }
  return {
    ok: true,
    profileId,
    profile: createdProfile,
  };
}

/**
 * Update an existing runtime profile in .pd/config.yaml.
 *
 * - Rejects non-existent profile (404 not_found)
 * - Rejects type changes (400 bad_request — type change = delete + create)
 * - Merges patch into existing profile, only known fields are persisted
 * - Persists atomically, preserving unknown config sections
 *
 * ERR entries: same as createRuntimeProfile.
 */
export function updateRuntimeProfile(
  workspaceDir: string,
  profileId: string,
  patch: unknown,
): RuntimeProfileCrudResult {
  // 1. Validate profileId
  if (typeof profileId !== 'string' || profileId.length === 0) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: 'profileId must be a non-empty string' };
  }

  // 2. Validate patch is a record
  if (!isRecord(patch)) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: 'Patch payload must be a JSON object' };
  }

  // 3. Load existing config — refuse to write on malformed (rc-9)
  const loadResult = loadPdConfig(workspaceDir);
  if (!loadResult.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message: `Cannot update runtime profile: existing .pd/config.yaml is malformed. Fix config errors first. Errors: ${loadResult.errors.map(e => e.reason).join('; ')}`,
    };
  }

  const { effective } = loadResult;

  // 4. Reject if profile doesn't exist (404)
  if (!Object.hasOwn(effective.config.runtimeProfiles, profileId)) {
    return {
      ok: false,
      statusCode: 404,
      error: 'not_found',
      message: `Runtime profile '${profileId}' does not exist. Available profiles: ${Object.keys(effective.config.runtimeProfiles).join(', ')}`,
      nextAction: 'Use POST /api/v1/config/profiles to create a new profile',
    };
  }

  const existingProfile = effective.config.runtimeProfiles[profileId];
  // Defensive guard: Object.hasOwn() above doesn't narrow TS type.
  if (!existingProfile) {
    return { ok: false, statusCode: 500, error: 'internal_error',
      message: `Profile '${profileId}' existence check passed but value is undefined.`,
      nextAction: 'This is a bug in PD config resolution. Please report it.' };
  }

  // 5. Reject type change (type change = delete + create)
  if (Object.hasOwn(patch, 'type')) {
    const patchType = patch.type;
    if (typeof patchType !== 'string' || patchType !== existingProfile.type) {
      return {
        ok: false,
        statusCode: 400,
        error: 'bad_request',
        message: `Cannot change profile type (existing: '${existingProfile.type}', requested: '${String(patchType)}'). Type change equals delete + create. Delete this profile and create a new one instead.`,
        nextAction: `DELETE /api/v1/config/profiles/${encodeURIComponent(profileId)} then POST /api/v1/config/profiles with the new type`,
      };
    }
  }

  // 6. Merge patch into existing profile, then extract only known fields
  const mergedSource: Record<string, unknown> = { ...existingProfile, ...patch };
  const mergedRecord = extractProfileFields(mergedSource, existingProfile.type);

  // 7. Read raw config to preserve unknown sections, update the profile
  const configPath = getPdConfigPath(workspaceDir);
  const rawConfig = readRawConfig(configPath);
  const profilesMap = isRecord(rawConfig.runtimeProfiles)
    ? { ...rawConfig.runtimeProfiles }
    : { ...effective.config.runtimeProfiles };
  profilesMap[profileId] = mergedRecord;
  rawConfig.runtimeProfiles = profilesMap;

  // 8. Validate the full updated config
  const validation = validatePdConfig(rawConfig);
  if (!validation.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Profile validation failed: ${validation.errors.map(e => e.reason).join('; ')}`,
      nextAction: 'Fix profile fields and retry',
    };
  }

  // 9. Atomic write
  try {
    writeConfigAtomic(configPath, rawConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, statusCode: 500, error: 'write_error', message: `Failed to write config: ${message}`, nextAction: 'Check disk space and file permissions for .pd/config.yaml' };
  }

  // 10. Return the validated updated profile
  // Defensive guard: Object.hasOwn() doesn't narrow TS type.
  const updatedProfile = validation.value.runtimeProfiles[profileId];
  if (!updatedProfile) {
    return { ok: false, statusCode: 500, error: 'internal_error',
      message: `Profile '${profileId}' was updated but could not be read back from config.`,
      nextAction: 'This is a bug in PD config persistence. Please report it.' };
  }
  return {
    ok: true,
    profileId,
    profile: updatedProfile,
  };
}

/**
 * Delete a runtime profile from .pd/config.yaml.
 *
 * - Rejects non-existent profile (404 not_found)
 * - Rejects if profile is the defaultRuntime (400 bad_request)
 * - Rejects if any agent binding references the profile (400 bad_request, lists agents)
 * - Persists atomically, preserving unknown config sections
 *
 * ERR entries: same as createRuntimeProfile.
 */
export function deleteRuntimeProfile(
  workspaceDir: string,
  profileId: string,
): RuntimeProfileCrudResult {
  // 1. Validate profileId
  if (typeof profileId !== 'string' || profileId.length === 0) {
    return { ok: false, statusCode: 400, error: 'bad_request', message: 'profileId must be a non-empty string' };
  }

  // 2. Load existing config — refuse to write on malformed (rc-9)
  const loadResult = loadPdConfig(workspaceDir);
  if (!loadResult.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message: `Cannot delete runtime profile: existing .pd/config.yaml is malformed. Fix config errors first. Errors: ${loadResult.errors.map(e => e.reason).join('; ')}`,
    };
  }

  const { effective } = loadResult;

  // 3. Reject if profile doesn't exist (404)
  if (!Object.hasOwn(effective.config.runtimeProfiles, profileId)) {
    return {
      ok: false,
      statusCode: 404,
      error: 'not_found',
      message: `Runtime profile '${profileId}' does not exist. Available profiles: ${Object.keys(effective.config.runtimeProfiles).join(', ')}`,
    };
  }

  // Capture the profile snapshot BEFORE deletion (for return value).
  // Defensive guard: Object.hasOwn() doesn't narrow TS type.
  const deletedProfile = effective.config.runtimeProfiles[profileId];
  if (!deletedProfile) {
    return { ok: false, statusCode: 500, error: 'internal_error',
      message: `Profile '${profileId}' existence check passed but value is undefined.`,
      nextAction: 'This is a bug in PD config resolution. Please report it.' };
  }

  // 4. Reject if profile is the defaultRuntime
  if (effective.config.internalAgents.defaultRuntime === profileId) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Cannot delete runtime profile '${profileId}' because it is the default runtime. Change the default runtime first.`,
      nextAction: 'Use PATCH /api/v1/config/default-runtime to change the default to another profile before deleting',
    };
  }

  // 5. Reject if any agent binding references this profile (list the agents)
  const referencingAgents: string[] = [];
  for (const agentName of INTERNAL_AGENT_NAMES) {
    const binding = effective.config.internalAgents.agents[agentName];
    if (binding && binding.runtimeProfile === profileId) {
      referencingAgents.push(agentName);
    }
  }
  if (referencingAgents.length > 0) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Cannot delete runtime profile '${profileId}' because it is referenced by agents: ${referencingAgents.join(', ')}. Update their bindings first.`,
      nextAction: `Use PATCH /api/v1/config/agents/:agentName/binding to reassign: ${referencingAgents.join(', ')}`,
    };
  }

  // 6. Read raw config to preserve unknown sections, remove the profile
  const configPath = getPdConfigPath(workspaceDir);
  const rawConfig = readRawConfig(configPath);
  const profilesMap = isRecord(rawConfig.runtimeProfiles)
    ? { ...rawConfig.runtimeProfiles }
    : {};
  delete profilesMap[profileId];
  rawConfig.runtimeProfiles = profilesMap;

  // 7. Validate the updated config
  const validation = validatePdConfig(rawConfig);
  if (!validation.ok) {
    return {
      ok: false,
      statusCode: 400,
      error: 'bad_request',
      message: `Updated config would be invalid after deletion: ${validation.errors.map(e => e.reason).join('; ')}`,
    };
  }

  // 8. Atomic write
  try {
    writeConfigAtomic(configPath, rawConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, statusCode: 500, error: 'write_error', message: `Failed to write config: ${message}`, nextAction: 'Check disk space and file permissions for .pd/config.yaml' };
  }

  // 9. Return the deleted profile snapshot for client confirmation
  return {
    ok: true,
    profileId,
    profile: deletedProfile,
  };
}

// ── Check Readiness ──────────────────────────────────────────────────────────

export function checkReadiness(
  workspaceDir: string,
  agentName: string,
  getEnvVar: (name: string) => string | undefined = (name: string) => process.env[name],
): ReadinessResult | ReadinessError {
  // 1. Validate agent name
  if (!isValidAgentName(agentName)) {
    return {
      ok: false,
      statusCode: 404,
      error: 'not_found',
      message: `Unknown agent name '${agentName}'. Valid agents: ${INTERNAL_AGENT_NAMES.join(', ')}`,
    };
  }

  // 2. Load config — if malformed, return unknown (not defaults pretending normal)
  const loadResult = loadPdConfig(workspaceDir);
  if (!loadResult.ok) {
    return {
      ok: true,
      agent: agentName,
      readiness: 'unknown',
      profileId: '',
      profileLabel: '',
      reason: `Config file is malformed: ${loadResult.errors[0]?.reason ?? 'unknown error'}`,
      nextAction: 'Fix .pd/config.yaml errors before checking readiness',
    };
  }

  const { effective } = loadResult;

  // 3. Resolve agent binding
  const bindingResult = resolveAgentRuntimeBinding(effective, agentName);

  if (!bindingResult.ok) {
    // Agent is disabled or profile not found
    // Use the agent's override profile id if present, otherwise default
    const unresolvedProfileId = effective.config.internalAgents.agents[agentName]?.runtimeProfile
      ?? effective.config.internalAgents.defaultRuntime;
    const resolvedProfileId = bindingResult.readiness === 'disabled'
      ? effective.config.internalAgents.defaultRuntime
      : unresolvedProfileId;
    const resolvedProfile = effective.config.runtimeProfiles[resolvedProfileId];
    // If profile not found, label must clearly indicate the missing profile
    const profileLabel = resolvedProfile
      ? buildProfileLabel(resolvedProfileId, resolvedProfile)
      : `unknown:${resolvedProfileId}`;
    return {
      ok: true,
      agent: agentName,
      readiness: bindingResult.readiness,
      profileId: resolvedProfileId,
      profileLabel,
      reason: bindingResult.reason,
      nextAction: bindingResult.nextAction,
    };
  }

  // 4. Check runtime readiness
  const readinessResult: AgentRuntimeReadinessResult = checkAgentRuntimeReadiness(
    bindingResult.profile,
    getEnvVar,
  );

  return {
    ok: true,
    agent: agentName,
    readiness: readinessResult.readiness,
    profileId: bindingResult.profileId,
    profileLabel: buildProfileLabel(bindingResult.profileId, bindingResult.profile),
    reason: readinessResult.reason,
    nextAction: readinessResult.nextAction,
  };
}
