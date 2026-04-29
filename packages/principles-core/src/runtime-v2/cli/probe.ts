/**
 * probeRuntime — Library function for probing a runtime's health and capabilities.
 *
 * Can be called from CLI or other code.
 *
 * Discriminated union on runtimeKind:
 *   'openclaw-cli' — uses OpenClawCliRuntimeAdapter
 *   'pi-ai'       — uses PiAiRuntimeAdapter (requires provider/model/apiKeyEnv/baseUrl)
 *
 * @throws Error if runtimeKind is unsupported
 * @throws PDRuntimeError if probe fails
 */
import { OpenClawCliRuntimeAdapter } from '../adapter/openclaw-cli-runtime-adapter.js';
import { PiAiRuntimeAdapter } from '../adapter/pi-ai-runtime-adapter.js';
import type { RuntimeHealth, RuntimeCapabilities } from '../runtime-protocol.js';

export type ProbeOptions =
  | {
      runtimeKind: 'openclaw-cli';
      /** 'local' or 'gateway' — required, no silent fallback (HG-03, DPB-09) */
      runtimeMode: 'local' | 'gateway';
      workspaceDir?: string;
      /** Agent ID to verify availability (default: 'diagnostician') */
      agentId?: string;
    }
  | {
      runtimeKind: 'pi-ai';
      provider: string;
      model: string;
      apiKeyEnv: string;
      /** Custom base URL for OpenAI-compatible providers not in pi-ai's built-in registry. */
      baseUrl?: string;
      maxRetries?: number;
      timeoutMs?: number;
    };

export type ProbeResult =
  | {
      runtimeKind: 'openclaw-cli';
      health: RuntimeHealth;
      capabilities: RuntimeCapabilities;
    }
  | {
      runtimeKind: 'pi-ai';
      health: RuntimeHealth;
      capabilities: RuntimeCapabilities;
      provider: string;
      model: string;
    };

export async function probeRuntime(options: ProbeOptions): Promise<ProbeResult> {
  if (options.runtimeKind === 'openclaw-cli') {
    // HG-03 (HARD GATE): runtimeMode is always explicitly provided by CLI layer.
    // probeRuntime itself requires runtimeMode to be set (no silent fallback).
    // P1 #3 fix: Pass agentId so healthCheck can verify the specific agent is available.
    const adapter = new OpenClawCliRuntimeAdapter({
      runtimeMode: options.runtimeMode,
      workspaceDir: options.workspaceDir,
      agentId: options.agentId,
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

  if (options.runtimeKind === 'pi-ai') {
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

  throw new Error(`Unsupported runtime kind: ${(options as { runtimeKind: string }).runtimeKind}`);
}
