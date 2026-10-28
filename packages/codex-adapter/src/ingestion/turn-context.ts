/**
 * Live-turn context bridge for agent-assisted explicit Owner pain
 * registration (no `PD记录痛苦：` prefix).
 *
 * The hook writes the CURRENT turn's host-verified identity — session id,
 * turn id, transcript path, CODEX_HOME, workspace — to one turn-scoped file
 * under `<workspace>/.state` on every UserPromptSubmit and clears it when the
 * turn completes (Stop) or the session restarts. `registerCurrentTurnOwnerStatement()`
 * consumes that file so the agent-driven CLI entry (`pd pain explicit`) can
 * hand the Owner's verbatim words to the SAME registration chain the prefix
 * entry uses (`recordExplicitOwnerStatement` → shared admission → diagnostician
 * task), while the model never sees, guesses, or transcribes lineage ids.
 *
 * Trust model: the file is host-written (hook payload fields only). The
 * bridge re-validates everything it reads as untrusted JSON (rc-1/rc-2),
 * cross-checks the workspace, and `recordExplicitOwnerStatement` re-validates
 * the transcript path (existence + CODEX_HOME containment + rollout identity)
 * at registration time. A cleared or stale context fails closed.
 *
 * Privacy: the file carries identifiers and paths only — never prompt text,
 * never transcript content. The conversation-ingestion flag does not gate it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexHome } from './codex-home.js';
import { extractFields, isRecord } from './ingestion-fields.js';
import { recordExplicitOwnerStatement, MAX_OWNER_STATEMENT_CHARS, type RecordOwnerStatementResult } from './explicit-owner-statement.js';

export const TURN_CONTEXT_FILENAME = 'pd_current_turn_context.json';
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

export type TurnContextWriteResult = { ok: true } | { ok: false; reason: string; nextAction: string };
export type TurnContextClearResult = { ok: true } | { ok: false; reason: string };

function turnContextPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.state', TURN_CONTEXT_FILENAME);
}

/**
 * Withdraw the current turn context (Stop / SessionStart). Only ENOENT is
 * ignored (nothing to withdraw); any other unlink failure is surfaced so the
 * caller can emit a diagnostic — swallowing it would leave the old context
 * bindable and silently break the fail-closed guarantee (rc-9). A failure
 * here never blocks the hook.
 */
export function clearCurrentTurnContext(args: { workspaceDir: string }): TurnContextClearResult {
  try {
    fs.unlinkSync(turnContextPath(args.workspaceDir));
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && Object.hasOwn(error, 'code') && Reflect.get(error, 'code') === 'ENOENT') {
      return { ok: true };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `clear_failed:${detail.slice(0, 160)}` };
  }
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
  env?: { CODEX_HOME?: string | undefined };
}): TurnContextWriteResult {
  const fields = extractFields(args.rawPayload);
  if (fields === null || fields.sessionId.length === 0 || fields.turnId === null || fields.transcriptPath === null) {
    const cleared = clearCurrentTurnContext({ workspaceDir: args.workspaceDir });
    if (!cleared.ok) return { ok: false, reason: cleared.reason, nextAction: CLEAR_FAILURE_NEXT_ACTION };
    return { ok: true };
  }
  const home = resolveCodexHome(args.env);
  if (!home.ok) {
    const cleared = clearCurrentTurnContext({ workspaceDir: args.workspaceDir });
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
  const target = turnContextPath(args.workspaceDir);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(context));
    fs.renameSync(temp, target);
    return { ok: true };
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best-effort temp cleanup */ }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `write_failed:${detail.slice(0, 160)}`, nextAction: 'Inspect workspace .state writability; the agent-assisted explicit entry is degraded until the hook can write the turn context.' };
  }
}

export type RegisterCurrentTurnResult =
  | RecordOwnerStatementResult
  | {
    status: 'rejected';
    reason: 'turn_context_missing' | 'turn_context_invalid' | 'turn_context_stale' | 'turn_context_workspace_mismatch';
    nextAction: string;
  };

function requireStringField(record: Record<string, unknown>, key: string): string | null {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readTurnContext(workspaceDir: string): CodexTurnContext | { error: 'turn_context_missing' | 'turn_context_invalid' | 'turn_context_stale' } {
  let raw: string;
  try {
    raw = fs.readFileSync(turnContextPath(workspaceDir), 'utf8');
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
  const sessionId = requireStringField(parsed, 'sessionId');
  const turnId = requireStringField(parsed, 'turnId');
  const transcriptPath = requireStringField(parsed, 'transcriptPath');
  const codexHome = requireStringField(parsed, 'codexHome');
  const contextWorkspaceDir = requireStringField(parsed, 'workspaceDir');
  if (writtenAt === null || sessionId === null || turnId === null || transcriptPath === null || codexHome === null || contextWorkspaceDir === null) {
    return { error: 'turn_context_invalid' };
  }
  const writtenAtMs = Date.parse(writtenAt);
  if (Number.isNaN(writtenAtMs)) return { error: 'turn_context_invalid' };
  if (Date.now() - writtenAtMs > TURN_CONTEXT_MAX_AGE_MS) return { error: 'turn_context_stale' };
  return {
    schemaVersion: TURN_CONTEXT_SCHEMA_VERSION,
    writtenAt,
    sessionId,
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
  const context = readTurnContext(args.workspaceDir);
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
