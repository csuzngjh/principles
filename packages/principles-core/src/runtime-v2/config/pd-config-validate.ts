/**
 * PD Config Validation — PRI-304
 *
 * Runtime validation from `unknown` (parsed YAML/JSON).
 * No `as` bypasses on untrusted input (ERR-001, ERR-005).
 * Uses `Object.hasOwn()` for key checks (ERR-013).
 * Missing/malformed required fields fail loud (ERR-009, ERR-010).
 * Non-boolean enabled fields fail loud (ERR-047).
 */

import {
  type PdConfig,
  type PdConfigValidationResult,
  type PdConfigValidationError,
  type FeatureFlagEntry,
  type FeatureCategory,
  type RuntimeProfile,
  type RuntimeProfileType,
  type OpenClawRuntimeProfile,
  type PdLocalRuntimeProfile,
  type InternalAgentBinding,
  type InternalAgentName,
  type InternalAgentsConfig,
  type UiConfig,
  type DiagnosticsMode,
  type WorkspaceConfig,
  PD_CONFIG_VERSION,
  VALID_FEATURE_CATEGORIES,
  VALID_PROFILE_TYPES,
  INTERNAL_AGENT_NAMES,
  VALID_DIAGNOSTICS_MODES,
  DANGEROUS_KEYS,
} from './pd-config-types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function err(path: string, reason: string, nextAction: string): PdConfigValidationError {
  return { path, reason, nextAction };
}

function readOwn(obj: Record<string, unknown>, key: string): unknown {
  if (DANGEROUS_KEYS.has(key)) return undefined;
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// ── Safe Preview ────────────────────────────────────────────────────────────

function safePreview(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > 50 ? `"${s.slice(0, 50)}…"` : `"${s}"`;
  }
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  if (t === 'object') return 'object';
  return t;
}

// ── Feature Flag Validation ─────────────────────────────────────────────────

function validateFeatureFlagEntry(
  raw: unknown,
  path: string,
  flagId: string,
): { ok: true; value: FeatureFlagEntry } | { ok: false; errors: PdConfigValidationError[] } {
  const errors: PdConfigValidationError[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [err(path, `feature '${flagId}' must be an object, got ${typeof raw}`, `Fix feature '${flagId}' to be an object with category and enabled fields`)] };
  }

  const categoryRaw = readOwn(raw, 'category');
  if (categoryRaw === undefined) {
    errors.push(err(`${path}.category`, `feature '${flagId}' missing required field 'category'`, `Add 'category' to feature '${flagId}' (one of: ${VALID_FEATURE_CATEGORIES.join(', ')})`));
  } else if (!isString(categoryRaw) || !VALID_FEATURE_CATEGORIES.includes(categoryRaw as FeatureCategory)) {
    errors.push(err(`${path}.category`, `feature '${flagId}' category must be one of: ${VALID_FEATURE_CATEGORIES.join(', ')}, got ${safePreview(categoryRaw)}`, `Change category of feature '${flagId}' to one of: ${VALID_FEATURE_CATEGORIES.join(', ')}`));
  }

  const enabledRaw = readOwn(raw, 'enabled');
  if (enabledRaw === undefined) {
    errors.push(err(`${path}.enabled`, `feature '${flagId}' missing required field 'enabled'`, `Add 'enabled' (boolean) to feature '${flagId}'`));
  } else if (!isBoolean(enabledRaw)) {
    errors.push(err(`${path}.enabled`, `feature '${flagId}' enabled must be boolean, got ${typeof enabledRaw}`, `Change enabled of feature '${flagId}' to true or false`));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      category: categoryRaw as FeatureCategory,
      enabled: enabledRaw as boolean,
    },
  };
}

// ── Runtime Profile Validation ──────────────────────────────────────────────

function validateOpenClawProfile(
  raw: Record<string, unknown>,
  path: string,
  profileId: string,
): { ok: true; value: OpenClawRuntimeProfile } | { ok: false; errors: PdConfigValidationError[] } {
  const errors: PdConfigValidationError[] = [];

  const provider = readOwn(raw, 'provider');
  if (provider !== undefined && !isString(provider)) {
    errors.push(err(`${path}.provider`, `profile '${profileId}' provider must be a string, got ${typeof provider}`, `Fix provider in profile '${profileId}'`));
  }

  const model = readOwn(raw, 'model');
  if (model !== undefined && !isString(model)) {
    errors.push(err(`${path}.model`, `profile '${profileId}' model must be a string, got ${typeof model}`, `Fix model in profile '${profileId}'`));
  }

  const source = readOwn(raw, 'source');
  if (source !== undefined && !isString(source)) {
    errors.push(err(`${path}.source`, `profile '${profileId}' source must be a string, got ${typeof source}`, `Fix source in profile '${profileId}'`));
  }

  // Reject secret-like fields (ADR-0016 §2.3)
  const forbiddenKeys = ['apiKey', 'api_key', 'token', 'gatewayToken', 'gateway_token', 'secret', 'password', 'auth'];
  for (const fk of forbiddenKeys) {
    if (Object.hasOwn(raw, fk)) {
      errors.push(err(`${path}.${fk}`, `profile '${profileId}' contains forbidden secret field '${fk}'`, `Remove '${fk}' from profile '${profileId}' — PD does not store provider credentials (ADR-0016 §2.2)`));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const result: OpenClawRuntimeProfile = { type: 'openclaw' };
  if (isString(provider)) result.provider = provider;
  if (isString(model)) result.model = model;
  if (isString(source)) result.source = source;
  return { ok: true, value: result };
}

function validatePdLocalProfile(
  raw: Record<string, unknown>,
  path: string,
  profileId: string,
): { ok: true; value: PdLocalRuntimeProfile } | { ok: false; errors: PdConfigValidationError[] } {
  const errors: PdConfigValidationError[] = [];

  const provider = readOwn(raw, 'provider');
  if (provider === undefined) {
    errors.push(err(`${path}.provider`, `profile '${profileId}' missing required field 'provider'`, `Add 'provider' to profile '${profileId}' (e.g. "anthropic", "openai")`));
  } else if (!isString(provider) || provider.length === 0) {
    errors.push(err(`${path}.provider`, `profile '${profileId}' provider must be a non-empty string, got ${safePreview(provider)}`, `Fix provider in profile '${profileId}'`));
  }

  const model = readOwn(raw, 'model');
  if (model === undefined) {
    errors.push(err(`${path}.model`, `profile '${profileId}' missing required field 'model'`, `Add 'model' to profile '${profileId}' (e.g. "claude-3-5-sonnet")`));
  } else if (!isString(model) || model.length === 0) {
    errors.push(err(`${path}.model`, `profile '${profileId}' model must be a non-empty string, got ${safePreview(model)}`, `Fix model in profile '${profileId}'`));
  }

  const apiKeyEnv = readOwn(raw, 'apiKeyEnv');
  if (apiKeyEnv === undefined) {
    errors.push(err(`${path}.apiKeyEnv`, `profile '${profileId}' missing required field 'apiKeyEnv'`, `Add 'apiKeyEnv' to profile '${profileId}' (e.g. "ANTHROPIC_API_KEY")`));
  } else if (!isString(apiKeyEnv) || apiKeyEnv.length === 0) {
    errors.push(err(`${path}.apiKeyEnv`, `profile '${profileId}' apiKeyEnv must be a non-empty string (env var name), got ${safePreview(apiKeyEnv)}`, `Fix apiKeyEnv in profile '${profileId}' to be an environment variable name`));
  }

  const baseUrl = readOwn(raw, 'baseUrl');
  if (baseUrl !== undefined && !isString(baseUrl)) {
    errors.push(err(`${path}.baseUrl`, `profile '${profileId}' baseUrl must be a string, got ${typeof baseUrl}`, `Fix baseUrl in profile '${profileId}'`));
  }

  const timeoutMs = readOwn(raw, 'timeoutMs');
  if (timeoutMs !== undefined && !isNumber(timeoutMs)) {
    errors.push(err(`${path}.timeoutMs`, `profile '${profileId}' timeoutMs must be a finite number, got ${safePreview(timeoutMs)}`, `Fix timeoutMs in profile '${profileId}'`));
  }
  if (isNumber(timeoutMs) && timeoutMs <= 0) {
    errors.push(err(`${path}.timeoutMs`, `profile '${profileId}' timeoutMs must be positive, got ${timeoutMs}`, `Set timeoutMs in profile '${profileId}' to a positive number`));
  }

  const maxRetries = readOwn(raw, 'maxRetries');
  if (maxRetries !== undefined && !isNumber(maxRetries)) {
    errors.push(err(`${path}.maxRetries`, `profile '${profileId}' maxRetries must be a finite number, got ${safePreview(maxRetries)}`, `Fix maxRetries in profile '${profileId}'`));
  }
  if (isNumber(maxRetries) && maxRetries < 0) {
    errors.push(err(`${path}.maxRetries`, `profile '${profileId}' maxRetries must be non-negative, got ${maxRetries}`, `Set maxRetries in profile '${profileId}' to a non-negative number`));
  }

  // Reject raw secret values
  const forbiddenValueKeys = ['apiKey', 'api_key', 'token', 'gatewayToken', 'gateway_token', 'secret', 'password', 'auth'];
  for (const fk of forbiddenValueKeys) {
    if (Object.hasOwn(raw, fk)) {
      errors.push(err(`${path}.${fk}`, `profile '${profileId}' contains forbidden secret field '${fk}'`, `Remove '${fk}' from profile '${profileId}' — use 'apiKeyEnv' for env var name reference (ADR-0016 §2.2)`));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const result: PdLocalRuntimeProfile = {
    type: 'pi-ai',
    provider: provider as string,
    model: model as string,
    apiKeyEnv: apiKeyEnv as string,
  };
  if (isString(baseUrl)) result.baseUrl = baseUrl;
  if (isNumber(timeoutMs)) result.timeoutMs = timeoutMs;
  if (isNumber(maxRetries)) result.maxRetries = maxRetries;
  return { ok: true, value: result };
}

function validateRuntimeProfile(
  raw: unknown,
  path: string,
  profileId: string,
): { ok: true; value: RuntimeProfile } | { ok: false; errors: PdConfigValidationError[] } {
  if (!isRecord(raw)) {
    return { ok: false, errors: [err(path, `profile '${profileId}' must be an object, got ${typeof raw}`, `Fix profile '${profileId}' to be an object with type, provider, model fields`)] };
  }

  // Reject dangerous keys
  for (const dk of DANGEROUS_KEYS) {
    if (Object.hasOwn(raw, dk)) {
      return { ok: false, errors: [err(`${path}.${dk}`, `profile '${profileId}' contains dangerous key '${dk}'`, `Remove '${dk}' from profile '${profileId}'`)] };
    }
  }

  const typeRaw = readOwn(raw, 'type');
  if (typeRaw === undefined) {
    return { ok: false, errors: [err(`${path}.type`, `profile '${profileId}' missing required field 'type'`, `Add 'type' to profile '${profileId}' (one of: ${VALID_PROFILE_TYPES.join(', ')})`)] };
  }
  if (!isString(typeRaw) || !VALID_PROFILE_TYPES.includes(typeRaw as RuntimeProfileType)) {
    return { ok: false, errors: [err(`${path}.type`, `profile '${profileId}' type must be one of: ${VALID_PROFILE_TYPES.join(', ')}, got ${safePreview(typeRaw)}`, `Fix type in profile '${profileId}'`)] };
  }

  if (typeRaw === 'openclaw') {
    return validateOpenClawProfile(raw, path, profileId);
  }
  return validatePdLocalProfile(raw, path, profileId);
}

// ── Internal Agent Binding Validation ───────────────────────────────────────

function validateInternalAgentBinding(
  raw: unknown,
  path: string,
  agentName: string,
): { ok: true; value: InternalAgentBinding } | { ok: false; errors: PdConfigValidationError[] } {
  const errors: PdConfigValidationError[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [err(path, `agent '${agentName}' must be an object, got ${typeof raw}`, `Fix agent '${agentName}' to be an object with enabled and optional runtimeProfile fields`)] };
  }

  const enabledRaw = readOwn(raw, 'enabled');
  if (enabledRaw === undefined) {
    errors.push(err(`${path}.enabled`, `agent '${agentName}' missing required field 'enabled'`, `Add 'enabled' (boolean) to agent '${agentName}'`));
  } else if (!isBoolean(enabledRaw)) {
    errors.push(err(`${path}.enabled`, `agent '${agentName}' enabled must be boolean, got ${typeof enabledRaw}`, `Change enabled of agent '${agentName}' to true or false`));
  }

  const runtimeProfileRaw = readOwn(raw, 'runtimeProfile');
  if (runtimeProfileRaw !== undefined && !isString(runtimeProfileRaw)) {
    errors.push(err(`${path}.runtimeProfile`, `agent '${agentName}' runtimeProfile must be a string, got ${typeof runtimeProfileRaw}`, `Fix runtimeProfile of agent '${agentName}' to a profile ID`));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const result: InternalAgentBinding = {
    enabled: enabledRaw as boolean,
  };
  if (isString(runtimeProfileRaw)) {
    result.runtimeProfile = runtimeProfileRaw;
  }
  return { ok: true, value: result };
}

// ── Internal Agents Config Validation ───────────────────────────────────────

function validateInternalAgents(raw: unknown, path: string): { ok: true; value: InternalAgentsConfig } | { ok: false; errors: PdConfigValidationError[] } {
  const errors: PdConfigValidationError[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [err(path, `internalAgents must be an object, got ${typeof raw}`, 'Fix internalAgents to be an object with defaultRuntime and agents')] };
  }

  const defaultRuntimeRaw = readOwn(raw, 'defaultRuntime');
  if (defaultRuntimeRaw === undefined) {
    errors.push(err(`${path}.defaultRuntime`, 'missing required field defaultRuntime', 'Add defaultRuntime with a runtime profile ID'));
  } else if (!isString(defaultRuntimeRaw) || defaultRuntimeRaw.length === 0) {
    errors.push(err(`${path}.defaultRuntime`, `defaultRuntime must be a non-empty string, got ${safePreview(defaultRuntimeRaw)}`, 'Fix defaultRuntime to a valid runtime profile ID'));
  }

  // agents sub-object
  const agentsRaw = readOwn(raw, 'agents');
  const agents: Record<string, InternalAgentBinding> = {};

  if (agentsRaw === undefined) {
    errors.push(err(`${path}.agents`, 'missing required field agents', `Add agents section with per-agent bindings: ${INTERNAL_AGENT_NAMES.join(', ')}`));
  } else if (!isRecord(agentsRaw)) {
    errors.push(err(`${path}.agents`, `agents must be an object, got ${typeof agentsRaw}`, 'Fix agents to be an object mapping agent names to bindings'));
  } else {
    for (const name of INTERNAL_AGENT_NAMES) {
      const agentRaw = readOwn(agentsRaw, name);
      if (agentRaw === undefined) {
        // Missing agents get defaults later in effective config
        continue;
      }
      const result = validateInternalAgentBinding(agentRaw, `${path}.agents.${name}`, name);
      if (result.ok) {
        agents[name] = result.value;
      } else {
        errors.push(...result.errors);
      }
    }

    // Reject unknown agent keys in agents sub-object
    for (const key of Object.keys(agentsRaw)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (!INTERNAL_AGENT_NAMES.includes(key as InternalAgentName)) {
        errors.push(err(`${path}.agents.${key}`, `unknown agent key '${key}'`, `Remove unknown agent '${key}' or use a known agent name: ${INTERNAL_AGENT_NAMES.join(', ')}`));
      }
    }
  }

  // Reject unknown keys at internalAgents level
  const knownTopKeys = new Set<string>(['defaultRuntime', 'agents']);
  for (const key of Object.keys(raw)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (!knownTopKeys.has(key)) {
      errors.push(err(`${path}.${key}`, `unknown key '${key}' in internalAgents`, `Remove unknown key '${key}' from internalAgents`));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      defaultRuntime: defaultRuntimeRaw as string,
      agents: agents,
    },
  };
}

// ── UI Config Validation ────────────────────────────────────────────────────

function validateUiConfig(raw: unknown, path: string): { ok: true; value: UiConfig } | { ok: false; errors: PdConfigValidationError[] } {
  const errors: PdConfigValidationError[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [err(path, `ui must be an object, got ${typeof raw}`, 'Fix ui to be an object with diagnostics settings')] };
  }

  const diagnosticsRaw = readOwn(raw, 'diagnostics');
  if (!isRecord(diagnosticsRaw)) {
    return { ok: false, errors: [err(`${path}.diagnostics`, `ui.diagnostics must be an object, got ${typeof diagnosticsRaw}`, 'Fix ui.diagnostics to be an object with mode field')] };
  }

  const modeRaw = readOwn(diagnosticsRaw, 'mode');
  if (modeRaw === undefined) {
    errors.push(err(`${path}.diagnostics.mode`, 'missing required field mode', `Add mode to ui.diagnostics (one of: ${VALID_DIAGNOSTICS_MODES.join(', ')})`));
  } else if (!isString(modeRaw) || !VALID_DIAGNOSTICS_MODES.includes(modeRaw as DiagnosticsMode)) {
    errors.push(err(`${path}.diagnostics.mode`, `mode must be one of: ${VALID_DIAGNOSTICS_MODES.join(', ')}, got ${safePreview(modeRaw)}`, `Fix mode to one of: ${VALID_DIAGNOSTICS_MODES.join(', ')}`));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      diagnostics: {
        mode: modeRaw as DiagnosticsMode,
      },
    },
  };
}

// ── Workspace Config Validation ─────────────────────────────────────────────

function isAbsolutePath(p: string): boolean {
  // Windows: C:\ or C:/ or \\unc
  // POSIX: /...
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

function validateWorkspaceConfig(
  raw: unknown,
  path: string,
): { ok: true; value: WorkspaceConfig } | { ok: false; errors: PdConfigValidationError[] } {
  const errors: PdConfigValidationError[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: [err(path, `workspace must be an object, got ${typeof raw}`, 'Fix workspace to be an object with a default field')] };
  }

  // Reject dangerous keys
  for (const dk of DANGEROUS_KEYS) {
    if (Object.hasOwn(raw, dk)) {
      return { ok: false, errors: [err(`${path}.${dk}`, `workspace contains dangerous key '${dk}'`, `Remove '${dk}' from workspace`)] };
    }
  }

  const defaultRaw = readOwn(raw, 'default');
  if (defaultRaw === undefined) {
    errors.push(err(`${path}.default`, 'workspace missing required field default', 'Add default path to workspace section (must be an absolute path)'));
  } else if (!isString(defaultRaw) || defaultRaw.length === 0) {
    errors.push(err(`${path}.default`, `workspace.default must be a non-empty string, got ${safePreview(defaultRaw)}`, 'Set workspace.default to an absolute directory path'));
  } else if (!isAbsolutePath(defaultRaw)) {
    errors.push(err(`${path}.default`, `workspace.default must be an absolute path, got "${defaultRaw}"`, 'Use an absolute path like "D:\\.openclaw\\workspace" or "/home/user/.openclaw/workspace"'));
  }

  // Reject unknown keys in workspace section
  const knownWorkspaceKeys = new Set(['default']);
  for (const key of Object.keys(raw)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (!knownWorkspaceKeys.has(key)) {
      errors.push(err(`${path}.${key}`, `unknown key '${key}' in workspace`, `Remove unknown key '${key}' from workspace`));
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: { default: defaultRaw as string },
  };
}

// ── Top-Level Validation ────────────────────────────────────────────────────

/**
 * Validate a parsed `.pd/config.yaml` value from unknown input.
 * Returns structured result — never throws on malformed input.
 */
export function validatePdConfig(raw: unknown): PdConfigValidationResult {
  const errors: PdConfigValidationError[] = [];

  if (raw === null || raw === undefined) {
    return {
      ok: false,
      errors: [err('', 'config is null or undefined', 'Provide a valid .pd/config.yaml file or use defaults')],
    };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: [err('', `config root must be an object, got ${typeof raw}`, 'Fix .pd/config.yaml to be a YAML object')],
    };
  }

  // Reject dangerous keys at root
  for (const dk of DANGEROUS_KEYS) {
    if (Object.hasOwn(raw, dk)) {
      errors.push(err(dk, `root contains dangerous key '${dk}'`, `Remove '${dk}' from config root`));
    }
  }

  // version
  const versionRaw = readOwn(raw, 'version');
  if (versionRaw === undefined) {
    errors.push(err('version', 'missing required field version', `Add version: ${PD_CONFIG_VERSION} to config`));
  } else if (!isNumber(versionRaw) || versionRaw !== PD_CONFIG_VERSION) {
    errors.push(err('version', `version must be ${PD_CONFIG_VERSION}, got ${safePreview(versionRaw)}`, `Set version to ${PD_CONFIG_VERSION}`));
  }

  // workspace (optional)
  const workspaceRaw = readOwn(raw, 'workspace');
  let workspace: WorkspaceConfig | undefined;
  if (workspaceRaw !== undefined) {
    const wsResult = validateWorkspaceConfig(workspaceRaw, 'workspace');
    if (wsResult.ok) {
      workspace = wsResult.value;
    } else {
      errors.push(...wsResult.errors);
    }
  }

  // features
  const featuresRaw = readOwn(raw, 'features');
  const features: Record<string, FeatureFlagEntry> = {};
  if (featuresRaw === undefined) {
    errors.push(err('features', 'missing required field features', 'Add features section with prompt, code_tool_hook, defer_archive entries'));
  } else if (!isRecord(featuresRaw)) {
    errors.push(err('features', `features must be an object, got ${typeof featuresRaw}`, 'Fix features to be an object mapping flag names to {category, enabled}'));
  } else {
    for (const key of Object.keys(featuresRaw)) {
      if (DANGEROUS_KEYS.has(key)) {
        errors.push(err(`features.${key}`, `dangerous key '${key}' rejected`, `Remove '${key}' from features`));
        continue;
      }
      const flagResult = validateFeatureFlagEntry(featuresRaw[key], `features.${key}`, key);
      if (flagResult.ok) {
        features[key] = flagResult.value;
      } else {
        errors.push(...flagResult.errors);
      }
    }
  }

  // runtimeProfiles
  const profilesRaw = readOwn(raw, 'runtimeProfiles');
  const runtimeProfiles: Record<string, RuntimeProfile> = {};
  if (profilesRaw === undefined) {
    errors.push(err('runtimeProfiles', 'missing required field runtimeProfiles', 'Add runtimeProfiles section with at least one profile'));
  } else if (!isRecord(profilesRaw)) {
    errors.push(err('runtimeProfiles', `runtimeProfiles must be an object, got ${typeof profilesRaw}`, 'Fix runtimeProfiles to be an object mapping profile IDs to profile definitions'));
  } else {
    for (const key of Object.keys(profilesRaw)) {
      if (DANGEROUS_KEYS.has(key)) {
        errors.push(err(`runtimeProfiles.${key}`, `dangerous key '${key}' rejected`, `Remove '${key}' from runtimeProfiles`));
        continue;
      }
      const profileResult = validateRuntimeProfile(profilesRaw[key], `runtimeProfiles.${key}`, key);
      if (profileResult.ok) {
        runtimeProfiles[key] = profileResult.value;
      } else {
        errors.push(...profileResult.errors);
      }
    }
  }

  // internalAgents
  const agentsRaw = readOwn(raw, 'internalAgents');
  let internalAgents: InternalAgentsConfig | undefined;
  if (agentsRaw === undefined) {
    errors.push(err('internalAgents', 'missing required field internalAgents', 'Add internalAgents section with defaultRuntime'));
  } else {
    const agentsResult = validateInternalAgents(agentsRaw, 'internalAgents');
    if (agentsResult.ok) {
      internalAgents = agentsResult.value;
    } else {
      errors.push(...agentsResult.errors);
    }
  }

  // ui
  const uiRaw = readOwn(raw, 'ui');
  let ui: UiConfig | undefined;
  if (uiRaw === undefined) {
    // ui is optional — defaults applied later
  } else {
    const uiResult = validateUiConfig(uiRaw, 'ui');
    if (uiResult.ok) {
      ui = uiResult.value;
    } else {
      errors.push(...uiResult.errors);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (!internalAgents) {
    return { ok: false, errors: [err('internalAgents', 'internalAgents validation unexpectedly failed', 'Check internalAgents configuration')] };
  }

  const config: PdConfig = {
    version: PD_CONFIG_VERSION,
    ...(workspace ? { workspace } : {}),
    features,
    runtimeProfiles,
    internalAgents,
    ui: ui ?? { diagnostics: { mode: 'simple' } },
  };

  return { ok: true, value: config };
}
