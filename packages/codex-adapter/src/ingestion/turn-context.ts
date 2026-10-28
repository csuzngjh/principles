/**
 * Live-turn context bridge for agent-assisted explicit Owner pain
 * registration (no `PD记录痛苦：` prefix).
 *
 * The hook writes the CURRENT turn's host-verified identity — session id,
 * turn id, transcript path, CODEX_HOME, workspace — to a file partitioned by
 * the hook payload's session id. Stop clears only a matching session+turn;
 * SessionStart clears only that session. The agent-driven CLI entry selects
 * the file using the host-bound CODEX_SESSION_ID, so concurrent conversations
 * cannot overwrite or borrow each other's context.
 *
 * Trust model: the file is host-written (hook payload fields only). The
 * bridge re-validates everything it reads as untrusted JSON (rc-1/rc-2),
 * cross-checks the workspace, and `recordExplicitOwnerStatement` re-validates
 * the transcript path (existence + CODEX_HOME containment + rollout identity)
 * at registration time. A cleared or stale context fails closed.
 *
 * Privacy: each file carries identifiers and paths only — never prompt text,
 * never transcript content. Session ids are hashed in filenames. The
 * conversation-ingestion flag does not gate context publication.
 */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveCodexHome } from './codex-home.js';
import { extractFields, isRecord } from './ingestion-fields.js';
import { recordExplicitOwnerStatement, MAX_OWNER_STATEMENT_CHARS, type RecordOwnerStatementResult } from './explicit-owner-statement.js';

export const TURN_CONTEXT_FILENAME_PREFIX = 'pd_current_turn_context_';
export const TURN_CONTEXT_SCHEMA_VERSION = 1;

/**
 * Staleness bound for the turn context. Stop/SessionStart withdraw the file,
 * but any early exit on those paths (decode/config failure, host.codex flag
 * flip, crash) leaves residue behind; a context older than this bound is
 * treated as ended and fails closed instead of binding a finished turn. 4h
 * mirrors the workspace-lease TTL default and sits far above the longest
 * legitimate in-turn registration latency.
 */
export const TURN_CONTEXT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/** Host-written identity of the CURRENT Codex turn. Ids and paths only. */
export interface CodexTurnContext {
  readonly schemaVersion: number;
  readonly writtenAt: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly transcriptPath: string;
  readonly codexHome: string;
  readonly workspaceDir: string;
}

interface CodexCallerEnvironment {
  CODEX_HOME?: string | undefined;
  CODEX_SESSION_ID?: string | undefined;
  CODEX_THREAD_ID?: string | undefined;
}

export type TurnContextWriteResult = { ok: true } | { ok: false; reason: string; nextAction: string };
export type TurnContextClearResult = { ok: true } | { ok: false; reason: string };

function resolveCallerSessionId(env: CodexCallerEnvironment): { ok: true; sessionId: string } | { ok: false; reason: 'caller_session_missing' | 'caller_session_conflict' } {
  const sessionId = env.CODEX_SESSION_ID?.trim();
  if (!sessionId) return { ok: false, reason: 'caller_session_missing' };
  const threadId = env.CODEX_THREAD_ID?.trim();
  if (threadId && threadId !== sessionId) return { ok: false, reason: 'caller_session_conflict' };
  return { ok: true, sessionId };
}

function turnContextPath(workspaceDir: string, sessionId: string): string {
  const sessionKey = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  return path.join(workspaceDir, '.state', `${TURN_CONTEXT_FILENAME_PREFIX}${sessionKey}.json`);
}

/**
 * Withdraw the current turn context (Stop / SessionStart). Only ENOENT is
 * ignored (nothing to withdraw); any other unlink failure is surfaced so the
 * caller can emit a diagnostic — swallowing it would leave the old context
 * bindable and silently break the fail-closed guarantee (rc-9). A failure
 * here never blocks the hook.
 */
function unlinkContext(target: string): TurnContextClearResult {
  try {
    fs.unlinkSync(target);
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT') return { ok: true };
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `clear_failed:${detail.slice(0, 160)}` };
  }
}

function restoreWithdrawnContext(staged: string, target: string): TurnContextClearResult {
  try {
    // Linking restores only if no newer turn has appeared at the target path.
    fs.linkSync(staged, target);
  } catch (error) {
    if (!(error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'EEXIST')) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `clear_failed:${detail.slice(0, 160)}` };
    }
  }
  return unlinkContext(staged);
}

export function clearCurrentTurnContext(args: { workspaceDir: string; sessionId: string; turnId?: string }): TurnContextClearResult {
  const target = turnContextPath(args.workspaceDir, args.sessionId);
  if (args.turnId === undefined) return unlinkContext(target);
  try {
    if (!fs.lstatSync(target).isFile()) return { ok: false, reason: 'clear_failed:context_not_regular_file' };
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT') return { ok: true };
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `clear_failed:${detail.slice(0, 160)}` };
  }
  const staged = `${target}.withdraw-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(target, staged);
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT') return { ok: true };
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `clear_failed:${detail.slice(0, 160)}` };
  }
  let current: unknown;
  try {
    current = JSON.parse(fs.readFileSync(staged, 'utf8'));
  } catch {
    return restoreWithdrawnContext(staged, target);
  }
  if (!isRecord(current) || current.sessionId !== args.sessionId || current.turnId !== args.turnId) {
    return restoreWithdrawnContext(staged, target);
  }
  return unlinkContext(staged);
}

const CLEAR_FAILURE_NEXT_ACTION = 'The previous turn context could not be withdrawn; the agent-assisted explicit entry stays fail-closed only via its staleness bound. Inspect the workspace .state directory.';

/**
 * Publish (or withdraw) the current turn context. Called from the
 * UserPromptSubmit branch of the hook. A payload without complete lineage
 * (session/turn/transcript) clears any previous file instead of leaving a
 * stale turn bindable — the invariant is "file exists ⟺ the current turn
 * carries full lineage". Fail-open: a write failure degrades the
 * agent-assisted entry only (the prefix entry never needed this file).
 */
export function writeCurrentTurnContext(args: {
  rawPayload: unknown;
  workspaceDir: string;
  env?: CodexCallerEnvironment;
}): TurnContextWriteResult {
  const fields = extractFields(args.rawPayload);
  if (fields === null || fields.sessionId.length === 0) {
    return { ok: false, reason: 'hook_session_missing', nextAction: 'The Codex hook payload has no session identity; no turn context was written or cleared.' };
  }
  if (fields.turnId === null || fields.transcriptPath === null) {
    const cleared = clearCurrentTurnContext({
      workspaceDir: args.workspaceDir,
      sessionId: fields.sessionId,
      ...(fields.turnId !== null ? { turnId: fields.turnId } : {}),
    });
    if (!cleared.ok) return { ok: false, reason: cleared.reason, nextAction: CLEAR_FAILURE_NEXT_ACTION };
    return { ok: true };
  }
  const home = resolveCodexHome(args.env);
  if (!home.ok) {
    const cleared = clearCurrentTurnContext({ workspaceDir: args.workspaceDir, sessionId: fields.sessionId, turnId: fields.turnId });
    if (!cleared.ok) return { ok: false, reason: cleared.reason, nextAction: CLEAR_FAILURE_NEXT_ACTION };
    return { ok: false, reason: `codex_home:${home.reason}`, nextAction: home.nextAction };
  }
  const context: CodexTurnContext = {
    schemaVersion: TURN_CONTEXT_SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    sessionId: fields.sessionId,
    turnId: fields.turnId,
    transcriptPath: fields.transcriptPath,
    codexHome: home.home,
    workspaceDir: args.workspaceDir,
  };
  const target = turnContextPath(args.workspaceDir, fields.sessionId);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(context));
    fs.renameSync(temp, target);
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
    const detail = error instanceof Error ? error.message : String(error);
    const cleared = clearCurrentTurnContext({ workspaceDir: args.workspaceDir, sessionId: fields.sessionId });
    const reason = `write_failed:${detail.slice(0, 160)}${cleared.ok ? '' : `;${cleared.reason}`}`;
    const nextAction = cleared.ok
      ? 'The previous session context was withdrawn after this write failed. Inspect workspace .state writability before retrying the agent-assisted explicit entry.'
      : 'The write failed and the previous session context could not be withdrawn. Do not retry the agent-assisted entry until the workspace .state context is manually cleared.';
    return { ok: false, reason, nextAction };
  }
}

export type RegisterCurrentTurnResult =
  | RecordOwnerStatementResult
  | {
    status: 'rejected';
    reason: 'turn_context_missing' | 'turn_context_invalid' | 'turn_context_stale' | 'turn_context_workspace_mismatch' | 'turn_context_session_mismatch' | 'caller_session_missing' | 'caller_session_conflict';
    nextAction: string;
  };

function requireStringField(record: Record<string, unknown>, key: string): string | null {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readTurnContext(workspaceDir: string, sessionId: string): CodexTurnContext | { error: 'turn_context_missing' | 'turn_context_invalid' | 'turn_context_stale' } {
  let raw: string;
  try {
    raw = fs.readFileSync(turnContextPath(workspaceDir, sessionId), 'utf8');
  } catch {
    return { error: 'turn_context_missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'turn_context_invalid' };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== TURN_CONTEXT_SCHEMA_VERSION) return { error: 'turn_context_invalid' };
  const writtenAt = requireStringField(parsed, 'writtenAt');
  const contextSessionId = requireStringField(parsed, 'sessionId');
  const turnId = requireStringField(parsed, 'turnId');
  const transcriptPath = requireStringField(parsed, 'transcriptPath');
  const codexHome = requireStringField(parsed, 'codexHome');
  const contextWorkspaceDir = requireStringField(parsed, 'workspaceDir');
  if (writtenAt === null || contextSessionId === null || turnId === null || transcriptPath === null || codexHome === null || contextWorkspaceDir === null) {
    return { error: 'turn_context_invalid' };
  }
  const writtenAtMs = Date.parse(writtenAt);
  if (Number.isNaN(writtenAtMs)) return { error: 'turn_context_invalid' };
  if (Date.now() - writtenAtMs > TURN_CONTEXT_MAX_AGE_MS) return { error: 'turn_context_stale' };
  return {
    schemaVersion: TURN_CONTEXT_SCHEMA_VERSION,
    writtenAt,
    sessionId: contextSessionId,
    turnId,
    transcriptPath,
    codexHome,
    workspaceDir: contextWorkspaceDir,
  };
}

/**
 * Register one explicit Owner statement through the LIVE turn context — the
 * agent-assisted counterpart of the prefix entry. The statement must be the
 * Owner's verbatim words from the CURRENT conversation turn (1–500 chars,
 * rejected when over the limit — never truncated); lineage comes exclusively
 * from the host-written context file, never from caller-supplied ids.
 */
export async function registerCurrentTurnOwnerStatement(args: {
  workspaceDir: string;
  statementText: string;
}): Promise<RegisterCurrentTurnResult> {
  const caller = resolveCallerSessionId(process.env);
  if (!caller.ok) {
    return {
      status: 'rejected',
      reason: caller.reason,
      nextAction: caller.reason === 'caller_session_missing'
        ? 'This command has no host-bound Codex session identity; nothing was read or recorded. Run it from the originating Codex session.'
        : 'The host session and thread identities conflict; nothing was read or recorded. Retry from the originating Codex session.',
    };
  }
  const context = readTurnContext(args.workspaceDir, caller.sessionId);
  if ('error' in context) {
    const nextAction = context.error === 'turn_context_missing'
      ? 'No live Codex turn context: the turn already completed, the session restarted, or the PD hook did not run. The native prefix entry (PD记录痛苦：<原文>) remains available in a NEW Owner message.'
      : context.error === 'turn_context_stale'
        ? `The live turn context is stale (older than ${TURN_CONTEXT_MAX_AGE_MS / 3_600_000} hours); treat the turn as ended. Nothing was recorded — use the native prefix entry (PD记录痛苦：<原文>) in a NEW Owner message.`
        : 'The Codex turn context file is malformed or an unsupported schema version; nothing was recorded. Retry in a new turn or use the native prefix entry (PD记录痛苦：<原文>).';
    return {
      status: 'rejected',
      reason: context.error,
      nextAction,
    };
  }
  if (path.resolve(context.workspaceDir) !== path.resolve(args.workspaceDir)) {
    return {
      status: 'rejected',
      reason: 'turn_context_workspace_mismatch',
      nextAction: 'The live turn context belongs to a different PD workspace; resolve the workspace the same way pd-status does and retry. Nothing was recorded.',
    };
  }
  if (context.sessionId !== caller.sessionId) {
    return {
      status: 'rejected',
      reason: 'turn_context_session_mismatch',
      nextAction: 'The turn context does not belong to this host-bound Codex session; nothing was recorded. Retry from the session that supplied the Owner statement.',
    };
  }
  const statement = args.statementText.trim();
  if (statement.length === 0) {
    return { status: 'rejected', reason: 'statement_empty', nextAction: 'The Owner statement is empty; nothing was recorded. Pass the Owner verbatim words (1–500 characters).' };
  }
  if (statement.length > MAX_OWNER_STATEMENT_CHARS) {
    return { status: 'rejected', reason: 'statement_too_long', nextAction: `The Owner statement exceeds ${MAX_OWNER_STATEMENT_CHARS} characters; nothing was recorded. Ask the Owner to condense THEIR words — do not summarize on their behalf.` };
  }
  return recordExplicitOwnerStatement({
    rawPayload: {
      session_id: context.sessionId,
      turn_id: context.turnId,
      transcript_path: context.transcriptPath,
    },
    workspaceDir: args.workspaceDir,
    statementText: statement,
    env: { CODEX_HOME: context.codexHome },
    explicitChannel: 'codex_explicit_agent',
  });
}
