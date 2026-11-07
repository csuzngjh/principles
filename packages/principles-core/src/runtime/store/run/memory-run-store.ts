/**
 * RunStore — in-memory test double using a Map.
 */
import type { RunRecord, RunStore, TolerantRunListResult } from './run-store.js';

export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>();

  async createRun(record: Omit<RunRecord, 'createdAt' | 'updatedAt'>): Promise<RunRecord> {
    const now = new Date().toISOString();
    const full: RunRecord = { ...record, createdAt: now, updatedAt: now };
    this.runs.set(record.runId, full);
    return full;
  }

  async listRunsByTask(taskId: string): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((r) => r.taskId === taskId);
  }

  async listValidRunsByTaskTolerant(taskId: string): Promise<TolerantRunListResult> {
    // In-memory store only ever holds schema-valid RunRecords, so there are
    // never any degraded rows. The tolerant contract is preserved for callers.
    return { runs: await this.listRunsByTask(taskId), degradedRuns: [] };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async updateRun(
    runId: string,
    patch: Partial<Pick<RunRecord, 'endedAt' | 'reason' | 'outputRef' | 'outputPayload' | 'errorCategory' | 'executionStatus'>>,
  ): Promise<RunRecord> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`Run not found: ${runId}`);
    const updated: RunRecord = { ...existing, ...patch };
    this.runs.set(runId, updated);
    return updated;
  }

  async deleteRun(runId: string): Promise<boolean> {
    return this.runs.delete(runId);
  }

  insert(record: RunRecord): void {
    this.runs.set(record.runId, record);
  }

  clear(): void {
    this.runs.clear();
  }
}
