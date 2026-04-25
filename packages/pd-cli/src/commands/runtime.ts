/**
 * pd runtime probe command — Runtime health and capabilities inspection.
 *
 * Usage:
 *   pd runtime probe --runtime openclaw-cli [--openclaw-local|--openclaw-gateway] [--json]
 *
 * HG-01 HARD GATE: This command must deliver.
 */
import { probeRuntime } from '@principles/core/runtime-v2/index.js';
import { PDRuntimeError } from '@principles/core/runtime-v2/index.js';

interface RuntimeProbeOptions {
  runtime: string;
  openclawLocal?: boolean;
  openclawGateway?: boolean;
  agent?: string;
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
 * pd runtime probe --runtime openclaw-cli [--openclaw-local|--openclaw-gateway] [--json]
 */
export async function handleRuntimeProbe(opts: RuntimeProbeOptions): Promise<void> {
  // Validate runtime kind (HG-01: only openclaw-cli supported)
  if (opts.runtime !== 'openclaw-cli') {
    console.error(`error: 'probe' command only supports --runtime openclaw-cli (got '${opts.runtime}')`);
    process.exit(1);
  }

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

    if (opts.json) {
      console.log(JSON.stringify({
        status: 'succeeded',
        runtimeKind: result.runtimeKind,
        health: result.health,
        capabilities: result.capabilities,
      }, null, 2));
      return;
    }

    // Human-readable output
    console.log(`\nRuntime: ${result.runtimeKind}`);
    console.log(`Mode:    ${runtimeMode}`);
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
