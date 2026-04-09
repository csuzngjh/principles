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

// ── #212: Status transition mechanism ───────────────────────────────────────

/**
 * Valid transitions in the internalization lifecycle:
 *
 * prompt_only → needs_training    (after manual validation or detectorMetadata upgrade)
 * needs_training → in_training    (training run started)
 * in_training → deployed_pending_eval  (checkpoint deployed for evaluation)
 * deployed_pending_eval → internalized (evaluation passed)
 * any → regressed                 (compliance dropped below threshold)
 * regressed → needs_training      (retraining triggered)
 */
const VALID_TRANSITIONS: Record<InternalizationStatus, InternalizationStatus[]> = {
  prompt_only: ['needs_training', 'regressed'],
  needs_training: ['in_training', 'regressed'],
  in_training: ['deployed_pending_eval', 'regressed'],
  deployed_pending_eval: ['internalized', 'regressed'],
  internalized: ['regressed'],
  regressed: ['needs_training'],
};

/**
 * Transition a principle's internalization status to the next valid state.
 * Throws if the transition is not allowed.
 *
 * #212: This enables principles created as `prompt_only` to eventually
 * become `needs_training` and enter the nocturnal evaluation pipeline.
 */
export function transitionInternalizationStatus(
  stateDir: string,
  principleId: string,
  nextStatus: InternalizationStatus,
): void {
  updateTrainingStore(stateDir, (store) => {
    const state = store[principleId];
    if (!state) {
      throw new Error(`Cannot transition: principle ${principleId} not found in training store`);
    }
    const allowed = VALID_TRANSITIONS[state.internalizationStatus] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new Error(
        `Invalid transition: ${state.internalizationStatus} → ${nextStatus}. ` +
        `Allowed: ${allowed.join(', ') || 'none (terminal state)'}`
      );
    }
    state.internalizationStatus = nextStatus;
  });
}

function ledgerTrainingStore(stateDir: string): PrincipleTrainingStore {
  return loadLedger(stateDir).trainingStore as PrincipleTrainingStore;
}
