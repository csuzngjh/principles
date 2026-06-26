/**
 * IntentDecisionModel — Console model for IntentDecisionRecord (PRI-470).
 *
 * Holds the workspaceDir (like ApprovalsConsoleModel) and opens a per-request
 * SqliteConnection inside each method: open → delegate to SqliteIntentDecisionStore
 * → close. This keeps each operation isolated and safe across workspaces.
 *
 * Graceful degradation (SPEC §21.7 / ERR-002):
 * - Missing state.db → reads return null/empty/zero summary; writes return a
 *   structured `not_initialized` result so the route can map to a clear HTTP
 *   error instead of silently creating a half-initialized workspace.
 * - Missing intent_decisions table → reads degrade to empty; writes re-throw
 *   (the table is created by SqliteConnection.initSchema, so its absence
 *   signals a corrupted or pre-PD workspace that should not be written to).
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: store rows validated via core type guards
 * - EP-03 / ERR-002: every degraded path carries reason + nextAction
 * - EP-09: model is a thin I/O adapter over the pure store contract
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SqliteConnection,
  SqliteIntentDecisionStore,
} from '@principles/core/runtime-v2';
import type {
  IntentDecisionInput,
  IntentDecisionRecord,
  IntentDecisionRecordResult,
  IntentDecisionSummary,
} from '@principles/core/runtime-v2';

function stateDbExists(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'));
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

export type IntentDecisionRecordResultModel =
  | { ok: true; record: IntentDecisionRecord; created: boolean }
  | { ok: false; reason: string; nextAction: string };

function emptySummary(): IntentDecisionSummary {
  return {
    counts: {
      confirm_drift: 0,
      revise_intent: 0,
      observe: 0,
      dismiss: 0,
      promote_to_principle: 0,
      promote_to_rulehost: 0,
    },
    lastDecisionAt: null,
  };
}

export class IntentDecisionModel {
  constructor(private readonly workspaceDir: string) {}

  async record(input: IntentDecisionInput): Promise<IntentDecisionRecordResultModel> {
    if (!stateDbExists(this.workspaceDir)) {
      return {
        ok: false,
        reason: 'state_db_not_found',
        nextAction: 'Initialize the workspace with PD (run a diagnosis or pd config) before recording intent decisions.',
      };
    }
    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir });
    try {
      const store = new SqliteIntentDecisionStore(connection);
      const result: IntentDecisionRecordResult = await store.record(input);
      return { ok: true, record: result.record, created: result.created };
    } catch (err: unknown) {
      if (isMissingTableError(err)) {
        return {
          ok: false,
          reason: 'intent_decisions_table_missing',
          nextAction: 'Run pd config doctor or re-initialize the workspace so the intent_decisions table is created.',
        };
      }
      throw err;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  async getById(id: string): Promise<IntentDecisionRecord | null> {
    if (!stateDbExists(this.workspaceDir)) return null;
    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const store = new SqliteIntentDecisionStore(connection);
      return await store.getById(id);
    } catch (err: unknown) {
      if (isMissingTableError(err)) return null;
      throw err;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  async listByPainId(painId: string): Promise<IntentDecisionRecord[]> {
    if (!stateDbExists(this.workspaceDir)) return [];
    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const store = new SqliteIntentDecisionStore(connection);
      return await store.listByPainId(painId);
    } catch (err: unknown) {
      if (isMissingTableError(err)) return [];
      throw err;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  async listByTaskId(taskId: string): Promise<IntentDecisionRecord[]> {
    if (!stateDbExists(this.workspaceDir)) return [];
    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const store = new SqliteIntentDecisionStore(connection);
      return await store.listByTaskId(taskId);
    } catch (err: unknown) {
      if (isMissingTableError(err)) return [];
      throw err;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }

  async getSummary(): Promise<IntentDecisionSummary> {
    if (!stateDbExists(this.workspaceDir)) return emptySummary();
    const connection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const store = new SqliteIntentDecisionStore(connection);
      return await store.getSummary();
    } catch (err: unknown) {
      if (isMissingTableError(err)) return emptySummary();
      throw err;
    } finally {
      try { connection.close(); } catch { /* best-effort */ }
    }
  }
}
