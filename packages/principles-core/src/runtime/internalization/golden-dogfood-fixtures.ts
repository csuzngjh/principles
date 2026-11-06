/**
 * GoldenDogfoodFixtures — static test datasets representing different pipeline states (PRI-385).
 * Free from any production secrets, tokens, or live customer workspace data.
 */

import type { LedgerPrinciple } from '../types/evidence-chain-contract.js';

export interface FixtureDataSet {
  workspaceDir: string;
  painEvents: unknown[];
  tasks: unknown[];
  candidates: unknown[];
  dreamerTasks: unknown[];
  ledgerPrinciples: LedgerPrinciple[];
  trajectoryDbAvailable: boolean;
  stateDbAvailable: boolean;
}

export const GOLDEN_FIXTURES: Record<string, FixtureDataSet> = {
  // 1. Canonical diagnosis_* task ID
  canonicalDiagnosis: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 1,
        source: 'manual',
        reason: 'Before declaring a user journey complete verify full observable product surface',
        text: 'Manual record: surface validation missing',
        created_at: '2026-06-13T10:00:00.000Z',
        score: 90,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_1',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:01:00.000Z',
        input_ref: 'pain_1',
        diagnostic_json: JSON.stringify({ rootCause: 'Verifier checks static patterns but misses real runtime load.' }),
      },
    ],
    candidates: [],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 2. Sub-run diag_router-diagnosis_* task ID (PRI-383 normalization)
  subRunDiagnosis: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: '2',
        source: 'manual',
        reason: 'Verify config file updates before committing',
        text: 'Manual record: verify config changes',
        created_at: '2026-06-13T10:02:00.000Z',
        score: 80,
      },
    ],
    tasks: [
      {
        task_id: 'diag_router-diagnosis_manual_2',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:03:00.000Z',
        input_ref: 'pain_2',
        diagnostic_json: JSON.stringify({ rootCause: 'No pre-commit hook runs pd config verification.' }),
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-subrun-2',
        task_id: 'diag_router-diagnosis_manual_2',
        title: 'Verify config changes before commit',
        description: 'Verify all config files conform to parser constraints prior to commit.',
        confidence: 0.95,
        recommendation_kind: 'principle',
      },
    ],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 3. Async pending without consumer (reason + nextAction)
  asyncPendingWithoutConsumer: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 3,
        source: 'manual',
        reason: 'Agent does not pause to clarify when command fails',
        created_at: '2026-06-13T10:04:00.000Z',
        score: 75,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_3',
        task_kind: 'diagnostician',
        status: 'pending',
        created_at: '2026-06-13T10:05:00.000Z',
        input_ref: 'pain_3',
      },
    ],
    candidates: [],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 4. Candidate generated but no dreamer task (internalization-missing)
  candidateGeneratedNoDreamer: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 4,
        source: 'manual',
        reason: 'Auto-consumer should lease tasks correctly',
        created_at: '2026-06-13T10:06:00.000Z',
        score: 70,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_4',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:07:00.000Z',
        input_ref: 'pain_4',
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-4',
        task_id: 'diagnosis_manual_4',
        title: 'Lease tasks correctly in auto-consumer',
        description: 'Prevent ready dreamer tasks from staying pending.',
        confidence: 0.85,
        recommendation_kind: 'principle',
      },
    ],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 5. Dreamer pending
  dreamerPending: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 5,
        source: 'manual',
        reason: 'Dreamer pending task scenario',
        created_at: '2026-06-13T10:08:00.000Z',
        score: 85,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_5',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:09:00.000Z',
        input_ref: 'pain_5',
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-5',
        task_id: 'diagnosis_manual_5',
        title: 'Dreamer pending title',
        description: 'Dreamer pending description',
        confidence: 0.9,
      },
    ],
    dreamerTasks: [
      {
        task_id: 'dreamer-cand-5-prompt',
        task_kind: 'dreamer',
        status: 'pending',
      },
    ],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 6. Dreamer running
  dreamerRunning: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 6,
        source: 'manual',
        reason: 'Dreamer running task scenario',
        created_at: '2026-06-13T10:10:00.000Z',
        score: 85,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_6',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:11:00.000Z',
        input_ref: 'pain_6',
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-6',
        task_id: 'diagnosis_manual_6',
        title: 'Dreamer running title',
        description: 'Dreamer running description',
        confidence: 0.9,
      },
    ],
    dreamerTasks: [
      {
        task_id: 'dreamer-cand-6-prompt',
        task_kind: 'dreamer',
        status: 'running',
      },
    ],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 7. Dreamer failed
  dreamerFailed: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 7,
        source: 'manual',
        reason: 'Dreamer failed task scenario',
        created_at: '2026-06-13T10:12:00.000Z',
        score: 85,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_7',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:13:00.000Z',
        input_ref: 'pain_7',
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-7',
        task_id: 'diagnosis_manual_7',
        title: 'Dreamer failed title',
        description: 'Dreamer failed description',
        confidence: 0.9,
      },
    ],
    dreamerTasks: [
      {
        task_id: 'dreamer-cand-7-prompt',
        task_kind: 'dreamer',
        status: 'failed',
      },
    ],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 8. Dreamer succeeded (reviewable or active in ledger)
  dreamerSucceeded: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 8,
        source: 'manual',
        reason: 'Dreamer succeeded task scenario',
        created_at: '2026-06-13T10:14:00.000Z',
        score: 85,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_8',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:15:00.000Z',
        input_ref: 'pain_8',
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-8',
        task_id: 'diagnosis_manual_8',
        title: 'Dreamer succeeded title',
        description: 'Dreamer succeeded description',
        confidence: 0.9,
      },
    ],
    dreamerTasks: [
      {
        task_id: 'dreamer-cand-8-prompt',
        task_kind: 'dreamer',
        status: 'succeeded',
      },
    ],
    ledgerPrinciples: [
      {
        id: 'principle-8',
        derivedFromPainIds: ['pain_8'],
        status: 'candidate', // owner-reviewable
        text: 'Dreamer succeeded principle text',
      },
    ],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 9. Malformed ledger / degraded diagnostic JSON
  malformedLedgerDegradedJson: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 9,
        source: 'manual',
        reason: 'Malformed data handling',
        created_at: '2026-06-13T10:16:00.000Z',
        score: 80,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_9',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:17:00.000Z',
        input_ref: 'pain_9',
        diagnostic_json: '{invalid-json}', // Degraded diagnostic_json
      },
    ],
    candidates: [],
    dreamerTasks: [],
    ledgerPrinciples: [], // missing ledger
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 10. Workspace mismatch / wrong workspace warning (per-record warning does not pollute globally)
  workspaceMismatchWarning: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 10,
        source: 'hook',
        reason: 'Workspace mismatch event',
        created_at: '2026-06-13T10:18:00.000Z',
        score: 60,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_other_999',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:00:00.000Z',
        input_ref: 'pain_999',
      },
    ],
    candidates: [],
    dreamerTasks: [],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 11. Auto-consumer: would_lease -> runner acquire real lease -> success creates successor
  autoConsumerSuccess: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 11,
        source: 'manual',
        reason: 'Auto-consumer leasing and successor creation success',
        created_at: '2026-06-13T10:20:00.000Z',
        score: 95,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_11',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:21:00.000Z',
        input_ref: 'pain_11',
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-11',
        task_id: 'diagnosis_manual_11',
        title: 'Auto-consumer successor task',
        description: 'Verifies that successor philosopher task is created after dreamer success.',
        confidence: 0.9,
      },
    ],
    dreamerTasks: [
      {
        task_id: 'dreamer-cand-11-prompt',
        task_kind: 'dreamer',
        status: 'succeeded',
      },
    ],
    ledgerPrinciples: [
      {
        id: 'principle-11',
        derivedFromPainIds: ['pain_11'],
        status: 'active',
      },
    ],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },

  // 12. Auto-consumer: would_lease -> runner acquire real lease -> failure persists detailed reason
  autoConsumerFailure: {
    workspaceDir: '/workspace/dogfood',
    painEvents: [
      {
        id: 12,
        source: 'manual',
        reason: 'Auto-consumer failure persistence check',
        created_at: '2026-06-13T10:22:00.000Z',
        score: 95,
      },
    ],
    tasks: [
      {
        task_id: 'diagnosis_manual_12',
        task_kind: 'diagnostician',
        status: 'succeeded',
        created_at: '2026-06-13T10:23:00.000Z',
        input_ref: 'pain_12',
      },
    ],
    candidates: [
      {
        candidate_id: 'cand-12',
        task_id: 'diagnosis_manual_12',
        title: 'Auto-consumer failure details',
        description: 'Dreamer failed task description',
        confidence: 0.9,
      },
    ],
    dreamerTasks: [
      {
        task_id: 'dreamer-cand-12-prompt',
        task_kind: 'dreamer',
        status: 'failed',
      },
    ],
    ledgerPrinciples: [],
    trajectoryDbAvailable: true,
    stateDbAvailable: true,
  },
};
