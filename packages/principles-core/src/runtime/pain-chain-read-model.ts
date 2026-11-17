/**
 * PainChainReadModel — shared core read model for pain-to-principle chain inspection.
 *
 * Encapsulates the complete pain→task→run→artifact→candidate→ledger traversal
 * so CLI commands (trace, health) do not duplicate SQL/ledger logic.
 *
 * PRI-14: Extract shared Runtime pain-chain read model.
 *
 * Reuse-aware ledger linkage (PRI-917 / R7): a consumed candidate may resolve
 * into an EXISTING principle via a reuse decision (appendReuseEvidence) instead
 * of creating a new ledger entry. Such chains are successes with zero ledger
 * growth — the reuse target principle is reported in `ledgerEntryIds`, and the
 * chain must not be classified as `ledger_write_failed`.
 */
import * as path from 'path';
import { RuntimeStateManager } from './store/runtime-state-manager.js';
import { loadLedger } from '../principle-tree-ledger.js';
import { mapFailureCategory, isPDErrorCategory } from './error-categories.js';
import type { FailureCategory } from './pain-to-principle-service.js';
import { createDiagnosticianTaskId } from './pain-signal-bridge.js';
import { currentEvaluation } from './store/candidate/admission-document.js';
import { evaluateCandidateAdmissionFromRecord } from './admission-gate.js';
import type { RecommendationKind } from './diagnostician-output.js';

export interface PainChainTraceLatencyMs {
  painToTask?: number;
  taskToRun?: number;
  runToArtifact?: number;
  artifactToCandidate?: number;
  candidateToLedger?: number;
}

export interface PainChainTrace {
  painId: string;
  taskId: string;
  runId?: string;
  artifactId?: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  status: string;
  latencyMs: PainChainTraceLatencyMs;
  failureCategory: FailureCategory | null;
  checkedAt: string;
  missingLinks: string[];
  /**
   * PRI-1263: present when candidates exist but NONE is admitted yet. A
   * candidate refused by the admission gate (pending / needs_evidence /
   * deferred / awaiting Owner review) correctly has no ledger entry — that is a
   * governed stop, not `ledger_write_failed`. Carries the actual admission
   * decision + reason + nextAction so the trace can guide the operator to
   * evidence supplementation or the manual review entry instead of an internalize
   * command the same gate would refuse.
   */
  admission?: {
    decision: 'needs_evidence' | 'deferred' | 'awaiting_owner';
    reason: string;
    nextAction: string;
  };
}

function parseTaskErrorCategory(task: { lastError?: string | null }): string | null {
  if (!task.lastError) return null;
  if (isPDErrorCategory(task.lastError)) return task.lastError;
  try {
    const parsed = JSON.parse(task.lastError);
    return parsed.category ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the candidateId → ledger principle id linkage from BOTH ledger
 * expressions of a resolved candidate:
 *
 *  1. `derivedFromPainIds` — the candidate created the principle (the field
 *     stores candidate ids despite its legacy pain-oriented name);
 *  2. `reuseEvidence[]` — the candidate was resolved into an EXISTING
 *     principle by a reuse decision (zero ledger growth by design,
 *     PRI-917 / R7).
 *
 * The ledger file is only shape-validated at its write boundaries, so every
 * value read here is guarded before use (rc-1/rc-4).
 */
function buildCandidateToLedgerEntryMap(principleEntries: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of principleEntries) {
    const e = entry as { id?: unknown; derivedFromPainIds?: unknown; reuseEvidence?: unknown };
    if (typeof e.id !== 'string' || e.id === '') continue;
    if (Array.isArray(e.derivedFromPainIds)) {
      for (const cid of e.derivedFromPainIds) {
        if (typeof cid === 'string' && cid !== '') map.set(cid, e.id);
      }
    }
    if (Array.isArray(e.reuseEvidence)) {
      for (const ev of e.reuseEvidence) {
        const candidateId = (ev as { candidateId?: unknown } | null)?.candidateId;
        if (typeof candidateId === 'string' && candidateId !== '') {
          map.set(candidateId, e.id);
        }
      }
    }
  }
  return map;
}

export interface PainChainReadModelOptions {
  workspaceDir: string;
  stateManager?: RuntimeStateManager;
}

/**
 * PRI-1263: read-only admission summary over a task's candidates.
 *
 * Pure read model — never re-evaluates or writes (the CLI write gate owns
 * re-evaluation). Classifies each candidate as admitted, or collects the
 * FIRST governed-stop reason (refused / deferred / awaiting Owner review /
 * unreadable disposition). Callers treat `admittedCount === 0` plus a stop
 * as "no ledger entry is EXPECTED yet" — not a ledger write failure.
 */
async function summarizeCandidateAdmissions(
  manager: RuntimeStateManager,
  candidates: readonly { candidateId: string; recommendationKind: RecommendationKind; confidence: number | null }[],
): Promise<{ admittedCount: number; stop: NonNullable<PainChainTrace['admission']> | null }> {
  let admittedCount = 0;
  let stop: NonNullable<PainChainTrace['admission']> | null = null;
  for (const candidate of candidates) {
    const read = await manager.getAdmissionDocument(candidate.candidateId);
    if (!read.ok) {
      // Fail-closed posture mirroring the write gate: an UNREADABLE admission
      // document cannot prove admission, so it never counts as admitted.
      stop ??= {
        decision: 'needs_evidence',
        reason: `admission_document_unreadable:${read.reason}`,
        nextAction: 'inspect principle_candidates.admission_json for this candidate; repair or re-run the diagnosis',
      };
      continue;
    }
    const current = currentEvaluation(read.document);
    if (current !== null && current.decision === 'admitted') {
      admittedCount += 1;
      continue;
    }
    if (read.document?.processing?.state === 'awaiting_owner') {
      stop ??= {
        decision: 'awaiting_owner',
        reason: 'admission_processing_awaiting_owner',
        nextAction: 'pd candidate review --candidate-id <id> --decide reuse|create --reason "..."',
      };
      continue;
    }
    if (current !== null) {
      stop ??= {
        decision: current.decision === 'deferred' ? 'deferred' : 'needs_evidence',
        reason: current.reason,
        nextAction: current.nextAction,
      };
      continue;
    }
    // No evaluation on record (pre-CR-03 record or owner-decision-only
    // document): fall back to the same read-only partial check the CLI write
    // entries use as their fast pre-refusal — never a write.
    const partial = evaluateCandidateAdmissionFromRecord({
      recommendationKind: candidate.recommendationKind,
      confidence: candidate.confidence,
    });
    if (partial.decision === 'admitted') {
      admittedCount += 1;
      continue;
    }
    stop ??= {
      decision: 'needs_evidence',
      reason: `no_admission_document:${partial.reason}`,
      nextAction: partial.nextAction,
    };
  }
  return { admittedCount, stop };
}

export class PainChainReadModel {
  private readonly workspaceDir: string;
  private stateManager: RuntimeStateManager | null = null;
  private readonly injectedStateManager: RuntimeStateManager | null;
  private ownsStateManager = false;

  constructor(opts: PainChainReadModelOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.injectedStateManager = opts.stateManager ?? null;
    if (this.injectedStateManager) {
      this.stateManager = this.injectedStateManager;
      this.ownsStateManager = false;
    }
  }

  async getTotalTaskCount(): Promise<number> {
    try {
      const manager = await this.getStateManager();
      const db = manager.connection.getDb();
      const row = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  private initialized = false;

  private async getStateManager(): Promise<RuntimeStateManager> {
    if (!this.stateManager) {
      this.stateManager = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
      this.ownsStateManager = true;
    }
    if (!this.initialized) {
      await this.stateManager.initialize();
      this.initialized = true;
    }
    return this.stateManager;
  }

  async traceByPainId(painId: string): Promise<PainChainTrace> {
    const taskId = createDiagnosticianTaskId(painId);
    const checkedAt = new Date().toISOString();
    const missingLinks: string[] = [];

    try {
      const manager = await this.getStateManager();

      const task = await manager.getTask(taskId);
      if (!task) {
        return {
          painId,
          taskId,
          status: 'not_found',
          failureCategory: 'runtime_unavailable',
          checkedAt,
          missingLinks: ['task'],
          candidateIds: [],
          ledgerEntryIds: [],
          latencyMs: {},
        };
      }

      const runs = await manager.getRunsByTask(taskId);
      const latestRun = runs.length > 0
        ? runs.reduce((a, b) => (a.startedAt > b.startedAt ? a : b))
        : undefined;

      let artifactId: string | undefined = undefined;
      let artifactCreatedAt: string | undefined = undefined;
      if (latestRun) {
        const runRows = manager.connection.getDb()
          .prepare('SELECT artifact_id, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(latestRun.runId) as { artifact_id: string; created_at: string } | undefined;
        if (runRows) {
          artifactId = runRows.artifact_id;
          artifactCreatedAt = runRows.created_at;
        }
      }

      const candidates = await manager.getCandidatesByTaskId(taskId);

      const ledgerStateDir = path.join(this.workspaceDir, '.state');
      const ledger = loadLedger(ledgerStateDir);
      const principleEntries = Object.values(ledger.tree.principles);
      // Reuse-aware (PRI-917 / R7): includes both created-entry linkage and
      // reuseEvidence resolutions, so a successful reuse chain is not
      // misclassified as ledger_write_failed.
      const candidateToLedgerEntry = buildCandidateToLedgerEntryMap(principleEntries);

      const candidateIds = candidates.map(c => c.candidateId);
      const ledgerEntryIds: string[] = [];
      for (const c of candidates) {
        const entryId = candidateToLedgerEntry.get(c.candidateId);
        if (entryId) {
          ledgerEntryIds.push(entryId);
        } else if (c.status === 'consumed') {
          missingLinks.push(`candidate:${c.candidateId} consumed but missing from ledger`);
        }
      }

      const latencyMs: PainChainTraceLatencyMs = {};
      if (task.createdAt && latestRun?.startedAt) {
        latencyMs.painToTask = Math.max(0, new Date(latestRun.startedAt).getTime() - new Date(task.createdAt).getTime());
      }
      if (latestRun?.startedAt && latestRun?.endedAt) {
        latencyMs.taskToRun = Math.max(0, new Date(latestRun.endedAt).getTime() - new Date(latestRun.startedAt).getTime());
      }
      if (latestRun?.endedAt && artifactCreatedAt) {
        latencyMs.runToArtifact = Math.max(0, new Date(artifactCreatedAt).getTime() - new Date(latestRun.endedAt).getTime());
      }
      if (artifactCreatedAt && candidates.length > 0) {
        const [firstCandidate] = candidates;
        if (firstCandidate) {
          latencyMs.artifactToCandidate = Math.max(0, new Date(firstCandidate.createdAt).getTime() - new Date(artifactCreatedAt).getTime());
        }
      }
      if (candidates.length > 0 && ledgerEntryIds.length > 0) {
        const [lastCandidate] = candidates.slice(-1);
        if (lastCandidate) {
          let earliestLedgerAt: string | undefined = undefined;
          for (const entry of principleEntries) {
            const e = entry as { id: string; createdAt?: string };
            if (ledgerEntryIds.includes(e.id) && e.createdAt) {
              if (!earliestLedgerAt || e.createdAt < earliestLedgerAt) earliestLedgerAt = e.createdAt;
            }
          }
          if (earliestLedgerAt) {
            latencyMs.candidateToLedger = Math.max(0, new Date(earliestLedgerAt).getTime() - new Date(lastCandidate.createdAt).getTime());
          }
        }
      }

      let status: string = task.status;
      let failureCategory: FailureCategory | null = null;
      let admission: PainChainTrace['admission'] = undefined;

      if (task.status === 'failed') {
        const errorCat = parseTaskErrorCategory(task);
        failureCategory = (mapFailureCategory(errorCat) as FailureCategory) ?? 'runtime_unavailable';
      } else if (task.status === 'succeeded') {
        if (candidateIds.length === 0) {
          status = 'failed';
          failureCategory = 'candidate_missing';
          missingLinks.push('No candidates generated for succeeded task');
        } else if (ledgerEntryIds.length === 0) {
          // PRI-1263: zero ledger entries is only a ledger-write failure when a
          // candidate was actually ADMITTED. A candidate the admission gate
          // refused (needs_evidence / deferred / awaiting Owner review) correctly
          // produces no ledger entry — classifying that as `ledger_write_failed`
          // reported a governed refusal as an infrastructure failure.
          const summarized = await summarizeCandidateAdmissions(manager, candidates);
          const governedStop = summarized.admittedCount === 0 ? summarized.stop : null;
          if (governedStop != null) {
            admission = governedStop;
            missingLinks.push(`admission:${governedStop.decision}:${governedStop.reason}`);
          } else {
            status = 'degraded';
            failureCategory = 'ledger_write_failed';
            missingLinks.push('Candidates present but no matching ledger entries');
          }
        }
      }

      return {
        painId,
        taskId,
        runId: latestRun?.runId,
        artifactId,
        candidateIds,
        ledgerEntryIds,
        status,
        latencyMs,
        failureCategory,
        checkedAt,
        missingLinks,
        ...(admission !== undefined ? { admission } : {}),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isConfigError = /disk|unavailable|config|api[_\s]?key|not found in env/i.test(message);
      return {
        painId,
        taskId,
        status: 'error',
        failureCategory: isConfigError ? 'config_missing' : 'runtime_unavailable',
        checkedAt,
        missingLinks: [isConfigError ? 'state_manager_init' : 'internal_error'],
        candidateIds: [],
        ledgerEntryIds: [],
        latencyMs: {},
      };
    }
  }

  async getLastSuccessfulChain(): Promise<PainChainTrace | undefined> {
    try {
      const manager = await this.getStateManager();
      const db = manager.connection.getDb();

      const lastSucceeded = db.prepare(
        "SELECT task_id, input_ref, created_at FROM tasks WHERE status = 'succeeded' ORDER BY updated_at DESC LIMIT 1"
      ).get() as { task_id: string; input_ref: string | null; created_at: string } | undefined;
      if (!lastSucceeded) return undefined;

      const painId = lastSucceeded.input_ref ?? lastSucceeded.task_id.replace('diagnosis_', '');
      const taskId = lastSucceeded.task_id;

      const run = db.prepare(
        "SELECT run_id, started_at, ended_at FROM runs WHERE task_id = ? AND execution_status = 'succeeded' ORDER BY started_at DESC LIMIT 1"
      ).get(taskId) as { run_id: string; started_at: string; ended_at: string } | undefined;
      if (!run) return undefined;

      const artifacts = db.prepare(
        "SELECT artifact_id, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1"
      ).get(run.run_id) as { artifact_id: string; created_at: string } | undefined;
      if (!artifacts) return undefined;

      const candidates = await manager.getCandidatesByTaskId(taskId);
      if (candidates.length === 0) return undefined;

      const ledgerStateDir = path.join(this.workspaceDir, '.state');
      const ledger = loadLedger(ledgerStateDir);
      const principleEntries = Object.values(ledger.tree.principles);
      // Reuse-aware (PRI-917 / R7): same linkage rules as traceByPainId.
      const candidateToLedgerEntry = buildCandidateToLedgerEntryMap(principleEntries);

      const candidateIds = candidates.map(c => c.candidateId);
      const ledgerEntryIds: string[] = [];
      for (const c of candidates) {
        const entryId = candidateToLedgerEntry.get(c.candidateId);
        if (entryId) ledgerEntryIds.push(entryId);
      }

      const latencyMs: PainChainTraceLatencyMs = {};
      if (lastSucceeded.created_at && run.started_at) {
        latencyMs.painToTask = Math.max(0, new Date(run.started_at).getTime() - new Date(lastSucceeded.created_at).getTime());
      }
      if (run.started_at && run.ended_at) {
        latencyMs.taskToRun = Math.max(0, new Date(run.ended_at).getTime() - new Date(run.started_at).getTime());
      }
      if (run.ended_at && artifacts.created_at) {
        latencyMs.runToArtifact = Math.max(0, new Date(artifacts.created_at).getTime() - new Date(run.ended_at).getTime());
      }
      if (artifacts.created_at && candidates.length > 0) {
        const [firstCandidate] = candidates;
        if (firstCandidate) {
          latencyMs.artifactToCandidate = Math.max(0, new Date(firstCandidate.createdAt).getTime() - new Date(artifacts.created_at).getTime());
        }
      }
      if (candidates.length > 0 && ledgerEntryIds.length > 0) {
        const [lastCandidate] = candidates.slice(-1);
        if (lastCandidate) {
          let earliestLedgerAt: string | undefined = undefined;
          for (const entry of principleEntries) {
            const e = entry as { id: string; createdAt?: string };
            if (ledgerEntryIds.includes(e.id) && e.createdAt) {
              if (!earliestLedgerAt || e.createdAt < earliestLedgerAt) earliestLedgerAt = e.createdAt;
            }
          }
          if (earliestLedgerAt) {
            latencyMs.candidateToLedger = Math.max(0, new Date(earliestLedgerAt).getTime() - new Date(lastCandidate.createdAt).getTime());
          }
        }
      }

      return {
        painId,
        taskId,
        runId: run.run_id,
        artifactId: artifacts.artifact_id,
        candidateIds,
        ledgerEntryIds,
        status: 'succeeded',
        latencyMs,
        failureCategory: null,
        checkedAt: new Date().toISOString(),
        missingLinks: [],
      };
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.stateManager && this.ownsStateManager) {
      await this.stateManager.close();
    }
    this.stateManager = null;
    this.initialized = false;
  }
}
