/**
 * SqliteIntentDocVersionStore — SQLite implementation of IntentDocVersionStore.
 *
 * SPEC bilingual+lifecycle: stores immutable snapshots of INTENT.md content
 * each time it changes, enabling version history and rollback. Mirrors the
 * intent_decisions audit pattern (immutable snapshots, hash linkage).
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: DB rows treated as unknown, mapped via guards
 * - EP-03 / ERR-002: write failures throw (fail loud)
 * - rc-2: no `as` bypass — all row fields validated element-wise via isIntentDocVersionRow
 */

import { randomUUID } from 'node:crypto';
import type { SqliteConnection } from '../sqlite-connection.js';
import { computeIntentContentHash } from '../../intent/intent-hash.js';
import type { IntentLang } from '../../intent/intent-doc.js';
import type { IntentDocVersion, IntentDocVersionStore } from '../../intent/intent-doc-version.js';

function isIntentLang(value: unknown): value is IntentLang {
  return value === 'zh-CN' || value === 'en';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface IntentDocVersionRow {
  id: string;
  lang: IntentLang;
  content_hash: string;
  content_snapshot: string;
  reason: string | null;
  created_at: string;
}

function isIntentDocVersionRow(v: unknown): v is IntentDocVersionRow {
  if (!isRecord(v)) return false;
  if (typeof v.id !== 'string') return false;
  if (!isIntentLang(v.lang)) return false;
  if (typeof v.content_hash !== 'string') return false;
  if (typeof v.content_snapshot !== 'string') return false;
  if (v.reason !== null && typeof v.reason !== 'string') return false;
  if (typeof v.created_at !== 'string') return false;
  return true;
}

function mapRow(r: IntentDocVersionRow): IntentDocVersion {
  return {
    id: r.id,
    lang: r.lang,
    contentHash: r.content_hash,
    contentSnapshot: r.content_snapshot,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

export class SqliteIntentDocVersionStore implements IntentDocVersionStore {
  constructor(private readonly connection: SqliteConnection) {}

  async saveVersion(input: { lang: IntentLang; content: string; reason?: string }): Promise<IntentDocVersion> {
    const db = this.connection.getDb();
    const id = randomUUID();
    const contentHash = computeIntentContentHash(input.content);
    const createdAt = new Date().toISOString();
    const reason = input.reason ?? null;
    db.prepare(
      `INSERT INTO intent_doc_versions (id, lang, content_hash, content_snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.lang, contentHash, input.content, reason, createdAt);
    const row = db.prepare(`SELECT * FROM intent_doc_versions WHERE id = ?`).get(id);
    if (!isIntentDocVersionRow(row)) {
      throw new Error(`saveVersion: failed to read back inserted record ${id}`);
    }
    return mapRow(row);
  }

  async listVersions(lang: IntentLang, limit = 50): Promise<IntentDocVersion[]> {
    const db = this.connection.getDb();
    const rows = db.prepare(
      `SELECT * FROM intent_doc_versions WHERE lang = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(lang, limit);
    return rows
      .filter(isIntentDocVersionRow)
      .map(mapRow);
  }

  async getVersion(id: string): Promise<IntentDocVersion | null> {
    const db = this.connection.getDb();
    const row = db.prepare(`SELECT * FROM intent_doc_versions WHERE id = ?`).get(id);
    if (!isIntentDocVersionRow(row)) return null;
    return mapRow(row);
  }

  async getLatest(lang: IntentLang): Promise<IntentDocVersion | null> {
    const db = this.connection.getDb();
    const row = db.prepare(
      `SELECT * FROM intent_doc_versions WHERE lang = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(lang);
    if (!isIntentDocVersionRow(row)) return null;
    return mapRow(row);
  }
}
