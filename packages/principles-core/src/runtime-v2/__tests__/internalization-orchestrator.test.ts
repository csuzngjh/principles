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
  } as unknown as TaskRecord;
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
  // eslint-disable-next-line @typescript-eslint/init-declarations
  let mockStateManager: ReturnType<typeof createMockStateManager>;
   
   
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports,@typescript-eslint/init-declarations
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
      mockStateManager.listTasks.mockResolvedValue([rawTask]);
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

    // ── Test 2: pending + dep pending → blocked ──────────────────────────────

    it('pending PI task with a pending dependency returns blocked and does not acquire lease', async () => {
      const rawTask = makeRawTask({
        taskId: 'pi-task-2',
        taskKind: 'philosopher',
        status: 'pending',
        dependencyTaskIds: ['dep-task-1'],
      });
      const depTask = makeRawTask({ taskId: 'dep-task-1', status: 'pending', taskKind: 'dreamer' });

      mockStateManager.listTasks.mockResolvedValue([rawTask]);
      mockStateManager.getTask.mockResolvedValue(depTask);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'philosopher' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('blocked');
      expect((result as { blockedBy: string[] }).blockedBy).toContain('dep-task-1');
      expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
    });

    // ── Test 3: dependency failed → dependency_failed ─────────────────────────

    it('dependency in failed status returns dependency_failed and does not mutate task', async () => {
      const rawTask = makeRawTask({
        taskId: 'pi-task-3',
        taskKind: 'scribe',
        status: 'pending',
        dependencyTaskIds: ['failed-dep'],
      });
      const failedDep = makeRawTask({ taskId: 'failed-dep', status: 'failed', taskKind: 'dreamer' });

      mockStateManager.listTasks.mockResolvedValue([rawTask]);
      mockStateManager.getTask.mockResolvedValue(failedDep);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'scribe' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('dependency_failed');
      expect((result as { failedDependencies: string[] }).failedDependencies).toContain('failed-dep');
      expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
    });

    // ── Test 4: invalid PITask metadata → invalid_task_metadata ─────────────

    it('task with invalid/missing PITask metadata returns invalid_task_metadata and does not mutate', async () => {
      const invalidTask = {
        ...makeRawTask({ taskId: 'bad-task' }),
        diagnosticJson: '{}', // missing pi_metadata key
      } as TaskRecord;

      mockStateManager.listTasks.mockResolvedValue([invalidTask]);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'dreamer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('invalid_task_metadata');
      expect((result as { taskId: string }).taskId).toBe('bad-task');
      expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
    });

    // ── Test 5: lease conflict → lease_conflict (structured, no mark failed) ──

    it('lease conflict returns structured lease_conflict without calling markTaskFailed', async () => {
      const rawTask = makeRawTask({ taskId: 'conflict-task', taskKind: 'artificer', status: 'pending' });
      mockStateManager.listTasks.mockResolvedValue([rawTask]);
      mockStateManager.acquireLease.mockRejectedValue(
        new PDRuntimeError('lease_conflict', 'Task conflict-task is already leased')
      );

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'artificer' }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('lease_conflict');
      expect((result as { taskId: string }).taskId).toBe('conflict-task');
      expect((result as { conflictReason: string }).conflictReason).toBeTruthy();
    });

    // ── Test 6: dryRun=true → would_lease (no actual lease) ─────────────────

    it('dryRun=true returns would_lease without acquiring the lease', async () => {
      const rawTask = makeRawTask({ taskId: 'dryrun-task', taskKind: 'evaluator', status: 'pending' });
      mockStateManager.listTasks.mockResolvedValue([rawTask]);

      const orchestrator = new OrchestratorClass(
        { stateManager: mockStateManager as unknown as RuntimeStateManager },
        { owner: 'test-owner', runtimeKind: 'evaluator', dryRun: true }
      );

      const result = await orchestrator.wakeOnce();

      expect(result.decision).toBe('would_lease');
      expect((result as { taskId: string }).taskId).toBe('dryrun-task');
      expect(mockStateManager.acquireLease).not.toHaveBeenCalled();
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

    // ── Test 8: architecture guard — no forbidden imports ────────────────────

    it('orchestrator source has zero forbidden imports (no openclaw-plugin, scheduling, or runtime adapter)', async () => {
      const clean = await moduleHasNoForbiddenImports('internalization/internalization-orchestrator.ts');
      expect(clean).toBe(true);
    });
  });
});
