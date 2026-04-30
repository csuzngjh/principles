/**
 * pd candidate commands — Principle candidate inspection, intake, audit, repair.
 *
 * Usage:
 *   pd candidate list --task-id <taskId> --workspace <path> [--json]
 *   pd candidate show <candidateId> --workspace <path> [--json]
 *   pd candidate intake --candidate-id <id> [--workspace <path>] [--json] [--dry-run]
 *   pd candidate audit --workspace <path> [--json]
 *   pd candidate repair --candidate-id <id> --workspace <path> [--json]
 */
import { randomUUID } from 'crypto';
import * as path from 'path';
import {
  RuntimeStateManager,
  candidateList,
  candidateShow,
  CandidateIntakeService,
  CandidateIntakeError,
  loadLedger,
  getLedgerFilePathPublic,
  type LedgerPrincipleEntry,
} from '@principles/core/runtime-v2';
import { PrincipleTreeLedgerAdapter } from '../principle-tree-ledger-adapter.js';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

interface CandidateListOptions {
  taskId: string;
  workspace?: string;
  json?: boolean;
}

interface CandidateShowOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
}

interface CandidateIntakeOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
  dryRun?: boolean;
}

interface CandidateAuditOptions {
  workspace?: string;
  json?: boolean;
}

interface CandidateRepairOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
}

interface AuditResult {
  status: 'ok' | 'degraded';
  consumedCount: number;
  missingLedgerEntryIds: string[];
  missingCandidates: string[];
  checkedLedgerPath: string;
  checkedDbPath: string;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Update candidate status. Sets consumed_at when status='consumed'. */
async function updateCandidateStatus(stateManager: RuntimeStateManager, candidateId: string, status: string): Promise<void> {
  const db = stateManager.connection;
  const now = new Date().toISOString();
  if (status === 'consumed') {
    db.getDb().prepare(
      'UPDATE principle_candidates SET status = ?, consumed_at = ? WHERE candidate_id = ?'
    ).run(status, now, candidateId);
  } else {
    db.getDb().prepare(
      'UPDATE principle_candidates SET status = ? WHERE candidate_id = ?'
    ).run(status, candidateId);
  }
}

// ── List ───────────────────────────────────────────────────────────────────────

export async function handleCandidateList(opts: CandidateListOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const result = await candidateList({
      taskId: opts.taskId,
      stateManager,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.candidates.length === 0) {
      console.log(`No candidates found for task: ${opts.taskId}`);
      return;
    }

    console.log(`\nPrinciple Candidates for Task: ${opts.taskId}\n`);
    console.log(`  Total: ${result.candidates.length}\n`);

    for (const candidate of result.candidates) {
      console.log(`  Candidate: ${candidate.candidateId}`);
      console.log(`    Title:       ${candidate.title}`);
      console.log(`    Artifact:    ${candidate.artifactId}`);
      console.log(`    Source Run:  ${candidate.sourceRunId}`);
      console.log(`    Confidence:  ${candidate.confidence ?? 'N/A'}`);
      console.log(`    Status:      ${candidate.status}`);
      console.log(`    Description: ${candidate.description.substring(0, 100)}${candidate.description.length > 100 ? '...' : ''}`);
      console.log('');
    }
  } finally {
    await stateManager.close();
  }
}

// ── Show ───────────────────────────────────────────────────────────────────────

export async function handleCandidateShow(opts: CandidateShowOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });

    const result = await candidateShow({
      candidateId: opts.candidateId,
      stateManager,
      ledgerAdapter,
    });

    if (!result) {
      console.error(`Candidate not found: ${opts.candidateId}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nPrinciple Candidate: ${result.candidateId}\n`);
    console.log(`  Title:       ${result.title}`);
    console.log(`  Description: ${result.description}`);
    console.log(`  Artifact:    ${result.artifactId}`);
    console.log(`  Task:        ${result.taskId}`);
    console.log(`  Source Run:  ${result.sourceRunId}`);
    console.log(`  Confidence:  ${result.confidence ?? 'N/A'}`);
    console.log(`  Status:      ${result.status}`);
    console.log(`  Created:     ${result.createdAt}`);
    if (result.ledgerEntryId) {
      console.log(`  Ledger Entry: ${result.ledgerEntryId}`);
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}

// ── Intake ────────────────────────────────────────────────────────────────────

/**
 * pd candidate intake --candidate-id <id> [--workspace <path>] [--json] [--dry-run]
 *
 * Intakes a principle candidate into the ledger.
 * Wires together CandidateIntakeService + PrincipleTreeLedgerAdapter.
 * Updates candidate status to 'consumed' (with consumed_at) after successful ledger write.
 * If ledger write succeeds but DB update fails, exits non-zero with clear error.
 */
export async function handleCandidateIntake(opts: CandidateIntakeOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
    const service = new CandidateIntakeService({ stateManager, ledgerAdapter });

    if (opts.dryRun) {
      const candidate = await stateManager.getCandidate(opts.candidateId);
      if (!candidate) {
        console.error(`Candidate not found: ${opts.candidateId}`);
        process.exit(1);
      }
      const artifact = await stateManager.getArtifact(candidate.artifactId);
      if (!artifact) {
        console.error(`Artifact not found for candidate: ${opts.candidateId}`);
        process.exit(1);
      }
      let recommendation: { title?: string; text?: string; triggerPattern?: string; action?: string } = {};
      try {
        const parsed = JSON.parse(artifact.contentJson || '{}');
        recommendation = parsed.recommendation || parsed;
      } catch (err) {
        console.warn(`Warning: could not parse artifact content as JSON — using defaults. ${err instanceof Error ? err.message : String(err)}`);
      }
      const entry: LedgerPrincipleEntry = {
        id: randomUUID(),
        title: recommendation.title || candidate.title,
        text: recommendation.text || candidate.description || '',
        triggerPattern: recommendation.triggerPattern || '',
        action: recommendation.action || '',
        status: 'probation',
        evaluability: 'weak_heuristic',
        sourceRef: `candidate://${opts.candidateId}`,
        artifactRef: `artifact://${candidate.artifactId}`,
        taskRef: candidate.taskId ? `task://${candidate.taskId}` : undefined,
        createdAt: new Date().toISOString(),
      };
      if (opts.json) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.log(`Dry-run: would write entry for candidate ${opts.candidateId}`);
        console.log(JSON.stringify(entry, null, 2));
      }
      return;
    }

    // Normal intake: ledger write first
    const entry = await service.intake(opts.candidateId);

    // Check if already consumed before this call
    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (candidate?.status === 'consumed') {
      const infoMessage = `Candidate ${opts.candidateId} was already consumed. Ledger entry: ${entry.id}`;
      if (opts.json) {
        console.log(JSON.stringify({
          candidateId: opts.candidateId,
          ledgerEntryId: entry.id,
          status: 'already_consumed',
          message: infoMessage,
        }, null, 2));
      } else {
        console.log(infoMessage);
      }
      return;
    }

    // Update DB status — this must succeed; if it fails, exit non-zero
    try {
      await updateCandidateStatus(stateManager, opts.candidateId, 'consumed');
    } catch (err) {
      const msg = `Ledger write succeeded (entry ${entry.id}) but DB status update failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Candidate ${opts.candidateId} may be in inconsistent state.`;
      console.error(`ERROR: ${msg}`);
      process.exit(1);
    }

    const result = {
      candidateId: opts.candidateId,
      ledgerEntryId: entry.id,
      status: 'consumed',
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nPrinciple Candidate Intake: ${opts.candidateId}\n`);
      console.log(`  Candidate:    ${opts.candidateId}`);
      console.log(`  Title:        ${entry.title}`);
      console.log(`  Ledger Entry: ${entry.id}`);
      console.log(`  Status:       consumed\n`);
      console.log('Intake complete.\n');
    }
  } catch (err) {
    if (err instanceof CandidateIntakeError || (err as { name?: string }).name === 'CandidateIntakeError') {
      const e = err as { code?: string; message: string };
      console.error(`Intake failed [${e.code ?? 'unknown'}]: ${e.message}`);
    } else {
      console.error(`Intake failed: ${String(err)}`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}

// ── Audit ─────────────────────────────────────────────────────────────────────

/**
 * pd candidate audit --workspace <path> [--json]
 *
 * Reads workspace/.pd/state.db principle_candidates and
 * the workspace ledger (same file used by OpenClaw plugin).
 * Checks each consumed candidate has a ledger entry.
 * Exits non-zero if any consumed candidate is missing from ledger.
 */
export async function handleCandidateAudit(opts: CandidateAuditOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    // Load all candidates from DB
    const dbPath = path.join(workspaceDir, '.pd', 'state.db');
    const ledgerStateDir = path.join(workspaceDir, '.state');
    const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);

    const db = stateManager.connection;
    const consumedRows = db.getDb().prepare(
      "SELECT candidate_id FROM principle_candidates WHERE status = 'consumed'"
    ).all() as { candidate_id: string }[];

    const consumedIds = consumedRows.map(r => r.candidate_id);

    // Load ledger using core's loadLedger (same format as plugin)
    const ledger = loadLedger(ledgerStateDir);
    const ledgerPrinciples = ledger.tree.principles;

    // Check each consumed candidate has ledger entry
    const missingLedgerEntryIds: string[] = [];
    for (const candidateId of consumedIds) {
      const found = Object.values(ledgerPrinciples).some((p) =>
        p.derivedFromPainIds.includes(candidateId),
      );
      if (!found) {
        missingLedgerEntryIds.push(candidateId);
      }
    }

    const result: AuditResult = {
      status: missingLedgerEntryIds.length === 0 ? 'ok' : 'degraded',
      consumedCount: consumedIds.length,
      missingLedgerEntryIds,
      missingCandidates: [],
      checkedLedgerPath: ledgerPath,
      checkedDbPath: dbPath,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCandidate Audit Results\n`);
      console.log(`  consumedCount: ${result.consumedCount}`);
      console.log(`  checkedLedgerPath: ${result.checkedLedgerPath}`);
      console.log(`  checkedDbPath: ${result.checkedDbPath}`);
      console.log(`  status: ${result.status}`);
      if (result.missingLedgerEntryIds.length > 0) {
        console.log(`\n  MISSING LEDGER ENTRIES (${result.missingLedgerEntryIds.length}):`);
        result.missingLedgerEntryIds.forEach(id => console.log(`    - ${id}`));
      } else {
        console.log(`\n  All consumed candidates have ledger entries.`);
      }
      console.log('');
    }

    if (result.status === 'degraded') {
      process.exit(1);
    }
  } finally {
    await stateManager.close();
  }
}

// ── Repair ─────────────────────────────────────────────────────────────────────

/**
 * pd candidate repair --candidate-id <id> --workspace <path> [--json]
 *
 * Handles consumed but missing ledger entries.
 * Re-calls CandidateIntakeService.intake() to write ledger entry.
 * Does not regenerate candidate; does not update status (already consumed).
 * Fills consumed_at if empty.
 */
export async function handleCandidateRepair(opts: CandidateRepairOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    // Verify candidate exists and is consumed
    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (!candidate) {
      console.error(`Candidate not found: ${opts.candidateId}`);
      process.exit(1);
    }
    if (candidate.status !== 'consumed') {
      console.error(`Candidate ${opts.candidateId} is not consumed (status=${candidate.status}). Repair only handles consumed candidates.`);
      process.exit(1);
    }

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: path.join(workspaceDir, '.state') });
    const service = new CandidateIntakeService({ stateManager, ledgerAdapter });

    // Check if already in ledger
    const existing = ledgerAdapter.existsForCandidate(opts.candidateId);
    if (existing) {
      const result = {
        candidateId: opts.candidateId,
        status: 'already_consistent',
        message: `Candidate ${opts.candidateId} already has ledger entry.`,
        ledgerEntryId: existing.id,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nCandidate ${opts.candidateId} already has ledger entry: ${existing.id}\n`);
        console.log('No repair needed.\n');
      }
      return;
    }

    // Re-intake to restore ledger entry
    const entry = await service.intake(opts.candidateId);

    // Ensure consumed_at is set (belt-and-suspenders)
    const db = stateManager.connection;
    const row = db.getDb().prepare('SELECT consumed_at FROM principle_candidates WHERE candidate_id = ?').get(opts.candidateId) as { consumed_at: string | null } | undefined;
    if (!row?.consumed_at) {
      const now = new Date().toISOString();
      db.getDb().prepare('UPDATE principle_candidates SET consumed_at = ? WHERE candidate_id = ?').run(now, opts.candidateId);
    }

    const result = {
      candidateId: opts.candidateId,
      status: 'repaired',
      ledgerEntryId: entry.id,
      message: `Ledger entry restored for consumed candidate ${opts.candidateId}.`,
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nCandidate Repair: ${opts.candidateId}\n`);
      console.log(`  Status:        repaired`);
      console.log(`  Ledger Entry:   ${entry.id}\n`);
      console.log('Repair complete.\n');
    }
  } catch (err) {
    if (err instanceof CandidateIntakeError || (err as { name?: string }).name === 'CandidateIntakeError') {
      const e = err as { code?: string; message: string };
      console.error(`Repair failed [${e.code ?? 'unknown'}]: ${e.message}`);
    } else {
      console.error(`Repair failed: ${String(err)}`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}