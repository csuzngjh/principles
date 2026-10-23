/** Read-only adapter over the canonical trajectory store; never creates/migrates it. */
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { createOwnerEvidenceScopeError } from '@principles/core/runtime-v2/internalization/evidence-readiness';
import type { BehaviorEvidencePort, ToolSemanticRegistry } from '@principles/core/runtime-v2';
import type { RuleHostEvidenceRow, RuleHostContextRow } from '@principles/core/trajectory-types';
import { BehaviorExamplePackAssembler, type BehaviorExampleDataSource } from './behavior-example-pack-assembler.js';
import { resolveWorkspaceHostToolSemantics } from './host-tool-semantic-resolver.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextRow(value: unknown): RuleHostContextRow {
  if (!record(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id)
    || typeof value.tool_name !== 'string' || typeof value.outcome !== 'string' || typeof value.params_json !== 'string') {
    throw new Error('Malformed trajectory context row');
  }
  const params: unknown = JSON.parse(value.params_json);
  if (!record(params)) throw new Error('Malformed trajectory params object');
  if (Object.keys(params).some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
    throw new Error('Unsafe keys in persisted trajectory params');
  }
  return { id: value.id, toolName: value.tool_name, outcome: value.outcome, paramsJson: value.params_json };
}

function source(db: Database.Database): BehaviorExampleDataSource {
  return {
    getPainEventByCanonicalId(id) {
      const row: unknown = db.prepare('SELECT id, session_id FROM pain_events WHERE canonical_pain_id = ? LIMIT 1').get(id);
      if (row === undefined) return null;
      if (!record(row) || typeof row.id !== 'number' || typeof row.session_id !== 'string') throw new Error('Malformed pain lineage row');
      return { id: row.id, sessionId: row.session_id };
    },
    getRuleHostEvidenceRow(id): RuleHostEvidenceRow | null {
      const row: unknown = db.prepare('SELECT id, session_id, tool_name, outcome, params_json FROM tool_calls WHERE id = ? LIMIT 1').get(id);
      if (row === undefined) return null;
      if (!record(row) || typeof row.session_id !== 'string') throw new Error('Malformed trajectory evidence row');
      return { ...contextRow(row), sessionId: row.session_id };
    },
    getRuleHostContextRowsBefore(sessionId, beforeId, limit) {
      const rows: unknown[] = db.prepare('SELECT id, tool_name, outcome, params_json FROM tool_calls WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(sessionId, beforeId, limit + 1);
      return { rows: rows.slice(0, limit).reverse().map(contextRow), truncated: rows.length > limit };
    },
  };
}

/** Lazy storage access: missing labels need no DB, and a failed open remains observable. */
export function createWorkspaceBehaviorEvidencePort(workspaceDir: string, toolSemantics?: ToolSemanticRegistry): BehaviorEvidencePort {
  return {
    assemble(selection) {
      const resolved = toolSemantics === undefined ? resolveWorkspaceHostToolSemantics(workspaceDir) : null;
      if (resolved !== null && !resolved.ok) throw createOwnerEvidenceScopeError('evidence_source_error', resolved.reason);
      const semantics = toolSemantics ?? (resolved !== null && resolved.ok ? resolved.registry : undefined);
      if (semantics === undefined) throw createOwnerEvidenceScopeError('evidence_source_error', 'Host tool semantics unavailable');
      let db: Database.Database;
      try {
        db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
      } catch (error) {
        throw createOwnerEvidenceScopeError('evidence_source_error', `Trajectory evidence unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        // One read snapshot prevents a pack combining different trajectory revisions.
        return db.transaction(() => new BehaviorExamplePackAssembler({ source: source(db), toolSemantics: semantics })
          .assemble({ ...selection, projectDir: workspaceDir }))();
      } finally {
        db.close();
      }
    },
  };
}

/**
 * Read one bounded, same-session history window from the canonical trajectory
 * database. The timestamp is the caller's pre-event cutoff; rows at or after
 * it are excluded so replayed/future calls cannot enter a live RuleContext.
 * This is read-only and never creates or migrates trajectory state.
 */
export function readWorkspaceRuleContextRowsBefore(
  workspaceDir: string,
  input: { sessionId: string; projectDir: string; beforeCreatedAt: string; excludeToolUseId: string; limit: number },
): { rows: readonly RuleHostContextRow[]; truncated: boolean; unscopedPriorRows: boolean } {
  const { sessionId, projectDir, beforeCreatedAt, excludeToolUseId, limit } = input;
  if (sessionId.trim().length === 0) throw new Error('history_session_id_invalid');
  if (!path.isAbsolute(projectDir)) throw new Error('history_project_dir_invalid');
  if (excludeToolUseId.trim().length === 0) throw new Error('history_tool_use_id_invalid');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('history_limit_invalid');
  if (!Number.isFinite(Date.parse(beforeCreatedAt))) throw new Error('history_cutoff_invalid');

  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 100');
    return db.transaction(() => {
      const rows: unknown[] = db.prepare(`
        SELECT id, tool_name, outcome, params_json
        FROM tool_calls
        WHERE session_id = ? AND project_dir = ? AND created_at < ? AND (tool_use_id IS NULL OR tool_use_id <> ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(sessionId, projectDir, beforeCreatedAt, excludeToolUseId, limit + 1);
      const unscoped: unknown = db.prepare(`
        SELECT 1 AS found FROM tool_calls
        WHERE session_id = ? AND project_dir IS NULL AND created_at < ?
          AND (tool_use_id IS NULL OR tool_use_id <> ?) LIMIT 1
      `).get(sessionId, beforeCreatedAt, excludeToolUseId);
      if (!Array.isArray(rows)) throw new Error('history_query_invalid');
      return {
        rows: rows.slice(0, limit).reverse().map(contextRow),
        truncated: rows.length > limit,
        unscopedPriorRows: unscoped !== undefined,
      };
    })();
  } finally {
    db.close();
  }
}

/**
 * List only Codex sessions proven by normalized host evidence and a matching
 * project-scoped trajectory row. The trajectory schema has no host_kind on
 * tool_calls, so that table alone is never used to infer the host.
 */
export function listObservedDesignGateSessions(
  workspaceDir: string,
): { projectWorkspacePath: string; hostSessionId: string }[] {
  const connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false });
  let evidenceRefs: { hostSessionId: string; lastObservedAt: string }[];
  try {
    const db = connection.getDb();
    const exists: unknown = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'intervention_evidence_records'").get();
    if (exists === undefined) return [];
    const rawRows: unknown[] = db.prepare(`
      SELECT native_refs_json, recorded_at
      FROM intervention_evidence_records
      ORDER BY recorded_at DESC
      LIMIT 1000
    `).all();
    const found = new Map<string, string>();
    for (const raw of rawRows) {
      if (!record(raw) || typeof raw.native_refs_json !== 'string' || typeof raw.recorded_at !== 'string') continue;
      let refs: unknown;
      try { refs = JSON.parse(raw.native_refs_json); } catch { continue; }
      if (!record(refs) || refs.hostKind !== 'codex' || typeof refs.sessionId !== 'string' || refs.sessionId.trim().length === 0) continue;
      if (!found.has(refs.sessionId)) found.set(refs.sessionId, raw.recorded_at);
    }
    evidenceRefs = [...found].map(([hostSessionId, lastObservedAt]) => ({ hostSessionId, lastObservedAt }));
  } finally {
    connection.close();
  }

  const trajectoryPath = path.join(workspaceDir, '.state', 'trajectory.db');
  const trajectory = new Database(trajectoryPath, { readonly: true, fileMustExist: true });
  try {
    const selectProject = trajectory.prepare(`
      SELECT project_dir, MAX(created_at) AS last_seen
      FROM tool_calls
      WHERE session_id = ? AND project_dir IS NOT NULL
      GROUP BY project_dir
      ORDER BY last_seen DESC
    `);
    const candidates: { projectWorkspacePath: string; hostSessionId: string; seenAt: string }[] = [];
    for (const evidence of evidenceRefs) {
      const rows: unknown[] = selectProject.all(evidence.hostSessionId);
      for (const raw of rows) {
        if (!record(raw) || typeof raw.project_dir !== 'string' || !path.isAbsolute(raw.project_dir)
          || typeof raw.last_seen !== 'string') continue;
        try {
          candidates.push({
            projectWorkspacePath: fs.realpathSync.native(raw.project_dir),
            hostSessionId: evidence.hostSessionId,
            seenAt: raw.last_seen > evidence.lastObservedAt ? raw.last_seen : evidence.lastObservedAt,
          });
        } catch { /* stale project paths are not offered as selectable sessions */ }
      }
    }
    const unique = new Map<string, { projectWorkspacePath: string; hostSessionId: string; seenAt: string }>();
    for (const candidate of candidates) {
      const key = `${candidate.projectWorkspacePath}\0${candidate.hostSessionId}`;
      const current = unique.get(key);
      if (!current || candidate.seenAt > current.seenAt) unique.set(key, candidate);
    }
    return [...unique.values()]
      .sort((left, right) => right.seenAt.localeCompare(left.seenAt))
      .slice(0, 100)
      .map(({ projectWorkspacePath, hostSessionId }) => ({ projectWorkspacePath, hostSessionId }));
  } finally {
    trajectory.close();
  }
}
