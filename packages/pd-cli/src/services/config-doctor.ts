/**
 * PD Config Doctor — discovers and explains PD / OpenClaw configuration state.
 *
 * PRI-299 MVP UX: provides a single, read-only view of:
 *   - PD workspace config paths (with existence checks)
 *   - OpenClaw config paths (with existence checks)
 *   - Effective feature flags
 *   - Provider/model/auth status (classified)
 *
 * Constraints:
 *   - NEVER reads or returns API key values, env var values, or raw config bytes.
 *   - All file reads are bounded; YAML/JSON is treated as `unknown` and validated.
 *   - Missing/malformed config produces a structured warning, never a crash.
 *   - Failures include `reason` and `nextAction` for operator guidance.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { loadEffectiveFeatureFlags } from './feature-flag-loader.js';
import { FEATURE_FLAGS_CONFIG_FILENAME, FEATURE_FLAGS_CONFIG_DIR } from './feature-flag-loader.js';

// ─── Public types ────────────────────────────────────────────────────────────

export type DoctorClassification =
  | 'healthy'
  | 'config_missing'
  | 'auth_missing'
  | 'rate_limit'
  | 'unavailable'
  | 'parse_failure'
  | 'unknown';

export type DoctorStatus = 'ok' | 'degraded' | 'failed';

export interface ConfigPathEntry {
  path: string;
  exists: boolean;
  /** Optional structural check (file is parseable JSON/YAML, etc.) */
  parseable?: boolean;
}

export interface ProviderHealthEntry {
  provider: string | null;
  model: string | null;
  apiKeyEnv: string | null;
  /** True if the env var name is non-empty and the env var is set. */
  apiKeyPresent: boolean;
  classification: DoctorClassification;
  reason: string;
  nextAction: string;
  /** Source of the discovered config (e.g., 'workflows.yaml', 'cli_flag', 'default'). */
  source: string;
}

export interface FeatureFlagSummary {
  source: string;
  configPath: string;
  enabledMvpChannels: string[];
  disabledFlags: string[];
  warnings: string[];
}

export interface DoctorOutput {
  status: DoctorStatus;
  workspaceDir: string;
  pdConfigPaths: {
    workspaceDir: ConfigPathEntry;
    pdDir: ConfigPathEntry;
    featureFlags: ConfigPathEntry;
    workflowsYaml: ConfigPathEntry;
    stateDb: ConfigPathEntry;
  };
  openclawConfigPaths: {
    openclawHome: ConfigPathEntry;
    openclawConfig: ConfigPathEntry;
  };
  featureFlags: FeatureFlagSummary;
  providerHealth: ProviderHealthEntry[];
  internalAgents: {
    correctionObserver: {
      enabled: boolean;
      flagSource: string;
      status: 'disabled' | 'configured' | 'auth_missing' | 'config_missing' | 'unavailable';
      configSource: 'workflows.yaml' | 'env' | 'missing' | 'unavailable';
      provider: string | null;
      model: string | null;
      apiKeyEnv: string | null;
      apiKeyPresent: boolean;
      reason: string;
      nextAction: string;
    };
  };
  warnings: string[];
  reason?: string;
  nextActions: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve the OpenClaw home directory used to look up `openclaw.json` and
 * extension state. PD does not own this path — it only reports its existence.
 */
export function getOpenClawHome(): string {
  const home = process.env.HOME
    || process.env.USERPROFILE
    || (process.env.HOMEDRIVE && process.env.HOMEPATH ? process.env.HOMEDRIVE + process.env.HOMEPATH : '');
  if (!home) return path.join(process.cwd(), '.openclaw');
  return path.join(home, '.openclaw');
}

export function getOpenClawConfigPath(): string {
  return path.join(getOpenClawHome(), 'openclaw.json');
}

/**
 * Build a `ConfigPathEntry` with existence check.
 */
function pathEntry(p: string): ConfigPathEntry {
  return { path: p, exists: fs.existsSync(p) };
}

const RATE_LIMIT_KEYWORDS = ['rate_limit', 'rate-limit', '429', 'too many requests', 'rpm exhausted'];
const AUTH_MISSING_KEYWORDS = ['auth_missing', 'unauthorized', '401', 'api key', 'no api key', 'api_key missing'];
const UNAVAILABLE_KEYWORDS = ['unavailable', 'model fallback', 'candidate_failed', 'embedded agent failed'];

function classifyText(text: string): DoctorClassification | null {
  const lowered = text.toLowerCase();
  for (const kw of RATE_LIMIT_KEYWORDS) {
    if (lowered.includes(kw)) return 'rate_limit';
  }
  for (const kw of AUTH_MISSING_KEYWORDS) {
    if (lowered.includes(kw)) return 'auth_missing';
  }
  for (const kw of UNAVAILABLE_KEYWORDS) {
    if (lowered.includes(kw)) return 'unavailable';
  }
  return null;
}

export interface InspectStateDbOptions {
  /** Max rows to scan from tasks table. */
  maxRows?: number;
  /** Max age in ms — only signals within this window are considered "recent". */
  maxAgeMs?: number;
}

export interface RecentProviderSignal {
  classification: DoctorClassification;
  reason: string;
  observedAt: string | null;
}

export interface StateDbSignalResult {
  signal: RecentProviderSignal | null;
  /** True if the DB was found and could be opened in readonly mode. */
  dbReachable: boolean;
  /** Optional warning when the DB exists but couldn't be read. */
  warning?: string;
}

const DEFAULT_MAX_ROWS = 50;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Read the state.db recent provider error signal (best-effort, structural only).
 *
 * We inspect recent task/run rows in `<workspaceDir>/.pd/state.db` to detect
 * `rate_limit` / `auth_missing` / `unavailable` signals from the live pipeline.
 * This is a bounded best-effort probe — if the DB is missing or unreadable we
 * return `null` and let the doctor fall back to config-only classification.
 */
export async function inspectStateDbForProviderSignal(
  stateDbPath: string,
  nowMs: number = Date.now(),
  opts: InspectStateDbOptions = {},
): Promise<StateDbSignalResult> {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  if (!fs.existsSync(stateDbPath)) {
    return { signal: null, dbReachable: false };
  }

  let db: BetterSqliteDatabase;
  try {
    db = new Database(stateDbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return {
      signal: null,
      dbReachable: false,
      warning: `state.db present but readonly open failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    // Check for tasks table — drift-safe (ERR-026): assert via pragma, not assumption.
    const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { name: string } | undefined;
    if (!tableInfo) {
      return { signal: null, dbReachable: true, warning: 'state.db has no tasks table — pipeline not initialized yet' };
    }

    // Find columns defensively.
    const taskCols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    const taskColNames = new Set(taskCols.map((c) => c.name));
    const hasErrorMessage = taskColNames.has('error_message');
    const hasLastErrorMessage = taskColNames.has('last_error_message');
    const hasFailureCategory = taskColNames.has('failure_category');
    const hasErrorCategory = taskColNames.has('error_category');
    const hasUpdatedAt = taskColNames.has('updated_at');
    const hasLastErrorAt = taskColNames.has('last_error_at');
    const hasCreatedAt = taskColNames.has('created_at');

    if (!hasErrorMessage && !hasLastErrorMessage) {
      return { signal: null, dbReachable: true, warning: 'state.db tasks table has no error_message column — provider signal unavailable' };
    }

    // Build a bounded scan: read up to maxRows recent failed tasks.
    const errorCol = hasErrorMessage ? 'error_message' : 'last_error_message';
    const tsCol = hasUpdatedAt ? 'updated_at' : hasLastErrorAt ? 'last_error_at' : hasCreatedAt ? 'created_at' : null;
    const tsExpr = tsCol ? `, ${tsCol} AS ts` : '';
    const whereExpr = tsCol ? `WHERE ${tsCol} >= ?` : '';
    const params: unknown[] = tsCol ? [nowMs - maxAgeMs] : [];

    const rows = db.prepare(
      `SELECT ${errorCol} AS error${tsExpr} FROM tasks ${whereExpr} ORDER BY rowid DESC LIMIT ?`,
    ).all(...params, maxRows) as { error: unknown; ts?: unknown }[];

    let mostRecentObservedAt: number | null = null;
    let aggregate = '';
    for (const row of rows) {
      if (typeof row.error !== 'string') continue;
      aggregate += ` ${row.error}`;
      if (typeof row.ts === 'number' && (mostRecentObservedAt === null || row.ts > mostRecentObservedAt)) {
        mostRecentObservedAt = row.ts;
      }
    }

    // Also check for explicit error_category/failure_category columns if present.
    if (hasErrorCategory || hasFailureCategory) {
      const catCol = hasErrorCategory ? 'error_category' : 'failure_category';
      const catRows = db.prepare(
        `SELECT ${catCol} AS cat${tsCol ? `, ${tsCol} AS ts` : ''} FROM tasks WHERE ${catCol} IS NOT NULL ${tsCol ? `AND ${tsCol} >= ?` : ''} ORDER BY rowid DESC LIMIT ?`,
      ).all(...(tsCol ? [nowMs - maxAgeMs] : []), maxRows) as { cat: unknown; ts?: unknown }[];
      for (const row of catRows) {
        if (typeof row.cat === 'string') {
          aggregate += ` ${row.cat}`;
        }
      }
    }

    const classification = classifyText(aggregate);
    if (classification === null) {
      return { signal: null, dbReachable: true };
    }

    return {
      signal: {
        classification,
        reason: `Recent task error matches '${classification}' signature (state.db scan)`,
        observedAt: mostRecentObservedAt ? new Date(mostRecentObservedAt).toISOString() : null,
      },
      dbReachable: true,
    };
  } catch (err) {
    return {
      signal: null,
      dbReachable: false,
      warning: `state.db scan failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

/**
 * Resolve the provider/model/apiKeyEnv from the workspace's `workflows.yaml`
 * funnel policy. Returns `null` for each field when not configured.
 *
 * NEVER leaks api key values or env var values.
 */
export interface ProviderConfigFromWorkflows {
  provider: string | null;
  model: string | null;
  apiKeyEnv: string | null;
  baseUrl: string | null;
  source: 'workflows.yaml' | 'cli_flag' | 'default' | 'missing';
  /** True if the workflows.yaml file was found and parseable. */
  workflowsFound: boolean;
  /** Parse warning, if any. */
  parseWarning?: string;
}

const DIAGNOSTIC_FUNNEL_ID = 'pd-runtime-v2-diagnosis';

export async function resolveProviderConfigFromWorkflows(
  stateDir: string,
  opts: { cliProvider?: string; cliModel?: string; cliApiKeyEnv?: string; cliBaseUrl?: string } = {},
): Promise<ProviderConfigFromWorkflows> {
  const workflowsPath = path.join(stateDir, 'workflows.yaml');
  if (!fs.existsSync(workflowsPath)) {
    // Fall back to CLI flag values if provided.
    if (opts.cliProvider || opts.cliModel || opts.cliApiKeyEnv) {
      return {
        provider: opts.cliProvider ?? null,
        model: opts.cliModel ?? null,
        apiKeyEnv: opts.cliApiKeyEnv ?? null,
        baseUrl: opts.cliBaseUrl ?? null,
        source: 'cli_flag',
        workflowsFound: false,
      };
    }
    return {
      provider: null,
      model: null,
      apiKeyEnv: null,
      baseUrl: null,
      source: 'missing',
      workflowsFound: false,
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(workflowsPath, 'utf8');
  } catch (err) {
    return {
      provider: null,
      model: null,
      apiKeyEnv: null,
      baseUrl: null,
      source: 'workflows.yaml',
      workflowsFound: true,
      parseWarning: `workflows.yaml read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      provider: null,
      model: null,
      apiKeyEnv: null,
      baseUrl: null,
      source: 'workflows.yaml',
      workflowsFound: true,
      parseWarning: `workflows.yaml parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      provider: null,
      model: null,
      apiKeyEnv: null,
      baseUrl: null,
      source: 'workflows.yaml',
      workflowsFound: true,
      parseWarning: 'workflows.yaml root is not an object',
    };
  }

  const funnelsRaw = parsed.funnels;
  if (!Array.isArray(funnelsRaw)) {
    return {
      provider: null,
      model: null,
      apiKeyEnv: null,
      baseUrl: null,
      source: 'workflows.yaml',
      workflowsFound: true,
      parseWarning: 'workflows.yaml: funnels is not an array',
    };
  }

  let policy: Record<string, unknown> | null = null;
  for (const f of funnelsRaw) {
    if (!isRecord(f)) continue;
    if (f.workflowId === DIAGNOSTIC_FUNNEL_ID && isRecord(f.policy)) {
      const { policy: candidate } = f;
      if (isRecord(candidate)) {
        policy = candidate;
        break;
      }
    }
  }

  if (policy === null) {
    return {
      provider: null,
      model: null,
      apiKeyEnv: null,
      baseUrl: null,
      source: 'workflows.yaml',
      workflowsFound: true,
      parseWarning: `workflows.yaml: funnel '${DIAGNOSTIC_FUNNEL_ID}' not found`,
    };
  }

  const provider = typeof policy.provider === 'string' ? policy.provider : null;
  const model = typeof policy.model === 'string' ? policy.model : null;
  const apiKeyEnv = typeof policy.apiKeyEnv === 'string' ? policy.apiKeyEnv : null;
  const baseUrl = typeof policy.baseUrl === 'string' ? policy.baseUrl : null;

  return {
    provider: provider || opts.cliProvider || null,
    model: model || opts.cliModel || null,
    apiKeyEnv: apiKeyEnv || opts.cliApiKeyEnv || null,
    baseUrl: baseUrl || opts.cliBaseUrl || null,
    source: 'workflows.yaml',
    workflowsFound: true,
  };
}

// ─── Main entry: buildDoctorOutput ───────────────────────────────────────────

export interface BuildDoctorInput {
  workspaceDir: string;
  /** Optional CLI overrides for provider/model/apiKeyEnv. */
  cliProvider?: string;
  cliModel?: string;
  cliApiKeyEnv?: string;
  cliBaseUrl?: string;
}

const MVP_CHANNELS = new Set(['prompt', 'code_tool_hook', 'defer_archive']);

export async function buildDoctorOutput(input: BuildDoctorInput): Promise<DoctorOutput> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const pdDir = path.join(workspaceDir, FEATURE_FLAGS_CONFIG_DIR);
  const featureFlagsPath = path.join(pdDir, FEATURE_FLAGS_CONFIG_FILENAME);
  const workflowsPath = path.join(workspaceDir, '.state', 'workflows.yaml');
  const stateDbPath = path.join(pdDir, 'state.db');

  // 1) Feature flags
  let enabledMvpChannels: string[] = [];
  let disabledFlags: string[] = [];
  let flagSource: string;
  let flagWarnings: string[];
  let hasFeatureFlagsError = false;
  let featureFlagsErrorMessage = '';

  let correctionObserverEnabled = true;
  let coFlagSource = 'defaults';

  try {
    const flags = loadEffectiveFeatureFlags(workspaceDir);
    flagSource = flags.source;
    flagWarnings = [...flags.warnings];
    for (const flag of Object.values(flags.flags)) {
      if (flag.enabled && MVP_CHANNELS.has(flag.id)) {
        enabledMvpChannels.push(flag.id);
      } else if (!flag.enabled) {
        disabledFlags.push(flag.id);
      }
    }
    if (flags.flags && flags.flags.correction_observer) {
      correctionObserverEnabled = flags.flags.correction_observer.enabled;
      coFlagSource = flags.source;
    }
  } catch (err) {
    hasFeatureFlagsError = true;
    featureFlagsErrorMessage = err instanceof Error ? err.message : String(err);
    flagSource = 'unavailable';
    flagWarnings = [`feature flags unavailable: ${featureFlagsErrorMessage}`];
    coFlagSource = 'unavailable';
  }

  // 2) Provider config from workflows.yaml (or CLI override)
  const providerCfg = await resolveProviderConfigFromWorkflows(
    path.join(workspaceDir, '.state'),
    {
      cliProvider: input.cliProvider,
      cliModel: input.cliModel,
      cliApiKeyEnv: input.cliApiKeyEnv,
      cliBaseUrl: input.cliBaseUrl,
    },
  );

  // 3) Build the provider health entry. NEVER leak env var value.
  const providerHealth: ProviderHealthEntry[] = [];
  const warnings: string[] = [];
  const nextActions: string[] = [];

  if (providerCfg.source === 'missing' && !input.cliProvider) {
    providerHealth.push({
      provider: null,
      model: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      classification: 'config_missing',
      reason: 'No provider configured (workflows.yaml funnel policy missing and no CLI override)',
      nextAction: 'Configure provider/model/apiKeyEnv in workflows.yaml pd-runtime-v2-diagnosis policy, or pass --provider/--model/--apiKeyEnv flags',
      source: providerCfg.source,
    });
    warnings.push('No provider configured for the diagnostic funnel');
    nextActions.push('Configure provider/model/apiKeyEnv in workflows.yaml or pass CLI flags');
  } else {
    const apiKeyEnvName = providerCfg.apiKeyEnv;
    const apiKeyPresent = !!apiKeyEnvName && Object.prototype.hasOwnProperty.call(process.env, apiKeyEnvName) && !!process.env[apiKeyEnvName];

    let classification: DoctorClassification;
    let reason: string;
    let nextAction: string;

    if (!providerCfg.provider || !providerCfg.model) {
      classification = 'config_missing';
      reason = !providerCfg.provider
        ? 'Provider not configured'
        : 'Model not configured';
      nextAction = 'Set provider and model in workflows.yaml funnel policy or pass --provider/--model flags';
    } else if (!apiKeyEnvName) {
      classification = 'auth_missing';
      reason = 'apiKeyEnv is not set in workflows.yaml';
      nextAction = "Add 'apiKeyEnv: <ENV_VAR_NAME>' to workflows.yaml funnel policy and ensure the env var holds a valid key";
    } else if (!apiKeyPresent) {
      classification = 'auth_missing';
      reason = `Environment variable '${apiKeyEnvName}' is not set or empty`;
      nextAction = `Set the environment variable '${apiKeyEnvName}' with a valid API key, then retry`;
    } else {
      // Config is well-formed and the key is present — check state.db for rate-limit / unavailable signals.
      const signalResult = await inspectStateDbForProviderSignal(stateDbPath);
      if (signalResult.warning) {
        warnings.push(signalResult.warning);
      }
      if (signalResult.signal) {
        const { classification: cls, reason: rsn } = signalResult.signal;
        classification = cls;
        reason = rsn;
        switch (classification) {
          case 'rate_limit':
            nextAction = `Wait for the provider's rate limit to reset, or reduce request rate. Recent error in state.db.`;
            break;
          case 'auth_missing':
            nextAction = `The env var is set, but the provider rejected the call. Verify the key value is current and has access to model '${providerCfg.model}'.`;
            break;
          case 'unavailable':
            nextAction = `Provider/model temporarily unavailable. Try a different model or retry later. Check provider status page.`;
            break;
          default:
            nextAction = 'Inspect recent task errors in state.db for details.';
        }
      } else {
        classification = 'healthy';
        reason = 'Provider, model, and apiKeyEnv are configured; env var is set; no recent error signals';
        nextAction = 'Run pd diagnose run to validate end-to-end provider connectivity';
      }
    }

    providerHealth.push({
      provider: providerCfg.provider,
      model: providerCfg.model,
      apiKeyEnv: apiKeyEnvName,
      apiKeyPresent,
      classification,
      reason,
      nextAction,
      source: providerCfg.source,
    });
  }

  if (providerCfg.parseWarning) {
    warnings.push(providerCfg.parseWarning);
    if (!providerCfg.workflowsFound) {
      nextActions.push('Create workflows.yaml in <workspace>/.state with a pd-runtime-v2-diagnosis funnel policy');
    } else {
      nextActions.push('Fix workflows.yaml parse error — see warnings for details');
    }
  }

  // 4) Aggregate feature-flag warnings
  for (const w of flagWarnings) {
    warnings.push(w);
  }
  if (flagWarnings.length > 0 && !hasFeatureFlagsError) {
    nextActions.push('Review .pd/feature-flags.yaml — see warnings for details');
  }
  if (hasFeatureFlagsError) {
    warnings.push(`feature flags unavailable: ${featureFlagsErrorMessage}`);
    nextActions.push(`Check that ${featureFlagsPath} is a readable file, not a directory.`);
    nextActions.push('Re-run npx create-principles-disciple if the config was generated incorrectly.');
  }

  // 4.5) CorrectionObserver Diagnostics
  let coStatus: 'disabled' | 'configured' | 'auth_missing' | 'config_missing' | 'unavailable';
  let coConfigSource: 'workflows.yaml' | 'env' | 'missing' | 'unavailable';
  let coProvider: string | null = null;
  let coModel: string | null = null;
  let coApiKeyEnv: string | null = null;
  let coApiKeyPresent = false;
  let coReason: string;
  let coNextAction: string;

  if (!correctionObserverEnabled) {
    coStatus = 'disabled';
    coConfigSource = 'missing';
    coProvider = null;
    coModel = null;
    coApiKeyEnv = null;
    coApiKeyPresent = false;
    coReason = 'CorrectionObserver is disabled via feature flags';
    coNextAction = 'Set correction_observer.enabled=true in .pd/feature-flags.yaml to enable it';
  } else {
    const coWorkflowsPath = path.join(workspaceDir, '.state', 'workflows.yaml');
    let coWorkflowsFound = false;
    let coWorkflowsParseError = false;
    let coWorkflowsParseErrorMessage = '';
    let coWorkflowPolicy: Record<string, unknown> | null = null;

    if (fs.existsSync(coWorkflowsPath)) {
      coWorkflowsFound = true;
      try {
        const raw = fs.readFileSync(coWorkflowsPath, 'utf8');
        const parsed = yaml.load(raw);
        if (isRecord(parsed)) {
          const funnelsRaw = parsed.funnels;
          if (Array.isArray(funnelsRaw)) {
            for (const f of funnelsRaw) {
              if (isRecord(f) && f.workflowId === 'pd-correction-observer' && isRecord(f.policy)) {
                coWorkflowPolicy = f.policy;
                break;
              }
            }
          }
        }
      } catch (err) {
        coWorkflowsParseError = true;
        coWorkflowsParseErrorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    if (coWorkflowsParseError) {
      coStatus = 'unavailable';
      coConfigSource = 'unavailable';
      coReason = `workflows.yaml parse failure: ${coWorkflowsParseErrorMessage}`;
      coNextAction = 'Fix workflows.yaml syntax or file access permissions';
    } else if (coWorkflowsFound && coWorkflowPolicy && coWorkflowPolicy.runtimeKind === 'pi-ai') {
      coConfigSource = 'workflows.yaml';
      coProvider = typeof coWorkflowPolicy.provider === 'string' ? coWorkflowPolicy.provider : null;
      coModel = typeof coWorkflowPolicy.model === 'string' ? coWorkflowPolicy.model : null;
      coApiKeyEnv = typeof coWorkflowPolicy.apiKeyEnv === 'string' ? coWorkflowPolicy.apiKeyEnv : null;
      coApiKeyPresent = !!coApiKeyEnv && Object.prototype.hasOwnProperty.call(process.env, coApiKeyEnv) && !!process.env[coApiKeyEnv];

      if (!coProvider || !coModel) {
        coStatus = 'config_missing';
        coReason = !coProvider ? 'Provider not configured in workflows.yaml policy' : 'Model not configured in workflows.yaml policy';
        coNextAction = 'Set provider and model in pd-correction-observer policy in workflows.yaml';
      } else if (!coApiKeyEnv) {
        coStatus = 'auth_missing';
        coReason = 'apiKeyEnv is not set in workflows.yaml pd-correction-observer policy';
        coNextAction = "Add 'apiKeyEnv: <ENV_VAR_NAME>' to workflows.yaml pd-correction-observer policy and ensure the env var holds a valid key";
      } else if (!coApiKeyPresent) {
        coStatus = 'auth_missing';
        coReason = `Environment variable '${coApiKeyEnv}' is not set or empty`;
        coNextAction = `Set the environment variable '${coApiKeyEnv}' with a valid API key, or disable correction_observer in feature flags`;
      } else {
        coStatus = 'configured';
        coReason = 'CorrectionObserver is configured and ready via workflows.yaml';
        coNextAction = 'No action required; correction observer is active';
      }
    } else {
      coConfigSource = 'env';
      coProvider = process.env.PD_CORRECTION_PROVIDER || 'anthropic';
      coModel = process.env.PD_CORRECTION_MODEL || 'anthropic/claude-3-5-sonnet';
      coApiKeyEnv = process.env.PD_CORRECTION_API_KEY_ENV || 'ANTHROPIC_API_KEY';
      coApiKeyPresent = !!coApiKeyEnv && Object.prototype.hasOwnProperty.call(process.env, coApiKeyEnv) && !!process.env[coApiKeyEnv];

      if (!coApiKeyPresent) {
        coStatus = 'auth_missing';
        coReason = `Environment variable '${coApiKeyEnv}' is not set or empty`;
        coNextAction = `Set the environment variable '${coApiKeyEnv}' with a valid API key, or configure workflows.yaml, or disable correction_observer in feature flags`;
      } else {
        coStatus = 'configured';
        coReason = 'CorrectionObserver is configured and ready via env overrides/defaults';
        coNextAction = 'No action required; correction observer is active';
      }
    }
  }

  // 5) Compute overall status
  let status: DoctorStatus = 'ok';
  const classifications = providerHealth.map((p) => p.classification);
  if (classifications.includes('rate_limit') || classifications.includes('unavailable')) {
    status = 'degraded';
  }
  if (classifications.includes('auth_missing') || classifications.includes('config_missing')) {
    status = 'failed';
  }
  if ((warnings.length > 0 || hasFeatureFlagsError) && status === 'ok') {
    status = 'degraded';
  }

  // 6) Reason
  let reason: string | undefined;
  if (status === 'failed') {
    const failed = providerHealth.filter((p) => p.classification === 'auth_missing' || p.classification === 'config_missing');
    if (failed.length > 0) {
      reason = `Provider auth/config missing: ${failed.map((p) => p.classification).join(', ')}`;
    } else {
      reason = 'Configuration is missing required fields';
    }
  } else if (status === 'degraded') {
    const degraded = providerHealth.filter((p) => p.classification === 'rate_limit' || p.classification === 'unavailable');
    if (degraded.length > 0) {
      reason = `Provider connectivity degraded: ${degraded.map((p) => p.classification).join(', ')}`;
    } else if (warnings.length > 0) {
      reason = `Config warnings present: ${warnings.length} item(s)`;
    }
  }

  // 7) Build path entries
  const out: DoctorOutput = {
    status,
    workspaceDir,
    pdConfigPaths: {
      workspaceDir: pathEntry(workspaceDir),
      pdDir: pathEntry(pdDir),
      featureFlags: pathEntry(featureFlagsPath),
      workflowsYaml: pathEntry(workflowsPath),
      stateDb: pathEntry(stateDbPath),
    },
    openclawConfigPaths: {
      openclawHome: pathEntry(getOpenClawHome()),
      openclawConfig: pathEntry(getOpenClawConfigPath()),
    },
    featureFlags: {
      source: flagSource,
      configPath: featureFlagsPath,
      enabledMvpChannels,
      disabledFlags,
      warnings: flagWarnings,
    },
    providerHealth,
    internalAgents: {
      correctionObserver: {
        enabled: correctionObserverEnabled,
        flagSource: coFlagSource,
        status: coStatus,
        configSource: coConfigSource,
        provider: coProvider,
        model: coModel,
        apiKeyEnv: coApiKeyEnv,
        apiKeyPresent: coApiKeyPresent,
        reason: coReason,
        nextAction: coNextAction,
      },
    },
    warnings,
    nextActions: nextActions.length > 0 ? nextActions : ['All checks passed — provider is configured and reachable'],
  };

  if (reason) out.reason = reason;
  return out;
}
