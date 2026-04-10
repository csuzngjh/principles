/**
 * Principle Tree Migration — Migrates trainingStore to tree.principles
 *
 * This migration handles the Phase 11 gap: existing principles in trainingStore
 * were never written to tree.principles, blocking the Rule/Implementation layer.
 *
 * Usage:
 *   - Called automatically by migratePrincipleTree() during plugin initialization
 *   - Or run manually: node scripts/migrate-principle-tree.mjs <workspace-dir>
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  loadLedger,
  createPrinciple,
  type LedgerPrinciple,
} from './principle-tree-ledger.js';
import type { LegacyPrincipleTrainingState } from './principle-tree-ledger.js';
import { SystemLogger } from './system-logger.js';

export interface PrincipleTreeMigrationResult {
  migratedCount: number;
  skippedCount: number;
  errorCount: number;
  details: Array<{
    principleId: string;
    status: 'migrated' | 'skipped' | 'error';
    reason?: string;
  }>;
}

/**
 * Check if migration is needed by comparing trainingStore and tree.principles
 */
export function needsMigration(stateDir: string): boolean {
  const ledger = loadLedger(stateDir);
  return Object.keys(ledger.trainingStore).some((principleId) => !ledger.tree.principles[principleId]);
}

/**
 * Create a minimal LedgerPrinciple from LegacyPrincipleTrainingState
 */
function trainingStateToTreePrinciple(
  principleId: string,
  state: LegacyPrincipleTrainingState,
  now: string
): LedgerPrinciple {
  return {
    id: principleId,
    version: 1,
    text: `Principle ${principleId}`, // Minimal text, will be enriched from PRINCIPLES.md if available
    triggerPattern: '', // Unknown from legacy data
    action: '', // Unknown from legacy data
    status: mapInternalizationStatusToPrincipleStatus(state.internalizationStatus),
    priority: 'P1', // Default priority
    scope: 'general',
    evaluability: state.evaluability,
    valueScore: 0,
    adherenceRate: state.complianceRate * 100, // Convert 0-1 to 0-100
    painPreventedCount: 0,
    derivedFromPainIds: [],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Map internalization status to principle status
 */
function mapInternalizationStatusToPrincipleStatus(
  status: LegacyPrincipleTrainingState['internalizationStatus']
): 'candidate' | 'active' | 'deprecated' {
  switch (status) {
    case 'internalized':
    case 'deployed_pending_eval':
      return 'active';
    case 'regressed':
    case 'needs_training':
      return 'candidate';
    case 'prompt_only':
    case 'in_training':
      return 'candidate';
    default:
      return 'candidate';
  }
}

/**
 * Migrate trainingStore principles to tree.principles
 *
 * This function is idempotent: it only migrates principles that don't exist
 * in tree.principles yet.
 */
export function migratePrincipleTree(
  stateDir: string,
  workspaceDir?: string
): PrincipleTreeMigrationResult {
  const result: PrincipleTreeMigrationResult = {
    migratedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    details: [],
  };

  try {
    const ledger = loadLedger(stateDir);
    const now = new Date().toISOString();

    for (const [principleId, state] of Object.entries(ledger.trainingStore)) {
      // Skip if already exists in tree.principles
      if (ledger.tree.principles[principleId]) {
        result.skippedCount++;
        result.details.push({
          principleId,
          status: 'skipped',
          reason: 'Already exists in tree.principles',
        });
        continue;
      }

      try {
        const treePrinciple = trainingStateToTreePrinciple(principleId, state, now);
        createPrinciple(stateDir, treePrinciple);

        result.migratedCount++;
        result.details.push({
          principleId,
          status: 'migrated',
        });

        if (workspaceDir) {
          SystemLogger.log(
            workspaceDir,
            'PRINCIPLE_TREE_MIGRATED',
            `Migrated ${principleId} from trainingStore to tree.principles`
          );
        }
      } catch (err) {
        result.errorCount++;
        result.details.push({
          principleId,
          status: 'error',
          reason: String(err),
        });

        if (workspaceDir) {
          SystemLogger.log(
            workspaceDir,
            'PRINCIPLE_TREE_MIGRATION_ERROR',
            `Failed to migrate ${principleId}: ${String(err)}`
          );
        }
      }
    }

    if (workspaceDir && result.migratedCount > 0) {
      SystemLogger.log(
        workspaceDir,
        'PRINCIPLE_TREE_MIGRATION_COMPLETE',
        `Migrated ${result.migratedCount} principles to tree.principles (${result.skippedCount} skipped, ${result.errorCount} errors)`
      );
    }
  } catch (err) {
    if (workspaceDir) {
      SystemLogger.log(
        workspaceDir,
        'PRINCIPLE_TREE_MIGRATION_FAILED',
        `Migration failed: ${String(err)}`
      );
    }
  }

  return result;
}

/**
 * Run migration if needed (called during plugin initialization)
 */
export function runMigrationIfNeeded(
  stateDir: string,
  workspaceDir?: string
): PrincipleTreeMigrationResult | null {
  if (!needsMigration(stateDir)) {
    return null;
  }

  return migratePrincipleTree(stateDir, workspaceDir);
}
