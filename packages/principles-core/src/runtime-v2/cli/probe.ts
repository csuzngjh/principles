/**
 * probeRuntime — Library function for probing a runtime's health and capabilities.
 *
 * Can be called from CLI or other code.
 *
 * ADR-0029 retired the 'openclaw-cli' backend, so pi-ai is the only probeable
 * runtime: the probe no longer depends on a host CLI agent session being
 * reachable — it exercises PD's own LLM call path (healthCheck + capabilities).
 *
 * @throws Error if runtimeKind is unsupported
 * @throws PDRuntimeError if probe fails
 */
import { PiAiRuntimeAdapter } from '../adapter/pi-ai-runtime-adapter.js';
import type { RuntimeHealth, RuntimeCapabilities } from '../runtime-protocol.js';

export interface ProbeOptions {
  runtimeKind: 'pi-ai';
  provider: string;
  model: string;
  apiKeyEnv: string;
  /** Custom base URL for OpenAI-compatible providers not in pi-ai's built-in registry. */
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface ProbeResult {
  runtimeKind: 'pi-ai';
  health: RuntimeHealth;
  capabilities: RuntimeCapabilities;
  provider: string;
  model: string;
}

export async function probeRuntime(options: ProbeOptions): Promise<ProbeResult> {
  if (options.runtimeKind !== 'pi-ai') {
    throw new Error(`Unsupported runtime kind: ${(options as { runtimeKind: string }).runtimeKind}`);
  }

  const adapter = new PiAiRuntimeAdapter({
    provider: options.provider,
    model: options.model,
    apiKeyEnv: options.apiKeyEnv,
    baseUrl: options.baseUrl,
    maxRetries: options.maxRetries,
    timeoutMs: options.timeoutMs,
  });

  const [health, capabilities] = await Promise.all([
    adapter.healthCheck(),
    adapter.getCapabilities(),
  ]);

  return {
    runtimeKind: 'pi-ai',
    health,
    capabilities,
    provider: options.provider,
    model: options.model,
  };
}
