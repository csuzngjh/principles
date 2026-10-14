/**
 * CandidateStore — in-memory test double using a Map.
 */
import type { CandidateRecord, CandidateStore } from './candidate-store.js';
import {
  appendAdmissionEvaluation,
  withProcessing,
  type AdmissionEvaluationRecord,
  type AdmissionProcessingRecord,
  type CandidateAdmissionDocument,
} from './admission-document.js';

export class MemoryCandidateStore implements CandidateStore {
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly admissions = new Map<string, CandidateAdmissionDocument | null>();

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

  async getAdmissionDocument(candidateId: string): Promise<
    { ok: true; document: CandidateAdmissionDocument | null } | { ok: false; reason: string }
  > {
    if (!this.candidates.has(candidateId)) return { ok: false, reason: 'candidate_not_found' };
    return { ok: true, document: this.admissions.get(candidateId) ?? null };
  }

  async appendAdmissionEvaluation(candidateId: string, evaluation: AdmissionEvaluationRecord): Promise<
    { status: 'appended' | 'reused'; document: CandidateAdmissionDocument } | { status: 'refused'; reason: string }
  > {
    if (!this.candidates.has(candidateId)) return { status: 'refused', reason: 'candidate_not_found' };
    const existing = this.admissions.get(candidateId) ?? null;
    const result = appendAdmissionEvaluation(existing, evaluation);
    if (result.status === 'refused') return result;
    this.admissions.set(candidateId, result.document);
    return { status: result.status, document: result.document };
  }

  async updateAdmissionProcessing(candidateId: string, processing: AdmissionProcessingRecord): Promise<boolean> {
    if (!this.candidates.has(candidateId)) return false;
    const existing = this.admissions.get(candidateId) ?? null;
    this.admissions.set(candidateId, withProcessing(existing, processing));
    return true;
  }

  listDiagnosisPostProcessingBacklog(options: { limit: number; nowIso?: string }): {
    eligible: { candidateId: string; taskId: string; status: string; createdAt: string; processingState: string | null }[];
    corrupt: { candidateId: string; taskId: string; status: string; createdAt: string }[];
  } {
    const nowMs = options.nowIso !== undefined ? Date.parse(options.nowIso) : Date.now();
    const eligible: { candidateId: string; taskId: string; status: string; createdAt: string; processingState: string | null }[] = [];
    const corrupt: { candidateId: string; taskId: string; status: string; createdAt: string }[] = [];
    for (const candidate of this.candidates.values()) {
      const document = this.admissions.get(candidate.candidateId) ?? null;
      const state = document?.processing?.state ?? null;
      const terminal = state === 'complete' || state === 'awaiting_owner' || state === 'exhausted';
      if (terminal) continue;
      const openProcessing = document !== null
        && (state === 'not_started' || state === 'in_progress')
        && (document.processing?.nextRetryAt === undefined || Date.parse(document.processing.nextRetryAt) <= nowMs);
      if (document === null && (candidate.status === 'pending' || candidate.status === 'consumed')) {
        eligible.push({ candidateId: candidate.candidateId, taskId: candidate.taskId, status: candidate.status, createdAt: candidate.createdAt, processingState: null });
      } else if (openProcessing) {
        eligible.push({ candidateId: candidate.candidateId, taskId: candidate.taskId, status: candidate.status, createdAt: candidate.createdAt, processingState: state });
      }
    }
    eligible.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { eligible: eligible.slice(0, options.limit), corrupt };
  }

  insert(record: CandidateRecord): void {
    this.candidates.set(record.candidateId, record);
  }

  clear(): void {
    this.candidates.clear();
    this.admissions.clear();
  }
}
