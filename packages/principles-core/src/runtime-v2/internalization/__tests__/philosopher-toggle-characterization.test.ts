/**
 * Characterization test — what actually happens when the philosopher agent
 * toggle is OFF (spec `internalization-progressive-disclosure`, task 1.3,
 * open question (a) in design §13.2).
 *
 * SCOPE: this test LOCKS IN CURRENT BEHAVIOR. It does not assert desired
 * behavior. If any assertion here starts failing, the philosopher-disabled
 * semantics changed and design §2.3 / Requirement 2.9 / 2.11 must be re-reviewed
 * before the change lands.
 *
 * ── The three candidate behaviors (design §13.2 (a)) ──────────────────────────
 *   (1) orchestrator SKIPS the node  (dreamer → scribe directly)
 *   (2) orchestrator REFUSES to enqueue it
 *   (3) it runs anyway and is merely hidden from the UI
 *
 * ── Verified answer: (3), with a caveat ──────────────────────────────────────
 * The task graph and the orchestrator never read the toggle at all. They are
 * toggle-blind:
 *   - `internalization-job-graph.ts` ALLOWED_EDGES has no dreamer→scribe edge.
 *   - `internalization-state-machine.ts` `createNextTaskProposal()` takes
 *     (task, artifacts, channel) — no config parameter exists.
 *   - `internalization-orchestrator.ts` `InternalizationOrchestratorDeps` is
 *     `{ stateManager }` only; `wakeOnce` / `proposeNextTask` /
 *     `commitNextTaskProposal` never load `.pd/config.yaml`.
 * So a philosopher successor IS proposed, IS committed, and IS leasable while
 * `internalAgents.agents.philosopher.enabled === false`.
 *
 * The toggle is only read outside core, at adapter-resolution time, and there
 * it REFUSES the whole run rather than skipping the node:
 *   - `packages/principles-core/src/runtime-v2/config/pd-config-agent-binding.ts:168-176`
 *     → `{ ok: false, readiness: 'disabled' }` (no `profile`, so the caller
 *        cannot proceed without the agent).
 *   - `packages/pd-cli/src/commands/runtime-internalization-run-rulehost.ts:124-126`
 *     `resolvePiAiAgentAdapter(effective, 'philosopher', ...)` THROWS on
 *     `!binding.ok`; lines 417-428 turn that throw into
 *     `reason: 'agent_runtime_resolution_failed'` + `exitCode = 1` for the
 *     entire pain → dreamer → philosopher → scribe chain.
 *   - `packages/pd-cli/src/commands/runtime-internalization-run-once.ts` does
 *     not read the toggle at all: `--runner philosopher` executes the runner.
 *
 * ── Consequence for the spec ────────────────────────────────────────────────
 * There is no "philosopher skipped" chain shape. Either philosopher runs (and
 * its writer-side `predecessorSummary` forwarding carries dreamer's 5 dimensions
 * to scribe, design §2.3), or the whole run is refused before scribe executes.
 * Requirement 2.9 / 2.11 therefore holds.
 *
 * ERR entries considered:
 *   - ERR-088 (EP-09, non-unique test signal): every assertion below names a
 *     concrete observable — `decision`, `successorKind`, `readiness`, the exact
 *     `reason` string, the `createTask` argument — never "did not throw" and
 *     never a bare `undefined`. The enabled agents (dreamer / scribe) are
 *     asserted as `ok: true` in the same test so a blanket-failure regression in
 *     `resolveAgentRuntimeBinding` cannot masquerade as "philosopher disabled".
 *   - ERR-024 (EP-02, production wiring vs leaf-only testing): the toggle-blind
 *     claim is asserted against the real `InternalizationOrchestrator` +
 *     `createNextTaskProposal`, plus a source-text guard proving no core
 *     orchestration module references the agent-enabled config at all — not
 *     against a hand-rolled stand-in.
 *   - ERR-073 (EP-09, characterization tests that only prove the happy path):
 *     both sides of the toggle are covered — the disabled agent AND the enabled
 *     agents — so the characterization pins the difference, not just one case.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_EDGES,
  getAllowedSuccessors,
  validateEdge,
} from '../internalization-job-graph.js';
import { createNextTaskProposal } from '../internalization-state-machine.js';
import { InternalizationOrchestrator } from '../internalization-orchestrator.js';
import type { PITaskRecord } from '../peer-runner-contracts.js';
import type { TaskRecord } from '../../task-status.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { getDefaultInternalAgents } from '../../config/pd-config-defaults.js';
import { computeEffectivePdConfig } from '../../config/pd-config-effective.js';
import { resolveAgentRuntimeBinding } from '../../config/pd-config-agent-binding.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRawTask(overrides: {
  taskId: string;
  taskKind: string;
  status: TaskRecord['status'];
  dependencyTaskIds?: string[];
  outputArtifactRefs?: { artifactType: string; ref: string }[];
}): TaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: overrides.taskId,
    taskKind: overrides.taskKind,
    status: overrides.status,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      pi_metadata: {
        dependencyTaskIds: overrides.dependencyTaskIds ?? [],
        channel: 'prompt',
        timeoutMs: 60_000,
        inputArtifactRefs: [],
        outputArtifactRefs: overrides.outputArtifactRefs ?? [],
      },
    }),
  };
}

function makeSucceededDreamerPITask(): PITaskRecord {
  const now = new Date().toISOString();
  return {
    taskId: 'dreamer-task-1',
    taskKind: 'dreamer',
    status: 'succeeded',
    createdAt: now,
    updatedAt: now,
    attemptCount: 1,
    maxAttempts: 3,
    dependencyTaskIds: [],
    channel: 'prompt',
    timeoutMs: 60_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-dreamer-1' }],
    rejectionCount: 0,
  };
}

interface MockStateManager {
  listTasks: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  acquireLease: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
}

function createMockStateManager(): MockStateManager {
  return {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    acquireLease: vi.fn(),
    createTask: vi.fn(),
  };
}

function readCoreSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf-8');
}

// ── 1. Config layer: the toggle is OFF by default and resolves to 'disabled' ──

describe('philosopher toggle — config layer (characterization)', () => {
  it('philosopher defaults to disabled while dreamer and scribe default to enabled', () => {
    const agents = getDefaultInternalAgents().agents;

    expect(agents.philosopher.enabled).toBe(false);
    // Positive discrimination (ERR-088): the default table is not uniformly false.
    expect(agents.dreamer.enabled).toBe(true);
    expect(agents.scribe.enabled).toBe(true);
  });

  it('resolveAgentRuntimeBinding reports philosopher as disabled with a structured reason', () => {
    const effective = computeEffectivePdConfig(null);

    const philosopher = resolveAgentRuntimeBinding(effective, 'philosopher');

    expect(philosopher.ok).toBe(false);
    if (philosopher.ok) throw new Error('expected philosopher binding to be unresolved');
    expect(philosopher.readiness).toBe('disabled');
    expect(philosopher.reason).toBe("Agent 'philosopher' is disabled");
    expect(philosopher.nextAction).toContain('internalAgents.agents.philosopher.enabled');
  });

  it('a disabled binding carries no runtime profile, so callers cannot proceed without the agent', () => {
    const effective = computeEffectivePdConfig(null);

    const philosopher = resolveAgentRuntimeBinding(effective, 'philosopher');

    if (philosopher.ok) throw new Error('expected philosopher binding to be unresolved');
    // There is no "skip this stage" signal in the contract — only 'disabled' /
    // 'not_ready' / 'needs_setup', all of which lack `profile`. This is why the
    // pd-cli mainline refuses the whole run instead of skipping the node.
    expect(Object.hasOwn(philosopher, 'profile')).toBe(false);
    expect(['disabled', 'not_ready', 'needs_setup']).toContain(philosopher.readiness);
  });

  it('enabled agents still resolve successfully under the same default config', () => {
    const effective = computeEffectivePdConfig(null);

    const dreamer = resolveAgentRuntimeBinding(effective, 'dreamer');
    const scribe = resolveAgentRuntimeBinding(effective, 'scribe');

    expect(dreamer.ok).toBe(true);
    expect(scribe.ok).toBe(true);
    if (!dreamer.ok || !scribe.ok) throw new Error('expected dreamer and scribe bindings to resolve');
    expect(dreamer.profileId).toBe('openclaw.default');
    expect(scribe.profileId).toBe('openclaw.default');
  });
});

// ── 2. Graph layer: philosopher is structurally mandatory, no bypass ─────────

describe('philosopher toggle — job graph has no bypass (characterization)', () => {
  it('ALLOWED_EDGES has exactly 5 edges and no dreamer → scribe bypass', () => {
    expect(ALLOWED_EDGES).toHaveLength(5);
    expect(validateEdge('dreamer', 'scribe')).toBe(false);
    expect(validateEdge('dreamer', 'philosopher')).toBe(true);
    expect(validateEdge('philosopher', 'scribe')).toBe(true);
  });

  it("dreamer's only successor is philosopher", () => {
    expect(getAllowedSuccessors('dreamer')).toEqual(['philosopher']);
  });
});

// ── 3. Orchestration layer: toggle-blind — the node runs anyway ──────────────

describe('philosopher toggle — orchestration is toggle-blind (characterization)', () => {
  it('createNextTaskProposal proposes philosopher after a succeeded dreamer, with no config input', () => {
    const proposal = createNextTaskProposal(makeSucceededDreamerPITask(), []);

    expect(proposal).not.toBeNull();
    expect(proposal?.taskKind).toBe('philosopher');
    expect(proposal?.parentTaskId).toBe('dreamer-task-1');
    expect(proposal?.dependencyTaskIds).toEqual(['dreamer-task-1']);
    expect(proposal?.inputArtifactRefs).toEqual([
      { artifactType: 'principle', ref: 'pi-art-dreamer-1' },
    ]);
  });

  it('commitNextTaskProposal creates a philosopher successor while the toggle is off', async () => {
    // Precondition made explicit: the toggle is OFF in the canonical config.
    expect(getDefaultInternalAgents().agents.philosopher.enabled).toBe(false);

    const stateManager = createMockStateManager();
    const dreamerTask = makeRawTask({
      taskId: 'dreamer-task-1',
      taskKind: 'dreamer',
      status: 'succeeded',
      outputArtifactRefs: [{ artifactType: 'principle', ref: 'pi-art-dreamer-1' }],
    });
    stateManager.getTask.mockResolvedValue(dreamerTask);
    // findExistingSuccessor scans pending then retry_wait.
    stateManager.listTasks.mockResolvedValue([]);
    stateManager.createTask.mockImplementation((input: TaskRecord) => Promise.resolve(input));

    const orchestrator = new InternalizationOrchestrator(
      { stateManager: stateManager as unknown as RuntimeStateManager },
      { owner: 'characterization-owner', runtimeKind: 'local-worker' },
    );

    const result = await orchestrator.commitNextTaskProposal('dreamer-task-1');

    expect(result.decision).toBe('successor_created');
    expect(result).toMatchObject({
      decision: 'successor_created',
      sourceTaskId: 'dreamer-task-1',
      successorKind: 'philosopher',
      successorTaskId: 'philosopher-dreamer-task-1-prompt',
    });
    // Side-effect assertion (ERR-088): the successor actually reached the store
    // as a philosopher task — not merely "no error was returned".
    expect(stateManager.createTask).toHaveBeenCalledOnce();
    expect(stateManager.createTask.mock.calls[0]?.[0]).toMatchObject({
      taskId: 'philosopher-dreamer-task-1-prompt',
      taskKind: 'philosopher',
      status: 'pending',
    });
  });

  it('wakeOnce leases a pending philosopher task while the toggle is off', async () => {
    expect(getDefaultInternalAgents().agents.philosopher.enabled).toBe(false);

    const stateManager = createMockStateManager();
    const philosopherTask = makeRawTask({
      taskId: 'philosopher-task-1',
      taskKind: 'philosopher',
      status: 'pending',
    });
    stateManager.listTasks
      .mockResolvedValueOnce([philosopherTask]) // pending
      .mockResolvedValueOnce([]); // retry_wait
    stateManager.acquireLease.mockResolvedValue({
      ...philosopherTask,
      status: 'leased',
      attemptCount: 1,
    });

    const orchestrator = new InternalizationOrchestrator(
      { stateManager: stateManager as unknown as RuntimeStateManager },
      { owner: 'characterization-owner', runtimeKind: 'local-worker' },
    );

    const result = await orchestrator.wakeOnce();

    expect(result).toMatchObject({
      decision: 'leased',
      taskId: 'philosopher-task-1',
      taskKind: 'philosopher',
      attemptCount: 1,
    });
    expect(stateManager.acquireLease).toHaveBeenCalledWith({
      taskId: 'philosopher-task-1',
      owner: 'characterization-owner',
      runtimeKind: 'local-worker',
    });
  });

  it('no core orchestration module reads the agent-enabled config (source guard)', () => {
    const modules = [
      '../internalization-orchestrator.ts',
      '../internalization-state-machine.ts',
      '../internalization-task-guards.ts',
      '../internalization-job-graph.ts',
    ];
    const forbidden = [
      'internalAgents',
      'resolveAgentRuntimeBinding',
      'checkAgentRuntimeReadiness',
      'InternalAgentName',
      'EffectivePdConfig',
    ];

    const hits: string[] = [];
    for (const modulePath of modules) {
      const src = readCoreSource(modulePath);
      for (const token of forbidden) {
        if (src.includes(token)) hits.push(`${modulePath} references ${token}`);
      }
    }

    // Empty means: the toggle cannot influence enqueueing, leasing, or successor
    // proposal. If this list becomes non-empty, behavior (2) "refuse to enqueue"
    // or (1) "skip the node" was introduced and Requirement 2 must be re-reviewed.
    expect(hits).toEqual([]);
  });
});
