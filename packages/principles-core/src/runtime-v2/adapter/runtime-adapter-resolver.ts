/**
 * Shared runtime-adapter resolver — pure logic, I/O injected (candidate ⑥ convergence).
 *
 * Moved from packages/pd-cli/src/services/runtime-adapter-resolver.ts (PRI-431) so
 * core, pd-cli, and openclaw-plugin can all resolve a PDRuntimeAdapter through one
 * function. The two pd-cli-local I/O calls in the original (loadPdConfig +
 * computeFlagsFromLoadResult, and resolveRuntimeFromPdConfig) are replaced by
 * injected callbacks on ResolveAdapterOptions, so this module stays pure (no
 * fs/path imports — AGENTS.md Critical Rule #1).
 *
 * Behavioural differences between the three former call sites are preserved
 * verbatim via explicit option fields (openclawModeFallback, piAiFieldDefaults,
 * l2PrincipleReaderOptions) — this resolver UNIFIES construction logic and error
 * handling, it does NOT silently unify runtime behaviour. Each call site passes
 * the options that reproduce its pre-convergence behaviour.
 *
 * ERR refs:
 * - ERR-001 (no any): all types explicit
 * - ERR-005 (no as bypass): no type casts
 * - ERR-009 (fail-loud): ConfigResolutionError thrown with structured fields
 * - ERR-013 (Object.hasOwn): feature flag check uses Object.hasOwn
 * - ERR-002 (graceful degradation with reason): structured error includes reason + nextAction
 */

import { TestDoubleRuntimeAdapter } from './test-double-runtime-adapter.js';
import { PiAiRuntimeAdapter } from './pi-ai-runtime-adapter.js';
import { OpenClawCliRuntimeAdapter } from './openclaw-cli-runtime-adapter.js';
import { L2AgentLoopAdapter } from './l2-agent-loop-adapter.js';
import { buildL2PrincipleReaderFromLedger } from '../build-l2-principle-reader.js';
import {
  isRuntimeConfigError,
  validateRuntimeConfig,
} from '../pain-signal-runtime-factory.js';
import type { PDRuntimeAdapter } from '../runtime-protocol.js';
import type { PdL2ArtifactReader } from '../tools/agent-tool-contract.js';
import type {
  RuntimeConfig,
  RuntimeConfigResult,
} from '../pain-signal-runtime-factory.js';
import { loadLedger } from '../../principle-tree-ledger.js';

// ── Injected I/O seam types ─────────────────────────────────────────────────
// These describe only the fields the resolver reads. Each package (pd-cli,
// openclaw-plugin, core) supplies its own concrete implementation whose shape
// is structurally compatible — no cross-package import required.

/**
 * Minimal view of a PD config load result consumed by the resolver. The
 * concrete PdConfigLoadResult in pd-cli / PluginConfigLoadResult in the plugin
 * both satisfy this structurally (effective/defaults + ok flag).
 */
export interface ResolverPdConfigLoadResult {
  ok: boolean;
  /** Effective config when ok, fallback defaults when not. */
  effective?: unknown;
  /** Fallback defaults available even when the file is malformed. */
  defaults?: unknown;
}

/**
 * Minimal view of the resolved-runtime-from-config object. The resolver only
 * reads .result (the RuntimeConfigResult) and passes the whole object to the
 * optional onConfigResolved callback.
 */
export interface ResolverResolvedRuntime {
  result: RuntimeConfigResult;
  [key: string]: unknown;
}

/** Feature-flags bag shape consumed by the L2 dreamer gate. */
export interface ResolverFeatureFlagsResult {
  flags: Record<string, { enabled: boolean } | undefined>;
}

/** Injected I/O callbacks. Each call site supplies its package's real loaders. */
export interface ResolverIoDeps {
  /** Load + validate .pd/config.yaml. Pure-shell; concrete impl owns fs. */
  loadPdConfig: (workspaceDir: string) => ResolverPdConfigLoadResult;
  /** Compute effective feature flags from a load result. */
  computeFlagsFromLoadResult: (result: ResolverPdConfigLoadResult) => ResolverFeatureFlagsResult;
  /** Resolve runtime config from .pd/config.yaml (returns RuntimeConfigResult + metadata). */
  resolveRuntimeFromPdConfig: (workspaceDir: string) => ResolverResolvedRuntime;
}

// ── Error class ─────────────────────────────────────────────────────────────

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

// ── Options interface ───────────────────────────────────────────────────────

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
   * Behaviour-difference knob (candidate ⑥): when openclawMode resolves to
   * undefined, fall back to this value instead of throwing. The legacy
   * pain-signal-runtime-factory and auto-consumer call sites passed
   * `?? 'default'`; the pd-cli call site threw. Reproduce each by setting /
   * omitting this field. Default: undefined (throw on missing mode).
   */
  openclawModeFallback?: 'local' | 'gateway' | 'default';
  /**
   * CLI override for openclaw mode (from --openclaw-local / --openclaw-gateway flags).
   * When provided, takes precedence over config openclawMode.
   */
  openclawMode?: 'local' | 'gateway';
  /** PRI-419: L2 artifact reader (only used when l2_dreamer is on). */
  l2ArtifactReader?: PdL2ArtifactReader;
  /** PRI-419: workspace stateDir for L2 principle reader (only used when l2_dreamer is on). */
  l2StateDir?: string;
  /**
   * Behaviour-difference knob (candidate ⑥): hardcoded pi-ai field defaults
   * applied with `??` after config + CLI overrides. The legacy auto-consumer
   * call site hardcoded 'openai'/'gpt-4o'/'OPENAI_API_KEY'; pain-signal-factory
   * and pd-cli did not. Reproduce the auto-consumer by passing these; omit
   * otherwise. Default: undefined (no defaults; missing fields throw via the
   * configOptional missing-field check or validateRuntimeConfig).
   */
  piAiFieldDefaults?: {
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
  };
  /** CLI agentId override for openclaw-cli (from --agent flag). Default: 'main'. */
  agentId?: string;
  /**
   * Whether config resolution errors are tolerated (proceed with CLI overrides alone).
   * When true, pi-ai branch skips validateRuntimeConfig and uses manual missing-field check.
   * Default: false (config errors throw ConfigResolutionError).
   */
  configOptional?: boolean;
  /**
   * Whether to validate that process.env[apiKeyEnv] is set before
   * constructing PiAiRuntimeAdapter. Default: false.
   */
  validateApiKeyEnv?: boolean;
  /**
   * Callback invoked with the full resolved config object (including legacyWarnings)
   * after successful config resolution. Useful for telemetry, legacyWarnings printing, etc.
   * NOT called for test-double branch (no config resolution).
   * Called even when config returns error IF configOptional is true.
   */
  onConfigResolved?: (resolved: ResolverResolvedRuntime) => void;
}

// ── Resolver function ───────────────────────────────────────────────────────

/**
 * Resolve a PDRuntimeAdapter from config + CLI overrides + injected I/O.
 *
 * The `io` parameter supplies the three package-specific I/O calls
 * (loadPdConfig, computeFlagsFromLoadResult, resolveRuntimeFromPdConfig).
 * Call sites pass their package's real implementations; tests pass mocks.
 */
export function resolveRuntimeAdapterFromConfig(
  opts: ResolveAdapterOptions,
  io: ResolverIoDeps,
): PDRuntimeAdapter {
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
  const resolved = io.resolveRuntimeFromPdConfig(opts.workspaceDir);
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
  const isPiAi =
    opts.runtimeKind === 'pi-ai' ||
    (opts.runtimeKind === 'config' &&
      !isRuntimeConfigError(configResult) &&
      configResult.runtimeKind === 'pi-ai');
  if (isPiAi) {
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
    const configFields: Partial<RuntimeConfig> = isRuntimeConfigError(configResult) ? {} : configResult;
    // candidate ⑥: apply piAiFieldDefaults AFTER config but the missing-field
    // check below still treats defaulted fields as present (matches legacy
    // auto-consumer, which hardcode these and therefore never hit missing-field).
    const provider = opts.piAiOverrides?.provider ?? configFields.provider ?? opts.piAiFieldDefaults?.provider;
    const model = opts.piAiOverrides?.model ?? configFields.model ?? opts.piAiFieldDefaults?.model;
    const apiKeyEnv = opts.piAiOverrides?.apiKeyEnv ?? configFields.apiKeyEnv ?? opts.piAiFieldDefaults?.apiKeyEnv;
    const baseUrl = opts.piAiOverrides?.baseUrl ?? configFields.baseUrl;
    const maxRetries = opts.piAiOverrides?.maxRetries ?? configFields.maxRetries;
    const adapterTimeoutMs = opts.timeoutMs ?? configFields.timeoutMs;

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
    if (opts.runnerKind === 'dreamer' && opts.l2ArtifactReader && opts.l2StateDir) {
      const effectiveFlags = io.computeFlagsFromLoadResult(io.loadPdConfig(opts.workspaceDir));
      const l2FlagDef = Object.hasOwn(effectiveFlags.flags, 'l2_dreamer')
        ? effectiveFlags.flags.l2_dreamer
        : undefined;
      const l2Flag = l2FlagDef ? l2FlagDef.enabled : false;
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
    const openclawConfigFields: Partial<RuntimeConfig> = isRuntimeConfigError(configResult)
      ? {}
      : configResult;
    // CLI override takes precedence over config; candidate ⑥: openclawModeFallback
    // reproduces the legacy `?? 'default'` of pain-signal-factory / auto-consumer
    // when set; when unset (pd-cli), missing mode throws (preserving prior behaviour).
    const openclawMode = opts.openclawMode ?? openclawConfigFields.openclawMode ?? opts.openclawModeFallback;
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
    // candidate ⑥: openclawModeFallback reproduces the legacy `?? 'default'`
    // of pain-signal-factory / auto-consumer when set; when unset (pd-cli),
    // missing mode throws (preserving prior behaviour). OpenClawCliRuntimeAdapter
    // natively accepts 'local' | 'gateway' | 'default', so 'default' passes through.
    const openclawAdapterOpts: {
      runtimeMode: 'local' | 'gateway' | 'default';
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

// ── Re-exports for call-site convenience ────────────────────────────────────
export type { RuntimeConfig, RuntimeConfigResult };
export { TestDoubleRuntimeAdapter, isRuntimeConfigError, validateRuntimeConfig };
