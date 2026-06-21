/**
 * PRI-431 Step 3: Shared runtime-adapter resolver.
 *
 * Extracted from duplicated `resolveRuntimeAdapter` in:
 *   - packages/pd-cli/src/commands/runtime-internalization-run-once.ts (L222-551)
 *   - packages/pd-cli/src/commands/diagnose.ts (L186-334, inline)
 *
 * Design decisions:
 * - Test-double payloads stay call-site-specific via `testDoublePayloadBuilder` callback.
 *   The 7 internalization runner payloads (philosopher/scribe/artificer/...) are unique
 *   to run-once.ts; the diagnostician payload is unique to diagnose.ts. Unifying them
 *   would couple unrelated domains.
 * - CLI-gate concerns (process.exit, telemetry, help text) stay at call sites.
 *   This resolver throws structured `ConfigResolutionError` that handlers translate.
 * - Lives in pd-cli/services (NOT core) because it constructs adapters and reads
 *   CLI feature flags via `loadEffectiveFeatureFlags`, which is a pd-cli service.
 *
 * ERR refs:
 * - ERR-001 (no any): all types explicit
 * - ERR-005 (no as bypass): no type casts
 * - ERR-009 (fail-loud): ConfigResolutionError thrown with structured fields
 * - ERR-013 (Object.hasOwn): feature flag check uses Object.hasOwn
 * - ERR-002 (graceful degradation with reason): structured error includes reason + nextAction
 */

import {
  TestDoubleRuntimeAdapter,
  PiAiRuntimeAdapter,
  OpenClawCliRuntimeAdapter,
  L2AgentLoopAdapter,
  buildL2PrincipleReaderFromLedger,
  loadLedger,
  isRuntimeConfigError,
  validateRuntimeConfig,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter, PdL2ArtifactReader, RuntimeConfig, RuntimeConfigResult } from '@principles/core/runtime-v2';
import { loadEffectiveFeatureFlags } from './feature-flag-loader.js';
import { resolveRuntimeFromPdConfig } from './resolve-runtime-from-pd-config.js';
import type { ResolvedRuntimeFromPdConfig } from './resolve-runtime-from-pd-config.js';

// ── Error class ────────────────────────────────────────────────────────────

export type ConfigResolutionErrorKind =
  | 'missing-fields'
  | 'invalid-config'
  | 'unsupported-runtime'
  | 'test-double-refused';

export interface ConfigResolutionErrorDetails {
  /** Required fields that are missing (for 'missing-fields' kind). */
  missing?: string[];
  /** Structured next action for the operator (CLI Operator Gate rule #6). */
  nextAction?: string;
}

export class ConfigResolutionError extends Error {
  readonly kind: ConfigResolutionErrorKind;
  readonly missing?: string[];
  readonly nextAction?: string;

  constructor(
    message: string,
    kind: ConfigResolutionErrorKind,
    details?: ConfigResolutionErrorDetails,
  ) {
    super(message);
    this.name = 'ConfigResolutionError';
    this.kind = kind;
    this.missing = details?.missing;
    this.nextAction = details?.nextAction;
  }
}

// ── Options interface ──────────────────────────────────────────────────────

export interface ResolveAdapterOptions {
  /** Runtime kind: 'test-double' | 'pi-ai' | 'openclaw-cli' | 'config' */
  runtimeKind: string;
  /** Workspace directory (for config resolution + feature flags) */
  workspaceDir: string;
  /** Runner kind (for L2 dreamer routing). Optional. */
  runnerKind?: string;
  /** CLI timeout override. Takes precedence over config timeoutMs. */
  timeoutMs?: number;
  /**
   * Whether test-double runtime is allowed. Default: false.
   * When false, 'test-double' runtimeKind throws ConfigResolutionError.
   */
  allowTestDouble?: boolean;
  /**
   * Call-site-specific test-double payload builder.
   * Required when runtimeKind === 'test-double' and allowTestDouble === true.
   * Receives the full opts object so the builder can access taskId, runnerKind, etc.
   */
  testDoublePayloadBuilder?: (opts: ResolveAdapterOptions) => PDRuntimeAdapter;
  /**
   * CLI overrides for pi-ai runtime (from --provider, --model, etc. flags).
   * When provided, these take precedence over config values.
   */
  piAiOverrides?: {
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    maxRetries?: number;
  };
  /**
   * CLI override for openclaw mode (from --openclaw-local / --openclaw-gateway flags).
   * When provided, takes precedence over config openclawMode.
   */
  openclawMode?: 'local' | 'gateway';
  /** PRI-419: L2 artifact reader (only used when l2_dreamer is on). */
  l2ArtifactReader?: PdL2ArtifactReader;
  /** PRI-419: workspace stateDir for L2 principle reader (only used when l2_dreamer is on). */
  l2StateDir?: string;
  /** PRI-431 Step 1d: CLI agentId override for openclaw-cli (from --agent flag). Default: 'main'. */
  agentId?: string;
  /**
   * PRI-431 Step 1d: Whether config resolution errors are tolerated (proceed with CLI overrides alone).
   * When true, pi-ai branch skips validateRuntimeConfig and uses manual missing-field check.
   * Default: false (config errors throw ConfigResolutionError).
   */
  configOptional?: boolean;
  /**
   * PRI-431 Step 1d: Whether to validate that process.env[apiKeyEnv] is set before
   * constructing PiAiRuntimeAdapter. Default: false (env var check stays at call site for backward compat).
   */
  validateApiKeyEnv?: boolean;
  /**
   * PRI-431 Step 1d: Callback invoked with the full resolved config object (including legacyWarnings)
   * after successful config resolution. Useful for telemetry, legacyWarnings printing, etc.
   * NOT called for test-double branch (no config resolution).
   * Called even when config returns error IF configOptional is true.
   */
  onConfigResolved?: (resolved: ResolvedRuntimeFromPdConfig) => void;
}

// ── Resolver function ──────────────────────────────────────────────────────

export function resolveRuntimeAdapterFromConfig(opts: ResolveAdapterOptions): PDRuntimeAdapter {
  // ── test-double branch ──────────────────────────────────────────────────
  if (opts.runtimeKind === 'test-double') {
    if (!opts.allowTestDouble) {
      throw new ConfigResolutionError(
        'runtimeKind "test-double" requires allowTestDouble=true.',
        'test-double-refused',
        { nextAction: 'Pass --allow-test-double or use a production runtime kind.' },
      );
    }
    if (!opts.testDoublePayloadBuilder) {
      throw new ConfigResolutionError(
        'runtimeKind "test-double" requires testDoublePayloadBuilder callback.',
        'missing-fields',
        {
          missing: ['testDoublePayloadBuilder'],
          nextAction:
            'Provide a testDoublePayloadBuilder function that constructs the test-double adapter.',
        },
      );
    }
    return opts.testDoublePayloadBuilder(opts);
  }

  // ── Resolve config from .pd/config.yaml (for pi-ai, openclaw-cli, config) ──
  const resolved = resolveRuntimeFromPdConfig(opts.workspaceDir);
  const configResult: RuntimeConfigResult = resolved.result;

  // PRI-431 Step 1d: invoke onConfigResolved callback (for telemetry, legacyWarnings, etc.)
  opts.onConfigResolved?.(resolved);

  if (isRuntimeConfigError(configResult)) {
    if (!opts.configOptional) {
      throw new ConfigResolutionError(
        `Config resolution from .pd/config.yaml failed: ${configResult.reason}. ${configResult.message}`,
        'invalid-config',
        { nextAction: configResult.nextAction },
      );
    }
    // configOptional=true: proceed with CLI overrides alone (pi-ai branch handles missing fields)
  }

  // ── pi-ai branch ────────────────────────────────────────────────────────
  // When runtimeKind === 'config', configResult must be a valid RuntimeConfig
  // (if it were an error and !configOptional, we threw above; if configOptional,
  // the caller passes an explicit runtimeKind, never 'config'). The type guard
  // also narrows for TypeScript.
  const isPiAi =
    opts.runtimeKind === 'pi-ai' ||
    (opts.runtimeKind === 'config' &&
      !isRuntimeConfigError(configResult) &&
      configResult.runtimeKind === 'pi-ai');
  if (isPiAi) {
    // PRI-431 Step 1d + PR review fix: validateRuntimeConfig is only called when
    // config is valid AND configOptional is false. When configOptional=true (diagnose.ts),
    // skip validateRuntimeConfig to match the original diagnose.ts behavior (which never
    // called it — only did a manual missing-field check on merged values). This avoids
    // a behavior change where validateRuntimeConfig would reject configs missing baseUrl
    // for non-built-in providers, even when the user passes --baseUrl on the CLI.
    if (!opts.configOptional && !isRuntimeConfigError(configResult)) {
      try {
        validateRuntimeConfig(configResult);
      } catch (err) {
        throw new ConfigResolutionError(
          err instanceof Error ? err.message : String(err),
          'invalid-config',
        );
      }
    }

    // Merge CLI overrides with config values (overrides take precedence)
    // When configOptional and config failed, configResult fields are unavailable — use empty object
    const configFields: Partial<RuntimeConfig> = isRuntimeConfigError(configResult) ? {} : configResult;
    const provider = opts.piAiOverrides?.provider ?? configFields.provider;
    const model = opts.piAiOverrides?.model ?? configFields.model;
    const apiKeyEnv = opts.piAiOverrides?.apiKeyEnv ?? configFields.apiKeyEnv;
    const baseUrl = opts.piAiOverrides?.baseUrl ?? configFields.baseUrl;
    const maxRetries = opts.piAiOverrides?.maxRetries ?? configFields.maxRetries;
    const adapterTimeoutMs = opts.timeoutMs ?? configFields.timeoutMs;

    // PRI-431 Step 1d + PR review fix: manual missing-field check on MERGED values
    // when configOptional=true. The original diagnose.ts always did this check on merged
    // values (not just when config failed), so we replicate that here. This covers both
    // the "config failed" case and the "config valid but missing fields not in config" case.
    if (opts.configOptional) {
      const missing: string[] = [];
      if (!provider) missing.push('provider');
      if (!model) missing.push('model');
      if (!apiKeyEnv) missing.push('apiKeyEnv');
      if (missing.length > 0) {
        throw new ConfigResolutionError(
          `Missing required pi-ai config: ${missing.join(', ')}.`,
          'missing-fields',
          {
            missing,
            nextAction:
              'Pass --provider, --model, --apiKeyEnv flags or configure .pd/config.yaml runtime profile.',
          },
        );
      }
    }

    // PRI-431 Step 1d: validate API key env var when requested
    if (opts.validateApiKeyEnv && apiKeyEnv && !process.env[apiKeyEnv]) {
      throw new ConfigResolutionError(
        `Environment variable '${apiKeyEnv}' is not set.`,
        'invalid-config',
        {
          nextAction:
            'Set the env var (e.g., export OPENAI_API_KEY=...) or choose a different apiKeyEnv.',
        },
      );
    }

    // PRI-419: L2 dreamer sub-branch — when l2_dreamer flag is on AND this is the
    // dreamer runner, route through the L2 multi-turn agent loop adapter.
    // Other runners (philosopher/scribe/...) stay on L1.
    if (opts.runnerKind === 'dreamer' && opts.l2ArtifactReader && opts.l2StateDir) {
      const effectiveFlags = loadEffectiveFeatureFlags(opts.workspaceDir);
      const l2Flag = Object.hasOwn(effectiveFlags.flags, 'l2_dreamer')
        ? (effectiveFlags.flags.l2_dreamer?.enabled ?? false)
        : false;
      if (l2Flag) {
        return new L2AgentLoopAdapter(
          {
            provider: String(provider),
            model: String(model),
            apiKeyEnv: String(apiKeyEnv),
            baseUrl,
            workspace: opts.workspaceDir,
            totalBudgetMs: adapterTimeoutMs,
          },
          {
            artifactReader: opts.l2ArtifactReader,
            principleReader: buildL2PrincipleReaderFromLedger(loadLedger(opts.l2StateDir)),
          },
        );
      }
    }

    return new PiAiRuntimeAdapter({
      provider: String(provider),
      model: String(model),
      apiKeyEnv: String(apiKeyEnv),
      maxRetries,
      timeoutMs: adapterTimeoutMs,
      baseUrl,
      workspace: opts.workspaceDir,
    });
  }

  // ── openclaw-cli branch ─────────────────────────────────────────────────
  const isOpenClawCli =
    opts.runtimeKind === 'openclaw-cli' ||
    (opts.runtimeKind === 'config' &&
      !isRuntimeConfigError(configResult) &&
      configResult.runtimeKind === 'openclaw-cli');
  if (isOpenClawCli) {
    // PRI-431 Step 1d: handle configOptional — when config failed, configFields is empty
    const openclawConfigFields: Partial<RuntimeConfig> = isRuntimeConfigError(configResult)
      ? {}
      : configResult;
    // CLI override takes precedence over config
    const openclawMode = opts.openclawMode ?? openclawConfigFields.openclawMode;
    if (!openclawMode) {
      throw new ConfigResolutionError(
        "runtimeKind 'openclaw-cli' requires openclawMode.",
        'missing-fields',
        {
          missing: ['openclawMode'],
          nextAction:
            'Add openclawMode: local|gateway to your .pd/config.yaml runtime profile or use --openclaw-local/--openclaw-gateway flags.',
        },
      );
    }
    // PRI-431 Step 1d: only pass agentId when explicitly provided (backward compat with run-once.ts)
    const openclawAdapterOpts: {
      runtimeMode: 'local' | 'gateway';
      workspaceDir: string;
      agentId?: string;
    } = {
      runtimeMode: openclawMode,
      workspaceDir: opts.workspaceDir,
    };
    if (opts.agentId !== undefined) {
      openclawAdapterOpts.agentId = opts.agentId;
    }
    return new OpenClawCliRuntimeAdapter(openclawAdapterOpts);
  }

  // ── Unsupported runtime ────────────────────────────────────────────────
  throw new Error(
    `Unsupported runtime kind: ${opts.runtimeKind}. Supported: test-double, pi-ai, openclaw-cli, config`,
  );
}

// ── Re-exports for call-site convenience ───────────────────────────────────
// These allow call sites to import everything from one module.
export type { RuntimeConfig, RuntimeConfigResult };
export { TestDoubleRuntimeAdapter, isRuntimeConfigError, validateRuntimeConfig };
