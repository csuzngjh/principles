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
import { PDRuntimeError } from '@principles/core/runtime-v2';

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
    console.log(formatCapabilitiesTable(result.capabilities as Record<string, unknown>));
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
 */
async function handlePiAiProbe(opts: RuntimeProbeOptions): Promise<void> {
  // D-01: flags are required for pi-ai probe unless --workspace is provided (policy fallback)
  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : undefined;
  let provider = opts.provider ?? '';
  let model = opts.model ?? '';
  let apiKeyEnv = opts.apiKeyEnv ?? '';
  let baseUrl = opts.baseUrl ?? '';
  let {timeoutMs} = opts;

  // D-01: always load workspace policy; CLI values take priority as override
  if (workspaceDir) {
    try {
      const { resolveRuntimeConfig } = await import('@principles/core/runtime-v2');
      const config = resolveRuntimeConfig(path.join(workspaceDir, '.state'));
      provider = provider || config.provider || '';
      model = model || config.model || '';
      apiKeyEnv = apiKeyEnv || config.apiKeyEnv || '';
      baseUrl = baseUrl || config.baseUrl || '';
      timeoutMs = timeoutMs ?? config.timeoutMs;
    } catch (err) {
      console.warn(`Warning: could not load workspace runtime config — policy fallback disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!provider) {
    console.error("error: --provider is required for --runtime pi-ai (or set in --workspace workflows.yaml)");
    console.error("  e.g.: pd runtime probe --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY");
    process.exit(1);
  }
  if (!model) {
    console.error("error: --model is required for --runtime pi-ai (or set in --workspace workflows.yaml)");
    console.error("  e.g.: pd runtime probe --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY");
    process.exit(1);
  }
  if (!apiKeyEnv) {
    console.error("error: --apiKeyEnv is required for --runtime pi-ai (or set in --workspace workflows.yaml)");
    console.error("  e.g.: pd runtime probe --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY");
    process.exit(1);
  }

  // D-09: check env var exists before calling probeRuntime
  if (!process.env[apiKeyEnv]) {
    console.error(`error: environment variable '${apiKeyEnv}' is not set`);
    process.exit(1);
  }

  try {
    const result = await probeRuntime({
      runtimeKind: 'pi-ai',
      provider,
      model,
      apiKeyEnv,
      baseUrl,
      maxRetries: opts.maxRetries,
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
      console.log(JSON.stringify({
        status,
        runtimeKind: result.runtimeKind,
        provider: result.provider,
        model: result.model,
        baseUrlPresent: !!baseUrl,
        health: result.health,
        capabilities: result.capabilities,
      }, null, 2));
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }

    // D-05: human-readable output
    console.log(`\nRuntime: ${result.runtimeKind}`);
    console.log(`Provider: ${result.provider}`);
    console.log(`Model:    ${result.model}`);
    if (baseUrl) console.log(`BaseUrl:  ${baseUrl}`);
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
    console.log(formatCapabilitiesTable(result.capabilities as Record<string, unknown>));
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
        status: 'failed',
        errorCategory,
        message,
        runtimeKind: 'pi-ai',
      }, null, 2));
    } else {
      console.error(`error: ${message} (${errorCategory})`);
    }
    process.exit(1);
  }
}

/**
 * pd runtime probe — dispatches to openclaw-cli or pi-ai branch.
 */
export async function handleRuntimeProbe(opts: RuntimeProbeOptions): Promise<void> {
  if (opts.runtime === 'openclaw-cli') {
    return handleOpenClawProbe(opts);
  }

  if (opts.runtime === 'pi-ai') {
    return handlePiAiProbe(opts);
  }

  console.error(`error: unsupported --runtime '${opts.runtime}' (supported: openclaw-cli, pi-ai)`);
  process.exit(1);
}
