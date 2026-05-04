/**
 * CandidateStore — in-memory test double using a Map.
 */
import type { CandidateRecord, CandidateStore } from './candidate-store.js';

export class MemoryCandidateStore implements CandidateStore {
  private readonly candidates = new Map<string, CandidateRecord>();

  async getCandidatesByTaskId(taskId: string): Promise<CandidateRecord[]> {
    return [...this.candidates.values()].filter((c) => c.taskId === taskId);
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    return this.candidates.get(candidateId) ?? null;
  }

  insert(record: CandidateRecord): void {
    this.candidates.set(record.candidateId, record);
  }

  clear(): void {
    this.candidates.clear();
  }
}
