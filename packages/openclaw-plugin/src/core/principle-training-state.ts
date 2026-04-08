/**
 * Principle Training State Store
 * ================================================================
 *
 * Legacy compatibility adapter over the hybrid principle tree ledger file.
 * Top-level principle training records remain source-compatible for existing
 * consumers, while `_tree` is reserved for first-class Rule/Implementation
 * entities managed by principle-tree-ledger.ts.
 */

import {
  loadLedger,
  saveLedger,
  saveLedgerAsync,
  updateTrainingStore,
  type LegacyPrincipleTrainingStore,
} from './principle-tree-ledger.js';
import type { PrincipleEvaluatorLevel } from './evolution-types.js';

/** File name for principle training state persistence */
export const PRINCIPLE_TRAINING_FILE = 'principle_training_state.json';

export type InternalizationStatus =
  | 'prompt_only'
  | 'needs_training'
  | 'in_training'
  | 'deployed_pending_eval'
  | 'internalized'
  | 'regressed';

export interface PrincipleTrainingState {
  principleId: string;
  evaluability: PrincipleEvaluatorLevel;
  applicableOpportunityCount: number;
  observedViolationCount: number;
  complianceRate: number;
  violationTrend: number;
  generatedSampleCount: number;
  approvedSampleCount: number;
  includedTrainRunIds: string[];
  deployedCheckpointIds: string[];
  lastEvalScore?: number;
  internalizationStatus: InternalizationStatus;
}

export type PrincipleTrainingStore = Record<string, PrincipleTrainingState>;

export function createDefaultPrincipleState(principleId: string): PrincipleTrainingState {
  return {
    principleId,
    evaluability: 'manual_only',
    applicableOpportunityCount: 0,
    observedViolationCount: 0,
    complianceRate: 0,
    violationTrend: 0,
    generatedSampleCount: 0,
    approvedSampleCount: 0,
    includedTrainRunIds: [],
    deployedCheckpointIds: [],
    internalizationStatus: 'prompt_only',
  };
}

export function loadStore(stateDir: string): PrincipleTrainingStore {
  return ledgerTrainingStore(stateDir);
}

export function saveStore(stateDir: string, store: PrincipleTrainingStore): void {
  const ledger = loadLedger(stateDir);
  saveLedger(stateDir, {
    ...ledger,
    trainingStore: store as LegacyPrincipleTrainingStore,
  });
}

export async function loadStoreAsync(stateDir: string): Promise<PrincipleTrainingStore> {
  return ledgerTrainingStore(stateDir);
}

export async function saveStoreAsync(stateDir: string, store: PrincipleTrainingStore): Promise<void> {
  const ledger = loadLedger(stateDir);
  await saveLedgerAsync(stateDir, {
    ...ledger,
    trainingStore: store as LegacyPrincipleTrainingStore,
  });
}

export function getPrincipleState(stateDir: string, principleId: string): PrincipleTrainingState {
  const store = loadStore(stateDir);
  return store[principleId] ?? createDefaultPrincipleState(principleId);
}

export function setPrincipleState(stateDir: string, state: PrincipleTrainingState): void {
  updateTrainingStore(stateDir, (store) => {
    store[state.principleId] = state;
  });
}

export function removePrincipleState(stateDir: string, principleId: string): void {
  updateTrainingStore(stateDir, (store) => {
    delete store[principleId];
  });
}

export function listPrincipleIds(stateDir: string): string[] {
  return Object.keys(loadStore(stateDir));
}

export function listPrinciplesByStatus(
  stateDir: string,
  status: InternalizationStatus,
): PrincipleTrainingState[] {
  return Object.values(loadStore(stateDir)).filter((state) => state.internalizationStatus === status);
}

export function listEvaluablePrinciples(stateDir: string): PrincipleTrainingState[] {
  return Object.values(loadStore(stateDir)).filter(
    (state) => state.evaluability !== 'manual_only' && state.internalizationStatus !== 'prompt_only',
  );
}

function ledgerTrainingStore(stateDir: string): PrincipleTrainingStore {
  return loadLedger(stateDir).trainingStore as PrincipleTrainingStore;
}
