/**
 * WorkBuddy conversation-ingestion orchestrator (PRI-1171 P2, ticket ⑤).
 *
 * Connects the EXISTING pieces — the unified host-runtime pipeline, the
 * WorkBuddy TranscriptSourceAdapter from ticket ④, the v3 consent ledger and
 * the workspace feature flags — without introducing a new subsystem. The hook
 * calls `ingestWorkbuddyConversation` on `turn_complete`; the worker calls the
 * catch-up sibling. Both go through this same gate ordering.
 *
 * Gate order is a hard privacy invariant (SPEC §8.2 / §10):
 *   1. resolved flags (host.workbuddy AND workbuddy_conversation_ingestion);
 *   2. the REAL v3 consent record for hostKind='workbuddy';
 *   3. only then any transcript filesystem read (pipeline's port).
 * Steps 1 and 2 perform ZERO transcript port calls. Unlike the Codex path
 * (which still hard-codes `consent: 'granted'` from its setup-flow invariant),
 * this host reads the ledger at runtime, so revoking consent takes effect
 * immediately.
 */
import os from 'node:os';
import {
  readConversationIngestionConsent,
  runConversationIngestion,
  type HookHints,
  type SessionRef,
  type TranscriptPort,
} from '@principles/host-runtime';
import { createWorkbuddyTranscriptSource } from './transcript-source.js';

export interface WorkbuddyIngestionOptions {
  /** Governance workspace (OD-07) — the v3 ledger and trajectory.db live here. */
  readonly workspaceDir: string;
  /** Original, undecoded hook payload: the hint source. */
  readonly rawPayload: unknown;
  readonly sessionId: string;
  /** Host cwd when the payload carries one; Stop does not. */
  readonly cwd?: string;
  /** Resolved BEFORE any I/O by the caller (both flags). */
  readonly ingestionEnabled: boolean;
  readonly now?: Date;
  readonly port?: TranscriptPort;
  readonly home?: string;
}

export type WorkbuddyIngestionOutcome =
  | { status: 'ingested'; inserted: number; warnings: readonly string[] }
  | { status: 'skipped'; reason: string; nextAction: string }
  | { status: 'degraded'; reason: string; nextAction: string; warnings: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Bridge the WorkBuddy snake_case hook payload to the host-neutral
 * `HookHints` contract. Both Stop variants are mapped because the capability
 * matrix names `agent_transcript_path` while the official hooks reference
 * names `transcript_path`; the source adapter already prefers whichever is
 * non-empty. Null / empty hints are dropped (InstructionsLoaded carries "").
 */
export function workbuddyIngestionHints(rawPayload: unknown): HookHints {
  if (!isRecord(rawPayload)) return {};
  const transcriptPath = nonEmptyString(own(rawPayload, 'transcript_path'));
  const agentTranscriptPath = nonEmptyString(own(rawPayload, 'agent_transcript_path'));
  const generationId = nonEmptyString(own(rawPayload, 'generation_id'));
  return {
    ...(transcriptPath !== null ? { transcriptPath } : {}),
    ...(agentTranscriptPath !== null ? { agentTranscriptPath } : {}),
    ...(generationId !== null ? { generationId } : {}),
  };
}

export function ingestWorkbuddyConversation(options: WorkbuddyIngestionOptions): WorkbuddyIngestionOutcome {
  // 1. Flag gate FIRST — before the consent read and before any port call.
  // A flag-off host behaves exactly as before this capability existed.
  if (!options.ingestionEnabled) {
    return {
      status: 'skipped',
      reason: 'ingestion_disabled',
      nextAction: 'Enable workbuddy_conversation_ingestion (and host.workbuddy) in the governance workspace .pd/config.yaml, then record consent with `pd workbuddy setup --accept`.',
    };
  }

  // 2. Real v3 consent ledger — never a hard-coded grant.
  const consent = readConversationIngestionConsent(options.workspaceDir, 'workbuddy');
  if (!consent.ok) {
    return {
      status: 'degraded',
      reason: `consent_unreadable:${consent.reason}`,
      nextAction: consent.nextAction,
      warnings: [],
    };
  }
  const decision = consent.record?.decision ?? 'not_present';
  if (decision !== 'granted') {
    return {
      status: 'skipped',
      reason: `consent_not_granted:${decision}`,
      nextAction: 'Record a granted WorkBuddy ingestion decision with `pd workbuddy setup --accept` before any transcript is read.',
    };
  }

  // 3. Never ingest from a recursively-triggered Stop hook.
  if (isRecord(options.rawPayload) && own(options.rawPayload, 'stop_hook_active') === true) {
    return {
      status: 'skipped',
      reason: 'stop_hook_recursion',
      nextAction: 'The host re-entered the Stop hook; ingestion is skipped to avoid a recursive read loop.',
    };
  }

  const now = options.now ?? new Date();
  const session: SessionRef = {
    sessionId: options.sessionId,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };

  try {
    const outcome = runConversationIngestion({
      workspaceDir: options.workspaceDir,
      source: createWorkbuddyTranscriptSource({ now }),
      session,
      hints: workbuddyIngestionHints(options.rawPayload),
      env: { home: options.home ?? os.homedir() },
      // The pipeline re-checks both gates; passing the real decision keeps a
      // single source of truth and makes the port-spy invariant observable.
      flags: { ingestionEnabled: true },
      consent: { decision },
      now,
      ...(options.port !== undefined ? { port: options.port } : {}),
    });
    if (outcome.status === 'degraded') {
      return {
        status: 'degraded',
        reason: outcome.reason,
        nextAction: outcome.nextAction,
        warnings: outcome.warnings,
      };
    }
    return { status: 'ingested', inserted: outcome.inserted, warnings: outcome.warnings };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return {
      status: 'degraded',
      reason: `workbuddy_ingestion_unexpected:${detail}`,
      nextAction: 'Inspect the WorkBuddy transcript and the governance workspace state; the checkpoint was not advanced past failed work.',
      warnings: [],
    };
  }
}
