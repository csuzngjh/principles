/** Read-only adapter over the canonical trajectory store; never creates/migrates it. */
import path from 'node:path';
import Database from 'better-sqlite3';
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
