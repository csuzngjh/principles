/**
 * CandidateStore — in-memory test double using a Map.
 */
import type { CandidateRecord, CandidateStore } from './candidate-store.js';

export class MemoryCandidateStore implements CandidateStore {
  private readonly candidates = new Map<string, CandidateRecord>();

  /**
   * Returns candidates filtered directly by taskId field.
   * Note: SQLite version JOINs tasks→runs→commits→candidates.
   * This test double uses the denormalized taskId field directly,
   * which is equivalent in normal data flows.
   */
  async getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]> {
    return [...this.candidates.values()].filter((c) => c.taskId === taskId);
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    return this.candidates.get(candidateId) ?? null;
  }

  async updateCandidateStatus(candidateId: string, patch: { status: CandidateRecord['status'] }): Promise<boolean> {
    const existing = this.candidates.get(candidateId);
    if (!existing) return false;
    this.candidates.set(candidateId, { ...existing, status: patch.status });
    return true;
  }

  async transitionCandidateStatus(candidateId: string, expectedStatus: CandidateRecord['status'], newStatus: CandidateRecord['status']): Promise<boolean> {
    const existing = this.candidates.get(candidateId);
    if (!existing || existing.status !== expectedStatus) return false;
    this.candidates.set(candidateId, { ...existing, status: newStatus });
    return true;
  }

  insert(record: CandidateRecord): void {
    this.candidates.set(record.candidateId, record);
  }

  clear(): void {
    this.candidates.clear();
  }
}
