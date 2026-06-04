/**
 * pd config doctor — Discover and explain PD / OpenClaw configuration state.
 *
 * PRI-305: Cutover to .pd/config.yaml.
 *   - Feature flags and internal agent runtime bindings come from .pd/config.yaml
 *   - .pd/feature-flags.yaml and .state/workflows.yaml are no longer production inputs
 *   - Legacy files are detected and reported as warnings
 *
 * PRI-299 MVP UX: provides a single, read-only view of:
 *   - PD workspace config paths (with existence checks)
 *   - OpenClaw config paths (with existence checks)
 *   - Effective feature flags from .pd/config.yaml
 *   - Internal agent runtime binding readiness from .pd/config.yaml
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
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import {
  loadPdConfig,
  computeFlagsFromLoadResult,
  redactLoadResult,
  getPdConfigPath,
} from './pd-config-loader.js';
import { MVP_CHANNEL_IDS } from '@principles/core/runtime-v2';
import type {
  RedactedAgentSummary,
  RedactedRuntimeProfileSummary,
} from '@principles/core/runtime-v2';

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
  parseable?: boolean;
}

export interface ProviderHealthEntry {
  provider: string | null;
  model: string | null;
  apiKeyEnv: string | null;
  apiKeyPresent: boolean;
  classification: DoctorClassification;
  reason: string;
  nextAction: string;
  source: string;
}

export interface FeatureFlagSummary {
  source: string;
  configPath: string;
  enabledMvpChannels: string[];
  disabledFlags: string[];
  warnings: string[];
}

export interface InternalAgentDiagnostics {
  name: string;
  enabled: boolean;
  runtimeProfileId: string;
  runtimeProfileLabel: string;
  readiness: 'ready' | 'not_ready' | 'needs_setup' | 'disabled' | 'unknown';
  provider: string | null;
  model: string | null;
  apiKeyEnv: string | null;
  apiKeyPresent: boolean;
  reason: string;
  nextAction: string;
}

export interface DoctorOutput {
  status: DoctorStatus;
  workspaceDir: string;
  pdConfigPaths: {
    workspaceDir: ConfigPathEntry;
    pdDir: ConfigPathEntry;
    configYaml: ConfigPathEntry;
    stateDb: ConfigPathEntry;
  };
  openclawConfigPaths: {
    openclawHome: ConfigPathEntry;
    openclawConfig: ConfigPathEntry;
  };
  featureFlags: FeatureFlagSummary;
  internalAgents: InternalAgentDiagnostics[];
  providerHealth: ProviderHealthEntry[];
  warnings: string[];
  reason?: string;
  nextActions: string[];
  /** Legacy files detected (informational only, not used for resolution) */
  legacyFilesDetected: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── State DB Inspection (unchanged from PRI-299) ────────────────────────────

export interface InspectStateDbOptions {
  maxRows?: number;
  maxAgeMs?: number;
}

export interface RecentProviderSignal {
  classification: DoctorClassification;
  reason: string;
  observedAt: string | null;
}

export interface StateDbSignalResult {
  signal: RecentProviderSignal | null;
  dbReachable: boolean;
  warning?: string;
}

const DEFAULT_MAX_ROWS = 50;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
    const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { name: string } | undefined;
    if (!tableInfo) {
      return { signal: null, dbReachable: true, warning: 'state.db has no tasks table — pipeline not initialized yet' };
    }

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

// ─── Internal Agent Diagnostics from .pd/config.yaml ─────────────────────────

function diagnoseInternalAgent(
  agent: RedactedAgentSummary,
  profile: RedactedRuntimeProfileSummary | undefined,
): InternalAgentDiagnostics {
  if (!agent.enabled) {
    return {
      name: agent.name,
      enabled: false,
      runtimeProfileId: agent.runtimeProfileId,
      runtimeProfileLabel: agent.runtimeProfileLabel,
      readiness: 'disabled',
      provider: null,
      model: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      reason: `${agent.name} is disabled in .pd/config.yaml`,
      nextAction: `Set internalAgents.agents.${agent.name}.enabled=true in .pd/config.yaml to enable`,
    };
  }

  // Agent is enabled — check profile readiness
  if (!profile) {
    return {
      name: agent.name,
      enabled: true,
      runtimeProfileId: agent.runtimeProfileId,
      runtimeProfileLabel: agent.runtimeProfileLabel,
      readiness: 'needs_setup',
      provider: null,
      model: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      reason: `Runtime profile '${agent.runtimeProfileId}' not found in .pd/config.yaml`,
      nextAction: `Add runtime profile '${agent.runtimeProfileId}' to .pd/config.yaml runtimeProfiles, or change the agent's runtimeProfile reference`,
    };
  }

  // Check apiKeyEnv for pi-ai profiles
  if (profile.type === 'pi-ai') {
    const apiKeyEnv = profile.apiKeyEnv ?? null;
    const apiKeyPresent = !!apiKeyEnv && Object.prototype.hasOwnProperty.call(process.env, apiKeyEnv) && !!process.env[apiKeyEnv];

    if (!apiKeyEnv) {
      return {
        name: agent.name,
        enabled: true,
        runtimeProfileId: agent.runtimeProfileId,
        runtimeProfileLabel: agent.runtimeProfileLabel,
        readiness: 'needs_setup',
        provider: null,
        model: null,
        apiKeyEnv: null,
        apiKeyPresent: false,
        reason: `pi-ai profile '${profile.id}' missing apiKeyEnv`,
        nextAction: `Add apiKeyEnv to runtime profile '${profile.id}' in .pd/config.yaml`,
      };
    }

    if (!apiKeyPresent) {
      return {
        name: agent.name,
        enabled: true,
        runtimeProfileId: agent.runtimeProfileId,
        runtimeProfileLabel: agent.runtimeProfileLabel,
        readiness: 'needs_setup',
        provider: null,
        model: null,
        apiKeyEnv,
        apiKeyPresent: false,
        reason: `Environment variable '${apiKeyEnv}' is not set or empty`,
        nextAction: `Set the environment variable '${apiKeyEnv}' with a valid API key`,
      };
    }

    // pi-ai with key present — check state.db for signals
    return {
      name: agent.name,
      enabled: true,
      runtimeProfileId: agent.runtimeProfileId,
      runtimeProfileLabel: agent.runtimeProfileLabel,
      readiness: 'not_ready', // runtime availability unknown without actual probe
      provider: null,
      model: null,
      apiKeyEnv,
      apiKeyPresent: true,
      reason: `pi-ai profile configured with apiKeyEnv='${apiKeyEnv}' (key present); runtime availability unknown`,
      nextAction: 'Run pd runtime probe to verify end-to-end connectivity',
    };
  }

  // OpenClaw profile
  if (profile.readiness === 'needs_setup') {
    return {
      name: agent.name,
      enabled: true,
      runtimeProfileId: agent.runtimeProfileId,
      runtimeProfileLabel: agent.runtimeProfileLabel,
      readiness: 'needs_setup',
      provider: null,
      model: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      reason: `OpenClaw profile '${profile.id}' needs setup (missing provider/model)`,
      nextAction: `Configure provider and model in runtime profile '${profile.id}' in .pd/config.yaml`,
    };
  }

  return {
    name: agent.name,
    enabled: true,
    runtimeProfileId: agent.runtimeProfileId,
    runtimeProfileLabel: agent.runtimeProfileLabel,
    readiness: 'ready',
    provider: null,
    model: null,
    apiKeyEnv: null,
    apiKeyPresent: false,
    reason: `OpenClaw profile '${profile.id}' is configured and ready`,
    nextAction: 'No action required',
  };
}

// ─── Main entry: buildDoctorOutput ───────────────────────────────────────────

export interface BuildDoctorInput {
  workspaceDir: string;
}

export async function buildDoctorOutput(input: BuildDoctorInput): Promise<DoctorOutput> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const pdDir = path.join(workspaceDir, '.pd');
  const configYamlPath = getPdConfigPath(workspaceDir);
  const stateDbPath = path.join(pdDir, 'state.db');

  // 1) Load PD config from .pd/config.yaml
  const loadResult = loadPdConfig(workspaceDir);
  const flags = computeFlagsFromLoadResult(loadResult);
  const redacted = redactLoadResult(loadResult);

  // 2) Feature flag summary
  const enabledMvpChannels: string[] = [];
  const disabledFlags: string[] = [];
  for (const flag of Object.values(flags.flags)) {
    if (flag.enabled && MVP_CHANNEL_IDS.includes(flag.id as typeof MVP_CHANNEL_IDS[number])) {
      enabledMvpChannels.push(flag.id);
    } else if (!flag.enabled) {
      disabledFlags.push(flag.id);
    }
  }

  const featureFlags: FeatureFlagSummary = {
    source: loadResult.ok ? loadResult.source : 'malformed',
    configPath: loadResult.configPath,
    enabledMvpChannels,
    disabledFlags,
    warnings: flags.warnings,
  };

  // 3) Internal agent diagnostics from .pd/config.yaml
  const profileMap = new Map<string, RedactedRuntimeProfileSummary>();
  for (const p of redacted.runtimeProfiles) {
    profileMap.set(p.id, p);
  }

  const internalAgents: InternalAgentDiagnostics[] = [];
  for (const agent of redacted.agents) {
    const profile = profileMap.get(agent.runtimeProfileId);
    internalAgents.push(diagnoseInternalAgent(agent, profile));
  }

  // 4) Provider health — derived from internal agents that are enabled
  const providerHealth: ProviderHealthEntry[] = [];
  const warnings: string[] = [];
  const nextActions: string[] = [];

  // Add config-level warnings
  warnings.push(...loadResult.warnings);
  warnings.push(...flags.warnings);

  if (!loadResult.ok) {
    for (const err of loadResult.errors) {
      warnings.push(`Config error at ${err.path}: ${err.reason}`);
    }
    nextActions.push(loadResult.errors[0]?.nextAction ?? 'Fix .pd/config.yaml and retry');
  }

  // Check for enabled agents that need setup
  const needsSetupAgents = internalAgents.filter(a => a.enabled && (a.readiness === 'needs_setup' || a.readiness === 'not_ready'));
  for (const agent of needsSetupAgents) {
    providerHealth.push({
      provider: null,
      model: null,
      apiKeyEnv: agent.apiKeyEnv,
      apiKeyPresent: agent.apiKeyPresent,
      classification: agent.readiness === 'needs_setup' ? 'config_missing' : 'auth_missing',
      reason: agent.reason,
      nextAction: agent.nextAction,
      source: 'config.yaml',
    });
  }

  // Check state.db for rate-limit / unavailable signals for enabled agents
  const readyAgents = internalAgents.filter(a => a.enabled && a.readiness === 'ready');
  if (readyAgents.length > 0) {
    const signalResult = await inspectStateDbForProviderSignal(stateDbPath);
    if (signalResult.warning) {
      warnings.push(signalResult.warning);
    }
    if (signalResult.signal) {
      const { classification: cls, reason: rsn } = signalResult.signal;
      providerHealth.push({
        provider: null,
        model: null,
        apiKeyEnv: null,
        apiKeyPresent: false,
        classification: cls,
        reason: rsn,
        nextAction: cls === 'rate_limit'
          ? "Wait for the provider's rate limit to reset, or reduce request rate"
          : 'Provider/model temporarily unavailable. Try a different model or retry later.',
        source: 'state.db',
      });
    } else {
      providerHealth.push({
        provider: null,
        model: null,
        apiKeyEnv: null,
        apiKeyPresent: false,
        classification: 'healthy',
        reason: 'Config is valid; no recent error signals in state.db',
        nextAction: 'Run pd runtime probe to verify end-to-end connectivity',
        source: 'config.yaml',
      });
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
  if (!loadResult.ok) {
    status = 'failed';
  }
  if ((warnings.length > 0) && status === 'ok') {
    status = 'degraded';
  }

  // 6) Reason
  let reason: string | undefined;
  if (status === 'failed') {
    if (!loadResult.ok) {
      reason = `Config validation failed: ${loadResult.errors.map(e => e.reason).join('; ')}`;
    } else {
      const failed = providerHealth.filter((p) => p.classification === 'auth_missing' || p.classification === 'config_missing');
      reason = failed.length > 0
        ? `Provider auth/config missing: ${failed.map((p) => p.classification).join(', ')}`
        : 'Configuration is missing required fields';
    }
  } else if (status === 'degraded') {
    const degraded = providerHealth.filter((p) => p.classification === 'rate_limit' || p.classification === 'unavailable');
    if (degraded.length > 0) {
      reason = `Provider connectivity degraded: ${degraded.map((p) => p.classification).join(', ')}`;
    } else if (warnings.length > 0) {
      reason = `Config warnings present: ${warnings.length} item(s)`;
    }
  }

  // 7) Build output
  const out: DoctorOutput = {
    status,
    workspaceDir,
    pdConfigPaths: {
      workspaceDir: pathEntry(workspaceDir),
      pdDir: pathEntry(pdDir),
      configYaml: { ...pathEntry(configYamlPath), parseable: loadResult.ok || !fs.existsSync(configYamlPath) ? true : false },
      stateDb: pathEntry(stateDbPath),
    },
    openclawConfigPaths: {
      openclawHome: pathEntry(getOpenClawHome()),
      openclawConfig: pathEntry(getOpenClawConfigPath()),
    },
    featureFlags,
    internalAgents,
    providerHealth,
    warnings,
    nextActions: nextActions.length > 0 ? nextActions : ['All checks passed — configuration is valid'],
    legacyFilesDetected: loadResult.legacyFilesDetected,
  };

  if (reason) out.reason = reason;
  return out;
}
