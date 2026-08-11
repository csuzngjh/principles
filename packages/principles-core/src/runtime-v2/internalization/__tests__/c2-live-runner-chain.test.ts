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

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Options for seeding a dreamer task through the real intake bridge path. */
interface SeedDreamerOptions {
  candidateId: string;
  channel: InternalizationChannel;
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
  const { candidateId, channel, sourceTaskId } = options;
  const bridgeInput: IntakeToInternalizationBridgeInput = {
    candidateId,
    recommendationKind: channel === 'code_tool_hook' ? 'rule' : 'principle',
    route: channel === 'code_tool_hook' ? 'rule-candidate' : 'principle-ledger',
    ready: true,
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
): Promise<string[]> {
  let currentTaskId = dreamerTaskId;
  const actualChain: string[] = ['dreamer'];

  // Derive the channel from the seeded dreamer taskId (dreamer-<cand>-<channel>)
  // so the regression assertion below works for both prompt and code_tool_hook
  // channels without a separate parameter.
  const dreamerSegments = dreamerTaskId.split('-');
  const channel = dreamerSegments[dreamerSegments.length - 1];

  for (let i = 0; i < EXPECTED_CHAIN.length - 1; i++) {
    const expectedNextKind = EXPECTED_CHAIN[i + 1];
    if (!expectedNextKind) {
      throw new Error(`EXPECTED_CHAIN[${i + 1}] is undefined`);
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

  it('prompt channel: full successor chain dreamer→philosopher→scribe→artificer→evaluator→rollout_reviewer', async () => {
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

    const actualChain = await walkFullChain(stateManager, orchestrator, dreamerTaskId);
    expect(actualChain).toEqual(EXPECTED_CHAIN);
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

  // ── Edge validation: validateEdge does not filter by channel ──────────────

  it('validateEdge returns true for all peer runner edges regardless of channel', async () => {
    // This documents that the job graph does NOT filter by channel.
    // The _channel parameter in validateEdge is unused.
    // This is a key finding for C2-P2: channel-based runner skipping does NOT
    // happen at the job graph level.
    const { validateEdge } = await import('../internalization-job-graph.js');

    const edges: [PeerRunnerKind, PeerRunnerKind][] = [
      ['dreamer', 'philosopher'],
      ['philosopher', 'scribe'],
      ['scribe', 'artificer'],
      ['artificer', 'evaluator'],
      ['evaluator', 'rollout_reviewer'],
    ];

    for (const [from, to] of edges) {
      expect(validateEdge(from, to, 'prompt')).toBe(true);
      expect(validateEdge(from, to, 'code_tool_hook')).toBe(true);
      expect(validateEdge(from, to, 'defer_archive')).toBe(true);
    }
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

  // ── MVP_CORE_TASK_KINDS excludes rollout_reviewer ─────────────────────────

  it('MVP_CORE_TASK_KINDS excludes rollout_reviewer', async () => {
    const { MVP_CORE_TASK_KINDS } = await import('../queue-actionability.js');
    expect(MVP_CORE_TASK_KINDS).toContain('dreamer');
    expect(MVP_CORE_TASK_KINDS).toContain('philosopher');
    expect(MVP_CORE_TASK_KINDS).toContain('scribe');
    expect(MVP_CORE_TASK_KINDS).toContain('artificer');
    expect(MVP_CORE_TASK_KINDS).toContain('evaluator');
    expect(MVP_CORE_TASK_KINDS).not.toContain('rollout_reviewer');
  });

  // ── DEFAULT_CONSUMER_RUNNER_KINDS is dreamer-only ────────────────────────

  it('DEFAULT_CONSUMER_RUNNER_KINDS is dreamer-only', async () => {
    const { DEFAULT_CONSUMER_RUNNER_KINDS } = await import('../internalization-consumer-decision.js');
    expect(DEFAULT_CONSUMER_RUNNER_KINDS).toEqual(['dreamer']);
  });
});
