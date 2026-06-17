/**
 * InternalizationOrchestrator — Unit Tests (PRI-68)
 *
 * TDD: Tests written first to define the expected behavior of the
 * core-owned InternalizationOrchestrator skeleton.
 *
 * The orchestrator consumes hydrated PITaskRecords, applies state-machine
 * decisions, acquires leases through RuntimeStateManager, and proposes
 * successor tasks — WITHOUT executing LLM calls or calling PDRuntimeAdapter.
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PeerRunnerKind } from '../internalization/peer-runner-contracts.js';
import { PDRuntimeError } from '../error-categories.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a raw TaskRecord (as returned by SqliteTaskStore) with valid
 * PI metadata in diagnosticJson, so hydratePITaskRecord() succeeds.
 */
function makeRawTask(overrides: {
  taskId?: string;
  taskKind?: string;
  status?: string;
  diagnosticJson?: string;
  dependencyTaskIds?: string[];
  channel?: string;
  timeoutMs?: number;
  inputArtifactRefs?: { artifactType: string; ref: string }[];
  outputArtifactRefs?: { artifactType: string; ref: string }[];
  parentTaskId?: string;
  correlationId?: string;
  attemptCount?: number;
  maxAttempts?: number;
  createdAt?: string;
  updatedAt?: string;
} = {}): TaskRecord {
  const {
    taskId = 'task-1',
    taskKind = 'dreamer',
    status = 'pending',
    dependencyTaskIds = [],
    channel = 'prompt',
    timeoutMs = 60000,
    inputArtifactRefs = [],
    outputArtifactRefs = [],
    parentTaskId,
    correlationId,
    attemptCount = 0,
    maxAttempts = 3,
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
  } = overrides;

  const piMetadata: Record<string, unknown> = {
    dependencyTaskIds,
    channel,
    timeoutMs,
    inputArtifactRefs,
    outputArtifactRefs,
  };
  if (parentTaskId !== undefined) piMetadata.parentTaskId = parentTaskId;
  if (correlationId !== undefined) piMetadata.correlationId = correlationId;

  const diagnosticJson = JSON.stringify({ pi_metadata: piMetadata });

  return {
    taskId,
    taskKind,
    status: status as TaskRecord['status'],
    createdAt,
    updatedAt,
    attemptCount,
    maxAttempts,
    diagnosticJson,
  };
}

/**
 * Mock interface for the subset of RuntimeStateManager used by the orchestrator.
 * Uses ReturnType<typeof vi.fn> so TypeScript knows .mockResolvedValue() exists.
 */
interface MockStateManager {
  listTasks: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  acquireLease: ReturnType<typeof vi.fn>;
}

/**
 * Creates a mock RuntimeStateManager with vi.fn() spies.
 */
function createMockStateManager(): MockStateManager {
  return {
    listTasks: vi.fn(),
    getTask: vi.fn(),
    acquireLease: vi.fn(),
  };
}

// ── Architecture Guard Helper ─────────────────────────────────────────────────

function moduleHasNoForbiddenImports(modulePath: string): Promise<boolean> {
  const src = readFileSync(resolve(__dirname, '..', modulePath), 'utf-8');
  return Promise.resolve(
    !src.includes('openclaw-plugin') &&
    !src.includes('PDRuntimeAdapter') &&
    !src.includes('startRun') &&
    !src.includes('DiagnosticianRunner') &&
    !src.includes('node:cron') &&
    !src.includes('setInterval') &&
    !src.includes('setTimeout')
  );
}

// ── Import after defining helpers (tests run against real module) ──────────────

// NOTE: We dynamically import the module under test so that the file must
// exist first (TDD constraint). All tests below are designed to FAIL until
// the source file is created.

describe('InternalizationOrchestrator', () => {
   
  let mockStateManager: ReturnType<typeof createMockStateManager>;
   
   
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  let OrchestratorClass: typeof import('../internalization/internalization-orchestrator.js').InternalizationOrchestrator;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStateManager = createMockStateManager();
    // Dynamic import ensures source file must exist (TDD)
    const mod = await import('../internalization/internalization-orchestrator.js');
    OrchestratorClass = mod.InternalizationOrchestrator;
  });

  // ── Test 1: pending PI task + no deps → leased ─────────────────────────────

  describe('wakeOnce — lease acquisition', () => {
    it('pending PI task with no dependencies acquires lease and returns leased decision', async () => {
      const rawTask = makeRawTask({ taskId: 'pi-task-1', taskKind: 'dreamer', status: 'pending' });
      // findCandidates calls listTasks twice (pending, then retry_wait)
      mockStateManager.listTasks
        .mockResolvedValueOnce([rawTask])   // pending → found
        .mockResolvedValueOnce([]);          // retry_wait → skipped
      mockStateManager.acquireLease.mockResolvedValue({ ...rawTask, status: 'leased' });

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('leased');
      expect((result as { taskId: string }).taskId).toBe('pi-task-1');
      expect(mockStateManager.acquireLease).toHaveBeenCalledOnce();
      expect(mockStateManager.acquireLease).toHaveBeenCalledWith({
        taskId: 'pi-task-1',
        owner: 'test-owner',
        runtimeKind: 'dreamer',
      });
    });

    // ── Test 2: pending blocked → retry_wait leasable ─────────────────────────

    it('blocked pending task is skipped; retry_wait candidate acquires lease', async () => {
      const blockedTask = makeRawTask({
        taskId: 'pi-task-2',
        taskKind: 'philosopher',
        status: 'pending',
        dependencyTaskIds: ['dep-task-1'],
      });
      const retryableTask = makeRawTask({ taskId: 'retry-task', taskKind: 'dreamer', status: 'retry_wait' });
      const depTask = makeRawTask({ taskId: 'dep-task-1', status: 'pending', taskKind: 'dreamer' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([blockedTask])    // pending → blocked (continues)
        .mockResolvedValueOnce([retryableTask]);  // retry_wait → leasable
      mockStateManager.getTask.mockResolvedValue(depTask);
      mockStateManager.acquireLease.mockResolvedValue({ ...retryableTask, status: 'leased' });

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('leased');
      expect((result as { taskId: string }).taskId).toBe('retry-task');
      expect(mockStateManager.acquireLease).toHaveBeenCalledWith({
        taskId: 'retry-task',
        owner: 'test-owner',
        runtimeKind: 'dreamer',
      });
    });

    // ── Test 3: pending failed dep → skips to next pending (leasable) ─────────

    it('pending task with failed dependency is skipped; next pending task acquires lease', async () => {
      const failedDepTask = makeRawTask({
        taskId: 'pi-task-3',
        taskKind: 'scribe',
        status: 'pending',
        dependencyTaskIds: ['failed-dep'],
      });
      const leasableTask = makeRawTask({ taskId: 'good-task', taskKind: 'artificer', status: 'pending' });
      const failedDep = makeRawTask({ taskId: 'failed-dep', status: 'failed', taskKind: 'dreamer' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([failedDepTask, leasableTask])  // pending: first is failed-dep, second is leasable
        .mockResolvedValueOnce([]);
      mockStateManager.getTask.mockResolvedValue(failedDep);
      mockStateManager.acquireLease.mockResolvedValue({ ...leasableTask, status: 'leased' });

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'artificer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('leased');
      expect((result as { taskId: string }).taskId).toBe('good-task');
    });

    // ── Test 4: invalid metadata → skips to next pending (leasable) ───────────

    it('task with invalid PI metadata is skipped; next pending task acquires lease', async () => {
      const invalidTask = {
        ...makeRawTask({ taskId: 'bad-task', taskKind: 'scribe' }),
        diagnosticJson: '{}', // missing pi_metadata key
      } as TaskRecord;
      const leasableTask = makeRawTask({ taskId: 'good-task', taskKind: 'artificer', status: 'pending' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([invalidTask, leasableTask])  // pending: first invalid, second leasable
        .mockResolvedValueOnce([]);
      mockStateManager.acquireLease.mockResolvedValue({ ...leasableTask, status: 'leased' });

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'artificer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('leased');
      expect((result as { taskId: string }).taskId).toBe('good-task');
    });

    // ── Test 5: lease conflict → skips to retry_wait (leasable) ─────────────────

    it('lease conflict on pending task is skipped; retry_wait task acquires lease', async () => {
      const conflictTask = makeRawTask({ taskId: 'conflict-task', taskKind: 'artificer', status: 'pending' });
      const retryableTask = makeRawTask({ taskId: 'retry-task', taskKind: 'dreamer', status: 'retry_wait' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([conflictTask])   // pending → lease conflict (continues)
        .mockResolvedValueOnce([retryableTask]);  // retry_wait → leasable
      mockStateManager.acquireLease
        .mockRejectedValueOnce(new PDRuntimeError('lease_conflict', 'Task conflict-task is already leased'))
        .mockResolvedValueOnce({ ...retryableTask, status: 'leased' });

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('leased');
      expect((result as { taskId: string }).taskId).toBe('retry-task');
    });

    // ── Test 6: dryRun=true → would_lease (no actual lease) ─────────────────

    it('dryRun=true returns would_lease without acquiring the lease', async () => {
      const rawTask = makeRawTask({ taskId: 'dryrun-task', taskKind: 'evaluator', status: 'pending' });
      mockStateManager.listTasks
        .mockResolvedValueOnce([rawTask])
        .mockResolvedValueOnce([]);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'evaluator', dryRun: true }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('would_lease');
      expect((result as { taskId: string }).taskId).toBe('dryrun-task');
      expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
    });

    // ── Test 6b: pending empty → retry_wait recovery ──────────────────────────

    it('retry_wait task acquires lease when pending queue is empty', async () => {
      const retryTask = makeRawTask({ taskId: 'retry-task', taskKind: 'dreamer', status: 'retry_wait' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([])             // pending → empty
        .mockResolvedValueOnce([retryTask]);   // retry_wait → has candidate
      mockStateManager.acquireLease.mockResolvedValue({ ...retryTask, status: 'leased' });

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('leased');
      expect((result as { taskId: string }).taskId).toBe('retry-task');
    });

    // ── Test 7: succeeded task → proposeNextTask → proposal_created ──────────

    it('succeeded task can generate a next-task proposal without creating the task', async () => {
      const succeededTask = makeRawTask({
        taskId: 'succeeded-dreamer',
        taskKind: 'dreamer',
        status: 'succeeded',
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'artifact-1' }],
      });
      mockStateManager.getTask.mockResolvedValue(succeededTask);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'philosopher' }
      );

      const result = await orchestrator.proposeNextTask('succeeded-dreamer');

      expect(result).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(result!.decision).toBe('proposal_created');
      expect((result as { proposal: unknown }).proposal).toBeDefined();
      // V1 chain: dreamer → philosopher
      const {proposal} = (result as { proposal: { taskKind: string } });
      expect(proposal.taskKind).toBe('philosopher');
    });

    // ── Test 7b: no_ready_tasks when candidate list is empty ─────────────────

    it('no_ready_tasks returns inspectedCount=0 when both pending and retry_wait are empty', async () => {
      mockStateManager.listTasks
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('no_ready_tasks');
      expect((result as { inspectedCount: number }).inspectedCount).toBe(0);
      expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
    });

    // ── Test 7e: no_ready_tasks reason = all_hydration_failed ──────────────

    it('no_ready_tasks reason=all_hydration_failed when every candidate has invalid PI metadata', async () => {
      // Two tasks with invalid metadata (missing pi_metadata key)
      const invalidTask1 = { ...makeRawTask({ taskId: 'bad-1', taskKind: 'dreamer' }), diagnosticJson: '{}' } as TaskRecord;
      const invalidTask2 = { ...makeRawTask({ taskId: 'bad-2', taskKind: 'philosopher' }), diagnosticJson: '{}' } as TaskRecord;

      mockStateManager.listTasks
        .mockResolvedValueOnce([invalidTask1, invalidTask2])
        .mockResolvedValueOnce([]);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('no_ready_tasks');
      const r = result as { inspectedCount: number; reason: string };
      expect(r.inspectedCount).toBe(2);
      expect(r.reason).toBe('all_hydration_failed');
    });

    // ── Test 7f: no_ready_tasks reason = all_blocked ───────────────────────

    it('no_ready_tasks reason=all_blocked when every candidate is blocked by incomplete dependencies', async () => {
      // Both tasks blocked by a dependency that is in a non-terminal state (pending)
      const blockedTask1 = makeRawTask({ taskId: 'blocked-1', taskKind: 'dreamer', dependencyTaskIds: ['dep-1'] });
      const blockedTask2 = makeRawTask({ taskId: 'blocked-2', taskKind: 'philosopher', dependencyTaskIds: ['dep-2'] });
      // dep-1 is pending (non-terminal) → validateInternalizationTaskReady returns 'blocked'
      // dep-2 is also pending → same result
      const pendingDep = makeRawTask({ taskId: 'dep-1', status: 'pending', taskKind: 'dreamer' });
      const pendingDep2 = makeRawTask({ taskId: 'dep-2', status: 'pending', taskKind: 'philosopher' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([blockedTask1, blockedTask2])
        .mockResolvedValueOnce([]);
      mockStateManager.getTask
        .mockResolvedValueOnce(pendingDep)   // dep-1 exists, pending → non-terminal
        .mockResolvedValueOnce(pendingDep2); // dep-2 exists, pending → non-terminal

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('no_ready_tasks');
      const r = result as { inspectedCount: number; reason: string };
      expect(r.inspectedCount).toBe(2);
      expect(r.reason).toBe('all_blocked');
    });

    // ── Test 7g: no_ready_tasks reason = all_lease_conflict ───────────────

    it('no_ready_tasks reason=all_lease_conflict when every candidate lease acquisition fails with conflict', async () => {
      const task1 = makeRawTask({ taskId: 'task-1', taskKind: 'dreamer', status: 'pending' });
      const task2 = makeRawTask({ taskId: 'task-2', taskKind: 'philosopher', status: 'retry_wait' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([task1])
        .mockResolvedValueOnce([task2]);
      // Both lease attempts fail with lease_conflict
      mockStateManager.acquireLease
        .mockRejectedValueOnce(new PDRuntimeError('lease_conflict', 'Already leased'))
        .mockRejectedValueOnce(new PDRuntimeError('lease_conflict', 'Already leased'));

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('no_ready_tasks');
      const r = result as { inspectedCount: number; reason: string };
      expect(r.inspectedCount).toBe(2);
      expect(r.reason).toBe('all_lease_conflict');
    });

    // ── Test 7h: no_ready_tasks reason = all_dependency_failed ──────────

    it('no_ready_tasks reason=all_dependency_failed when every candidate has failed dependencies', async () => {
      // Both tasks have dependencies that resolve to 'failed' status → dependency_failed gate
      const depFailedTask1 = makeRawTask({ taskId: 'dep-fail-1', taskKind: 'dreamer', dependencyTaskIds: ['failed-dep-a'] });
      const depFailedTask2 = makeRawTask({ taskId: 'dep-fail-2', taskKind: 'philosopher', dependencyTaskIds: ['failed-dep-b'] });
      const failedDepA = makeRawTask({ taskId: 'failed-dep-a', status: 'failed', taskKind: 'dreamer' });
      const failedDepB = makeRawTask({ taskId: 'failed-dep-b', status: 'failed', taskKind: 'dreamer' });

      mockStateManager.listTasks
        .mockResolvedValueOnce([depFailedTask1, depFailedTask2])
        .mockResolvedValueOnce([]);
      mockStateManager.getTask
        .mockResolvedValueOnce(failedDepA)
        .mockResolvedValueOnce(failedDepB);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('no_ready_tasks');
      const r = result as { inspectedCount: number; reason: string };
      expect(r.inspectedCount).toBe(2);
      expect(r.reason).toBe('all_dependency_failed');
    });

    // ── Test 7c: proposeNextTask returns null when task not found ────────────

    it('proposeNextTask returns null when task does not exist', async () => {
      mockStateManager.getTask.mockResolvedValue(null);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.proposeNextTask('nonexistent-task');
      expect(result).toBeNull();
    });

    // ── Test 7d: proposeNextTask returns null for non-PI task kind ──────────

    it('proposeNextTask returns null when taskKind is not a PeerRunnerKind', async () => {
      const rawTask = makeRawTask({
        taskId: 'diag-task',
        taskKind: 'diagnostician', // not a PeerRunnerKind
        status: 'succeeded',
      });
      mockStateManager.getTask.mockResolvedValue(rawTask);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.proposeNextTask('diag-task');
      expect(result).toBeNull();
    });

    // ── Test 8: architecture guard — no forbidden imports ────────────────────

    it('orchestrator source has zero forbidden imports (no openclaw-plugin, scheduling, or runtime adapter)', async () => {
      const clean = await moduleHasNoForbiddenImports('internalization/internalization-orchestrator.ts');
      expect(clean).toBe(true);
    });

    // ── Test 9-13: wakeOnce taskKind filtering (PRI-110) ────────────────────

    describe('wakeOnce — taskKind filtering', () => {
      it('wakeOnce("artificer") skips dreamer candidates and leases artificer task', async () => {
        const dreamerTask = makeRawTask({ taskId: 'dreamer-1', taskKind: 'dreamer', status: 'pending' });
        const artificerTask = makeRawTask({ taskId: 'artificer-1', taskKind: 'artificer', status: 'pending' });
        mockStateManager.listTasks
          .mockResolvedValueOnce([dreamerTask, artificerTask])
          .mockResolvedValueOnce([]);
        mockStateManager.acquireLease.mockResolvedValue({ ...artificerTask, status: 'leased' });

        const orchestrator = new OrchestratorClass(
          { stateManager: mockStateManager as unknown as RuntimeStateManager },
          { owner: 'test-owner', runtimeKind: 'artificer', dryRun: false },
        );

        const result = await orchestrator.wakeOnce('artificer');

        expect(result.decision).toBe('leased');
        expect((result as { taskId: string }).taskId).toBe('artificer-1');
      });

      it('wakeOnce("dreamer") with mixed candidates only returns dreamer task', async () => {
        const dreamerTask = makeRawTask({ taskId: 'dreamer-1', taskKind: 'dreamer', status: 'pending' });
        const artificerTask = makeRawTask({ taskId: 'artificer-1', taskKind: 'artificer', status: 'pending' });
        mockStateManager.listTasks
          .mockResolvedValueOnce([artificerTask, dreamerTask])
          .mockResolvedValueOnce([]);
        mockStateManager.acquireLease.mockResolvedValue({ ...dreamerTask, status: 'leased' });

        const orchestrator = new OrchestratorClass(
          { stateManager: mockStateManager as unknown as RuntimeStateManager },
          { owner: 'test-owner', runtimeKind: 'dreamer', dryRun: false },
        );

        const result = await orchestrator.wakeOnce('dreamer');

        expect(result.decision).toBe('leased');
        expect((result as { taskId: string }).taskId).toBe('dreamer-1');
      });

      it('wakeOnce("evaluator") with no evaluator candidates returns no_ready_tasks with filtered_out reason', async () => {
        const dreamerTask = makeRawTask({ taskId: 'dreamer-1', taskKind: 'dreamer', status: 'pending' });
        mockStateManager.listTasks
          .mockResolvedValueOnce([dreamerTask])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([dreamerTask])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([dreamerTask])
          .mockResolvedValueOnce([]);

        const orchestrator = new OrchestratorClass(
          { stateManager: mockStateManager as unknown as RuntimeStateManager },
          { owner: 'test-owner', runtimeKind: 'evaluator', dryRun: false },
        );

        const result = await orchestrator.wakeOnce('evaluator');

        expect(result.decision).toBe('no_ready_tasks');
        expect((result as { inspectedCount: number }).inspectedCount).toBe(0);
        expect((result as { reason: string }).reason).toBe('filtered_out');
      });

      it('wakeOnce("evaluator") with completely empty queue returns no_ready_tasks with no_candidates reason', async () => {
        mockStateManager.listTasks
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]);

        const orchestrator = new OrchestratorClass(
          { stateManager: mockStateManager as unknown as RuntimeStateManager },
          { owner: 'test-owner', runtimeKind: 'evaluator', dryRun: false },
        );

        const result = await orchestrator.wakeOnce('evaluator');

        expect(result.decision).toBe('no_ready_tasks');
        expect((result as { inspectedCount: number }).inspectedCount).toBe(0);
        expect((result as { reason: string }).reason).toBe('no_candidates');
      });

      it('wakeOnce with invalid taskKind throws PDRuntimeError input_invalid', async () => {
        const orchestrator = new OrchestratorClass(
          { stateManager: mockStateManager as unknown as RuntimeStateManager },
          { owner: 'test-owner', runtimeKind: 'dreamer', dryRun: false },
        );

        await expect(orchestrator.wakeOnce('diagnostician' as unknown as PeerRunnerKind)).rejects.toThrow('invalid taskKind filter');
      });

      it('wakeOnce() without taskKind returns first leasable task regardless of kind (backward compat)', async () => {
        const dreamerTask = makeRawTask({ taskId: 'dreamer-1', taskKind: 'dreamer', status: 'pending' });
        const artificerTask = makeRawTask({ taskId: 'artificer-1', taskKind: 'artificer', status: 'pending' });
        mockStateManager.listTasks
          .mockResolvedValueOnce([dreamerTask, artificerTask])
          .mockResolvedValueOnce([]);
        mockStateManager.acquireLease.mockResolvedValue({ ...dreamerTask, status: 'leased' });

        const orchestrator = new OrchestratorClass(
          { stateManager: mockStateManager as unknown as RuntimeStateManager },
          { owner: 'test-owner', runtimeKind: 'dreamer', dryRun: false },
        );

        const result = await orchestrator.wakeOnce();

        expect(result.decision).toBe('leased');
        expect((result as { taskId: string }).taskId).toBe('dreamer-1');
      });

      it('wakeOnce("artificer") skips blocked artificer and finds ready artificer', async () => {
        const blockedArtificer = makeRawTask({
          taskId: 'artificer-blocked',
          taskKind: 'artificer',
          status: 'pending',
          dependencyTaskIds: ['dep-1'],
        });
        const readyArtificer = makeRawTask({ taskId: 'artificer-ready', taskKind: 'artificer', status: 'pending' });
        const pendingDep = makeRawTask({ taskId: 'dep-1', status: 'pending', taskKind: 'scribe' });

        mockStateManager.listTasks
          .mockResolvedValueOnce([blockedArtificer, readyArtificer])
          .mockResolvedValueOnce([]);
        mockStateManager.getTask.mockResolvedValue(pendingDep);
        mockStateManager.acquireLease.mockResolvedValue({ ...readyArtificer, status: 'leased' });

        const orchestrator = new OrchestratorClass(
          { stateManager: mockStateManager as unknown as RuntimeStateManager },
          { owner: 'test-owner', runtimeKind: 'artificer', dryRun: false },
        );

        const result = await orchestrator.wakeOnce('artificer');

        expect(result.decision).toBe('leased');
        expect((result as { taskId: string }).taskId).toBe('artificer-ready');
      });
    });
  });

  // ── PRI-88: commitNextTaskProposal ──────────────────────────────────────────

  describe('commitNextTaskProposal (PRI-88)', () => {
     
    let createTaskFn: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.clearAllMocks();
      mockStateManager = createMockStateManager();
      createTaskFn = vi.fn();
      (mockStateManager as unknown as Record<string, unknown>).createTask = createTaskFn;
    });

    it('succeeded dreamer commit creates philosopher task', async () => {
      const succeededDreamer = makeRawTask({
        taskId: 'dreamer-1',
        taskKind: 'dreamer',
        status: 'succeeded',
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'artifact-dreamer-1' }],
      });
      mockStateManager.getTask.mockResolvedValue(succeededDreamer);
      mockStateManager.listTasks.mockResolvedValue([]);
      createTaskFn.mockResolvedValue({
        taskId: 'philosopher-dreamer-1-prompt',
        taskKind: 'philosopher',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.commitNextTaskProposal('dreamer-1');

      expect(result.decision).toBe('successor_created');
      if (result.decision === 'successor_created') {
        expect(result.sourceTaskId).toBe('dreamer-1');
        expect(result.successorKind).toBe('philosopher');
        expect(result.successorTaskId).toBe('philosopher-dreamer-1-prompt');
      }
      expect(createTaskFn).toHaveBeenCalledOnce();
    });

    it('repeated commit returns successor_exists without creating duplicate', async () => {
      const succeededDreamer = makeRawTask({
        taskId: 'dreamer-1',
        taskKind: 'dreamer',
        status: 'succeeded',
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'artifact-dreamer-1' }],
      });
      const existingPhilosopher = makeRawTask({
        taskId: 'philosopher-dreamer-1-prompt',
        taskKind: 'philosopher',
        status: 'pending',
        parentTaskId: 'dreamer-1',
        channel: 'prompt',
      });

      mockStateManager.getTask.mockResolvedValue(succeededDreamer);
      mockStateManager.listTasks.mockResolvedValue([existingPhilosopher]);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.commitNextTaskProposal('dreamer-1');

      expect(result.decision).toBe('successor_exists');
      if (result.decision === 'successor_exists') {
        expect(result.sourceTaskId).toBe('dreamer-1');
        expect(result.successorTaskId).toBe('philosopher-dreamer-1-prompt');
        expect(result.successorKind).toBe('philosopher');
      }
      expect(createTaskFn).not.toHaveBeenCalled();
    });

    it('source task not found returns task_not_found', async () => {
      mockStateManager.getTask.mockResolvedValue(null);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.commitNextTaskProposal('nonexistent');

      expect(result.decision).toBe('task_not_found');
      if (result.decision === 'task_not_found') {
        expect(result.taskId).toBe('nonexistent');
      }
    });

    it('source task not succeeded returns source_not_succeeded', async () => {
      const pendingTask = makeRawTask({
        taskId: 'dreamer-1',
        taskKind: 'dreamer',
        status: 'pending',
      });
      mockStateManager.getTask.mockResolvedValue(pendingTask);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.commitNextTaskProposal('dreamer-1');

      expect(result.decision).toBe('source_not_succeeded');
      if (result.decision === 'source_not_succeeded') {
        expect(result.taskId).toBe('dreamer-1');
        expect(result.status).toBe('pending');
      }
    });

    it('source task with invalid metadata returns invalid_task_metadata', async () => {
      const invalidTask = {
        ...makeRawTask({ taskId: 'bad-task', taskKind: 'dreamer', status: 'succeeded' }),
        diagnosticJson: '{}',
      } as TaskRecord;
      mockStateManager.getTask.mockResolvedValue(invalidTask);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.commitNextTaskProposal('bad-task');

      expect(result.decision).toBe('invalid_task_metadata');
      if (result.decision === 'invalid_task_metadata') {
        expect(result.taskId).toBe('bad-task');
      }
    });

    it('terminal runner with no successor returns no_successor', async () => {
      const succeededTrainer = makeRawTask({
        taskId: 'trainer-1',
        taskKind: 'trainer',
        status: 'succeeded',
        channel: 'model_training',
      });
      mockStateManager.getTask.mockResolvedValue(succeededTrainer);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'trainer' }
      );

      const result = await orchestrator.commitNextTaskProposal('trainer-1');

      expect(result.decision).toBe('no_successor');
      if (result.decision === 'no_successor') {
        expect(result.sourceTaskId).toBe('trainer-1');
      }
    });

    it('created successor task has correct PI metadata in diagnosticJson', async () => {
      const succeededDreamer = makeRawTask({
        taskId: 'dreamer-1',
        taskKind: 'dreamer',
        status: 'succeeded',
        channel: 'prompt',
        outputArtifactRefs: [{ artifactType: 'principle', ref: 'artifact-dreamer-1' }],
      });
      mockStateManager.getTask.mockResolvedValue(succeededDreamer);
      mockStateManager.listTasks.mockResolvedValue([]);
      createTaskFn.mockImplementation((record: Record<string, unknown>) => Promise.resolve({
        ...record,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.commitNextTaskProposal('dreamer-1');

      expect(result.decision).toBe('successor_created');
      expect(createTaskFn).toHaveBeenCalledOnce();

      const createArg = (createTaskFn.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(createArg.taskKind).toBe('philosopher');
      expect(createArg.status).toBe('pending');
      expect(createArg.diagnosticJson).toBeDefined();

      const parsed = JSON.parse(createArg.diagnosticJson as string);
      expect(parsed.pi_metadata).toBeDefined();
      expect(parsed.pi_metadata.parentTaskId).toBe('dreamer-1');
      expect(parsed.pi_metadata.dependencyTaskIds).toEqual(['dreamer-1']);
      expect(parsed.pi_metadata.channel).toBe('prompt');
      expect(parsed.pi_metadata.inputArtifactRefs).toEqual([{ artifactType: 'principle', ref: 'artifact-dreamer-1' }]);
    });
  });
});
