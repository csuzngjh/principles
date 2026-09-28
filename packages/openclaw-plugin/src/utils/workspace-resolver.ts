/**
 * Workspace Directory Resolution Utilities
 *
 * Shared helpers for resolving workspace directories across commands and hooks.
 *
 * Hook resolution priority (PRI-259): PD canonical config → OpenClaw fallback.
 * PD canonical sources: PD_WORKSPACE_DIR env → OPENCLAW_WORKSPACE env →
 * principles-disciple.json → ~/.openclaw/workspace default.
 * OpenClaw fallback: ctx.workspaceDir → api.runtime.agent.resolveAgentWorkspaceDir().
 *
 * WHY PD canonical wins over host runtime workspace (ADR-0023 §2.6.1, PRI-686):
 * the PD workspace is the single boundary of governance state (.pd/.state/
 * .principles/memory/) — splitting it across two directories splits governance
 * itself. The host's workspace semantics (e.g. OpenClaw 2026.8/9 resolving an
 * unpinned main agent to <defaults.workspace>/main) describe where a session
 * RUNS, not which state tree owns governance.
 */

import type { OpenClawPluginApi, PluginCommandContext } from '../openclaw-sdk.js';
import { isDriveQualifiedWorkspacePath, validateWorkspaceDir, type WorkspaceResolutionContext } from '../core/workspace-dir-validation.js';
import { resolveWorkspaceDirFromApi } from '../core/path-resolver.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Resolve workspace directory for command execution.
 *
 * Chain (PRI-686, aligned with hook side PRI-259): PD explicit sources
 * (PD_WORKSPACE_DIR → OPENCLAW_WORKSPACE → principles-disciple.json) →
 * ctx.workspaceDir → resolveWorkspaceDirFromApi (official OpenClaw API).
 *
 * PD explicit sources are owner-declared and intentionally override the live
 * session context: on OpenClaw 2026.8/9 multi-agent layouts an unpinned agent
 * entry resolves ctx.workspaceDir to `<defaults.workspace>/<agentId>`, which
 * split hook writes (PD canonical) from command reads (agent sub-workspace)
 * and silently gated every pain candidate with needs_evidence.
 *
 * Divergence between PD explicit and ctx.workspaceDir is logged as a warning
 * — never silent (rc-9).
 *
 * CRITICAL: Throws if workspaceDir cannot be resolved. Silent failures are dangerous
 * because commands might operate on the wrong directory.
 */
/** Options shared by command-side resolvers (mirrors HookWorkspaceResolutionOptions). */
export interface CommandWorkspaceResolutionOptions {
  /** Override PD explicit-source resolution — for tests isolating from host config. */
  explicitPdResolver?: () => CanonicalWorkspaceResult | null;
}

export function resolveCommandWorkspaceDir(
  api: OpenClawPluginApi,
  ctx: { workspaceDir?: string },
  options?: CommandWorkspaceResolutionOptions,
): string {
  // 1. PD explicit sources (owner-declared) take priority over session context
  const injectedExplicit = options?.explicitPdResolver;
  const declared = injectedExplicit ? null : resolveExplicitPdSourcesWithDiagnostics();
  const explicit = injectedExplicit ? injectedExplicit() : declared?.resolved ?? null;
  if (explicit) {
    if (ctx.workspaceDir && path.resolve(ctx.workspaceDir) !== path.resolve(explicit.workspaceDir)) {
      api.logger.warn(
        `[PD:Command] PD explicit workspace (${explicit.source}: ${explicit.workspaceDir}) ` +
        `differs from OpenClaw context (${ctx.workspaceDir}). Using PD explicit. ` +
        `If this is wrong, update ~/.openclaw/principles-disciple.json or unset PD_WORKSPACE_DIR/OPENCLAW_WORKSPACE.`,
      );
    }
    const rejectionWarning = describeRejectedCandidates(declared?.rejected ?? [], explicit.source);
    if (rejectionWarning) {
      api.logger.warn(`[PD:Command] ${rejectionWarning}`);
    }
    return explicit.workspaceDir;
  }

  // 2. Direct from command context (set by OpenClaw for current session)
  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (!issue) {
      const rejectionWarning = describeRejectedCandidates(declared?.rejected ?? [], 'openclaw_context');
      if (rejectionWarning) {
        api.logger.warn(`[PD:Command] ${rejectionWarning}`);
      }
      return ctx.workspaceDir;
    }
    // Validation failed — fail immediately, do not silently fall back
    const errorMsg = `[PD:Command] ctx.workspaceDir="${ctx.workspaceDir}" is invalid: ${issue}`;
    api.logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  // 3. Official OpenClaw API → env vars → config file
  const resolved = resolveWorkspaceDirFromApi(api);
  if (resolved) return resolved;

  // CRITICAL FAILURE: Cannot determine workspace directory
  const errorMsg = `[PD:Command] CRITICAL: Cannot resolve workspace directory. ` +
    `ctx.workspaceDir="${ctx.workspaceDir ?? ''}" is invalid, and all fallbacks failed. ` +
    `Commands will NOT execute to prevent data corruption.`;
  api.logger.error(errorMsg);

  throw new Error(errorMsg);
}

/**
 * Resolve workspace directory for plugin command execution.
 *
 * Chain (PRI-686, aligned with hook side PRI-259): PD explicit sources
 * (PD_WORKSPACE_DIR → OPENCLAW_WORKSPACE → principles-disciple.json) →
 * ctx.workspaceDir (canonical) → ctx.config.workspaceDir (dispatcher fallback)
 *
 * Same priority as resolveCommandWorkspaceDir — see its doc comment for the
 * workspace-split rationale. Divergence is logged, never silent (rc-9).
 *
 * CRITICAL: Throws if workspaceDir cannot be resolved. Commands must NEVER silently
 * fall back to process.cwd() as this masks configuration errors and can corrupt
 * the wrong workspace.
 *
 * @param ctx - Plugin command context (has workspaceDir + config properties)
 * @param source - Source label for error messages (e.g. 'pain', 'pd-status')
 * @param logger - Optional logger for divergence warnings (the plugin API logger)
 */
export function resolvePluginCommandWorkspaceDir(
  ctx: PluginCommandContext,
  source: string,
  logger?: { warn?: (msg: string) => void },
  options?: CommandWorkspaceResolutionOptions,
): string {
  // 1. PD explicit sources (owner-declared) take priority over session context
  const explicit = (options?.explicitPdResolver ?? resolveExplicitPdSources)();
  if (explicit) {
    // rc-2: config.workspaceDir is untrusted dispatcher data — only a real
    // string participates in the divergence comparison; other types are
    // treated as absent (they would previously crash path.resolve).
    const configWorkspaceDir =
      typeof ctx.config?.workspaceDir === 'string' ? ctx.config.workspaceDir : undefined;
    const ctxWs = ctx.workspaceDir ?? configWorkspaceDir;
    if (ctxWs && path.resolve(ctxWs) !== path.resolve(explicit.workspaceDir)) {
      logger?.warn?.(
        `[PD:Command:${source}] PD explicit workspace (${explicit.source}: ${explicit.workspaceDir}) ` +
        `differs from OpenClaw context (${ctxWs}). Using PD explicit. ` +
        `If this is wrong, update ~/.openclaw/principles-disciple.json or unset PD_WORKSPACE_DIR/OPENCLAW_WORKSPACE.`,
      );
    }
    return explicit.workspaceDir;
  }

  // 2. Canonical workspaceDir field (set by OpenClaw command dispatcher)
  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (!issue) return ctx.workspaceDir;
    throw new Error(`[PD:Command:${source}] ctx.workspaceDir="${ctx.workspaceDir}" is invalid: ${issue}`);
  }

  // 2. Dispatcher may also put workspaceDir in config (legacy/alternative path)
  const configWorkspaceDir = ctx.config?.workspaceDir as string | undefined;
  if (configWorkspaceDir) {
    const issue = validateWorkspaceDir(configWorkspaceDir);
    if (!issue) return configWorkspaceDir;
    throw new Error(`[PD:Command:${source}] ctx.config.workspaceDir="${configWorkspaceDir}" is invalid: ${issue}`);
  }

  // CRITICAL FAILURE: No workspace directory available
  throw new Error(
    `[PD:Command:${source}] CRITICAL: workspaceDir is not set in ctx.workspaceDir or ctx.config.workspaceDir. ` +
    `Commands cannot execute without a valid workspace. Set OPENCLAW_WORKSPACE_DIR env var or ensure the workspace is properly initialized.`,
  );
}

// ── PD Canonical Workspace Config Resolution (PRI-259) ──────────────────

export type CanonicalWorkspaceSource = 'pd_env' | 'openclaw_env' | 'pd_config' | 'pd_default';

export interface CanonicalWorkspaceResult {
  workspaceDir: string;
  source: CanonicalWorkspaceSource;
}

const PD_CONFIG_FILENAME = 'principles-disciple.json';

/**
 * Find the first usable `workspace` pointer among the known config locations.
 *
 * A candidate file whose pointer cannot be trusted is skipped and the scan
 * continues: refusing the whole `pd_config` source because the first file holds
 * a bad value would ignore a perfectly good pointer further down the list.
 * Refusals are pushed into `rejected` so the caller can report them.
 */
function loadWorkspaceFromPdConfigFile(rejected: RejectedWorkspaceCandidate[]): string | null {
  const candidates = [
    path.join(os.homedir(), '.openclaw', PD_CONFIG_FILENAME),
    path.join(os.homedir(), '.principles', PD_CONFIG_FILENAME),
    path.join(process.cwd(), PD_CONFIG_FILENAME),
  ];

  for (const configPath of candidates) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (Object.hasOwn(parsed, 'workspace')) {
          const workspaceValue = (parsed as Record<string, unknown>)['workspace'];
          if (typeof workspaceValue === 'string' && workspaceValue.trim()) {
            const value = workspaceValue.trim();
            if (!isDriveQualifiedWorkspacePath(value)) {
              rejected.push({ source: 'pd_config', value, reason: 'not_absolute' });
              continue;
            }
            return value;
          }
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** A declared workspace candidate that was refused, with why. */
export interface RejectedWorkspaceCandidate {
  source: CanonicalWorkspaceSource;
  value: string;
  reason: 'not_absolute' | 'rejected_by_validation';
}

interface DeclaredWorkspaceResolution {
  resolved: CanonicalWorkspaceResult | null;
  rejected: RejectedWorkspaceCandidate[];
}

/** Reads one declared candidate; may record its own refusals into `rejected`. */
type DeclaredCandidateReader = (rejected: RejectedWorkspaceCandidate[]) => string | null | undefined;

/**
 * Resolve owner-declared workspace candidates in priority order.
 *
 * A candidate that does not name one fixed directory is REJECTED instead of
 * resolved: path.resolve() turns a drive-relative or separator-less value
 * (e.g. "D:.openclawworkspace" — what a Windows path becomes when its
 * backslashes are lost in transit) into a plausible absolute path that depends
 * on the process CWD, and anchors a root-relative value such as "\workspace"
 * to whichever drive the process is on. Either way governance state is aimed
 * at a directory that depends on who is reading. Skipping to the next source
 * degrades safely; resolving it does not.
 *
 * A rejected candidate is reported, never swallowed: a silent fallback that
 * changes which directory owns governance state is the same class of problem
 * this guard exists to prevent.
 *
 * Candidates are read lazily so a higher-priority source still short-circuits
 * the file read behind it — this runs per hook event.
 */
function resolveDeclaredWorkspaceDir(
  candidates: ReadonlyArray<readonly [CanonicalWorkspaceSource, DeclaredCandidateReader]>,
): DeclaredWorkspaceResolution {
  const rejected: RejectedWorkspaceCandidate[] = [];

  for (const [source, read] of candidates) {
    const raw = read(rejected);
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    if (!isDriveQualifiedWorkspacePath(value)) {
      rejected.push({ source, value, reason: 'not_absolute' });
      continue;
    }
    const dir = path.resolve(value);
    if (!validateWorkspaceDir(dir)) {
      return { resolved: { workspaceDir: dir, source }, rejected };
    }
    rejected.push({ source, value, reason: 'rejected_by_validation' });
  }

  return { resolved: null, rejected };
}

/** The owner-declared candidates, in priority order, each read lazily. */
function declaredWorkspaceCandidates(): ReadonlyArray<readonly [CanonicalWorkspaceSource, DeclaredCandidateReader]> {
  return [
    ['pd_env', () => process.env.PD_WORKSPACE_DIR],
    ['openclaw_env', () => process.env.OPENCLAW_WORKSPACE],
    ['pd_config', (rejected) => loadWorkspaceFromPdConfigFile(rejected)],
  ];
}

/**
 * Describe refused candidates for the operator log. `fallback` is the source
 * that was actually used, so the line states where resolution landed — not
 * only that something was refused.
 */
function describeRejectedCandidates(
  rejected: readonly RejectedWorkspaceCandidate[],
  fallback: string,
): string | undefined {
  if (rejected.length === 0) return undefined;
  const details = rejected
    .map((r) => `${r.source} (value="${r.value}", reason=${r.reason})`)
    .join(', ');
  return (
    `Workspace pointer rejected, falling back to ${fallback}: ${details}. ` +
    'A workspace pointer must be an absolute path; a drive-relative or ' +
    'separator-less value would resolve against the process working directory.'
  );
}

export function resolveCanonicalWorkspaceDir(): CanonicalWorkspaceResult | null {
  const explicit = resolveDeclaredWorkspaceDir(declaredWorkspaceCandidates()).resolved;
  if (explicit) {
    return explicit;
  }

  const defaultDir = path.join(os.homedir(), '.openclaw', 'workspace');
  if (!validateWorkspaceDir(defaultDir)) {
    return { workspaceDir: defaultDir, source: 'pd_default' };
  }

  return null;
}

/**
 * Resolve only PD explicit sources (env vars + config file), excluding pd_default.
 * Used by hook resolution to ensure ctx.workspaceDir takes priority over the
 * hardcoded default fallback.
 *
 * Returns the refused candidates alongside the winner so hook resolution can
 * report them; see resolveHookWorkspaceDir.
 */
function resolveExplicitPdSourcesWithDiagnostics(): DeclaredWorkspaceResolution {
  return resolveDeclaredWorkspaceDir(declaredWorkspaceCandidates());
}

function resolveExplicitPdSources(): CanonicalWorkspaceResult | null {
  return resolveExplicitPdSourcesWithDiagnostics().resolved;
}

// ── Hook Workspace Resolution (PRI-259) ────────────────────────────────

export type HookWorkspaceSource = CanonicalWorkspaceSource | 'openclaw_context' | 'openclaw_api';

export interface HookWorkspaceResolutionSuccess {
  ok: true;
  workspaceDir: string;
  source: HookWorkspaceSource;
  consistencyWarning?: string;
}

export interface HookWorkspaceResolutionFailure {
  ok: false;
  reason: string;
  nextAction: string;
  message: string;
}

export type HookWorkspaceResolutionResult =
  | HookWorkspaceResolutionSuccess
  | HookWorkspaceResolutionFailure;

function tryResolveFromOpenClawApi(
  api: OpenClawPluginApi,
  agentId: string | undefined,
): string | undefined {
  try {
    const resolved = api.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config, agentId ?? 'main');
    if (resolved && !validateWorkspaceDir(resolved)) {
      return resolved;
    }
  } catch {
    // Fall through
  }
  return undefined;
}

export interface HookWorkspaceResolutionOptions {
  canonicalResolver?: () => CanonicalWorkspaceResult | null;
  explicitPdResolver?: () => CanonicalWorkspaceResult | null;
}

export function resolveHookWorkspaceDir(
  ctx: WorkspaceResolutionContext,
  api: OpenClawPluginApi,
  source: string,
  options?: HookWorkspaceResolutionOptions,
): HookWorkspaceResolutionResult {
  // Priority 1: PD explicit sources (env vars + config file) — these are
  // owner-declared and intentionally override the live session context.
  //
  // Priority order is unchanged: a refused candidate is skipped, never fatal.
  // An injected resolver is a test seam and carries no diagnostics of its own.
  const injectedExplicit = options?.explicitPdResolver;
  const declared = injectedExplicit ? null : resolveExplicitPdSourcesWithDiagnostics();
  const explicit = injectedExplicit ? injectedExplicit() : declared?.resolved ?? null;
  const rejectedCandidates = declared?.rejected ?? [];

  if (explicit) {
    const warnings: string[] = [];
    const rejectionWarning = describeRejectedCandidates(rejectedCandidates, explicit.source);
    if (rejectionWarning) warnings.push(rejectionWarning);

    if (ctx.workspaceDir) {
      const normalizedCtx = path.resolve(ctx.workspaceDir);
      const normalizedExplicit = path.resolve(explicit.workspaceDir);
      if (normalizedCtx !== normalizedExplicit) {
        warnings.push(
          `PD explicit workspace (${explicit.source}: ${explicit.workspaceDir}) ` +
          `differs from OpenClaw context (${ctx.workspaceDir}). Using PD explicit.`,
        );
      }
    }

    return {
      ok: true,
      workspaceDir: explicit.workspaceDir,
      source: explicit.source,
      consistencyWarning: warnings.length > 0 ? warnings.join(' ') : undefined,
    };
  }

  // Priority 2: OpenClaw live context — the real session workspace.
  // This MUST take priority over pd_default (the hardcoded fallback).
  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (!issue) {
      return {
        ok: true,
        workspaceDir: ctx.workspaceDir,
        source: 'openclaw_context',
        consistencyWarning: describeRejectedCandidates(rejectedCandidates, 'openclaw_context'),
      };
    }
  }

  // Priority 3: OpenClaw API resolution
  const apiResolved = tryResolveFromOpenClawApi(api, ctx.agentId);
  if (apiResolved) {
    return {
      ok: true,
      workspaceDir: apiResolved,
      source: 'openclaw_api',
      consistencyWarning: describeRejectedCandidates(rejectedCandidates, 'openclaw_api'),
    };
  }

  // Priority 4: pd_default (hardcoded fallback) — only when nothing else works
  const resolveCanonical = options?.canonicalResolver ?? resolveCanonicalWorkspaceDir;
  const canonical = resolveCanonical();
  if (canonical && canonical.source === 'pd_default') {
    const warnings = [
      'Using hardcoded default workspace (~/.openclaw/workspace). ' +
      'Set PD_WORKSPACE_DIR or create ~/.openclaw/principles-disciple.json for stable resolution.',
      describeRejectedCandidates(rejectedCandidates, 'pd_default'),
    ];
    return {
      ok: true,
      workspaceDir: canonical.workspaceDir,
      source: 'pd_default',
      consistencyWarning: warnings.filter(Boolean).join(' '),
    };
  }

  return {
    ok: false,
    reason: 'workspace_dir_unresolvable',
    nextAction:
      'Set PD_WORKSPACE_DIR environment variable, create ~/.openclaw/principles-disciple.json ' +
      'with a "workspace" field, or ensure OpenClaw provides workspaceDir in hook context.',
    message:
      `[PD:${source}] Cannot resolve workspace directory from any source. ` +
      `PD explicit config (PD_WORKSPACE_DIR, principles-disciple.json) ` +
      `and OpenClaw fallback (ctx.workspaceDir, api.resolveAgentWorkspaceDir, ~/.openclaw/workspace) all failed.`,
  };
}

/**
 * Resolve workspace directory for tool hook execution (safe version).
 * Returns undefined instead of throwing if resolution fails.
 *
 * PRI-259: Uses PD canonical config as primary source, OpenClaw as fallback.
 */
export function resolveToolHookWorkspaceDirSafe(
  ctx: WorkspaceResolutionContext,
  api: OpenClawPluginApi,
  source: string,
  options?: HookWorkspaceResolutionOptions,
): string | undefined {
  const result = resolveHookWorkspaceDir(ctx, api, source, options);

  if (!result.ok) {
    api.logger.warn(result.message);
    return undefined;
  }

  if (result.consistencyWarning) {
    api.logger.warn(`[PD:${source}] ${result.consistencyWarning}`);
  }

  return result.workspaceDir;
}

export class WorkspaceResolutionError extends Error {
  readonly reason: string;
  readonly nextAction: string;

  constructor(message: string, reason: string, nextAction: string) {
    super(message);
    this.name = 'WorkspaceResolutionError';
    this.reason = reason;
    this.nextAction = nextAction;
  }

  toJSON() {
    return {
      ok: false as const,
      reason: this.reason,
      message: this.message,
      nextAction: this.nextAction,
    };
  }
}

export function resolveWorkspaceDirForRuntimeV2(
  ctx: { workspaceDir?: string },
  api: OpenClawPluginApi | undefined,
  source: string,
): string {
  const explicit = ctx.workspaceDir;
  if (!explicit || !explicit.trim()) {
    throw new WorkspaceResolutionError(
      `No explicit workspace directory for Runtime V2 entrypoint (${source}). ` +
      'Provide workspaceDir in context. Runtime V2 does not use legacy discovery fallback.',
      'workspace_dir_missing',
      'Ensure the OpenClaw hook context includes workspaceDir, or set PD_WORKSPACE_DIR environment variable.',
    );
  }

  const normalized = path.resolve(explicit.trim());
  const validation = validateWorkspaceDir(normalized);
  if (validation) {
    throw new WorkspaceResolutionError(
      `workspaceDir validation failed for ${source}: ${validation}`,
      'workspace_dir_invalid',
      'Provide a valid workspaceDir that is not the home directory, root, or empty.',
    );
  }

  return normalized;
}
