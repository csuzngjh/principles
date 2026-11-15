/**
 * PRI-1196 — detached background selector for the Codex host.
 *
 * argv[2] is a single-use job file written by the UserPromptSubmit hook after
 * the Native body was already encoded. The job carries the current prompt ONLY
 * so the SAME decision protocol can run; it is deleted before any network I/O.
 * This process never writes to the host's stdout/stderr (`stdio: 'ignore'`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAdaptiveBackgroundSelection } from '@principles/host-runtime';
import {
  ADAPTIVE_APPEND_SCHEMA_VERSION,
  ADAPTIVE_APPEND_TTL_MS,
  adaptiveTurnEnded,
  appendAdaptiveAppendFact,
  takeAdaptiveAppendJob,
  writeAdaptiveAppendResultFor,
  type AdaptiveAppendJob,
} from './ingestion/adaptive-append-state.js';

export type BackgroundSelectionJobResult =
  | {readonly status: 'selected'; readonly activationId: string}
  | {readonly status: 'skipped' | 'unavailable' | 'invalid'; readonly reason: string};

function stateDirOf(workspaceDir: string): string {
  return path.join(workspaceDir, '.state');
}

function factCode(outcomeStatus: string, reason: string): string {
  if (outcomeStatus === 'needs_setup') return `needs_setup:${reason}`.slice(0, 240);
  return `skipped:background_${reason}`.slice(0, 240);
}

async function execute(job: AdaptiveAppendJob): Promise<BackgroundSelectionJobResult> {
  const startedAt = Date.now();
  const handoff = {workspaceDir: job.workspaceDir, sessionId: job.sessionId, turnId: job.turnId};
  // Stop already ended this turn: a decision now cannot reach it.
  if (adaptiveTurnEnded(handoff)) return {status: 'skipped', reason: 'turn_ended'};
  const deadlineAt = job.createdAt + ADAPTIVE_APPEND_TTL_MS - 1000;
  if (startedAt >= deadlineAt) {
    appendAdaptiveAppendFact({
      stateDir: stateDirOf(job.workspaceDir),
      sessionId: job.sessionId,
      turnId: job.turnId,
      workspaceDir: job.workspaceDir,
      resultCode: 'skipped:background_expired',
      scored: false,
      budget: job.budgetChars,
      injectedCharCount: 0,
    });
    return {status: 'skipped', reason: 'expired'};
  }
  const outcome = await runAdaptiveBackgroundSelection({
    workspaceDir: job.workspaceDir,
    sessionId: job.sessionId,
    turnId: job.turnId,
    promptContent: job.promptContent,
    nativeActivationIds: job.nativeActivationIds,
    nativeChars: job.nativeChars,
    budgetChars: job.budgetChars,
    deadlineAt,
    env: process.env,
    ...(job.hookInvocationId ? {hookInvocationId: job.hookInvocationId} : {}),
  });
  const scored = outcome.diagnostic.sends > 0;
  // Re-check after the decision: Stop or a new turn may have landed meanwhile.
  if (adaptiveTurnEnded(handoff)) return {status: 'skipped', reason: 'turn_ended'};
  if (outcome.status === 'selected') {
    writeAdaptiveAppendResultFor(job.workspaceDir, {
      schemaVersion: ADAPTIVE_APPEND_SCHEMA_VERSION,
      createdAt: Date.now(),
      startedAt: job.createdAt,
      sessionId: job.sessionId,
      turnId: job.turnId,
      target: outcome.target,
      directiveChars: outcome.directive.length,
      nativeActivationIds: [...job.nativeActivationIds],
      nativeChars: job.nativeChars,
      budgetChars: job.budgetChars,
      hookIdentity: job.hookIdentity,
    });
    // "Background selected" is recorded separately from the eventual append:
    // no activationIds here, so this line never claims an injection.
    appendAdaptiveAppendFact({
      stateDir: stateDirOf(job.workspaceDir),
      sessionId: job.sessionId,
      turnId: job.turnId,
      workspaceDir: job.workspaceDir,
      resultCode: 'selected:background_ready',
      scored,
      budget: job.budgetChars,
      injectedCharCount: 0,
    });
    return {status: 'selected', activationId: outcome.target.activationId};
  }
  appendAdaptiveAppendFact({
    stateDir: stateDirOf(job.workspaceDir),
    sessionId: job.sessionId,
    turnId: job.turnId,
    workspaceDir: job.workspaceDir,
    resultCode: factCode(outcome.diagnostic.status, outcome.reason),
    scored,
    budget: job.budgetChars,
    injectedCharCount: 0,
  });
  return {status: outcome.status, reason: outcome.reason};
}

/** Test seam: execute one job without the process boundary. */
export async function runBackgroundSelectionJob(jobPath: string): Promise<BackgroundSelectionJobResult> {
  const job = takeAdaptiveAppendJob(jobPath);
  if (!job) return {status: 'invalid', reason: 'job_unreadable'};
  return execute(job);
}

const [, entryPath, jobPath] = process.argv;
const isMain = typeof entryPath === 'string'
  && path.resolve(entryPath) === fileURLToPath(import.meta.url)
  && jobPath !== undefined;
if (isMain && jobPath !== undefined) {
  try {
    await runBackgroundSelectionJob(jobPath);
  } catch {
    // A detached selector that throws must still leave the turn on Native.
    // No raw error crosses into the host or the evidence log.
    try {
      const job = takeAdaptiveAppendJob(jobPath);
      if (job) {
        appendAdaptiveAppendFact({
          stateDir: stateDirOf(job.workspaceDir),
          sessionId: job.sessionId,
          turnId: job.turnId,
          workspaceDir: job.workspaceDir,
          resultCode: 'skipped:background_selection_failed',
          scored: false,
          budget: job.budgetChars,
          injectedCharCount: 0,
        });
      }
    } catch {
      // Nothing else can be done without risking the host; the turn is Native.
    }
  }
}
