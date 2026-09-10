/**
 * PRI-719 — per-agent runtime profile binding in the REAL consumer cycle
 * (EP002-R2 F4 regression).
 *
 * Drives the REAL `runInternalizationConsumerCycle` (the shared executor for
 * OpenClaw's auto-consumer and the Codex workspace worker) against a real
 * workspace (.pd/config.yaml + state.db). Only the LLM boundary is doubled
 * (ScribeRunner.run / ArtificerRunner.run), so the assertions prove the
 * production composition: the adapter the cycle constructs for a leased task
 * comes from THAT stage's `internalAgents.agents[kind].runtimeProfile`, not
 * from the shared diagnostician binding.
 *
 * F4 incident shape (lab 2026-09-09): scribe/artificer declared bai profiles
 * but the consumer resolved the runtime config ONCE per cycle (diagnostician
 * binding) and shared one adapter across all task kinds — every per-agent
 * profile declaration was silently ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  ScribeRunner,
  ArtificerRunner,
  getDefaultPdConfig,
  type RuntimeStateManager,
} from '@principles/core/runtime-v2';
import { runInternalizationConsumerCycle } from '../src/internalization-consumer-cycle.js';

const dirs: string[] = [];

interface CapturedAdapterConfig {
  provider?: string;
  model?: string;
}

function readAdapterConfig(runner: unknown): CapturedAdapterConfig {
  const adapter = (runner as { runtimeAdapter?: { kind(): string } }).runtimeAdapter;
  if (!adapter) throw new Error('runner has no runtimeAdapter');
  // PiAiRuntimeAdapter keeps its config private; read through the structural
  // cast for the two fields under assertion.
  return (adapter as unknown as { config: CapturedAdapterConfig }).config;
}

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cycle-profile-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig();
  config.features.internalization_auto_consumer.enabled = true;
  config.features.internalization_full_chain.enabled = true;
  (config.runtimeProfiles as Record<string, unknown>) = {
    ...(config.runtimeProfiles as Record<string, unknown>),
    'pi-ai.base': {
      type: 'pi-ai', provider: 'base-prov', model: 'base-model', apiKeyEnv: 'BASE_KEY',
    },
    'pi-ai.scribeA': {
      type: 'pi-ai', provider: 'prov-scribe', model: 'scribe-model', apiKeyEnv: 'SCRIBE_KEY',
    },
    'pi-ai.artificerB': {
      type: 'pi-ai', provider: 'prov-artificer', model: 'artificer-model', apiKeyEnv: 'ARTIFICER_KEY',
    },
  };
  (config.internalAgents as { defaultRuntime: string }).defaultRuntime = 'pi-ai.base';
  const agents = config.internalAgents.agents as Record<string, { enabled: boolean; runtimeProfile?: string }>;
  agents.diagnostician.enabled = true;
  agents.scribe.enabled = true;
  agents.scribe.runtimeProfile = 'pi-ai.scribeA';
  agents.artificer.enabled = true;
  agents.artificer.runtimeProfile = 'pi-ai.artificerB';
  // JSON is valid YAML — same trick the sibling cycle tests use.
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

/** Stable-id chain (orchestrator successor convention): root `corr-001`. */
async function seedTasks(workspaceDir: string): Promise<void> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    const mk = (taskId: string, taskKind: string, status: string, deps: string[]) =>
      stateManager.createTask({
        taskId, taskKind, status, attemptCount: status === 'succeeded' ? 1 : 0, maxAttempts: 3,
        ...(status === 'succeeded' ? { resultRef: `${taskKind}://seed` } : {}),
        diagnosticJson: createPITaskDiagnosticJson({
          dependencyTaskIds: deps,
          channel: 'prompt',
          timeoutMs: 300_000,
          inputArtifactRefs: [],
          outputArtifactRefs: [],
          correlationId: 'corr-001',
        }),
      });
    await mk('philosopher-corr-001-prompt', 'philosopher', 'succeeded', []);
    await mk('scribe-corr-001-prompt', 'scribe', 'pending', ['philosopher-corr-001-prompt']);
    await mk('artificer-corr-001-prompt', 'artificer', 'pending', ['scribe-corr-001-prompt']);
  } finally {
    await handle.close();
  }
}

describe('runInternalizationConsumerCycle — PRI-719 per-agent runtime profile', () => {
  beforeEach(() => {
    process.env.BASE_KEY = 'test-key';
    process.env.SCRIBE_KEY = 'test-key';
    process.env.ARTIFICER_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.BASE_KEY;
    delete process.env.SCRIBE_KEY;
    delete process.env.ARTIFICER_KEY;
    for (const dir of dirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }
    vi.restoreAllMocks();
  });

  it('two stages with different declared profiles execute on their OWN provider/model', async () => {
    const workspace = makeWorkspace();
    await seedTasks(workspace);

    const captured: Record<string, CapturedAdapterConfig> = {};
    vi.spyOn(ScribeRunner.prototype, 'run').mockImplementation(async function (this: ScribeRunner, taskId: string) {
      captured.scribe = readAdapterConfig(this);
      const sm = (this as unknown as { stateManager: RuntimeStateManager }).stateManager;
      await sm.markTaskSucceeded(taskId, 'scribe://test-run');
      return { status: 'succeeded', taskId, attemptCount: 1 } as never;
    });
    vi.spyOn(ArtificerRunner.prototype, 'run').mockImplementation(async function (this: ArtificerRunner, taskId: string) {
      captured.artificer = readAdapterConfig(this);
      const sm = (this as unknown as { stateManager: RuntimeStateManager }).stateManager;
      await sm.markTaskSucceeded(taskId, 'artificer://test-run');
      return { status: 'succeeded', taskId, attemptCount: 1 } as never;
    });

    const events: Array<{ event: string; payload: string }> = [];
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

    const cycle1 = await runInternalizationConsumerCycle(workspace, {
      owner: 'test', logLabel: 'T', logger, emitEvent: (e, p) => events.push({ event: e, payload: p }),
    });
    expect(cycle1.ran).toBe(true);
    expect(cycle1.taskKind).toBe('scribe');

    const cycle2 = await runInternalizationConsumerCycle(workspace, {
      owner: 'test', logLabel: 'T', logger, emitEvent: (e, p) => events.push({ event: e, payload: p }),
    });
    expect(cycle2.ran).toBe(true);
    expect(cycle2.taskKind).toBe('artificer');

    // The declared binding actually executed (EP002-R2 F4: both used to run
    // on the diagnostician/base binding).
    expect(captured.scribe?.provider).toBe('prov-scribe');
    expect(captured.scribe?.model).toBe('scribe-model');
    expect(captured.artificer?.provider).toBe('prov-artificer');
    expect(captured.artificer?.model).toBe('artificer-model');

    // Run evidence: the CONSUMER_RUN events answer profile/provider/model.
    const runEvents = events.filter((e) => e.event === 'INTERNALIZATION_CONSUMER_RUN');
    const scribeRun = runEvents.find((e) => e.payload.includes('"taskKind":"scribe"'));
    const artificerRun = runEvents.find((e) => e.payload.includes('"taskKind":"artificer"'));
    expect(scribeRun?.payload).toContain('"runtimeProfileId":"pi-ai.scribeA"');
    expect(artificerRun?.payload).toContain('"runtimeProfileId":"pi-ai.artificerB"');
  });

  it('a stage whose profile is unready is skipped observably; other stages still run', async () => {
    const workspace = makeWorkspace();
    await seedTasks(workspace);
    // Break ONLY the scribe binding (key missing).
    delete process.env.SCRIBE_KEY;

    const captured: Record<string, CapturedAdapterConfig> = {};
    vi.spyOn(ArtificerRunner.prototype, 'run').mockImplementation(async function (this: ArtificerRunner, taskId: string) {
      captured.artificer = readAdapterConfig(this);
      const sm = (this as unknown as { stateManager: RuntimeStateManager }).stateManager;
      await sm.markTaskSucceeded(taskId, 'artificer://test-run');
      return { status: 'succeeded', taskId, attemptCount: 1 } as never;
    });

    const events: Array<{ event: string; payload: string }> = [];
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

    const cycle1 = await runInternalizationConsumerCycle(workspace, {
      owner: 'test', logLabel: 'T', logger, emitEvent: (e, p) => events.push({ event: e, payload: p }),
    });
    // scribe is skipped (unready), no other kind has a ready task → no lease.
    expect(cycle1.ran).toBe(false);
    const skip = events.find((e) => e.event === 'INTERNALIZATION_CONSUMER_SKIP' && e.payload.includes('"taskKind":"scribe"'));
    expect(skip).toBeDefined();
    expect(skip?.payload).toContain('SCRIBE_KEY');

    // After the scribe task is satisfied out-of-band, the artificer runs on
    // its own (unaffected) profile.
    const handle = await createRuntimeStateHandle({ workspaceDir: workspace, readonly: false });
    try {
      await handle.stateManager.updateTask('scribe-corr-001-prompt', { status: 'succeeded' });
    } finally {
      await handle.close();
    }
    const cycle2 = await runInternalizationConsumerCycle(workspace, {
      owner: 'test', logLabel: 'T', logger, emitEvent: (e, p) => events.push({ event: e, payload: p }),
    });
    expect(cycle2.ran).toBe(true);
    expect(cycle2.taskKind).toBe('artificer');
    expect(captured.artificer?.provider).toBe('prov-artificer');
  });
});
