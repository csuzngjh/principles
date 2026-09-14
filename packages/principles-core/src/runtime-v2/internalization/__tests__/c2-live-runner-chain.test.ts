/**
 * C2-P0 Pinning Test: Live MVP Runner Chain (PRI-457)
 *
 * Asserts the actual successor task chain created in the real store matches
 * the documented live runner chain for each MVP activation channel.
 *
 * ERR Gate:
 *   - ERR-004 / ERR-008 / EP-07: successor task kinds are read from the real
 *     store after commitNextTaskProposal, not inferred from ALLOWED_EDGES.
 *   - EP-09: uses real InternalizationOrchestrator + RuntimeStateManager (SQLite),
 *     not a hand-written expected-edge list.
 *
 * This test is the regression guard for C2-P2 (de-surface Quiet runners).
 * If the live chain ever diverges from the documented MVP chain, CI fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson } from '../pitask-metadata.js';
import {
  buildDreamerTaskSeed,
  computeBridgeDecision,
  type IntakeToInternalizationBridgeInput,
} from '../intake-to-internalization-bridge.js';
import type { InternalizationChannel, PeerRunnerKind } from '../peer-runner-contracts.js';

// ── Test constants ───────────────────────────────────────────────────────────

const OWNER = 'test-c2-p0';
const RUNTIME_KIND = 'test-double';

/**
 * The expected live runner chain under default config, per channel.
 *
 * This is the ASSERTION target — the test verifies that the real store
 * contains these successor task kinds after each commitNextTaskProposal call.
 *
 * Source: docs/plans/2026-06-mvp-slimming-candidates-1-2/c2-live-runner-chain.md
 */
const EXPECTED_CHAIN: PeerRunnerKind[] = [
  'dreamer',
  'philosopher',
  'scribe',
  'artificer',
  'evaluator',
  'rollout_reviewer',
];

/**
 * PRI-720: the standard prompt-channel chain skips the RuleCode sub-chain —
 * artificer/evaluator tasks are never created; scribe's canonical successor
 * is rollout_reviewer (principle semantic mode).
 */
const EXPECTED_PROMPT_CHAIN: PeerRunnerKind[] = [
  'dreamer',
  'philosopher',
  'scribe',
  'rollout_reviewer',
];

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Options for seeding a dreamer task through the real intake bridge path. */
interface SeedDreamerOptions {
  candidateId: string;
  channel: InternalizationChannel;
  /** PRI-720: explicit full-chain topology override. */
  pipelineMode?: 'full_chain';
  sourceTaskId?: string;
}

/**
 * Seed a dreamer task through the real intake bridge path.
 *
 * Uses buildDreamerTaskSeed (the same function the production intake bridge
 * calls) to generate the diagnosticJson, then creates the task in the real
 * store. This is the real seeding path — not a hand-built task record.
 */
async function seedDreamerTask(
  stateManager: RuntimeStateManager,
  options: SeedDreamerOptions,
): Promise<string> {
  const { candidateId, channel, pipelineMode, sourceTaskId } = options;
  const bridgeInput: IntakeToInternalizationBridgeInput = {
    candidateId,
    recommendationKind: channel === 'code_tool_hook' ? 'rule' : 'principle',
    route: channel === 'code_tool_hook' ? 'rule-candidate' : 'principle-ledger',
    ready: true,
    pipelineMode,
    // PRI-720 C6: a code_tool_hook seed must carry complete mechanical trigger
    // evidence, otherwise the bridge demotes it to the prompt channel.
    ...(channel === 'code_tool_hook' ? { recommendation: { triggerPattern: 'edit .pd/**', action: 'block' } } : {}),
    sourceTaskId,
    sourceArtifactId: sourceTaskId ? `art-${sourceTaskId}` : undefined,
    sourceRunId: sourceTaskId ? `run-${sourceTaskId}` : undefined,
  };

  const seed = buildDreamerTaskSeed(bridgeInput);
  if ('decision' in seed) {
    // BridgeDecision has 4 variants; only not_internalizable/invalid_candidate carry reason.
    const reason = 'reason' in seed ? seed.reason : seed.decision;
    throw new Error(`Failed to seed dreamer task: ${reason}`);
  }

  await stateManager.createTask({
    taskId: seed.taskId,
    taskKind: seed.taskKind,
    status: seed.status,
    attemptCount: seed.attemptCount,
    maxAttempts: seed.maxAttempts,
    diagnosticJson: seed.diagnosticJson,
    inputRef: undefined,
    resultRef: undefined,
    lastError: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
  });

  return seed.taskId;
}

/**
 * Transition a task from pending → leased → succeeded.
 *
 * This simulates what the auto-consumer / CLI does when a runner completes
 * successfully. The orchestrator's commitNextTaskProposal requires the source
 * task to be in 'succeeded' status.
 */
async function simulateTaskSuccess(
  stateManager: RuntimeStateManager,
  taskId: string,
): Promise<void> {
  await stateManager.acquireLease({
    taskId,
    owner: OWNER,
    runtimeKind: RUNTIME_KIND,
  });
  await stateManager.markTaskSucceeded(taskId);
  // P0-3: 生产 runner 现在把 verdict durable 写进任务元数据 (succeeded 前置)。
  // evaluator/rollout 模拟必须同构,否则 commit 门正确地 fail-closed。
  const task = await stateManager.getTask(taskId);
  const piTask = task ? hydratePITaskRecord(task) : null;
  if (piTask && (piTask.taskKind === 'evaluator')) {
    await stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson({
      dependencyTaskIds: piTask.dependencyTaskIds,
      channel: piTask.channel,
      pipelineMode: piTask.pipelineMode,
      timeoutMs: piTask.timeoutMs,
      inputArtifactRefs: piTask.inputArtifactRefs,
      outputArtifactRefs: piTask.outputArtifactRefs,
      parentTaskId: piTask.parentTaskId,
      correlationId: piTask.correlationId,
      runnerDecision: 'approved',
    }));
  }
  if (piTask && piTask.taskKind === 'rollout_reviewer') {
    await stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson({
      dependencyTaskIds: piTask.dependencyTaskIds,
      channel: piTask.channel,
      pipelineMode: piTask.pipelineMode,
      timeoutMs: piTask.timeoutMs,
      inputArtifactRefs: piTask.inputArtifactRefs,
      outputArtifactRefs: piTask.outputArtifactRefs,
      parentTaskId: piTask.parentTaskId,
      correlationId: piTask.correlationId,
      runnerDecision: 'approve_rollout',
    }));
  }
}

/**
 * Read the actual successor task from the store after commitNextTaskProposal.
 *
 * EP-07 compliance: reads the REAL successor record from the store, not a
 * hand-written expected value. The assertion compares the actual taskKind
 * from the store against the expected chain.
 */
async function readActualSuccessor(
  stateManager: RuntimeStateManager,
  successorTaskId: string,
): Promise<{ taskId: string; taskKind: string; status: string }> {
  const task = await stateManager.getTask(successorTaskId);
  if (!task) {
    throw new Error(`Successor task ${successorTaskId} not found in store`);
  }
  return {
    taskId: task.taskId,
    taskKind: task.taskKind,
    status: task.status,
  };
}

/**
 * Walk the full successor chain from a seeded dreamer task, returning the
 * actual task kinds observed in the store.
 *
 * EP-07: every successor is read from the real store via readActualSuccessor.
 */
async function walkFullChain(
  stateManager: RuntimeStateManager,
  orchestrator: InternalizationOrchestrator,
  dreamerTaskId: string,
  expectedChain: PeerRunnerKind[] = EXPECTED_CHAIN,
): Promise<string[]> {
  let currentTaskId = dreamerTaskId;
  const actualChain: string[] = ['dreamer'];

  // Derive the channel from the seeded dreamer taskId (dreamer-<cand>-<channel>)
  // so the regression assertion below works for both prompt and code_tool_hook
  // channels without a separate parameter.
  const dreamerSegments = dreamerTaskId.split('-');
  const channel = dreamerSegments[dreamerSegments.length - 1];

  for (let i = 0; i < expectedChain.length - 1; i++) {
    const expectedNextKind = expectedChain[i + 1];
    if (!expectedNextKind) {
      throw new Error(`expectedChain[${i + 1}] is undefined`);
    }

    await simulateTaskSuccess(stateManager, currentTaskId);
    const commitResult = await orchestrator.commitNextTaskProposal(currentTaskId);

    if (commitResult.decision !== 'successor_created') {
      throw new Error(`Expected successor_created at chain step ${i}, got ${commitResult.decision}`);
    }
    expect(commitResult.successorKind).toBe(expectedNextKind);

    const actualSuccessor = await readActualSuccessor(stateManager, commitResult.successorTaskId);
    expect(actualSuccessor.taskKind).toBe(expectedNextKind);
    expect(actualSuccessor.status).toBe('pending');

    // Regression guard (acceptance 2026-08-11): the channel suffix MUST NOT
    // accumulate across the peer-runner chain. Every successor taskId derives
    // its root from the same correlationId (candidateId), so the channel
    // segment `-<channel>` appears EXACTLY ONCE at the tail, regardless of how
    // many hops deep we are. Before the fix, scribe ids looked like
    // `scribe-philosopher-dreamer-<cand>-prompt-prompt-prompt` (3× channel),
    // which broke the scribe/evaluator output validators (taskId mismatch).
    const successorId = commitResult.successorTaskId;
    const duplicated = `-${channel}-${channel}`;
    expect(successorId).not.toContain(duplicated);
    // Defensive invariant: a task id must never contain the literal "-undefined"
    // segment, even if some future code path reaches the successor construction
    // with an absent channel.
    expect(successorId).not.toContain('-undefined');

    actualChain.push(actualSuccessor.taskKind);
    currentTaskId = commitResult.successorTaskId;
  }

  // Terminal runner has no successor
  await simulateTaskSuccess(stateManager, currentTaskId);
  const terminalCommit = await orchestrator.commitNextTaskProposal(currentTaskId);
  expect(terminalCommit.decision).toBe('no_successor');

  return actualChain;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PRI-457 C2-P0: Live MVP runner chain pinning test', () => {
  let tmpDir: string;
  let stateManager: RuntimeStateManager;
  let orchestrator: InternalizationOrchestrator;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-c2-p0-chain-'));
    stateManager = new RuntimeStateManager({ workspaceDir: tmpDir });
    await stateManager.initialize();
    orchestrator = new InternalizationOrchestrator(
      { stateManager },
      { owner: OWNER, runtimeKind: RUNTIME_KIND, dryRun: true },
    );
  });

  afterEach(async () => {
    await stateManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Channel: prompt ──────────────────────────────────────────────────────

  it('prompt channel (standard): principle chain dreamer→philosopher→scribe→rollout_reviewer — artificer/evaluator never created (PRI-720)', async () => {
    const dreamerTaskId = await seedDreamerTask(stateManager, {
      candidateId: `cand-prompt-${Date.now()}`,
      channel: 'prompt',
    });

    const dreamerTask = await stateManager.getTask(dreamerTaskId);
    expect(dreamerTask).not.toBeNull();
    if (!dreamerTask) {
      throw new Error('Dreamer task not found after seeding');
    }
    expect(dreamerTask.taskKind).toBe('dreamer');

    const actualChain = await walkFullChain(stateManager, orchestrator, dreamerTaskId, EXPECTED_PROMPT_CHAIN);
    expect(actualChain).toEqual(EXPECTED_PROMPT_CHAIN);
  });

  // ── Channel: prompt + full_chain override (PRI-720) ──────────────────────

  it('prompt channel + pipelineMode full_chain: legacy full chain dreamer→…→rollout_reviewer (Owner override)', async () => {
    const candidateId = `cand-prompt-full-${Date.now()}`;
    const dreamerTaskId = await seedDreamerTask(stateManager, {
      candidateId,
      channel: 'prompt',
      pipelineMode: 'full_chain',
    });

    const dreamerTask = await stateManager.getTask(dreamerTaskId);
    if (!dreamerTask) {
      throw new Error('Dreamer task not found after seeding');
    }
    // The override is durable on the seed record...
    const piDreamer = hydratePITaskRecord(dreamerTask);
    expect(piDreamer?.pipelineMode).toBe('full_chain');

  // ...inherited by every successor...
  const actualChain = await walkFullChain(stateManager, orchestrator, dreamerTaskId);
  expect(actualChain).toEqual(EXPECTED_CHAIN);

  // ...check a mid-chain record (deterministic successor id: <kind>-<candidateId>-<channel>).
  const scribeTask = await stateManager.getTask(`scribe-${candidateId}-prompt`);
  if (!scribeTask) {
    throw new Error('Scribe successor not found');
  }
  const piScribe = hydratePITaskRecord(scribeTask);
  expect(piScribe?.pipelineMode).toBe('full_chain');
  expect(piScribe?.channel).toBe('prompt');
  // The RuleCode sub-chain was created and also carries the override.
  const artificerTask = await stateManager.getTask(`artificer-${candidateId}-prompt`);
  if (!artificerTask) {
    throw new Error('Artificer successor not found — full_chain override must create it on the prompt channel');
  }
  const piArtificer = hydratePITaskRecord(artificerTask);
  expect(piArtificer?.pipelineMode).toBe('full_chain');
});

  // ── Channel: code_tool_hook ──────────────────────────────────────────────

  it('code_tool_hook channel: full successor chain dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer', async () => {
    const dreamerTaskId = await seedDreamerTask(stateManager, {
      candidateId: `cand-hook-${Date.now()}`,
      channel: 'code_tool_hook',
    });

    const dreamerTask = await stateManager.getTask(dreamerTaskId);
    expect(dreamerTask).not.toBeNull();
    if (!dreamerTask) {
      throw new Error('Dreamer task not found after seeding');
    }
    expect(dreamerTask.taskKind).toBe('dreamer');

    const actualChain = await walkFullChain(stateManager, orchestrator, dreamerTaskId);
    expect(actualChain).toEqual(EXPECTED_CHAIN);
  });

  // ── Channel: defer_archive ───────────────────────────────────────────────

  it('defer_archive channel: no route maps to defer_archive — no dreamer task seeded', async () => {
    // The intake bridge has NO route that maps to the defer_archive channel.
    // defer recommendations return 'not_internalizable' at computeBridgeDecision.
    // Use ready: true so the code reaches the route check (not the !ready early exit).
    const bridgeInput: IntakeToInternalizationBridgeInput = {
      candidateId: `cand-defer-${Date.now()}`,
      recommendationKind: 'defer',
      route: 'deferred',
      ready: true,
    };

    const decision = computeBridgeDecision(bridgeInput);
    expect(decision.decision).toBe('not_internalizable');
    // Verify the rejection is specifically because the route is deferred,
    // not because of a missing ready flag or unknown route.
    if (!('reason' in decision)) {
      throw new Error('Expected not_internalizable decision to have a reason field');
    }
    expect(decision.reason).toContain('deferred');

    // No dreamer task is seeded — no runners run for defer_archive
    // through the internalization pipeline.
  });

  // ── Cross-channel: successor inherits channel from parent ─────────────────

  it('successor tasks inherit the channel from the parent task', async () => {
    for (const channel of ['prompt', 'code_tool_hook'] as InternalizationChannel[]) {
      const dreamerTaskId = await seedDreamerTask(stateManager, {
        candidateId: `cand-${channel}-inherit-${Date.now()}`,
        channel,
      });

      await simulateTaskSuccess(stateManager, dreamerTaskId);
      const commitResult = await orchestrator.commitNextTaskProposal(dreamerTaskId);

      if (commitResult.decision !== 'successor_created') {
        throw new Error(`Expected successor_created, got ${commitResult.decision}`);
      }
      expect(commitResult.successorKind).toBe('philosopher');

      // Read the actual successor and verify its channel via hydrated metadata
      const successorTask = await stateManager.getTask(commitResult.successorTaskId);
      expect(successorTask).not.toBeNull();
      if (!successorTask) {
        throw new Error(`Successor task ${commitResult.successorTaskId} not found`);
      }
      expect(successorTask.diagnosticJson).toBeDefined();

      // Parse the PI metadata to verify channel inheritance
      // Runtime Contract #2/#5: no `as` on untrusted data; use typeof + Object.hasOwn
      const diagJson = successorTask.diagnosticJson;
      if (!diagJson) {
        throw new Error('Successor task diagnosticJson is empty');
      }
      const parsed: unknown = JSON.parse(diagJson);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('diagnosticJson is not an object');
      }
      if (!Object.hasOwn(parsed, 'pi_metadata')) {
        throw new Error('pi_metadata key not found in successor diagnosticJson');
      }
      const piMeta = (parsed as Record<string, unknown>).pi_metadata;
      if (typeof piMeta !== 'object' || piMeta === null) {
        throw new Error('pi_metadata is not an object');
      }
      if (!Object.hasOwn(piMeta, 'channel')) {
        throw new Error('pi_metadata.channel is missing');
      }
      const channelValue = (piMeta as Record<string, unknown>).channel;
      expect(channelValue).toBe(channel);
    }
  });

  // ── Edge validation: channel-aware topology (PRI-720) ────────────────────

  it('validateEdge resolves the edge set from channel + pipelineMode (PRI-720)', async () => {
    // Channel-aware since PRI-720: prompt/defer_archive take the principle
    // semantic path (scribe→rollout_reviewer); code_tool_hook keeps the full
    // linear chain; full_chain override restores the legacy graph on any
    // channel; unchannelled legacy reads keep the full graph.
    const { validateEdge, resolveChannelEdges } = await import('../internalization-job-graph.js');

    // Shared upstream edges exist on every channel.
    for (const channel of ['prompt', 'code_tool_hook', 'defer_archive'] as const) {
      expect(validateEdge('dreamer', 'philosopher', { channel })).toBe(true);
      expect(validateEdge('philosopher', 'scribe', { channel })).toBe(true);
    }
    // evaluator→rollout_reviewer exists only where the evaluator exists.
    expect(validateEdge('evaluator', 'rollout_reviewer', { channel: 'code_tool_hook' })).toBe(true);
    expect(validateEdge('evaluator', 'rollout_reviewer', { channel: 'prompt' })).toBe(false);

    // The channel fork (AC11): prompt forbids the RuleCode sub-chain,
    // code_tool_hook requires it.
    expect(validateEdge('scribe', 'rollout_reviewer', { channel: 'prompt' })).toBe(true);
    expect(validateEdge('scribe', 'artificer', { channel: 'prompt' })).toBe(false);
    expect(validateEdge('scribe', 'rollout_reviewer', { channel: 'code_tool_hook' })).toBe(false);
    expect(validateEdge('scribe', 'artificer', { channel: 'code_tool_hook' })).toBe(true);
    expect(validateEdge('artificer', 'evaluator', { channel: 'prompt' })).toBe(false);
    expect(validateEdge('artificer', 'evaluator', { channel: 'code_tool_hook' })).toBe(true);

    // defer_archive is prompt-shaped (AC9).
    expect(validateEdge('scribe', 'rollout_reviewer', { channel: 'defer_archive' })).toBe(true);
    expect(validateEdge('scribe', 'artificer', { channel: 'defer_archive' })).toBe(false);

    // The full_chain override restores every legacy edge on any channel.
    for (const channel of ['prompt', 'defer_archive', 'code_tool_hook'] as const) {
      expect(validateEdge('scribe', 'artificer', { channel: channel, pipelineMode: 'full_chain' })).toBe(true);
      expect(validateEdge('artificer', 'evaluator', { channel: channel, pipelineMode: 'full_chain' })).toBe(true);
    }

    // Backward compatibility: no channel → full graph (legacy callers).
    expect(validateEdge('scribe', 'artificer')).toBe(true);
    expect(validateEdge('artificer', 'evaluator')).toBe(true);

    // SSOT: the resolved edge tables are exactly the documented topology.
    expect(resolveChannelEdges('prompt')).toEqual([
      ['dreamer', 'philosopher'],
      ['philosopher', 'scribe'],
      ['scribe', 'rollout_reviewer'],
    ]);
    expect(resolveChannelEdges('code_tool_hook')).toEqual([
      ['dreamer', 'philosopher'],
      ['philosopher', 'scribe'],
      ['scribe', 'artificer'],
      ['artificer', 'evaluator'],
      ['evaluator', 'rollout_reviewer'],
    ]);
    expect(resolveChannelEdges()).toHaveLength(5);
  });

  // ── Config defaults: document the DEFAULT_AGENT_ENABLED values ────────────

  it('DEFAULT_AGENT_ENABLED: dreamer+scribe+artificer on; philosopher+evaluator+rolloutReviewer off', async () => {
    // This pins the config defaults that the trace doc relies on.
    // If these defaults change, the Core/Quiet classification must be re-evaluated.
    const { getDefaultInternalAgents } = await import('../../config/pd-config-defaults.js');
    const agents = getDefaultInternalAgents();

    expect(agents.agents.dreamer.enabled).toBe(true);
    expect(agents.agents.philosopher.enabled).toBe(false);
    expect(agents.agents.scribe.enabled).toBe(true);
    expect(agents.agents.artificer.enabled).toBe(true);
    expect(agents.agents.evaluator.enabled).toBe(false);
    expect(agents.agents.rolloutReviewer.enabled).toBe(false);
  });

  // ── MVP_CORE_TASK_KINDS includes rollout_reviewer (manual-gate kind) ────────

  it('MVP_CORE_TASK_KINDS includes all 6 peer-runner kinds (rollout_reviewer = manual gate)', async () => {
    const { MVP_CORE_TASK_KINDS } = await import('../queue-actionability.js');
    expect(MVP_CORE_TASK_KINDS).toContain('dreamer');
    expect(MVP_CORE_TASK_KINDS).toContain('philosopher');
    expect(MVP_CORE_TASK_KINDS).toContain('scribe');
    expect(MVP_CORE_TASK_KINDS).toContain('artificer');
    expect(MVP_CORE_TASK_KINDS).toContain('evaluator');
    expect(MVP_CORE_TASK_KINDS).toContain('rollout_reviewer');
  });

  // ── DEFAULT_CONSUMER_RUNNER_KINDS is dreamer-only (flag-off rollback) ──────

  it('DEFAULT_CONSUMER_RUNNER_KINDS is dreamer-only (flag-off rollback default)', async () => {
    const { DEFAULT_CONSUMER_RUNNER_KINDS } = await import('../internalization-consumer-decision.js');
    expect(DEFAULT_CONSUMER_RUNNER_KINDS).toEqual(['dreamer']);
  });

  // ── FULL_CHAIN_CONSUMER_RUNNER_KINDS (flag-on scope) includes rollout_reviewer ─

  it('FULL_CHAIN_CONSUMER_RUNNER_KINDS advances dreamer→…→evaluator→rollout_reviewer', async () => {
    const { FULL_CHAIN_CONSUMER_RUNNER_KINDS } = await import('../internalization-consumer-decision.js');
    expect(FULL_CHAIN_CONSUMER_RUNNER_KINDS).toEqual([
      'dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer',
    ]);
  });
});
