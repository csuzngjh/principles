/**
 * Migration bridge from legacy EvolutionQueueItem to TaskRecord.
 *
 * Legacy shape (from .state/evolution-queue.json):
 * {
 *   taskId: string,
 *   status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled',
 *   taskKind: string,
 *   attemptCount: number,
 *   maxAttempts: number,
 *   inputRef?: string,
 *   resultRef?: string,
 *   lastError?: string,
 *   createdAt: string,
 *   updatedAt: string
 * }
 *
 * Target shape: TaskRecord (see task-status.ts)
 *
 * Status mapping:
 *   'pending'        → 'pending'
 *   'in_progress'   → 'leased' (old runtime had no lease concept, so in_progress = leased)
 *   'completed'     → 'succeeded'
 *   'failed'        → 'failed'
 *   'canceled'      → 'failed' (canceled maps to failed, not a separate status)
 *
 * NOT migrated (D-05: new store starts blank — no migration of existing queue data):
 *   This is a BRIDGE for dual-write compatibility, NOT actual data migration.
 *   It provides the transformation logic that adapters can use if needed.
 */
import type { TaskRecord, PDTaskStatus } from '../task-status.js';
import type { TaskStore } from './task-store.js';

export interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: string[];
}

/**
 * Migration bridge from legacy EvolutionQueueItem to TaskRecord.
 *
 * Provides the transformation logic that adapters can use to translate
 * between the legacy queue format and the new TaskRecord format.
 */
export class EvolutionQueueItemMigrator {
  constructor(private readonly taskStore: TaskStore) {}

  /**
   * Map legacy EvolutionQueueItem status to PDTaskStatus.
   * Returns null if the status is unrecognized (skip migration).
   */
  static mapLegacyStatus(legacyStatus: string): PDTaskStatus | null {
    const mapping: Record<string, PDTaskStatus> = {
      pending: 'pending',
      in_progress: 'leased',
      completed: 'succeeded',
      failed: 'failed',
      canceled: 'failed',
    };
    return mapping[legacyStatus] ?? null;
  }

  /**
   * Transform a legacy EvolutionQueueItem to TaskRecord fields.
   * Only includes fields that are safe to migrate — lease fields are NOT migrated
   * since the legacy queue had no lease concept.
   */
  static toTaskRecord(
    legacyItem: {
      taskId: string;
      taskKind: string;
      status: string;
      attemptCount?: number;
      maxAttempts?: number;
      inputRef?: string;
      resultRef?: string;
      lastError?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  ): Omit<TaskRecord, 'createdAt' | 'updatedAt'> | null {
    const newStatus = EvolutionQueueItemMigrator.mapLegacyStatus(legacyItem.status);
    if (!newStatus) return null;

    return {
      taskId: legacyItem.taskId,
      taskKind: legacyItem.taskKind,
      status: newStatus,
      attemptCount: legacyItem.attemptCount ?? 0,
      maxAttempts: legacyItem.maxAttempts ?? 3,
      inputRef: legacyItem.inputRef,
      resultRef: legacyItem.resultRef,
      lastError: legacyItem.lastError as TaskRecord['lastError'],
    };
  }

  /**
   * Migrate a single legacy item (idempotent).
   * If task already exists in store, compares updatedAt and only overwrites if legacy is newer.
   */
  async migrateOne(
    legacyItem: {
      taskId: string;
      taskKind: string;
      status: string;
      attemptCount?: number;
      maxAttempts?: number;
      inputRef?: string;
      resultRef?: string;
      lastError?: string;
      createdAt?: string;
      updatedAt?: string;
    }
  ): Promise<{ migrated: boolean; reason?: string }> {
    const record = EvolutionQueueItemMigrator.toTaskRecord(legacyItem);
    if (!record) {
      return { migrated: false, reason: 'unknown_status' };
    }

    const existing = await this.taskStore.getTask(record.taskId);
    if (existing) {
      // Idempotent: only overwrite if legacy is newer
      const legacyUpdated = legacyItem.updatedAt ? new Date(legacyItem.updatedAt) : null;
      const existingUpdated = new Date(existing.updatedAt);
      if (legacyUpdated && legacyUpdated <= existingUpdated) {
        return { migrated: false, reason: 'existing_newer' };
      }
      // Update existing record
      await this.taskStore.updateTask(record.taskId, {
        status: record.status,
        attemptCount: record.attemptCount,
        maxAttempts: record.maxAttempts,
        lastError: record.lastError,
        inputRef: record.inputRef,
        resultRef: record.resultRef,
      });
      return { migrated: true, reason: 'updated_existing' };
    }

    // Create new record
    await this.taskStore.createTask(record);
    return { migrated: true, reason: 'created_new' };
  }
}
