/**
 * PRI-714 (review fix #3): production language wiring proof for the SHARED
 * internalization consumer cycle.
 *
 * The PR's original fault class was "the parameter exists but is not wired" —
 * builder-only tests still pass after deleting the production pass-through.
 * This regression drives the REAL `runInternalizationConsumerCycle` (the one
 * shared executor used by OpenClaw's auto-consumer and the Codex worker)
 * against real workspaces with real `.pd/config.yaml`, and asserts the
 * LANGUAGE DIRECTIVE on the ACTUAL message handed to
 * `adapter.startRun` — the LLM boundary itself:
 *
 *   - explicit `principles.outputLanguage: 'en'` in the workspace config
 *     overrides the zh-CN default (English directive on the wire);
 *   - a config without `principles.outputLanguage` resolves the zh-CN
 *     default (Simplified-Chinese directive on the wire).
 *
 * Only the LLM boundary is doubled (PiAiRuntimeAdapter prototype), and the
 * double returns a valid DreamerOutput so the full dreamer stage (validator,
 * artifact persistence) runs through real production components.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  getDefaultPdConfig,
  PiAiRuntimeAdapter,
  type StartRunInput,
} from '@principles/core/runtime-v2';
import { runInternalizationConsumerCycle } from '../src/internalization-consumer-cycle.js';

const dirs: string[] = [];

function makeWorkspace(outputLanguage?: 'en'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cycle-lang-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  const config = getDefaultPdConfig() as Record<string, unknown> & {
    features: Record<string, { enabled: boolean }>;
    internalAgents: { defaultRuntime: string; agents: Record<string, { enabled: boolean; runtimeProfile?: string }> };
    runtimeProfiles: Record<string, unknown>;
    principles?: { outputLanguage?: string };
  };
  config.features.internalization_auto_consumer.enabled = true;
  config.features.internalization_full_chain.enabled = true;
  config.internalAgents.agents.dreamer.enabled = true;
  config.internalAgents.agents.diagnostician.enabled = true;
  config.runtimeProfiles['pi-ai.llamacpp'] = {
    type: 'pi-ai',
    provider: 'llamacpp',
    model: 'qwen3.8-27b-llamacpp',
    apiKeyEnv: 'LLAMACPP_API_KEY',
    baseUrl: 'http://127.0.0.1:8080/v1',
    timeoutMs: 300_000,
  };
  config.internalAgents.defaultRuntime = 'pi-ai.llamacpp';
  config.internalAgents.agents.diagnostician.runtimeProfile = 'pi-ai.llamacpp';
  // Workspace-level language: present in A, absent in B (default zh-CN).
  if (outputLanguage !== undefined) {
    config.principles = { outputLanguage };
  }
  // JSON is valid YAML — same trick the shared executor tests use.
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
  return root;
}

/** Seed a pending dreamer task through the REAL state manager. */
async function seedDreamerTask(workspaceDir: string): Promise<string> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const { stateManager } = handle;
    await stateManager.createTask({
      taskId: 'dreamer-lang-001',
      taskKind: 'dreamer',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: [],
        channel: 'prompt',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
      }),
    });
    return 'dreamer-lang-001';
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * LLM-boundary double: record every startRun inputPayload (the actual prompt
 * message), then satisfy the dreamer stage with a schema-valid DreamerOutput
 * so the real validator + artifact store complete the run.
 */
function spyDreamerBoundary(): string[] {
  const messages: string[] = [];
  const caps = {
    supportsStructuredJsonOutput: false,
    supportsToolUse: false,
    supportsWorkingDirectory: false,
    supportsModelSelection: false,
    supportsLongRunningSessions: false,
    supportsCancellation: false,
    supportsArtifactWriteBack: false,
    supportsConcurrentRuns: false,
    supportsStreaming: false,
  };
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'startRun').mockImplementation(async function (this: unknown, input: StartRunInput) {
    messages.push(typeof input.inputPayload === 'string' ? input.inputPayload : JSON.stringify(input.inputPayload));
    return { runId: `run-${input.taskRef.taskId}`, runtimeKind: 'pi-ai', startedAt: new Date().toISOString() };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'pollRun').mockImplementation(async (runId: string) => ({
    status: 'succeeded' as const, runId,
  }));
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'fetchOutput').mockImplementation(async (runId: string) => {
    const taskId = runId.replace(/^run-/, '');
    const message = messages.find((m) => m.includes(taskId)) ?? '';
    const parsed: unknown = message === '' ? {} : JSON.parse(message);
    const inputTaskId = (parsed !== null && typeof parsed === 'object' && Reflect.get(parsed, 'taskId') === taskId)
      ? taskId
      : 'dreamer-lang-001';
    return {
      runId,
      payload: {
        valid: true,
        taskId: inputTaskId,
        candidates: [{
          candidateIndex: 0,
          badDecision: 'recorded bad decision',
          betterDecision: 'recorded better decision',
          rationale: 'recorded rationale',
          confidence: 0.9,
          riskLevel: 'low' as const,
          strategicPerspective: 'safety',
        }],
        contextRefs: [],
        sourcePainId: 'pain-lang',
        generatedAt: new Date().toISOString(),
      },
    };
  });
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'cancelRun').mockImplementation(async () => undefined);
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'getCapabilities').mockImplementation(async () => caps);
  vi.spyOn(PiAiRuntimeAdapter.prototype, 'healthCheck').mockImplementation(async () => ({
    healthy: true, degraded: false, warnings: [], lastCheckedAt: new Date().toISOString(),
  }));
  return messages;
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.LLAMACPP_API_KEY = 'test-key';
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LLAMACPP_API_KEY;
  const { disposePainSignalBridgesForWorkspace } = await import('@principles/core/runtime-v2');
  for (const dir of dirs) {
    await disposePainSignalBridgesForWorkspace(dir).catch(() => undefined);
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const dir of dirs.splice(0)) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(150);
      }
    }
    if (lastError !== null) throw new Error(`cleanup failed on ${dir}: ${String(lastError).slice(0, 120)}`);
  }
});

describe('runInternalizationConsumerCycle — outputLanguage reaches adapter.startRun (PRI-714 review fix)', () => {
  it('explicit principles.outputLanguage=en overrides the zh-CN default on the startRun message', async () => {
    const workspace = makeWorkspace('en');
    await seedDreamerTask(workspace);
    const messages = spyDreamerBoundary();

    const outcome = await runInternalizationConsumerCycle(workspace, {
      owner: 'test', logLabel: 'Test', logger, emitEvent: () => undefined,
    });

    expect(outcome.ran).toBe(true);
    expect(outcome.taskKind).toBe('dreamer');
    expect(messages).toHaveLength(1);
    const message = messages[0] ?? '';
    expect(message).toContain('LANGUAGE DIRECTIVE');
    expect(message).toContain('English');
    expect(message).toContain('(candidates[].badDecision, candidates[].betterDecision, candidates[].rationale, candidates[].strategicPerspective)');
    expect(message).not.toContain('Simplified Chinese');
  }, 60_000);

  it('a config without principles.outputLanguage resolves the zh-CN default on the startRun message', async () => {
    const workspace = makeWorkspace();
    await seedDreamerTask(workspace);
    const messages = spyDreamerBoundary();

    const outcome = await runInternalizationConsumerCycle(workspace, {
      owner: 'test', logLabel: 'Test', logger, emitEvent: () => undefined,
    });

    expect(outcome.ran).toBe(true);
    expect(outcome.taskKind).toBe('dreamer');
    expect(messages).toHaveLength(1);
    const message = messages[0] ?? '';
    expect(message).toContain('LANGUAGE DIRECTIVE');
    expect(message).toContain('Simplified Chinese');
    expect(message).toContain('简体中文');
  }, 60_000);
});
