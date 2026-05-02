/**
 * PainChainReadModel — shared core read model for pain-to-principle chain inspection.
 *
 * Encapsulates the complete pain→task→run→artifact→candidate→ledger traversal
 * so CLI commands (trace, health) do not duplicate SQL/ledger logic.
 *
 * PRI-14: Extract shared Runtime V2 pain-chain read model.
 */
import * as path from 'path';
import { RuntimeStateManager } from './store/runtime-state-manager.js';
import { loadLedger } from '../principle-tree-ledger.js';
import { mapFailureCategory, isPDErrorCategory } from './error-categories.js';
import type { FailureCategory } from './pain-to-principle-service.js';
import { createDiagnosticianTaskId } from './pain-signal-bridge.js';

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

export interface PainChainReadModelOptions {
  workspaceDir: string;
  stateManager?: RuntimeStateManager;
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

      const candidateToLedgerEntry = new Map<string, string>();
      for (const entry of principleEntries) {
        const e = entry as { id: string; derivedFromPainIds?: string[] };
        for (const cid of e.derivedFromPainIds ?? []) {
          candidateToLedgerEntry.set(cid, e.id);
        }
      }

      const candidateIds = candidates.map(c => c.candidateId);
      const ledgerEntryIds: string[] = [];
      const seenEntryIds = new Set<string>();
      for (const c of candidates) {
        const entryId = candidateToLedgerEntry.get(c.candidateId);
        if (entryId) {
          if (!seenEntryIds.has(entryId)) {
            seenEntryIds.add(entryId);
            ledgerEntryIds.push(entryId);
          }
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
        const [first] = candidates;
        if (first) {
          let earliestCandidateAt = first.createdAt;
          for (const c of candidates) {
            if (c.createdAt < earliestCandidateAt) earliestCandidateAt = c.createdAt;
          }
          latencyMs.artifactToCandidate = Math.max(0, new Date(earliestCandidateAt).getTime() - new Date(artifactCreatedAt).getTime());
        }
      }
      if (candidates.length > 0 && ledgerEntryIds.length > 0) {
        const [first] = candidates;
        if (first) {
          let latestCandidateAt = first.createdAt;
          for (const c of candidates) {
            if (c.createdAt > latestCandidateAt) latestCandidateAt = c.createdAt;
          }
          let earliestLedgerAt: string | undefined = undefined;
          for (const entry of principleEntries) {
            const e = entry as { id: string; createdAt?: string };
            if (ledgerEntryIds.includes(e.id) && e.createdAt) {
              if (!earliestLedgerAt || e.createdAt < earliestLedgerAt) earliestLedgerAt = e.createdAt;
            }
          }
          if (earliestLedgerAt) {
            latencyMs.candidateToLedger = Math.max(0, new Date(earliestLedgerAt).getTime() - new Date(latestCandidateAt).getTime());
          }
        }
      }

      let status: string = task.status;
      let failureCategory: FailureCategory | null = null;

      if (task.status === 'failed') {
        const errorCat = parseTaskErrorCategory(task);
        failureCategory = (mapFailureCategory(errorCat) as FailureCategory) ?? 'runtime_unavailable';
      } else if (task.status === 'succeeded') {
        if (candidateIds.length === 0) {
          status = 'failed';
          failureCategory = 'candidate_missing';
          missingLinks.push('No candidates generated for succeeded task');
        } else if (ledgerEntryIds.length === 0) {
          status = 'degraded';
          failureCategory = 'ledger_write_failed';
          missingLinks.push('Candidates present but no matching ledger entries');
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
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[PainChainReadModel] traceByPainId(${painId}) failed: ${message}`);
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
      const candidateToLedgerEntry = new Map<string, string>();
      for (const entry of principleEntries) {
        const e = entry as { id: string; derivedFromPainIds?: string[] };
        for (const cid of e.derivedFromPainIds ?? []) {
          candidateToLedgerEntry.set(cid, e.id);
        }
      }

      const candidateIds = candidates.map(c => c.candidateId);
      const ledgerEntryIds: string[] = [];
      const seenEntryIds = new Set<string>();
      for (const c of candidates) {
        const entryId = candidateToLedgerEntry.get(c.candidateId);
        if (entryId) {
          if (!seenEntryIds.has(entryId)) {
            seenEntryIds.add(entryId);
            ledgerEntryIds.push(entryId);
          }
        }
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
        const [first] = candidates;
        if (first) {
          let earliestCandidateAt = first.createdAt;
          for (const c of candidates) {
            if (c.createdAt < earliestCandidateAt) earliestCandidateAt = c.createdAt;
          }
          latencyMs.artifactToCandidate = Math.max(0, new Date(earliestCandidateAt).getTime() - new Date(artifacts.created_at).getTime());
        }
      }
      if (candidates.length > 0 && ledgerEntryIds.length > 0) {
        const [first] = candidates;
        if (first) {
          let latestCandidateAt = first.createdAt;
          for (const c of candidates) {
            if (c.createdAt > latestCandidateAt) latestCandidateAt = c.createdAt;
          }
          let earliestLedgerAt: string | undefined = undefined;
          for (const entry of principleEntries) {
            const e = entry as { id: string; createdAt?: string };
            if (ledgerEntryIds.includes(e.id) && e.createdAt) {
              if (!earliestLedgerAt || e.createdAt < earliestLedgerAt) earliestLedgerAt = e.createdAt;
            }
          }
          if (earliestLedgerAt) {
            latencyMs.candidateToLedger = Math.max(0, new Date(earliestLedgerAt).getTime() - new Date(latestCandidateAt).getTime());
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[PainChainReadModel] getLastSuccessfulChain failed: ${message}`);
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.stateManager && this.ownsStateManager) {
      await this.stateManager.close();
    }
    this.stateManager = null;
  }
}
