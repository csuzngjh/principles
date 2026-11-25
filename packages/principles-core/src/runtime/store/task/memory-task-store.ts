/**
 * TaskStore — in-memory test double using a Map.
 */
import type { TaskRecord } from '../../task-status.js';
import type { TaskStore, TaskStoreFilter, TaskStoreUpdatePatch } from './task-store.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PRI-1274 (B1 / P1-3): the admission-disposition state from the task's
 * `diagnostic_json.recovery.state`, or null when absent/unparseable — the
 * memory-store twin of SQLite's `json_extract(... , '$.recovery.state')`. */
function readRecoveryStateFromDiagnosticJson(diagnosticJson: string | null | undefined): string | null {
  if (typeof diagnosticJson !== 'string' || diagnosticJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (!isPlainObject(parsed)) return null;
    const { recovery } = parsed;
    if (!isPlainObject(recovery)) return null;
    const { state } = recovery;
    return typeof state === 'string' ? state : null;
  } catch {
    return null;
  }
}

function readDiagnosticHostKind(diagnosticJson: string | null | undefined): string | null {
  if (typeof diagnosticJson !== 'string' || diagnosticJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(diagnosticJson);
    if (!isPlainObject(parsed)) return null;
    return typeof parsed.hostKind === 'string' ? parsed.hostKind : null;
  } catch {
    return null;
  }
}

export class MemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const full: TaskRecord = {
      ...record,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(record.taskId, full);
    return full;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async updateTask(taskId: string, patch: TaskStoreUpdatePatch): Promise<TaskRecord> {
    const existing = this.tasks.get(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    const updated: TaskRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    } as TaskRecord;
    this.tasks.set(taskId, updated);
    return updated;
  }

  // eslint-disable-next-line @typescript-eslint/max-params -- the 4th parameter is a CAS PRECONDITION (SPEC-PD-IAER-001 §6.3), not write payload: folding it into the patch type would let it leak into TaskRecord on unconditional updateTask paths.
  async updateTaskIfDiagnosticJsonUnchanged(
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: TaskStoreUpdatePatch,
    options?: {
      readonly expectedStatus?: string;
      readonly expectedAttemptCount?: number;
      readonly expectedMaxAttempts?: number;
      readonly expectedLeaseOwner?: string | null;
      readonly expectedLeaseExpiresAt?: string | null;
      readonly expectedLeaseGeneration?: number;
    },
  ): Promise<TaskRecord | null> {
    const existing = this.tasks.get(taskId);
    if (!existing) return null;
    if ((existing.diagnosticJson ?? null) !== expectedDiagnosticJson) return null;
    // PRI-983 (SPEC §6.3): parity with SqliteTaskStore's expected-status
    // precondition — content-neutral resets must still arbitrate on status.
    if (options?.expectedStatus !== undefined && existing.status !== options.expectedStatus) return null;
    // PRI-991 (P1-04): parity with SqliteTaskStore's full decision-snapshot
    // preconditions (undefined = not asserted; null = assert NULL).
    if (options?.expectedAttemptCount !== undefined && existing.attemptCount !== options.expectedAttemptCount) return null;
    if (options?.expectedMaxAttempts !== undefined && existing.maxAttempts !== options.expectedMaxAttempts) return null;
    if (options?.expectedLeaseOwner !== undefined && (existing.leaseOwner ?? null) !== options.expectedLeaseOwner) return null;
    if (options?.expectedLeaseExpiresAt !== undefined && (existing.leaseExpiresAt ?? null) !== options.expectedLeaseExpiresAt) return null;
    // PRI-1274 review round 2 (directive G1): generation fencing parity —
    // legacy rows without a generation read as 0 through TaskRecord.
    if (options?.expectedLeaseGeneration !== undefined && (existing.leaseGeneration ?? 0) !== options.expectedLeaseGeneration) return null;
    return this.updateTask(taskId, patch);
  }

  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    let results = [...this.tasks.values()];
    if (filter?.status) results = results.filter((t) => t.status === filter.status);
    if (filter?.taskKind) results = results.filter((t) => t.taskKind === filter.taskKind);
    // PRI-1274 (B1 / P1-3): parity with SqliteTaskStore's admission-disposition
    // gating — applied BEFORE the sort/limit cut, exactly like the SQL WHERE
    // clause sits before ORDER BY/LIMIT. Unparseable JSON means "no state".
    if (filter?.recoveryState !== undefined) {
      results = results.filter((t) => readRecoveryStateFromDiagnosticJson(t.diagnosticJson) === filter.recoveryState);
    }
    if (filter?.excludeRecoveryStates !== undefined && filter.excludeRecoveryStates.length > 0) {
      const excluded = new Set<string>(filter.excludeRecoveryStates);
      results = results.filter((t) => !excluded.has(readRecoveryStateFromDiagnosticJson(t.diagnosticJson) ?? ''));
    }
    if (filter?.diagnosticHostKind !== undefined) {
      results = results.filter((t) => readDiagnosticHostKind(t.diagnosticJson) === filter.diagnosticHostKind);
    }
    // Parity with SqliteTaskStore (A-liveness): silently ignoring
    // orderBy/afterCursor here would make cursor-based scans return wrong
    // pages under the memory store — a rc-9 silent degradation.
    if (filter?.afterCursor) {
      if (filter.orderBy !== 'updated_at_asc' && filter.orderBy !== 'updated_at_desc') {
        throw new Error('MemoryTaskStore.listTasks: afterCursor requires orderBy updated_at_asc|desc');
      }
      const { updatedAt, taskId } = filter.afterCursor;
      results = results.filter((t) => filter.orderBy === 'updated_at_asc'
        ? (t.updatedAt > updatedAt || (t.updatedAt === updatedAt && t.taskId > taskId))
        : (t.updatedAt < updatedAt || (t.updatedAt === updatedAt && t.taskId < taskId)));
    }
    if (filter?.orderBy === 'updated_at_asc') {
      results.sort((a, b) => a.updatedAt === b.updatedAt ? (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0) : (a.updatedAt < b.updatedAt ? -1 : 1));
    } else if (filter?.orderBy === 'updated_at_desc') {
      results.sort((a, b) => a.updatedAt === b.updatedAt ? (a.taskId < b.taskId ? 1 : a.taskId > b.taskId ? -1 : 0) : (a.updatedAt > b.updatedAt ? -1 : 1));
    }
    if (filter?.offset) results = results.slice(filter.offset);
    if (filter?.limit) results = results.slice(0, filter.limit);
    return results;
  }

  async deleteTask(taskId: string): Promise<boolean> {
    return this.tasks.delete(taskId);
  }

  clear(): void {
    this.tasks.clear();
  }
}
