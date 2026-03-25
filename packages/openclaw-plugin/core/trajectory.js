import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { withLock } from '../utils/file-lock.js';
import { resolvePdPath } from './paths.js';
const DEFAULT_INLINE_THRESHOLD = 16 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_ORPHAN_BLOB_GRACE_DAYS = 7;
const SCHEMA_VERSION = 1;
function nowIso() {
    return new Date().toISOString();
}
function safeJson(value) {
    return JSON.stringify(value ?? {});
}
function fileSizeIfExists(filePath) {
    try {
        return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    }
    catch {
        return 0;
    }
}
function summarizeForDiff(text) {
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
function redactText(text) {
    return text
        .replace(/[A-Za-z]:\\[^\s"'`]+/g, '<WINDOWS_PATH>')
        .replace(/\/(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?/g, '<PATH>')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<EMAIL>')
        .replace(/\b(sk|rk|pk)_[A-Za-z0-9]+\b/g, '<TOKEN>');
}
export class TrajectoryDatabase {
    workspaceDir;
    stateDir;
    dbPath;
    blobDir;
    exportDir;
    blobInlineThresholdBytes;
    orphanBlobGraceMs;
    db;
    constructor(opts) {
        this.workspaceDir = path.resolve(opts.workspaceDir);
        this.stateDir = resolvePdPath(this.workspaceDir, 'STATE_DIR');
        this.dbPath = resolvePdPath(this.workspaceDir, 'TRAJECTORY_DB');
        this.blobDir = resolvePdPath(this.workspaceDir, 'TRAJECTORY_BLOBS_DIR');
        this.exportDir = resolvePdPath(this.workspaceDir, 'EXPORTS_DIR');
        this.blobInlineThresholdBytes = opts.blobInlineThresholdBytes ?? DEFAULT_INLINE_THRESHOLD;
        this.orphanBlobGraceMs = Math.max(0, (opts.orphanBlobGraceDays ?? DEFAULT_ORPHAN_BLOB_GRACE_DAYS) * 24 * 60 * 60 * 1000);
        fs.mkdirSync(this.stateDir, { recursive: true });
        fs.mkdirSync(this.blobDir, { recursive: true });
        fs.mkdirSync(this.exportDir, { recursive: true });
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma(`busy_timeout = ${Math.max(0, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
        this.initSchema();
        this.importLegacyArtifacts();
        this.pruneUnreferencedBlobs();
    }
    dispose() {
        this.db.close();
    }
    recordSession(input) {
        const startedAt = input.startedAt ?? nowIso();
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO sessions (session_id, started_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at
      `).run(input.sessionId, startedAt, nowIso());
        });
    }
    recordAssistantTurn(input) {
        this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
        const rawStorage = this.storeRawText('assistant', input.rawText);
        const createdAt = input.createdAt ?? nowIso();
        return this.withWrite(() => {
            const result = this.db.prepare(`
        INSERT INTO assistant_turns (
          session_id, run_id, provider, model, raw_text, sanitized_text, usage_json,
          empathy_signal_json, blob_ref, raw_excerpt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.sessionId, input.runId, input.provider, input.model, rawStorage.inlineText, input.sanitizedText, safeJson(input.usageJson), safeJson(input.empathySignalJson), rawStorage.blobRef, rawStorage.excerpt, createdAt);
            return Number(result.lastInsertRowid);
        });
    }
    recordUserTurn(input) {
        this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
        const rawStorage = this.storeRawText('user', input.rawText);
        const createdAt = input.createdAt ?? nowIso();
        return this.withWrite(() => {
            const result = this.db.prepare(`
        INSERT INTO user_turns (
          session_id, turn_index, raw_text, blob_ref, raw_excerpt,
          correction_detected, correction_cue, references_assistant_turn_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.sessionId, input.turnIndex, rawStorage.inlineText, rawStorage.blobRef, rawStorage.excerpt, input.correctionDetected ? 1 : 0, input.correctionCue ?? null, input.referencesAssistantTurnId ?? null, createdAt);
            return Number(result.lastInsertRowid);
        });
    }
    recordToolCall(input) {
        this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
        const createdAt = input.createdAt ?? nowIso();
        const rowId = this.withWrite(() => {
            const result = this.db.prepare(`
        INSERT INTO tool_calls (
          session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message,
          gfi_before, gfi_after, params_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.sessionId, input.toolName, input.outcome, input.durationMs ?? null, input.exitCode ?? null, input.errorType ?? null, input.errorMessage ?? null, input.gfiBefore ?? null, input.gfiAfter ?? null, safeJson(input.paramsJson), createdAt);
            return Number(result.lastInsertRowid);
        });
        if (input.outcome === 'success') {
            this.maybeCreateCorrectionSample(input.sessionId);
        }
        return rowId;
    }
    recordPainEvent(input) {
        this.recordSession({ sessionId: input.sessionId, startedAt: input.createdAt });
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO pain_events (
          session_id, source, score, reason, severity, origin, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.sessionId, input.source, input.score, input.reason ?? null, input.severity ?? null, input.origin ?? null, input.confidence ?? null, input.createdAt ?? nowIso());
        });
    }
    recordGateBlock(input) {
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO gate_blocks (session_id, tool_name, file_path, reason, plan_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.sessionId ?? null, input.toolName, input.filePath ?? null, input.reason, input.planStatus ?? null, input.createdAt ?? nowIso());
        });
    }
    recordTrustChange(input) {
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO trust_changes (session_id, previous_score, new_score, delta, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.sessionId ?? null, input.previousScore, input.newScore, input.delta, input.reason, input.createdAt ?? nowIso());
        });
    }
    recordPrincipleEvent(input) {
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO principle_events (principle_id, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(input.principleId ?? null, input.eventType, safeJson(input.payload), input.createdAt ?? nowIso());
        });
    }
    recordTaskOutcome(input) {
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO task_outcomes (session_id, task_id, outcome, summary, principle_ids_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(input.sessionId, input.taskId ?? null, input.outcome, input.summary ?? null, safeJson(input.principleIdsJson), input.createdAt ?? nowIso());
        });
    }
    recordEvolutionTask(input) {
        const now = nowIso();
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO evolution_tasks (
          task_id, trace_id, source, reason, score, status,
          enqueued_at, started_at, completed_at, resolution, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          status = excluded.status,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          resolution = excluded.resolution,
          updated_at = excluded.updated_at
      `).run(input.taskId, input.traceId, input.source, input.reason ?? null, input.score ?? 0, input.status ?? 'pending', input.enqueuedAt ?? null, input.startedAt ?? null, input.completedAt ?? null, input.resolution ?? null, input.createdAt ?? now, input.updatedAt ?? now);
        });
    }
    updateEvolutionTask(taskId, updates) {
        const now = nowIso();
        this.withWrite(() => {
            const setClauses = ['updated_at = ?'];
            const values = [now];
            if (updates.status !== undefined) {
                setClauses.push('status = ?');
                values.push(updates.status);
            }
            if (updates.startedAt !== undefined) {
                setClauses.push('started_at = ?');
                values.push(updates.startedAt);
            }
            if (updates.completedAt !== undefined) {
                setClauses.push('completed_at = ?');
                values.push(updates.completedAt);
            }
            if (updates.resolution !== undefined) {
                setClauses.push('resolution = ?');
                values.push(updates.resolution);
            }
            if (updates.score !== undefined) {
                setClauses.push('score = ?');
                values.push(updates.score);
            }
            values.push(taskId);
            this.db.prepare(`
        UPDATE evolution_tasks SET ${setClauses.join(', ')} WHERE task_id = ?
      `).run(...values);
        });
    }
    recordEvolutionEvent(input) {
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO evolution_events (trace_id, task_id, stage, level, message, summary, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.traceId, input.taskId ?? null, input.stage, input.level ?? 'info', input.message, input.summary ?? null, safeJson(input.metadata), input.createdAt ?? nowIso());
        });
    }
    listEvolutionTasks(filters = {}) {
        const conditions = [];
        const values = [];
        if (filters.status) {
            conditions.push('status = ?');
            values.push(filters.status);
        }
        if (filters.dateFrom) {
            conditions.push('created_at >= ?');
            values.push(filters.dateFrom);
        }
        if (filters.dateTo) {
            conditions.push('created_at <= ?');
            values.push(filters.dateTo);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = filters.limit ?? 50;
        const offset = filters.offset ?? 0;
        const rows = this.db.prepare(`
      SELECT id, task_id, trace_id, source, reason, score, status,
             enqueued_at, started_at, completed_at, resolution, created_at, updated_at
      FROM evolution_tasks
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset);
        return rows.map((row) => ({
            id: Number(row.id),
            taskId: String(row.task_id),
            traceId: String(row.trace_id),
            source: String(row.source),
            reason: row.reason ? String(row.reason) : null,
            score: Number(row.score ?? 0),
            status: String(row.status),
            enqueuedAt: row.enqueued_at ? String(row.enqueued_at) : null,
            startedAt: row.started_at ? String(row.started_at) : null,
            completedAt: row.completed_at ? String(row.completed_at) : null,
            resolution: row.resolution ? String(row.resolution) : null,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
        }));
    }
    listEvolutionEvents(traceId, filters = {}) {
        const limit = filters.limit ?? 100;
        const offset = filters.offset ?? 0;
        let rows;
        if (traceId) {
            rows = this.db.prepare(`
        SELECT id, trace_id, task_id, stage, level, message, summary, metadata_json, created_at
        FROM evolution_events
        WHERE trace_id = ?
        ORDER BY created_at ASC
        LIMIT ? OFFSET ?
      `).all(traceId, limit, offset);
        }
        else {
            rows = this.db.prepare(`
        SELECT id, trace_id, task_id, stage, level, message, summary, metadata_json, created_at
        FROM evolution_events
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset);
        }
        return rows.map((row) => ({
            id: Number(row.id),
            traceId: String(row.trace_id),
            taskId: row.task_id ? String(row.task_id) : null,
            stage: String(row.stage),
            level: String(row.level ?? 'info'),
            message: String(row.message),
            summary: row.summary ? String(row.summary) : null,
            metadata: JSON.parse(String(row.metadata_json ?? '{}')),
            createdAt: String(row.created_at),
        }));
    }
    getEvolutionTaskByTraceId(traceId) {
        const row = this.db.prepare(`
      SELECT id, task_id, trace_id, source, reason, score, status,
             enqueued_at, started_at, completed_at, resolution, created_at, updated_at
      FROM evolution_tasks
      WHERE trace_id = ?
      LIMIT 1
    `).get(traceId);
        if (!row)
            return null;
        return {
            id: Number(row.id),
            taskId: String(row.task_id),
            traceId: String(row.trace_id),
            source: String(row.source),
            reason: row.reason ? String(row.reason) : null,
            score: Number(row.score ?? 0),
            status: String(row.status),
            enqueuedAt: row.enqueued_at ? String(row.enqueued_at) : null,
            startedAt: row.started_at ? String(row.started_at) : null,
            completedAt: row.completed_at ? String(row.completed_at) : null,
            resolution: row.resolution ? String(row.resolution) : null,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
        };
    }
    getEvolutionStats() {
        const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM evolution_tasks GROUP BY status
    `).all();
        const stats = { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 };
        for (const row of rows) {
            stats.total += row.count;
            if (row.status === 'pending')
                stats.pending = row.count;
            else if (row.status === 'in_progress')
                stats.inProgress = row.count;
            else if (row.status === 'completed')
                stats.completed = row.count;
            else if (row.status === 'failed')
                stats.failed = row.count;
        }
        return stats;
    }
    listAssistantTurns(sessionId) {
        const rows = this.db.prepare(`
      SELECT id, session_id, run_id, provider, model, raw_text, sanitized_text, blob_ref, created_at
      FROM assistant_turns
      WHERE session_id = ?
      ORDER BY id ASC
    `).all(sessionId);
        return rows.map((row) => ({
            id: Number(row.id),
            sessionId: String(row.session_id),
            runId: String(row.run_id),
            provider: String(row.provider),
            model: String(row.model),
            rawText: this.restoreRawText(row.raw_text, row.blob_ref),
            sanitizedText: String(row.sanitized_text ?? ''),
            blobRef: row.blob_ref ? String(row.blob_ref) : null,
            createdAt: String(row.created_at),
        }));
    }
    listCorrectionSamples(status = 'pending') {
        const rows = this.db.prepare(`
      SELECT sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
             recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
             review_status, export_mode, created_at, updated_at
      FROM correction_samples
      WHERE review_status = ?
      ORDER BY created_at DESC
    `).all(status);
        return rows.map((row) => ({
            sampleId: String(row.sample_id),
            sessionId: String(row.session_id),
            badAssistantTurnId: Number(row.bad_assistant_turn_id),
            userCorrectionTurnId: Number(row.user_correction_turn_id),
            recoveryToolSpanJson: String(row.recovery_tool_span_json),
            diffExcerpt: String(row.diff_excerpt ?? ''),
            principleIdsJson: String(row.principle_ids_json ?? '[]'),
            qualityScore: Number(row.quality_score),
            reviewStatus: row.review_status,
            exportMode: row.export_mode,
            createdAt: String(row.created_at),
            updatedAt: String(row.updated_at),
        }));
    }
    reviewCorrectionSample(sampleId, status, note) {
        const updatedAt = nowIso();
        const updated = this.withWrite(() => {
            const updateResult = this.db.prepare(`
        UPDATE correction_samples
        SET review_status = ?, updated_at = ?
        WHERE sample_id = ?
      `).run(status, updatedAt, sampleId);
            if (updateResult.changes === 0) {
                return false;
            }
            this.db.prepare(`
        INSERT INTO sample_reviews (sample_id, review_status, note, created_at)
        VALUES (?, ?, ?, ?)
      `).run(sampleId, status, note ?? null, updatedAt);
            return true;
        });
        if (!updated) {
            throw new Error(`Correction sample not found: ${sampleId}`);
        }
        const record = this.db.prepare(`
      SELECT sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
             recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
             review_status, export_mode, created_at, updated_at
      FROM correction_samples
      WHERE sample_id = ?
    `).get(sampleId);
        if (!record) {
            throw new Error(`Correction sample not found after review update: ${sampleId}`);
        }
        return {
            sampleId: String(record.sample_id),
            sessionId: String(record.session_id),
            badAssistantTurnId: Number(record.bad_assistant_turn_id),
            userCorrectionTurnId: Number(record.user_correction_turn_id),
            recoveryToolSpanJson: String(record.recovery_tool_span_json),
            diffExcerpt: String(record.diff_excerpt ?? ''),
            principleIdsJson: String(record.principle_ids_json ?? '[]'),
            qualityScore: Number(record.quality_score),
            reviewStatus: record.review_status,
            exportMode: record.export_mode,
            createdAt: String(record.created_at),
            updatedAt: String(record.updated_at),
        };
    }
    exportCorrections(opts) {
        const rows = this.db.prepare(`
      SELECT cs.sample_id, cs.session_id, cs.recovery_tool_span_json, cs.diff_excerpt, cs.quality_score,
             at.raw_text AS assistant_raw_text, at.blob_ref AS assistant_blob_ref, at.sanitized_text,
             ut.raw_text AS user_raw_text, ut.blob_ref AS user_blob_ref, ut.correction_cue
      FROM correction_samples cs
      JOIN assistant_turns at ON at.id = cs.bad_assistant_turn_id
      JOIN user_turns ut ON ut.id = cs.user_correction_turn_id
      WHERE (? = 0 OR cs.review_status = 'approved')
      ORDER BY cs.created_at ASC
    `).all(opts.approvedOnly ? 1 : 0);
        const exportPath = path.join(this.exportDir, `corrections-${Date.now()}-${opts.mode}.jsonl`);
        const lines = rows.map((row) => {
            const assistantRaw = this.restoreRawText(row.assistant_raw_text, row.assistant_blob_ref);
            const userRaw = this.restoreRawText(row.user_raw_text, row.user_blob_ref);
            const assistantText = opts.mode === 'redacted' ? redactText(assistantRaw) : assistantRaw;
            const userText = opts.mode === 'redacted' ? redactText(userRaw) : userRaw;
            return JSON.stringify({
                sample_id: row.sample_id,
                session_id: row.session_id,
                instruction: userText,
                input_context: assistantText,
                bad_attempt_summary: String(row.diff_excerpt ?? ''),
                preferred_response: userText,
                labels: {
                    correction_cue: row.correction_cue,
                    quality_score: row.quality_score,
                },
                metadata: {
                    mode: opts.mode,
                    recovery_tool_span_json: row.recovery_tool_span_json,
                },
            });
        });
        fs.writeFileSync(exportPath, `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`, 'utf8');
        this.recordExportAudit('corrections', opts.mode, opts.approvedOnly, exportPath, rows.length);
        return { filePath: exportPath, count: rows.length, mode: opts.mode };
    }
    exportAnalytics() {
        const payload = {
            generatedAt: nowIso(),
            stats: this.getDataStats(),
            dailyMetrics: this.dailyMetrics(),
            errorClusters: this.db.prepare('SELECT * FROM v_error_clusters').all(),
            principleEffectiveness: this.db.prepare('SELECT * FROM v_principle_effectiveness').all(),
            sampleQueue: this.db.prepare('SELECT * FROM v_sample_queue').all(),
        };
        const exportPath = path.join(this.exportDir, `analytics-${Date.now()}.json`);
        fs.writeFileSync(exportPath, JSON.stringify(payload, null, 2), 'utf8');
        this.recordExportAudit('analytics', 'raw', true, exportPath, Array.isArray(payload.dailyMetrics) ? payload.dailyMetrics.length : 0);
        return { filePath: exportPath, count: Array.isArray(payload.dailyMetrics) ? payload.dailyMetrics.length : 0 };
    }
    getDataStats() {
        const getCount = (table, where) => {
            const sql = where ? `SELECT COUNT(*) as count FROM ${table} WHERE ${where}` : `SELECT COUNT(*) as count FROM ${table}`;
            return Number(this.db.prepare(sql).get().count);
        };
        const lastIngest = this.db.prepare(`
      SELECT MAX(ts) AS ts FROM (
        SELECT MAX(created_at) AS ts FROM assistant_turns
        UNION ALL SELECT MAX(created_at) AS ts FROM user_turns
        UNION ALL SELECT MAX(created_at) AS ts FROM tool_calls
        UNION ALL SELECT MAX(created_at) AS ts FROM pain_events
      )
    `).get();
        return {
            dbPath: this.dbPath,
            dbSizeBytes: fileSizeIfExists(this.dbPath),
            assistantTurns: getCount('assistant_turns'),
            userTurns: getCount('user_turns'),
            toolCalls: getCount('tool_calls'),
            painEvents: getCount('pain_events'),
            pendingSamples: getCount('correction_samples', `review_status = 'pending'`),
            approvedSamples: getCount('correction_samples', `review_status = 'approved'`),
            blobBytes: this.computeBlobBytes(),
            lastIngestAt: lastIngest.ts ?? null,
        };
    }
    cleanupBlobStorage() {
        return this.pruneUnreferencedBlobs();
    }
    initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_checkpoint (
        source_key TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assistant_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        raw_text TEXT,
        sanitized_text TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        empathy_signal_json TEXT NOT NULL,
        blob_ref TEXT,
        raw_excerpt TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        raw_text TEXT,
        blob_ref TEXT,
        raw_excerpt TEXT,
        correction_detected INTEGER NOT NULL DEFAULT 0,
        correction_cue TEXT,
        references_assistant_turn_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms INTEGER,
        exit_code INTEGER,
        error_type TEXT,
        error_message TEXT,
        gfi_before REAL,
        gfi_after REAL,
        params_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT,
        severity TEXT,
        origin TEXT,
        confidence REAL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gate_blocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        tool_name TEXT NOT NULL,
        file_path TEXT,
        reason TEXT NOT NULL,
        plan_status TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trust_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        previous_score REAL NOT NULL,
        new_score REAL NOT NULL,
        delta REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS principle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principle_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_id TEXT,
        outcome TEXT NOT NULL,
        summary TEXT,
        principle_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS correction_samples (
        sample_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        bad_assistant_turn_id INTEGER NOT NULL,
        user_correction_turn_id INTEGER NOT NULL,
        recovery_tool_span_json TEXT NOT NULL,
        diff_excerpt TEXT NOT NULL,
        principle_ids_json TEXT NOT NULL,
        quality_score REAL NOT NULL,
        review_status TEXT NOT NULL,
        export_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sample_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sample_id TEXT NOT NULL,
        review_status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exports_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        export_kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        approved_only INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evolution_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT UNIQUE NOT NULL,
        trace_id TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT,
        score INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        enqueued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evolution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        task_id TEXT,
        stage TEXT NOT NULL,
        level TEXT DEFAULT 'info',
        message TEXT NOT NULL,
        summary TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE VIEW IF NOT EXISTS v_error_clusters AS
      SELECT tool_name, COALESCE(error_type, 'unknown') AS error_type, COUNT(*) AS occurrences
      FROM tool_calls
      WHERE outcome = 'failure'
      GROUP BY tool_name, COALESCE(error_type, 'unknown')
      ORDER BY occurrences DESC;
      CREATE VIEW IF NOT EXISTS v_principle_effectiveness AS
      SELECT event_type, COUNT(*) AS total
      FROM principle_events
      GROUP BY event_type
      ORDER BY total DESC;
      CREATE VIEW IF NOT EXISTS v_sample_queue AS
      SELECT review_status, COUNT(*) AS total
      FROM correction_samples
      GROUP BY review_status;
      CREATE INDEX IF NOT EXISTS idx_assistant_turns_session_id ON assistant_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_assistant_turns_created_at ON assistant_turns(created_at);
      CREATE INDEX IF NOT EXISTS idx_assistant_turns_provider_model ON assistant_turns(provider, model);
      CREATE INDEX IF NOT EXISTS idx_user_turns_session_id ON user_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at);
      CREATE INDEX IF NOT EXISTS idx_pain_events_session_id ON pain_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_correction_samples_review_status ON correction_samples(review_status);
      CREATE INDEX IF NOT EXISTS idx_evolution_tasks_trace_id ON evolution_tasks(trace_id);
      CREATE INDEX IF NOT EXISTS idx_evolution_tasks_status ON evolution_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_evolution_tasks_created_at ON evolution_tasks(created_at);
      CREATE INDEX IF NOT EXISTS idx_evolution_events_trace_id ON evolution_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_evolution_events_created_at ON evolution_events(created_at);
    `);
        const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get();
        this.migrateSchema(row?.version);
        if (!row) {
            this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        }
        else if (row.version !== SCHEMA_VERSION) {
            this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
        }
    }
    importLegacyArtifacts() {
        this.importLegacySessions();
        this.importLegacyEvents();
        this.importLegacyEvolution();
    }
    migrateSchema(_fromVersion) {
        this.db.exec(`
      DROP VIEW IF EXISTS v_daily_metrics;
      CREATE VIEW IF NOT EXISTS v_daily_metrics AS
      WITH tool_daily AS (
        SELECT
          substr(created_at, 1, 10) AS day,
          COUNT(*) AS tool_calls,
          SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) AS failures
        FROM tool_calls
        GROUP BY substr(created_at, 1, 10)
      ),
      correction_daily AS (
        SELECT
          substr(created_at, 1, 10) AS day,
          SUM(CASE WHEN correction_detected = 1 THEN 1 ELSE 0 END) AS user_corrections
        FROM user_turns
        GROUP BY substr(created_at, 1, 10)
      )
      SELECT
        tool_daily.day AS day,
        tool_daily.tool_calls AS tool_calls,
        tool_daily.failures AS failures,
        COALESCE(correction_daily.user_corrections, 0) AS user_corrections
      FROM tool_daily
      LEFT JOIN correction_daily ON correction_daily.day = tool_daily.day;
    `);
    }
    dailyMetrics() {
        return this.db.prepare('SELECT * FROM v_daily_metrics ORDER BY day ASC').all();
    }
    importLegacySessions() {
        const key = 'legacy:sessions';
        if (this.isImported(key))
            return;
        const sessionDir = resolvePdPath(this.workspaceDir, 'SESSION_DIR');
        if (!fs.existsSync(sessionDir))
            return;
        for (const file of fs.readdirSync(sessionDir).filter((entry) => entry.endsWith('.json'))) {
            try {
                const content = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
                if (content.sessionId) {
                    const startedAt = typeof content.lastActivityAt === 'number'
                        ? new Date(content.lastActivityAt).toISOString()
                        : nowIso();
                    this.recordSession({ sessionId: content.sessionId, startedAt });
                }
            }
            catch {
                // Ignore malformed legacy sessions.
            }
        }
        this.markImported(key);
    }
    importLegacyEvents() {
        const key = 'legacy:events';
        if (this.isImported(key))
            return;
        const eventsPath = path.join(this.stateDir, 'logs', 'events.jsonl');
        if (!fs.existsSync(eventsPath))
            return;
        const raw = fs.readFileSync(eventsPath, 'utf8').trim();
        if (!raw) {
            this.markImported(key);
            return;
        }
        for (const line of raw.split('\n')) {
            try {
                const event = JSON.parse(line);
                if (event.type === 'pain_signal' && event.sessionId) {
                    this.recordPainEvent({
                        sessionId: event.sessionId,
                        source: String(event.data?.source ?? 'legacy'),
                        score: Number(event.data?.score ?? 0),
                        reason: typeof event.data?.reason === 'string' ? event.data.reason : null,
                        severity: typeof event.data?.severity === 'string' ? event.data.severity : null,
                        origin: typeof event.data?.origin === 'string' ? event.data.origin : null,
                        confidence: typeof event.data?.confidence === 'number' ? event.data.confidence : null,
                        createdAt: event.ts,
                    });
                }
                if (event.type === 'trust_change') {
                    this.recordTrustChange({
                        sessionId: event.sessionId,
                        previousScore: Number(event.data?.previousScore ?? 0),
                        newScore: Number(event.data?.newScore ?? 0),
                        delta: Number(event.data?.delta ?? 0),
                        reason: String(event.data?.reason ?? 'legacy'),
                        createdAt: event.ts,
                    });
                }
                if (event.type === 'gate_block') {
                    this.recordGateBlock({
                        sessionId: event.sessionId,
                        toolName: String(event.data?.toolName ?? 'unknown'),
                        filePath: typeof event.data?.filePath === 'string' ? event.data.filePath : null,
                        reason: String(event.data?.reason ?? 'legacy'),
                        planStatus: typeof event.data?.planStatus === 'string' ? event.data.planStatus : null,
                        createdAt: event.ts,
                    });
                }
            }
            catch {
                // Ignore malformed legacy events.
            }
        }
        this.markImported(key);
    }
    importLegacyEvolution() {
        const key = 'legacy:evolution';
        if (this.isImported(key))
            return;
        const evolutionPath = resolvePdPath(this.workspaceDir, 'EVOLUTION_STREAM');
        if (!fs.existsSync(evolutionPath))
            return;
        const raw = fs.readFileSync(evolutionPath, 'utf8').trim();
        if (!raw) {
            this.markImported(key);
            return;
        }
        for (const line of raw.split('\n')) {
            try {
                const event = JSON.parse(line);
                this.recordPrincipleEvent({
                    principleId: typeof event.data?.principleId === 'string' ? event.data.principleId : null,
                    eventType: String(event.type ?? 'legacy'),
                    payload: event.data ?? {},
                    createdAt: event.ts,
                });
            }
            catch {
                // Ignore malformed legacy evolution events.
            }
        }
        this.markImported(key);
    }
    markImported(sourceKey) {
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO ingest_checkpoint (source_key, imported_at)
        VALUES (?, ?)
        ON CONFLICT(source_key) DO UPDATE SET imported_at = excluded.imported_at
      `).run(sourceKey, nowIso());
        });
    }
    isImported(sourceKey) {
        const row = this.db.prepare('SELECT source_key FROM ingest_checkpoint WHERE source_key = ?').get(sourceKey);
        return Boolean(row);
    }
    maybeCreateCorrectionSample(sessionId) {
        const pending = this.db.prepare(`
      SELECT sample_id FROM correction_samples
      WHERE session_id = ? AND review_status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId);
        if (pending?.sample_id)
            return;
        const correctionTurn = this.db.prepare(`
      SELECT id, references_assistant_turn_id, correction_cue, raw_text, blob_ref
      FROM user_turns
      WHERE session_id = ? AND correction_detected = 1
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId);
        if (!correctionTurn || !correctionTurn.references_assistant_turn_id)
            return;
        const failedCall = this.db.prepare(`
      SELECT id, tool_name, error_type, error_message
      FROM tool_calls
      WHERE session_id = ? AND outcome = 'failure'
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId);
        if (!failedCall)
            return;
        const successfulCalls = this.db.prepare(`
      SELECT id, tool_name
      FROM tool_calls
      WHERE session_id = ? AND outcome = 'success'
      ORDER BY id DESC
      LIMIT 3
    `).all(sessionId);
        if (successfulCalls.length === 0)
            return;
        const sampleId = `sample_${crypto.createHash('md5').update(`${sessionId}:${correctionTurn.id}:${successfulCalls[0].id}`).digest('hex').slice(0, 12)}`;
        const userRawText = this.restoreRawText(correctionTurn.raw_text, correctionTurn.blob_ref);
        const qualityScore = [
            correctionTurn.references_assistant_turn_id ? 35 : 0,
            correctionTurn.correction_cue ? 20 : 0,
            failedCall ? 20 : 0,
            successfulCalls.length > 0 ? 25 : 0,
        ].reduce((sum, value) => sum + value, 0);
        this.withWrite(() => {
            this.db.prepare(`
        INSERT OR IGNORE INTO correction_samples (
          sample_id, session_id, bad_assistant_turn_id, user_correction_turn_id,
          recovery_tool_span_json, diff_excerpt, principle_ids_json, quality_score,
          review_status, export_mode, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'raw', ?, ?)
      `).run(sampleId, sessionId, Number(correctionTurn.references_assistant_turn_id), Number(correctionTurn.id), safeJson(successfulCalls.map((call) => ({ id: call.id, toolName: call.tool_name }))), summarizeForDiff(userRawText || String(failedCall.error_message ?? failedCall.error_type ?? failedCall.tool_name)), '[]', qualityScore, nowIso(), nowIso());
        });
    }
    recordExportAudit(exportKind, mode, approvedOnly, filePath, rowCount) {
        this.withWrite(() => {
            this.db.prepare(`
        INSERT INTO exports_audit (export_kind, mode, approved_only, file_path, row_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(exportKind, mode, approvedOnly ? 1 : 0, filePath, rowCount, nowIso());
        });
    }
    storeRawText(kind, text) {
        const excerpt = text.length > 200 ? `${text.slice(0, 197)}...` : text;
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes <= this.blobInlineThresholdBytes) {
            return { inlineText: text, blobRef: null, excerpt };
        }
        const hash = crypto.createHash('sha256').update(text).digest('hex');
        const relativePath = `${kind}-${hash}.txt`;
        const fullPath = path.join(this.blobDir, relativePath);
        if (!fs.existsSync(fullPath)) {
            fs.writeFileSync(fullPath, text, 'utf8');
        }
        return { inlineText: null, blobRef: relativePath, excerpt };
    }
    restoreRawText(inlineText, blobRef) {
        if (inlineText)
            return inlineText;
        if (!blobRef)
            return '';
        const fullPath = path.join(this.blobDir, blobRef);
        return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '';
    }
    computeBlobBytes() {
        if (!fs.existsSync(this.blobDir))
            return 0;
        return fs.readdirSync(this.blobDir).reduce((sum, file) => sum + fileSizeIfExists(path.join(this.blobDir, file)), 0);
    }
    pruneUnreferencedBlobs() {
        if (!fs.existsSync(this.blobDir)) {
            return { removedFiles: 0, reclaimedBytes: 0 };
        }
        const referenced = new Set();
        const rows = this.db.prepare(`
      SELECT blob_ref FROM assistant_turns WHERE blob_ref IS NOT NULL
      UNION
      SELECT blob_ref FROM user_turns WHERE blob_ref IS NOT NULL
    `).all();
        for (const row of rows) {
            if (row.blob_ref)
                referenced.add(String(row.blob_ref));
        }
        const now = Date.now();
        let removedFiles = 0;
        let reclaimedBytes = 0;
        for (const entry of fs.readdirSync(this.blobDir)) {
            if (referenced.has(entry))
                continue;
            const fullPath = path.join(this.blobDir, entry);
            let stat;
            try {
                stat = fs.statSync(fullPath);
            }
            catch {
                continue;
            }
            if (!stat.isFile())
                continue;
            if (this.orphanBlobGraceMs > 0 && now - stat.mtimeMs < this.orphanBlobGraceMs)
                continue;
            reclaimedBytes += stat.size;
            removedFiles += 1;
            fs.rmSync(fullPath, { force: true });
        }
        return { removedFiles, reclaimedBytes };
    }
    withWrite(fn) {
        return withLock(this.dbPath, fn, { lockSuffix: '.trajectory.lock', lockStaleMs: 30000 });
    }
}
export class TrajectoryRegistry {
    static instances = new Map();
    static get(workspaceDir, opts = {}) {
        const normalized = path.resolve(workspaceDir);
        const existing = this.instances.get(normalized);
        if (existing)
            return existing;
        const created = new TrajectoryDatabase({ workspaceDir: normalized, ...opts });
        this.instances.set(normalized, created);
        return created;
    }
    static dispose(workspaceDir) {
        const normalized = path.resolve(workspaceDir);
        const instance = this.instances.get(normalized);
        if (instance) {
            instance.dispose();
            this.instances.delete(normalized);
        }
    }
    static clear() {
        for (const instance of this.instances.values()) {
            instance.dispose();
        }
        this.instances.clear();
    }
    static use(workspaceDir, fn, opts = {}) {
        const normalized = path.resolve(workspaceDir);
        const existing = this.instances.get(normalized);
        if (existing) {
            return fn(existing);
        }
        const transient = new TrajectoryDatabase({ workspaceDir: normalized, ...opts });
        try {
            return fn(transient);
        }
        finally {
            transient.dispose();
        }
    }
}
