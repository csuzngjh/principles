/**
 * probeRuntime — ADR-0029 retired the 'openclaw-cli' backend, so pi-ai is the
 * only probeable runtime. These tests pin both halves of that contract:
 *
 * - a pi-ai probe builds PD's own adapter (no host CLI session) and reports an
 *   unset API key as unhealthy without any network I/O;
 * - any other runtime kind is rejected loud instead of silently probing pi-ai.
 */

import { describe, expect, it } from 'vitest';
import { probeRuntime } from '../cli/probe.js';
import type { ProbeOptions } from '../cli/probe.js';

const UNSET_KEY_ENV = 'PD_PROBE_TEST_UNSET_API_KEY';

describe('probeRuntime (ADR-0029: pi-ai is the only runtime)', () => {
  it('probes the pi-ai adapter and reports a missing API key as unhealthy without network I/O', async () => {
    expect(process.env[UNSET_KEY_ENV], `${UNSET_KEY_ENV} must stay unset for this test`).toBeUndefined();

    const result = await probeRuntime({
      runtimeKind: 'pi-ai',
      provider: 'openai',
      model: 'some-model',
      apiKeyEnv: UNSET_KEY_ENV,
    });

    expect(result.runtimeKind).toBe('pi-ai');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('some-model');
    expect(result.health.healthy).toBe(false);
    expect(result.health.warnings.join(' ')).toContain(UNSET_KEY_ENV);
    expect(typeof result.capabilities.supportsStreaming).toBe('boolean');
  });

  it('rejects a retired runtime kind instead of silently probing pi-ai', async () => {
    // Simulates an untyped JS caller; the runtime guard must fail loud.
    const untrusted = { runtimeKind: 'openclaw-cli' } as unknown as ProbeOptions;
    await expect(probeRuntime(untrusted)).rejects.toThrow(/Unsupported runtime kind: openclaw-cli/);
  });
});
