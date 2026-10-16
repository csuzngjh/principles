/**
 * pd runtime internalization evidence — Owner evidence attach/resume (B1).
 *
 * SPEC-PD-IAER-001 FR-03/FR-06 (PRI-983): the Owner recovery entry for
 * Artificer tasks blocked on evidence (needs_human_review + a stable FR-04
 * evidence reasonCode). Three subcommands, ALL default dry-run; `--confirm`
 * performs the mutation (cli-4):
 *
 *   evidence list   --workspace <dir> [--json]
 *       Read-only: tasks waiting for Owner evidence with pain linkage,
 *       missing fields and the concrete next action (FR-06 1/2).
 *
 *   evidence attach --task <id> --pain <painId> --negative <id>
 *                   --positive <id>... --outcome <text>
 *                   [--decidedBy <label>] [--json] [--confirm]
 *       Assembles the labelled examples through the production assembler
 *       (same chain as run-rulehost), and on --confirm persists the
 *       digest-verified selection into pi_metadata via CAS. The task STAYS
 *       needs_human_review — attach never unblocks (FR-06 6).
 *
 *   evidence resume --task <id> [--decidedBy <label>] [--json] [--confirm]
 *       Re-assembles, verifies the stored contentDigest, and on --confirm
 *       performs the ATOMIC authority reset through the single recovery
 *       authority (ownerRetryNeedsHumanReviewTask, CAS precondition) — at
 *       most one concurrent resume wins (FR-06 7, §6.3, T06).
 *
 * Authorization expression (repo reality — no owner authentication exists):
 * explicit --confirm + decidedBy label + append-only audit
 * (.state/recovery_actions.jsonl) + revision/contentDigest provenance.
 *
 * CLI contract: --json prints exactly ONE parseable JSON object (cli-1);
 * refusal paths set exit 1 with stable reason + nextAction and mutate
 * nothing (cli-2/cli-5/cli-6). No V1 fallback exists on any path (PRI-780).
 * No new feature flag: rollback = git revert (mvp-q-3).
 *
 * Host-neutral trajectory assembly is shared with the background worker.
 * It uses persisted host tool declarations; unknown host semantics fail loud.
 */

import * as path from 'path';
import * as fs from 'node:fs';
import type { Command } from 'commander';
import {
  RuntimeStateManager,
  storeEmitter,
  attachOwnerEvidence,
  resumeOwnerEvidenceTask,
  listEvidenceWaitingTasks,
  type OwnerEvidenceAttachOutcome,
  type OwnerEvidenceResumeOutcome,
  type BehaviorEvidencePort,
} from '@principles/core/runtime-v2';
import { createWorkspaceBehaviorEvidencePort } from '@principles/host-runtime';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

// ── shared output ───────────────────────────────────────────────────────────

function emitJson(payload: Record<string, unknown>): void {
  // cli-1-strict-json: exactly one parseable JSON object on stdout.
  console.log(JSON.stringify(payload, null, 2));
}

function resolveWorkspaceOr(workspace?: string): string | null {
  try {
    return path.resolve(resolveWorkspaceDir(workspace));
  } catch {
    return null;
  }
}

function workspaceReady(workspaceDir: string): boolean {
  // Read paths must never bootstrap an empty state.db (ERR-023 precedent):
  // a missing DB is a structured refusal, not a fresh workspace.
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'));
}

/** The same host-neutral assembler and trajectory reader used by the Codex worker. */
async function withAssemblerPort<T>(
  workspaceDir: string,
  fn: (port: BehaviorEvidencePort) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn(createWorkspaceBehaviorEvidencePort(workspaceDir)) };
  } catch (error) {
    return { ok: false, error };
  }
}

// ── evidence list ───────────────────────────────────────────────────────────

export interface EvidenceListOptions {
  workspace?: string;
  json?: boolean;
}

export async function handleRuntimeInternalizationEvidenceList(opts: EvidenceListOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceOr(opts.workspace);
  if (workspaceDir === null) {
    if (opts.json) emitJson({ ok: false, status: 'failed', reason: 'workspace_unresolved', nextAction: 'Pass --workspace <dir> pointing at a workspace with an initialized .pd/state.db.' });
    else console.error('Error: could not resolve a workspace. Pass --workspace <dir>.');
    process.exitCode = 1;
    return;
  }
  if (!workspaceReady(workspaceDir)) {
    if (opts.json) emitJson({ ok: false, status: 'failed', workspace: workspaceDir, reason: 'workspace_not_initialized', nextAction: 'Initialize the workspace first (pd runtime init) or pass --workspace <dir>.' });
    else console.error(`Error: no .pd/state.db under ${workspaceDir}. Initialize the workspace first (pd runtime init).`);
    process.exitCode = 1;
    return;
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    const tasks = await listEvidenceWaitingTasks(stateManager);
    const empty = tasks.length === 0;
    if (opts.json) {
      emitJson({
        ok: true,
        mode: 'evidence_list',
        workspace: workspaceDir,
        status: empty ? 'empty' : 'complete',
        count: tasks.length,
        ...(empty ? { reason: 'No Artificer tasks are waiting for Owner evidence.', nextAction: 'Nothing to do. Blocked-on-evidence tasks appear here after a consumer preflight (needs_human_review + an owner_behavior_examples_* reasonCode).' } : { tasks, nextAction: 'Attach evidence per task (dry-run by default): pd runtime internalization evidence attach --task <taskId> ...' }),
      });
      return;
    }
    console.log(`Owner evidence queue (${workspaceDir})`);
    if (empty) {
      console.log('  No Artificer tasks are waiting for Owner evidence.');
      return;
    }
    for (const t of tasks) {
      console.log(`  - ${t.taskId}`);
      console.log(`    channel:   ${t.channel}`);
      console.log(`    painId:    ${t.painId ?? '(not attached)'}`);
      console.log(`    reason:    ${t.reasonCode}`);
      console.log(`    attempts:  ${t.attemptCount}/${t.maxAttempts}${t.evidenceRevision > 0 ? ` (evidence revision ${t.evidenceRevision})` : ''}`);
      if (t.missingFields.length > 0) console.log(`    missing:   ${t.missingFields.join(', ')}`);
      console.log(`    next:      ${t.nextAction}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (opts.json) emitJson({ ok: false, status: 'failed', workspace: workspaceDir, reason, nextAction: 'Verify the workspace state.db (pd runtime internalization integrity --json).' });
    else console.error(`Error: ${reason}`);
    process.exitCode = 1;
  } finally {
    await stateManager.close().catch(() => undefined);
  }
}

// ── evidence attach ─────────────────────────────────────────────────────────

export interface EvidenceAttachOptions {
  workspace?: string;
  task?: string;
  pain?: string;
  negative?: number;
  positive?: string[];
  outcome?: string;
  decidedBy?: string;
  json?: boolean;
  confirm?: boolean;
}

function parsePositiveIds(raw: readonly string[] | undefined): { ok: true; ids: number[] } | { ok: false; reason: string } {
  if (raw === undefined || raw.length === 0) {
    return { ok: false, reason: 'at least one --positive <toolCallId> is required (1..3 unique positive integers)' };
  }
  // Accept space-separated variadic tokens and comma-joined tokens alike.
  const tokens = raw.flatMap((token) => token.split(',')).map((t) => t.trim()).filter((t) => t !== '');
  const ids: number[] = [];
  for (const token of tokens) {
    const value = Number(token);
    if (!Number.isSafeInteger(value) || value <= 0) {
      return { ok: false, reason: `--positive must be positive integers, got "${token}"` };
    }
    ids.push(value);
  }
  if (ids.length < 1 || ids.length > 3) {
    return { ok: false, reason: `--positive must contain 1..3 ids, got ${ids.length}` };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: '--positive ids must be unique' };
  }
  return { ok: true, ids };
}

function attachOutcomePayload(taskId: string, outcome: OwnerEvidenceAttachOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case 'dry_run':
      return {
        status: 'dry_run',
        taskId,
        painId: outcome.painId,
        wouldPersist: outcome.wouldPersist,
        nextAction: outcome.nextAction,
      };
    case 'attached':
      return {
        status: 'attached',
        taskId,
        revision: outcome.revision,
        contentDigest: outcome.contentDigest,
        ownerOperation: outcome.ownerOperation,
        attachedAt: outcome.attachedAt,
        taskStillNeedsHumanReview: outcome.taskStillNeedsHumanReview,
        nextAction: outcome.nextAction,
      };
    case 'refused':
      return {
        status: 'refused',
        taskId,
        reason: outcome.reason,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        ...(outcome.reason === 'owner_behavior_examples_required' ? { missingFields: ['sourcePainId', 'sourceNegativeToolCallId', 'positiveToolCallIds', 'ownerDesiredOutcome'] } : {}),
        nextAction: outcome.nextAction,
      };
    case 'conflict':
      return { status: 'conflict', taskId, nextAction: outcome.nextAction };
  }
}

export async function handleRuntimeInternalizationEvidenceAttach(opts: EvidenceAttachOptions): Promise<void> {
  const taskId = opts.task ?? '';
  const refuse = (reason: string, nextAction: string, detail?: string): void => {
    if (opts.json) emitJson({ status: 'refused', taskId, reason, ...(detail !== undefined ? { detail } : {}), nextAction });
    else console.error(`Error: ${reason}${detail !== undefined ? ` (${detail})` : ''}. ${nextAction}`);
    process.exitCode = 1;
  };

  if (!taskId || !opts.pain || opts.negative === undefined || !opts.outcome) {
    refuse('missing_required_options', 'Pass --task <taskId> --pain <canonicalPainId> --negative <toolCallId> --positive <id>... --outcome "<desired behavior>".');
    return;
  }
  const positives = parsePositiveIds(opts.positive);
  if (!positives.ok) {
    refuse('invalid_positive_ids', 'Provide 1..3 unique positive tool call ids, e.g. --positive 7 8.', positives.reason);
    return;
  }

  const workspaceDir = resolveWorkspaceOr(opts.workspace);
  if (workspaceDir === null) {
    refuse('workspace_unresolved', 'Pass --workspace <dir>.');
    return;
  }
  if (!workspaceReady(workspaceDir)) {
    refuse('workspace_not_initialized', 'Initialize the workspace first (pd runtime init) or pass --workspace <dir>.');
    return;
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    const outcome = await withAssemblerPort(workspaceDir, (port) => attachOwnerEvidence(stateManager, {
      taskId,
      selection: {
        sourcePainId: opts.pain as string,
        sourceNegativeToolCallId: opts.negative as number,
        positiveToolCallIds: positives.ids,
        ownerDesiredOutcome: opts.outcome as string,
      },
      decidedBy: opts.decidedBy,
      mode: opts.confirm ? 'confirm' : 'dry_run',
      assemble: port,
      workspaceDir,
      eventEmitter: storeEmitter,
      owner: 'pd-cli:evidence',
    }));
    if (!outcome.ok) {
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      refuse('evidence_source_unavailable', 'Verify the workspace trajectory store and host tool declaration are readable; restart the configured host to refresh its declaration.', detail);
      return;
    }
    const payload = attachOutcomePayload(taskId, outcome.value);
    if (opts.json) {
      emitJson(payload);
    } else {
      console.log(`Evidence attach: ${outcome.value.status}`);
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'status') continue;
        console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
      }
    }
    if (outcome.value.status === 'refused' || outcome.value.status === 'conflict') {
      process.exitCode = 1;
    }
  } catch (err) {
    refuse('evidence_attach_failed', 'Inspect the task (pd runtime internalization queue --json) and the workspace state.db.', err instanceof Error ? err.message : String(err));
  } finally {
    await stateManager.close().catch(() => undefined);
  }
}

// ── evidence resume ─────────────────────────────────────────────────────────

export interface EvidenceResumeOptions {
  workspace?: string;
  task?: string;
  decidedBy?: string;
  json?: boolean;
  confirm?: boolean;
}

function resumeOutcomePayload(taskId: string, outcome: OwnerEvidenceResumeOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case 'dry_run':
      return {
        status: 'dry_run',
        taskId,
        reasonCode: outcome.reasonCode,
        painId: outcome.painId,
        revision: outcome.revision,
        contentDigest: outcome.contentDigest,
        previousAttemptCount: outcome.previousAttemptCount,
        nextAction: outcome.nextAction,
      };
    case 'resumed':
      return {
        status: 'resumed',
        taskId,
        previousStatus: outcome.previousStatus,
        newStatus: outcome.newStatus,
        previousAttemptCount: outcome.previousAttemptCount,
        revision: outcome.revision,
        contentDigest: outcome.contentDigest,
        nextAction: outcome.nextAction,
      };
    case 'refused':
      return {
        status: 'refused',
        taskId,
        reason: outcome.reason,
        ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        nextAction: outcome.nextAction,
      };
    case 'conflict':
      return { status: 'conflict', taskId, nextAction: outcome.nextAction };
  }
}

export async function handleRuntimeInternalizationEvidenceResume(opts: EvidenceResumeOptions): Promise<void> {
  const taskId = opts.task ?? '';
  const refuse = (reason: string, nextAction: string, detail?: string): void => {
    if (opts.json) emitJson({ status: 'refused', taskId, reason, ...(detail !== undefined ? { detail } : {}), nextAction });
    else console.error(`Error: ${reason}${detail !== undefined ? ` (${detail})` : ''}. ${nextAction}`);
    process.exitCode = 1;
  };

  if (!taskId) {
    refuse('missing_required_options', 'Pass --task <taskId> (find ids via pd runtime internalization evidence list).');
    return;
  }
  const workspaceDir = resolveWorkspaceOr(opts.workspace);
  if (workspaceDir === null) {
    refuse('workspace_unresolved', 'Pass --workspace <dir>.');
    return;
  }
  if (!workspaceReady(workspaceDir)) {
    refuse('workspace_not_initialized', 'Initialize the workspace first (pd runtime init) or pass --workspace <dir>.');
    return;
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    const outcome = await withAssemblerPort(workspaceDir, (port) => resumeOwnerEvidenceTask(stateManager, {
      taskId,
      decidedBy: opts.decidedBy,
      mode: opts.confirm ? 'confirm' : 'dry_run',
      assemble: port,
      workspaceDir,
      eventEmitter: storeEmitter,
      owner: 'pd-cli:evidence',
    }));
    if (!outcome.ok) {
      const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      refuse('evidence_source_unavailable', 'Verify the workspace trajectory store and host tool declaration are readable; resume requires re-assembly from the same evidence.', detail);
      return;
    }
    const payload = resumeOutcomePayload(taskId, outcome.value);
    if (opts.json) {
      emitJson(payload);
    } else {
      console.log(`Evidence resume: ${outcome.value.status}`);
      for (const [key, value] of Object.entries(payload)) {
        if (key === 'status') continue;
        console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
      }
    }
    if (outcome.value.status === 'refused' || outcome.value.status === 'conflict') {
      process.exitCode = 1;
    }
  } catch (err) {
    refuse('evidence_resume_failed', 'Inspect the task (pd runtime internalization queue --json) and the workspace state.db.', err instanceof Error ? err.message : String(err));
  } finally {
    await stateManager.close().catch(() => undefined);
  }
}

// ── registration ────────────────────────────────────────────────────────────

/** Register `pd runtime internalization evidence list|attach|resume`. */
export function registerRuntimeInternalizationEvidenceCommand(
  internalizationCmd: Command,
  handlers: {
    list?: typeof handleRuntimeInternalizationEvidenceList;
    attach?: typeof handleRuntimeInternalizationEvidenceAttach;
    resume?: typeof handleRuntimeInternalizationEvidenceResume;
  } = {},
): Command {
  const listHandler = handlers.list ?? handleRuntimeInternalizationEvidenceList;
  const attachHandler = handlers.attach ?? handleRuntimeInternalizationEvidenceAttach;
  const resumeHandler = handlers.resume ?? handleRuntimeInternalizationEvidenceResume;

  const evidenceCmd = internalizationCmd
    .command('evidence')
    .description('Owner evidence recovery for Artificer tasks blocked on labelled behaviour examples (FR-03/FR-06)');

  evidenceCmd
    .command('list')
    .description('List Artificer tasks waiting for Owner evidence (read-only)')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output as JSON')
    .action(async (opts: EvidenceListOptions) => {
      await listHandler(opts);
    });

  evidenceCmd
    .command('attach')
    .description('Attach the Owner-labelled evidence selection (dry-run by default; --confirm persists via CAS; the task stays needs_human_review)')
    .requiredOption('--task <taskId>', 'Artificer task id waiting for evidence')
    .requiredOption('--pain <canonicalPainId>', 'Canonical pain id the evidence belongs to')
    .requiredOption('--negative <toolCallId>', 'Owner-selected tool call to block', Number)
    .requiredOption('--positive <id...>', 'Owner-selected allow tool call ids (1..3 unique)')
    .requiredOption('--outcome <text>', 'Owner desired behaviour outcome (non-empty)')
    .option('--decidedBy <label>', 'Operator label recorded in provenance + audit')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output as JSON')
    .option('--confirm', 'Actually attach (default is dry-run)')
    .action(async (opts: EvidenceAttachOptions) => {
      await attachHandler(opts);
    });

  evidenceCmd
    .command('resume')
    .description('Digest-verified atomic requeue of an evidence-blocked task (dry-run by default; --confirm resets through the single recovery authority)')
    .requiredOption('--task <taskId>', 'Artificer task id with an attached evidence selection')
    .option('--decidedBy <label>', 'Operator label recorded in provenance + audit')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--json', 'Output as JSON')
    .option('--confirm', 'Actually resume (default is dry-run)')
    .action(async (opts: EvidenceResumeOptions) => {
      await resumeHandler(opts);
    });

  return evidenceCmd;
}
