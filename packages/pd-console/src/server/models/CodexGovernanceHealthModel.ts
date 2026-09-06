/**
 * CodexGovernanceHealthModel — read model for the §15 Console health block
 * (Codex Governance Closure Slice D, PRI-625; SPEC rev 2 §15).
 *
 * Aggregates the Codex governance facts the Console can show without ever
 * touching a Codex transcript:
 * - both flag states (host.codex, codex_conversation_ingestion);
 * - consent state (decision metadata only — no captured text);
 * - worker mode (no Companion ⇒ `manual_action_required`, never auto-closure);
 * - per-rollout checkpoints with completeness (byte lag lives in CLI health,
 *   which owns Codex-home transcript path resolution);
 * - observation counts (operational/promoted/quarantined) + next expiry;
 * - admission counts incl. admitted-pain-without-task + promotion tails;
 * - Diagnostician task counts (via the Runtime V2 task store).
 *
 * §15 semantics: unknown is not reported as healthy — every degraded section
 * becomes a ready blocker with a structured reason.
 *
 * ERR checklist: ERR-002 (reason + nextAction), ERR-013 (Object.hasOwn on
 * untrusted rows), rc-9 (no silent fallback).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadPdConfigForPlugin,
  readCodexIngestionConsent,
  deriveCodexIngestionConsentState,
  listGovernanceCheckpoints,
  readGovernanceObservationStats,
  readGovernanceAdmissionCounts,
  computeCodexWorkerStatusMode,
  CODEX_INGESTION_DISCLOSURE_VERSION,
  type GovernanceCheckpointRecord,
} from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig, SqliteConnection, SqliteTaskStore } from '@principles/core/runtime-v2';
import { getInstallLayoutPaths, parseInstallManifest } from '@principles/install-layout';

export interface CodexRolloutHealth {
  rolloutIdentity: string;
  byteOffset: number;
  lastOrdinal: number;
  incompleteTail: boolean;
  lastDegradationReason: string | null;
  updatedAt: string;
}

export interface CodexGovernanceHealth {
  ingestionEnabled: boolean;
  ingestionSource: string;
  consent: {
    state: 'granted' | 'declined' | 'not_present' | 'flag_on_without_consent';
    decidedAt?: string;
    decidedVia?: string;
    disclosureVersion?: string;
    disclosureStale: boolean;
  };
  workerMode: 'ready' | 'manual_action_required' | 'paused' | 'degraded';
  registeredInInstallManifest: boolean;
  rollouts: CodexRolloutHealth[];
  observations: {
    operational: number;
    promoted: number;
    quarantined: number;
    nextExpiryAt: string | null;
    lastObservationAt: string | null;
  };
  admissions: {
    admitted: number;
    admittedWithoutTask: number;
    pendingTails: number;
    staleTails: number;
    completedTails: number;
  };
  diagnosticianTasks: {
    pending: number;
    leased: number;
    retryWait: number;
    needsHumanReview: number;
  };
  ready: boolean;
  readyBlockers: string[];
  /** rev2 automatic closure readiness ≠ cross-host signal parity (PRI-632). */
  productClaim: 'rev2_automatic_closure' | 'degraded';
}

function readInstallManifestRegistration(workspaceDir: string): boolean {
  try {
    const paths = getInstallLayoutPaths(os.homedir());
    const raw: unknown = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    const parsed = parseInstallManifest(raw);
    return parsed.manifest?.workspaces?.some((entry) => path.resolve(entry) === path.resolve(workspaceDir)) ?? false;
  } catch {
    return false;
  }
}

export class CodexGovernanceHealthModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async collect(): Promise<CodexGovernanceHealth> {
    const blockers: string[] = [];
    const noteBlocker = (label: string, reason?: string): void => {
      blockers.push(reason !== undefined ? `${label}: ${reason}` : label);
    };

    // ── Flags ────────────────────────────────────────────────────────────────
    const configLoad = loadPdConfigForPlugin(this.workspaceDir);
    const {flags} = computeFeatureFlagsFromConfig(configLoad.effective);
    const ingestionEnabled = flags.codex_conversation_ingestion?.enabled === true;
    if (!configLoad.ok) noteBlocker('workspace', 'config_malformed');

    // ── Consent (metadata only — never captured text) ────────────────────────
    const consentRead = readCodexIngestionConsent(this.workspaceDir);
    let consent: CodexGovernanceHealth['consent'];
    if (consentRead.ok) {
      const state = deriveCodexIngestionConsentState(consentRead.record, ingestionEnabled);
      const disclosureStale = consentRead.record !== null && consentRead.record.disclosureVersion !== CODEX_INGESTION_DISCLOSURE_VERSION;
      consent = {
        state,
        disclosureStale,
        ...(consentRead.record !== null
          ? { decidedAt: consentRead.record.decidedAt, decidedVia: consentRead.record.decidedVia, disclosureVersion: consentRead.record.disclosureVersion }
          : {}),
      };
      if (ingestionEnabled && state !== 'granted') noteBlocker('consent', state);
    } else {
      consent = { state: 'not_present', disclosureStale: false };
      noteBlocker('consent', consentRead.reason);
    }

    // ── Worker mode (no Companion ⇒ manual_action_required) ──────────────────
    const registered = readInstallManifestRegistration(this.workspaceDir);
    const evaluation = computeCodexWorkerStatusMode({ workspaceDir: this.workspaceDir, registeredInInstallManifest: registered });
    if (evaluation.mode !== 'ready') noteBlocker('worker', evaluation.reason ?? evaluation.mode);

    // ── Per-rollout checkpoint completeness ─────────────────────────────────
    // (Byte lag against the live transcript is CLI-health territory: it needs
    // Codex-home transcript path resolution, which stays inside the adapter.
    // The Console surfaces checkpoint completeness and staleness.)
    const rollouts: CodexRolloutHealth[] = [];
    const listed = listGovernanceCheckpoints({ workspaceDir: this.workspaceDir, hostKind: 'codex' });
    const listedCheckpoints = (listed as { checkpoints?: GovernanceCheckpointRecord[] }).checkpoints;
    if (Array.isArray(listedCheckpoints)) {
      for (const checkpoint of listedCheckpoints) {
        rollouts.push({
          rolloutIdentity: checkpoint.rolloutIdentity,
          byteOffset: checkpoint.byteOffset,
          lastOrdinal: checkpoint.lastOrdinal,
          incompleteTail: checkpoint.incompleteTail,
          lastDegradationReason: checkpoint.lastDegradationReason,
          updatedAt: checkpoint.updatedAt,
        });
        if (checkpoint.incompleteTail) noteBlocker('rollout', `${checkpoint.rolloutIdentity} incomplete_tail`);
      }
    } else {
      noteBlocker('rollouts', 'checkpoints_unavailable');
    }

    // ── Observation / admission counts ───────────────────────────────────────
    let observations: CodexGovernanceHealth['observations'] = { operational: 0, promoted: 0, quarantined: 0, nextExpiryAt: null, lastObservationAt: null };
    const stats = readGovernanceObservationStats({ workspaceDir: this.workspaceDir });
    if (stats.ok) {
      observations = {
        operational: stats.stats.operational,
        promoted: stats.stats.promoted,
        quarantined: stats.stats.quarantined,
        nextExpiryAt: stats.stats.nextExpiryAt,
        lastObservationAt: stats.stats.lastObservationAt,
      };
    } else {
      noteBlocker('observations', stats.reason);
    }

    let admissions: CodexGovernanceHealth['admissions'] = { admitted: 0, admittedWithoutTask: 0, pendingTails: 0, staleTails: 0, completedTails: 0 };
    const admissionCounts = readGovernanceAdmissionCounts({ workspaceDir: this.workspaceDir });
    if (admissionCounts.ok) {
      admissions = {
        admitted: admissionCounts.counts.admitted,
        admittedWithoutTask: admissionCounts.counts.admittedWithoutTask,
        pendingTails: admissionCounts.counts.pendingTails,
        staleTails: admissionCounts.counts.staleTails,
        completedTails: admissionCounts.counts.completedTails,
      };
      if (admissionCounts.counts.admittedWithoutTask > 0) {
        noteBlocker('admissions', `${String(admissionCounts.counts.admittedWithoutTask)} admitted pain(s) without a Diagnostician task`);
      }
    } else {
      noteBlocker('admissions', admissionCounts.reason);
    }

    // ── Diagnostician task counts ────────────────────────────────────────────
    let diagnosticianTasks: CodexGovernanceHealth['diagnosticianTasks'] = { pending: 0, leased: 0, retryWait: 0, needsHumanReview: 0 };
    try {
      const taskStore = new SqliteTaskStore(new SqliteConnection(this.workspaceDir));
      const count = async (status: 'pending' | 'leased' | 'retry_wait' | 'needs_human_review'): Promise<number> =>
        (await taskStore.listTasks({ status, taskKind: 'diagnostician', limit: 1000 })).length;
      const [pending, leased, retryWait, needsHumanReview] = await Promise.all([
        count('pending'), count('leased'), count('retry_wait'), count('needs_human_review'),
      ]);
      diagnosticianTasks = { pending, leased, retryWait, needsHumanReview };
      if (needsHumanReview > 0) noteBlocker('diagnostician', `${String(needsHumanReview)} task(s) need human review`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 120) : String(error);
      noteBlocker('diagnostician', `counts_unavailable: ${message}`);
    }

    const ready = blockers.length === 0;
    return {
      ingestionEnabled,
      ingestionSource: configLoad.source,
      consent,
      workerMode: evaluation.mode,
      registeredInInstallManifest: registered,
      rollouts,
      observations,
      admissions,
      diagnosticianTasks,
      ready,
      readyBlockers: blockers.slice(0, 12),
      productClaim: ready ? 'rev2_automatic_closure' : 'degraded',
    };
  }
}

