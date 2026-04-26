// eslint-disable-file
// TODO: Fix TypeScript module resolution for openclaw-plugin
// This file uses dynamic import for PrincipleTreeLedgerAdapter

/**
 * pd candidate list/show commands — Principle candidate inspection.
 *
 * Usage:
 *   pd candidate list --task-id <taskId> --workspace <path> [--json]
 *   pd candidate show <candidateId> --workspace <path> [--json]
 */
import { randomUUID } from 'crypto';
import {
  RuntimeStateManager,
  candidateList,
  candidateShow,
} from '@principles/core/runtime-v2';
import { CandidateIntakeService } from '@principles/core/runtime-v2';
import { CandidateIntakeError } from '@principles/core/runtime-v2';
import type { LedgerPrincipleEntry } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

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

/**
 * pd candidate list --task-id <taskId> [--workspace <path>] [--json]
 *
 * Lists all principle candidates for a task, including candidateId, artifactId,
 * taskId, title, description, confidence, status, sourceRunId.
 */
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

    console.log(`\nPrinciple Candidates for Task: ${result.taskId}\n`);
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

/**
 * pd candidate show <candidateId> [--workspace <path>] [--json]
 *
 * Shows full detail for a single principle candidate.
 * Returns: candidateId, artifactId, taskId, title, description,
 * confidence, sourceRunId, status, createdAt.
 */
export async function handleCandidateShow(opts: CandidateShowOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const result = await candidateShow({
      candidateId: opts.candidateId,
      stateManager,
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
    console.log('');
  } finally {
    await stateManager.close();
  }
}

interface CandidateIntakeOptions {
  candidateId: string;
  workspace?: string;
  json?: boolean;
  dryRun?: boolean;
}

/**
 * Update candidate status to 'consumed' via direct SQL.
 * RuntimeStateManager doesn't expose this method, so we access the DB directly.
 */
async function updateCandidateStatus(stateManager: RuntimeStateManager, candidateId: string, status: string): Promise<void> {
  const db = stateManager.connection;
  db.getDb().prepare('UPDATE principle_candidates SET status = ? WHERE candidate_id = ?').run(status, candidateId);
}

/**
 * pd candidate intake --candidate-id <id> [--workspace <path>] [--json] [--dry-run]
 *
 * Intakes a principle candidate into the ledger.
 * Wires together CandidateIntakeService + PrincipleTreeLedgerAdapter.
 * Updates candidate status to 'consumed' after successful ledger write.
 */
export async function handleCandidateIntake(opts: CandidateIntakeOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    // Import from built dist directory to avoid TypeScript checking source files
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modulePath = '../../openclaw-plugin/dist/core/principle-tree-ledger-adapter.js';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { PrincipleTreeLedgerAdapter } = await import(modulePath).catch((err: unknown) => {
      console.error('Failed to load PrincipleTreeLedgerAdapter:', String(err));
      process.exit(1);
      return { PrincipleTreeLedgerAdapter: null as unknown as new (opts: { stateDir: string }) => any };
    }) as { PrincipleTreeLedgerAdapter: new (opts: { stateDir: string }) => any };

    const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir: workspaceDir });
    const service = new CandidateIntakeService({ stateManager, ledgerAdapter });

    if (opts.dryRun) {
      // Dry-run: build complete 11-field entry without writing (CLI-02)
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
      // Parse artifact to extract recommendation
      let recommendation: { title?: string; text?: string; triggerPattern?: string; action?: string } = {};
      try {
        const parsed = JSON.parse(artifact.contentJson || '{}');
        recommendation = parsed.recommendation || parsed;
      } catch {
        // Use defaults if parse fails
      }
      // Build complete 11-field LedgerPrincipleEntry (same as CandidateIntakeService)
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
      // Output
      if (opts.json) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.log(`Dry-run: would write entry for candidate ${opts.candidateId}`);
        console.log(JSON.stringify(entry, null, 2));
      }
      return;
    }

    // Normal intake (CLI-01: ledger write first, then update status)
    const entry = await service.intake(opts.candidateId);

    // Check if candidate was already consumed (idempotent return per CLI-04)
    const candidate = await stateManager.getCandidate(opts.candidateId);
    if (candidate?.status === 'consumed') {
      // Already consumed before this call - output info message
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

    // Update candidate status to 'consumed' (CLI-01)
    await updateCandidateStatus(stateManager, opts.candidateId, 'consumed');

    // Output success
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
    // Error handling (CLI-04)
    if (err instanceof CandidateIntakeError || (err as any).name === 'CandidateIntakeError') {
      console.error(`Intake failed [${(err as any).code}]: ${(err as any).message}`);
    } else {
      console.error(`Intake failed: ${String(err)}`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}
