/**
 * PRI-982 (SPEC-PD-IAER-001 FR-02/FR-03, EP-02 production-path wiring) — the
 * OpenClaw auto-consumer service must inject the `behaviorEvidence` port into
 * the shared consumer cycle, wrapping the production
 * `BehaviorExamplePackAssembler` with the SAME construction parameters as the
 * run-rulehost CLI (FR-07: one assembly contract for both entry points).
 *
 * The cycle itself is mocked at the boundary (the host-runtime suite drives
 * it end to end); this test pins the PLUGIN-side wiring: the port exists, is
 * lazy (no trajectory DB is opened until assemble is called), and reaches the
 * real assembler (fail-loud pain-not-found on an empty workspace).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runConsumerCycle } from '../../src/service/internalization-auto-consumer-service.js';
import { loadFeatureFlagFromConfig } from '../../src/core/pd-config-loader.js';
import { runInternalizationConsumerCycle, type InternalizationConsumerCyclePorts } from '@principles/host-runtime';
import { RuleHostEvidenceRegistry } from 'principles-disciple/rulehost-evidence';
import type { PluginLogger } from '../../src/openclaw-sdk.js';

vi.mock('../../src/core/pd-config-loader.js');
vi.mock('../../src/core/system-logger.js');

// Spread-mock host-runtime (ERR-115: full-module replacement breaks on new
// exports) — the cycle fn becomes a plain capture mock for this test only.
vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  return {
    ...actual,
    runInternalizationConsumerCycle: vi.fn(),
  };
});

describe('runConsumerCycle behaviorEvidence wiring (PRI-982)', () => {
  let workspaceDir: string;

  afterEach(() => {
    if (workspaceDir) {
      RuleHostEvidenceRegistry.dispose(workspaceDir);
    }
    vi.restoreAllMocks();
  });

  it('injects a lazy behaviorEvidence port that reaches the production assembler', async () => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evidence-port-'));
    fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify({
      version: 1,
      features: { internalization_auto_consumer: { category: 'quiet', enabled: true } },
    }));

    let capturedPorts: InternalizationConsumerCyclePorts | undefined;
    const mocked = runInternalizationConsumerCycle as unknown as ReturnType<typeof vi.fn>;
    mocked.mockImplementationOnce(async (_dir: string, ports: InternalizationConsumerCyclePorts) => {
      capturedPorts = ports;
      return { ran: false, skipReason: 'wiring-capture' };
    });
    vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'test', flagId: 'internalization_auto_consumer' } as never);

    const logger: PluginLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await runConsumerCycle(workspaceDir, logger);

    expect(capturedPorts).toBeDefined();
    expect(capturedPorts?.behaviorEvidence).toBeDefined();

    // Lazy: assembling against an empty workspace reaches the REAL assembler
    // and fails loud with its pain-not-found contract (no silent stub).
    let thrown: unknown;
    try {
      capturedPorts?.behaviorEvidence?.assemble({
        sourcePainId: 'pain_does_not_exist',
        sourceNegativeToolCallId: 1,
        positiveToolCallIds: [2],
        ownerDesiredOutcome: 'block writes outside the workspace',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('pain event not found for canonical_pain_id="pain_does_not_exist"');
  });
});
