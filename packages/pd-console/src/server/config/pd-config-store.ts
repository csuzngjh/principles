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

  // Update only the agent binding section
  const agentsMap: Record<string, AgentBindingEntry> = {};
  for (const name of INTERNAL_AGENT_NAMES) {
    const existing = effective.config.internalAgents.agents[name];
    if (name === agentName) {
      agentsMap[name] = { enabled, runtimeProfile };
    } else if (existing) {
      agentsMap[name] = {
        enabled: existing.enabled,
        ...(existing.runtimeProfile ? { runtimeProfile: existing.runtimeProfile } : {}),
      };
    }
  }

  // Merge: start from raw config, overlay known sections, update internalAgents.agents
  const updatedConfig: Record<string, unknown> = {
    ...rawConfig,
    version: effective.config.version,
    features: { ...effective.config.features },
    runtimeProfiles: { ...effective.config.runtimeProfiles },
    internalAgents: {
      defaultRuntime: effective.config.internalAgents.defaultRuntime,
      agents: agentsMap,
    },
    ui: { ...effective.config.ui },
  };

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

  // Merge: update only defaultRuntime, preserve agent overrides
  const updatedConfig: Record<string, unknown> = {
    ...rawConfig,
    version: effective.config.version,
    features: { ...effective.config.features },
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

/** Valid values for principles.outputLanguage in config.yaml */
export const VALID_OUTPUT_LANGUAGES = ['zh-CN', 'en'] as const;
export type OutputLanguage = typeof VALID_OUTPUT_LANGUAGES[number];

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

/** Default output language when not configured. */
const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'zh-CN';

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

  // 4. Refuse to CREATE a features section if absent (spec §13.4: 不允许新增)
  //    Use Object.hasOwn for untrusted key check (ERR-013)
  if (!Object.hasOwn(rawConfig, 'features') || !isRecord(rawConfig.features)) {
    return {
      ok: false,
      statusCode: 422,
      error: 'no_features_section',
      message: `Cannot update feature flag: .pd/config.yaml has no 'features:' section. This API does not create new feature sections.`,
      nextAction: 'Manually add a features: section to .pd/config.yaml first, or set the flag via yaml directly.',
    };
  }

  // 5. Load existing config — if malformed, refuse to write
  const loadResult = loadPdConfig(workspaceDir);
  if (!loadResult.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: 'conflict',
      message: `Cannot update feature flag: existing .pd/config.yaml is malformed. Fix config errors first. Errors: ${loadResult.errors.map(e => e.reason).join('; ')}`,
    };
  }

  // 6. Merge: update features[featureName].enabled, preserving other flags
  const existingFeatures = { ...rawConfig.features } as Record<string, unknown>;
  const existingEntry = Object.hasOwn(existingFeatures, featureName)
    ? existingFeatures[featureName]
    : undefined;
  // Preserve existing category if present; otherwise use the registered default
  const category = (isRecord(existingEntry) && Object.hasOwn(existingEntry, 'category') && typeof existingEntry.category === 'string')
    ? existingEntry.category
    : (DEFAULT_FLAG_CATEGORY.get(featureName) ?? 'quiet');
  existingFeatures[featureName] = { category, enabled };
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
