/**
 * probeRuntime — Library function for probing a runtime's health and capabilities.
 *
 * Can be called from CLI or other code.
 *
 * @param options.runtimeKind - Runtime kind to probe (only 'openclaw-cli' supported for now)
 * @param options.runtimeMode - 'local' or 'gateway' (required for openclaw-cli)
 * @param options.workspaceDir - PD workspace directory (optional, passed to adapter)
 * @returns { health: RuntimeHealth, capabilities: RuntimeCapabilities }
 *
 * @throws Error if runtimeKind is unsupported
 */
import { OpenClawCliRuntimeAdapter } from '../adapter/openclaw-cli-runtime-adapter.js';
import type { RuntimeHealth, RuntimeCapabilities } from '../runtime-protocol.js';

export interface ProbeOptions {
  runtimeKind: 'openclaw-cli';
  runtimeMode?: 'local' | 'gateway';
  workspaceDir?: string;
}

export interface ProbeResult {
  runtimeKind: 'openclaw-cli';
  health: RuntimeHealth;
  capabilities: RuntimeCapabilities;
}

export async function probeRuntime(options: ProbeOptions): Promise<ProbeResult> {
  if (options.runtimeKind !== 'openclaw-cli') {
    throw new Error(`probeRuntime only supports 'openclaw-cli' runtime kind (got '${options.runtimeKind}')`);
  }

  // runtimeMode is required by CLI layer before calling probeRuntime
  // Here we accept undefined and default to 'local' for safety
  const adapter = new OpenClawCliRuntimeAdapter({
    runtimeMode: options.runtimeMode ?? 'local',
    workspaceDir: options.workspaceDir,
  });

  const [health, capabilities] = await Promise.all([
    adapter.healthCheck(),
    adapter.getCapabilities(),
  ]);

  return {
    runtimeKind: 'openclaw-cli',
    health,
    capabilities,
  };
}
