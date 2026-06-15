/**
 * pd runtime probe command — Runtime health and capabilities inspection.
 *
 * Usage:
 *   pd runtime probe --runtime openclaw-cli [--openclaw-local|--openclaw-gateway] [--json]
 *   pd runtime probe --runtime pi-ai --provider <name> --model <id> --apiKeyEnv <name> [--baseUrl <url>] [--json]
 *
 * HG-01 HARD GATE: This command must deliver.
 */
import * as path from 'path';
import { probeRuntime } from '@principles/core/runtime-v2';
import { PDRuntimeError, isRuntimeConfigError } from '@principles/core/runtime-v2';
import { resolveRuntimeFromPdConfig, resolveRuntimeWithOverrides } from '../services/resolve-runtime-from-pd-config.js';

interface RuntimeProbeOptions {
  runtime: string;
  openclawLocal?: boolean;
  openclawGateway?: boolean;
  agent?: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
  workspace?: string;
  json?: boolean;
}

/**
 * Format capabilities as a key-value table for console output.
 */
function formatCapabilitiesTable(capabilities: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(capabilities)) {
    const displayValue = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
    lines.push(`  ${key.padEnd(40)} ${displayValue}`);
  }
  return lines.join('\n');
}

/**
 * openclaw-cli probe branch (existing behavior, unchanged).
 */
async function handleOpenClawProbe(opts: RuntimeProbeOptions): Promise<void> {
  // Validate mutually exclusive flags (HG-03)
  if (opts.openclawLocal && opts.openclawGateway) {
    console.error('error: --openclaw-local and --openclaw-gateway are mutually exclusive');
    process.exit(1);
  }

  // Require explicit runtime mode (HG-03, DPB-09)
  if (!opts.openclawLocal && !opts.openclawGateway) {
    console.error('error: --openclaw-local or --openclaw-gateway is required for --runtime openclaw-cli');
    process.exit(1);
  }

  const runtimeMode = opts.openclawLocal ? 'local' : 'gateway';

  try {
    const result = await probeRuntime({
      runtimeKind: 'openclaw-cli',
      runtimeMode,
      agentId: opts.agent,
    });

    // Per finding #2: status must reflect actual health
    // healthy=false → status=failed, exit 1
    // healthy=true + degraded=true → status=degraded
    // healthy=true + degraded=false → status=succeeded
    let exitCode = 0;
    const status = !result.health.healthy ? 'failed'
      : result.health.degraded ? 'degraded'
      : 'succeeded';
    if (!result.health.healthy) exitCode = 1;

    if (opts.json) {
      console.log(JSON.stringify({
        status,
        runtimeKind: result.runtimeKind,
        health: result.health,
        capabilities: result.capabilities,
      }, null, 2));
      if (exitCode !== 0) {
        process.exit(exitCode);
      }
      return;
    }

    // Human-readable output
    console.log(`\nRuntime: ${result.runtimeKind}`);
    console.log(`Mode:    ${runtimeMode}`);
    console.log(`Status:  ${status}`);
    console.log('');
    console.log('Health:');
    console.log(`  healthy:       ${result.health.healthy ? 'yes' : 'no'}`);
    console.log(`  degraded:      ${result.health.degraded ? 'yes' : 'no'}`);
    if (result.health.warnings.length > 0) {
      console.log(`  warnings:`);
      for (const w of result.health.warnings) {
        console.log(`    - ${w}`);
      }
    }
    console.log(`  lastCheckedAt: ${result.health.lastCheckedAt}`);
    console.log('');
    console.log('Capabilities:');
    console.log(formatCapabilitiesTable(result.capabilities));
    console.log('');

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    let errorCategory = 'execution_failed';
    if (error instanceof PDRuntimeError) {
      errorCategory = error.category;
    }
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'failed',
        errorCategory,
        message,
        runtimeKind: 'openclaw-cli',
      }, null, 2));
    } else {
      console.error(`error: ${message} (${errorCategory})`);
    }
    process.exit(1);
  }
}

/**
 * pi-ai probe branch — validates flags, calls probeRuntime, formats output.
 *
 * PRI-402: When --workspace is provided without explicit --provider,
 * reads pi-ai config from .pd/config.yaml via resolveRuntimeWithOverrides.
 * JSON output includes configSource, runtimeProfileId, runtimeProfileLabel
 * for alignment with `pd config doctor`.
 */
async function handlePiAiProbe(opts: RuntimeProbeOptions): Promise<void> {
  // D-01: flags are required for pi-ai probe unless --workspace is provided (policy fallback)
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : undefined;
  let provider = opts.provider ?? '';
  let model = opts.model ?? '';
  let apiKeyEnv = opts.apiKeyEnv ?? '';
  let baseUrl = opts.baseUrl ?? '';
  let { timeoutMs, maxRetries } = opts;

  // PRI-402: Track config source and profile info for JSON output
  let configSource: string | null = null;
  let runtimeProfileId: string | null = null;
  let runtimeProfileLabel: string | null = null;

  // PRI-393: always load workspace policy from .pd/config.yaml (not .state/workflows.yaml)
  if (workspaceDir) {
    const resolved = resolveRuntimeWithOverrides(workspaceDir, {
      provider: opts.provider,
      model: opts.model,
      apiKeyEnv: opts.apiKeyEnv,
      baseUrl: opts.baseUrl,
      maxRetries: opts.maxRetries,
      timeoutMs: opts.timeoutMs,
    });
    for (const w of resolved.legacyWarnings) console.warn(`Warning: ${w}`);

    // PRI-402: capture profile info regardless of merge result
    ({ configSource, runtimeProfileId, runtimeProfileLabel } = resolved);

    if (resolved.mergedConfig) {
      provider = provider || resolved.mergedConfig.provider || '';
      model = model || resolved.mergedConfig.model || '';
      apiKeyEnv = apiKeyEnv || resolved.mergedConfig.apiKeyEnv || '';
      baseUrl = baseUrl || resolved.mergedConfig.baseUrl || '';
      timeoutMs = timeoutMs ?? resolved.mergedConfig.timeoutMs;
      maxRetries = maxRetries ?? resolved.mergedConfig.maxRetries;
    } else if (isRuntimeConfigError(resolved.result)) {
      // PRI-402: fail-loud JSON when config.yaml is broken (EP-03, EP-04)
      if (opts.json) {
        console.log(JSON.stringify({
          ok: false,
          status: 'failed',
          reason: resolved.result.reason,
          message: resolved.result.message,
          nextAction: resolved.result.nextAction,
          configSource: resolved.configSource,
        }, null, 2));
      } else {
        console.error(`error: could not resolve runtime from .pd/config.yaml — ${resolved.result.message}`);
        console.error(`nextAction: ${resolved.result.nextAction}`);
      }
      process.exit(1);
      return;
    }
  }

  if (!provider) {
    // PRI-402: fail-loud JSON when provider is missing (EP-03, EP-04)
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'failed',
        reason: 'provider_missing',
        message: '--provider is required for --runtime pi-ai (or set in .pd/config.yaml)',
        nextAction: 'Set provider in .pd/config.yaml runtimeProfiles, or pass --provider explicitly',
        configSource,
      }, null, 2));
    } else {
      console.error("error: --provider is required for --runtime pi-ai (or set in .pd/config.yaml)");
      console.error("  e.g.: pd runtime probe --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY");
    }
    process.exit(1);
    return;
  }
  if (!model) {
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'failed',
        reason: 'model_missing',
        message: '--model is required for --runtime pi-ai (or set in .pd/config.yaml)',
        nextAction: 'Set model in .pd/config.yaml runtimeProfiles, or pass --model explicitly',
        configSource,
      }, null, 2));
    } else {
      console.error("error: --model is required for --runtime pi-ai (or set in .pd/config.yaml)");
      console.error("  e.g.: pd runtime probe --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY");
    }
    process.exit(1);
    return;
  }
  if (!apiKeyEnv) {
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'failed',
        reason: 'apiKeyEnv_missing',
        message: '--apiKeyEnv is required for --runtime pi-ai (or set in .pd/config.yaml)',
        nextAction: 'Set apiKeyEnv in .pd/config.yaml runtimeProfiles, or pass --apiKeyEnv explicitly',
        configSource,
      }, null, 2));
    } else {
      console.error("error: --apiKeyEnv is required for --runtime pi-ai (or set in .pd/config.yaml)");
      console.error("  e.g.: pd runtime probe --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY");
    }
    process.exit(1);
    return;
  }

  // D-09: check env var exists before calling probeRuntime
  if (!process.env[apiKeyEnv]) {
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'failed',
        reason: 'api_key_not_set',
        message: `Environment variable '${apiKeyEnv}' is not set`,
        nextAction: `Set the environment variable '${apiKeyEnv}' with a valid API key`,
        configSource,
      }, null, 2));
    } else {
      console.error(`error: environment variable '${apiKeyEnv}' is not set`);
    }
    process.exit(1);
    return;
  }

  try {
    const result = await probeRuntime({
      runtimeKind: 'pi-ai',
      provider,
      model,
      apiKeyEnv,
      baseUrl,
      maxRetries: maxRetries,
      timeoutMs: timeoutMs ?? 120_000, // D-04: probe timeout 120s (matches Runtime defaults)
    });

    // Narrow to pi-ai result (TypeScript can't infer from input args alone)
    if (result.runtimeKind !== 'pi-ai') {
      throw new Error('unexpected: probeRuntime returned non-pi-ai result');
    }

    // Determine status from health
    let exitCode = 0;
    const status = !result.health.healthy ? 'failed'
      : result.health.degraded ? 'degraded'
      : 'succeeded';
    if (!result.health.healthy) exitCode = 1;

    if (opts.json) {
      // PRI-402: include configSource, runtimeProfileId, runtimeProfileLabel in JSON output
      const jsonOutput: Record<string, unknown> = {
        ok: result.health.healthy,
        status,
        runtimeKind: result.runtimeKind,
        provider: result.provider,
        model: result.model,
        baseUrlPresent: !!baseUrl,
        health: result.health,
        capabilities: result.capabilities,
      };
      if (configSource) jsonOutput.configSource = configSource;
      if (runtimeProfileId) jsonOutput.runtimeProfileId = runtimeProfileId;
      if (runtimeProfileLabel) jsonOutput.runtimeProfileLabel = runtimeProfileLabel;
      console.log(JSON.stringify(jsonOutput, null, 2));
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }

    // D-05: human-readable output
    console.log(`\nRuntime: ${result.runtimeKind}`);
    console.log(`Provider: ${result.provider}`);
    console.log(`Model:    ${result.model}`);
    if (baseUrl) console.log(`BaseUrl:  ${baseUrl}`);
    if (runtimeProfileLabel) console.log(`Profile:  ${runtimeProfileLabel}`);
    if (configSource) console.log(`Config:   ${configSource}`);
    console.log(`Status:   ${status}`);
    console.log('');
    console.log('Health:');
    console.log(`  healthy:       ${result.health.healthy ? 'yes' : 'no'}`);
    console.log(`  degraded:      ${result.health.degraded ? 'yes' : 'no'}`);
    if (result.health.warnings.length > 0) {
      console.log('  warnings:');
      for (const w of result.health.warnings) {
        console.log(`    - ${w}`);
      }
    }
    console.log(`  lastCheckedAt: ${result.health.lastCheckedAt}`);
    console.log('');
    console.log('Capabilities:');
    console.log(formatCapabilitiesTable(result.capabilities));
    console.log('');

    if (exitCode !== 0) process.exit(exitCode);
  } catch (error: unknown) {
    // D-10: test complete failure → error category + raw error
    const message = error instanceof Error ? error.message : String(error);
    let errorCategory = 'execution_failed';
    if (error instanceof PDRuntimeError) {
      errorCategory = error.category;
    }
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'failed',
        errorCategory,
        message,
        runtimeKind: 'pi-ai',
        configSource,
      }, null, 2));
    } else {
      console.error(`error: ${message} (${errorCategory})`);
    }
    process.exit(1);
  }
}

/**
 * --runtime config probe branch — PRI-393
 * Resolves runtime from .pd/config.yaml, then dispatches to pi-ai or openclaw-cli probe.
 */
async function handleConfigProbe(opts: RuntimeProbeOptions): Promise<void> {
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : undefined;
  if (!workspaceDir) {
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'failed',
        reason: 'workspace_missing',
        message: '--workspace is required for --runtime config',
        nextAction: 'Provide --workspace <path> pointing to a PD workspace directory',
      }, null, 2));
    } else {
      console.error('error: --workspace is required for --runtime config');
    }
    process.exit(1);
    return;
  }

  const resolved = resolveRuntimeFromPdConfig(workspaceDir);
  for (const w of resolved.legacyWarnings) console.warn(`Warning: ${w}`);

  if (isRuntimeConfigError(resolved.result)) {
    if (opts.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'failed',
        errorCategory: 'config_error',
        message: resolved.result.message,
        reason: resolved.result.reason,
        nextAction: resolved.result.nextAction,
        configSource: resolved.configSource,
      }, null, 2));
    } else {
      console.error(`error: ${resolved.result.message}`);
      console.error(`nextAction: ${resolved.result.nextAction}`);
    }
    process.exit(1);
    return;
  }

  const config = resolved.result;
  // Dispatch to the appropriate runtime probe
  if (config.runtimeKind === 'pi-ai') {
    return handlePiAiProbe({
      ...opts,
      provider: opts.provider ?? config.provider,
      model: opts.model ?? config.model,
      apiKeyEnv: opts.apiKeyEnv ?? config.apiKeyEnv,
      baseUrl: opts.baseUrl ?? config.baseUrl,
      timeoutMs: opts.timeoutMs ?? config.timeoutMs,
    });
  }

  if (config.runtimeKind === 'openclaw-cli') {
    return handleOpenClawProbe({
      ...opts,
      openclawLocal: config.openclawMode === 'local' ? true : opts.openclawLocal,
      openclawGateway: config.openclawMode === 'gateway' ? true : opts.openclawGateway,
    });
  }

  console.error(`error: unsupported runtimeKind '${config.runtimeKind}' from .pd/config.yaml`);
  process.exit(1);
  return;
}

/**
 * pd runtime probe — dispatches to openclaw-cli, pi-ai, or config branch.
 */
export async function handleRuntimeProbe(opts: RuntimeProbeOptions): Promise<void> {
  if (opts.runtime === 'openclaw-cli') {
    return handleOpenClawProbe(opts);
  }

  if (opts.runtime === 'pi-ai') {
    return handlePiAiProbe(opts);
  }

  if (opts.runtime === 'config') {
    return handleConfigProbe(opts);
  }

  console.error(`error: unsupported --runtime '${opts.runtime}' (supported: openclaw-cli, pi-ai, config)`);
  process.exit(1);
  return;
}
