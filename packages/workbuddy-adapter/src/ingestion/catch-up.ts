/**
 * WorkBuddy transcript catch-up (PRI-1171 P2, ticket ⑤).
 *
 * The Stop hook is the primary ingestion trigger, but a hook can time out or
 * a single 1 MiB bounded window can leave lag behind. The worker calls this
 * once per cycle: it walks the DURABLE workbuddy checkpoints (the exact set of
 * sessions the authenticated hook already delivered), locates each transcript
 * by its exact session id, and re-enters the SAME gated pipeline through
 * `ingestWorkbuddyConversation` (so consent is re-read and revocation takes
 * effect immediately).
 *
 * "No session discovery" means it never INVENTS an identity: it does not pick
 * a "latest" or "most interesting" session. It does enumerate the projects
 * directory (`readdirSync`) to find the one file whose name equals an already
 * checkpointed session id, because the host stores each project in a separate
 * directory and the checkpoint does not record which one.
 *
 * Locating is deterministic, not a "latest file" guess: only
 * `<projectsRoot>/<any-project>/<sessionId>.jsonl` with EXACTLY one match is
 * accepted, and `validateWorkbuddyTranscriptPath` re-applies containment,
 * main-session shape and regular-file checks before any read. No schema
 * change, no second source of truth — checkpoints stay the authority.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listGovernanceCheckpoints } from '@principles/host-runtime';
import { ingestWorkbuddyConversation } from './ingestion.js';
import { validateWorkbuddyTranscriptPath, workbuddyProjectsRoot } from './transcript-path.js';

const DEFAULT_MAX_ROLLOUTS = 8;
/** Mirrors the locator's main-session file-name contract; refuse odd identities. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface WorkbuddyCatchUpOptions {
  readonly workspaceDir: string;
  /** Resolved BEFORE any I/O: host.workbuddy AND workbuddy_conversation_ingestion. */
  readonly ingestionEnabled: boolean;
  readonly now?: Date;
  readonly home?: string;
  readonly maxRollouts?: number;
}

export interface WorkbuddyCatchUpResult {
  readonly status: 'ok' | 'skipped' | 'degraded';
  readonly reason?: string;
  readonly nextAction?: string;
  readonly examined: number;
  readonly ingested: number;
  readonly warnings: readonly string[];
}

function locateCheckpointTranscript(projectsRoot: string, rolloutIdentity: string): string | null {
  if (!SESSION_ID_PATTERN.test(rolloutIdentity)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const fileName = `${rolloutIdentity}.jsonl`;
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, fileName);
    try {
      if (fs.statSync(candidate).isFile()) matches.push(candidate);
    } catch {
      // This project does not carry that session — keep looking, never guess.
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export function catchUpWorkbuddyIngestion(options: WorkbuddyCatchUpOptions): WorkbuddyCatchUpResult {
  // Flag gate FIRST — before checkpoint listing or any filesystem scan.
  if (!options.ingestionEnabled) {
    return {
      status: 'skipped',
      reason: 'feature_disabled',
      nextAction: 'Enable workbuddy_conversation_ingestion (and host.workbuddy) plus a granted consent record to start transcript catch-up.',
      examined: 0, ingested: 0, warnings: [],
    };
  }

  const listed = listGovernanceCheckpoints({ workspaceDir: options.workspaceDir, hostKind: 'workbuddy' });
  if (!listed.ok) {
    return {
      status: 'degraded', reason: listed.reason, nextAction: listed.nextAction,
      examined: 0, ingested: 0, warnings: [],
    };
  }
  const projectsRoot = workbuddyProjectsRoot(options.home ?? os.homedir());
  const limit = Math.max(1, Math.min(options.maxRollouts ?? DEFAULT_MAX_ROLLOUTS, 32));
  const checkpoints = listed.checkpoints.slice(0, limit);

  let ingested = 0;
  const warnings: string[] = [];
  for (const checkpoint of checkpoints) {
    const located = locateCheckpointTranscript(projectsRoot, checkpoint.rolloutIdentity);
    if (located === null) {
      warnings.push(`transcript_unavailable:${checkpoint.rolloutIdentity}`);
      continue;
    }
    const validated = validateWorkbuddyTranscriptPath(located, projectsRoot);
    if (!validated.ok) {
      warnings.push(`${validated.reason}:${checkpoint.rolloutIdentity}`);
      continue;
    }
    const outcome = ingestWorkbuddyConversation({
      workspaceDir: options.workspaceDir,
      rawPayload: { transcript_path: validated.canonicalPath },
      sessionId: checkpoint.rolloutIdentity,
      ingestionEnabled: true,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.home !== undefined ? { home: options.home } : {}),
    });
    if (outcome.status === 'ingested') ingested += outcome.inserted;
    else if (outcome.status === 'degraded') warnings.push(`${outcome.reason}:${checkpoint.rolloutIdentity}`);
    // 'skipped' = consent revoked/absent: intentional, never a warning.
  }
  if (warnings.length > 0) {
    return {
      status: 'degraded', reason: 'catch_up_degraded',
      nextAction: 'Inspect the WorkBuddy transcript store and the governance trajectory checkpoints; the worker retries on the next cycle.',
      examined: checkpoints.length, ingested, warnings,
    };
  }
  return { status: 'ok', examined: checkpoints.length, ingested, warnings };
}
