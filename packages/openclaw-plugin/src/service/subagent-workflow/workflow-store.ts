
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowRow, WorkflowEventRow, WorkflowState } from './types.js';

const SCHEMA_VERSION = 2;

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface WorkflowStoreOptions {
    workspaceDir: string;
    busyTimeoutMs?: number;
}

export class WorkflowStore {
    private readonly workspaceDir: string;
    private readonly dbPath: string;
    private readonly db: Database.Database;
    
    constructor(opts: WorkflowStoreOptions) {
        this.workspaceDir = path.resolve(opts.workspaceDir);
        const stateDir = path.join(this.workspaceDir, '.state');
        this.dbPath = path.join(stateDir, 'subagent_workflows.db');
        
        fs.mkdirSync(stateDir, { recursive: true });
        
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma(`busy_timeout = ${Math.max(0, opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
        this.initSchema();
    }
    
    dispose(): void {
        this.db.close();
    }
    
    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS subagent_workflows (
                workflow_id TEXT PRIMARY KEY,
                workflow_type TEXT NOT NULL,
                transport TEXT NOT NULL,
                parent_session_id TEXT NOT NULL,
                child_session_key TEXT NOT NULL,
                run_id TEXT,
                state TEXT NOT NULL DEFAULT 'pending',
                cleanup_state TEXT NOT NULL DEFAULT 'none',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_observed_at INTEGER,
                duration_ms INTEGER,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );
            
            CREATE TABLE IF NOT EXISTS subagent_workflow_events (
                workflow_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                from_state TEXT,
                to_state TEXT NOT NULL,
                reason TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                FOREIGN KEY (workflow_id) REFERENCES subagent_workflows(workflow_id) ON DELETE CASCADE
            );
            
            CREATE INDEX IF NOT EXISTS idx_workflows_parent_session ON subagent_workflows(parent_session_id);
            CREATE INDEX IF NOT EXISTS idx_workflows_child_session ON subagent_workflows(child_session_key);
            CREATE INDEX IF NOT EXISTS idx_workflows_state ON subagent_workflows(state);
            CREATE INDEX IF NOT EXISTS idx_workflows_type ON subagent_workflows(workflow_type);

            CREATE INDEX IF NOT EXISTS idx_events_workflow ON subagent_workflow_events(workflow_id);
        `);
        
        const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
        const currentVersion = row?.version ?? 0;
        if (currentVersion === 0) {
            this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        } else if (currentVersion < SCHEMA_VERSION) {
            this.runMigrations(currentVersion, SCHEMA_VERSION);
            this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
        }
    }

    private runMigrations(fromVersion: number, toVersion: number): void {
        if (fromVersion < 2 && toVersion >= 2) {
            try {
                this.db.exec('ALTER TABLE subagent_workflows ADD COLUMN duration_ms INTEGER');
                console.info(`[PD:WorkflowStore] Schema migration v${fromVersion} → v${toVersion}: added duration_ms column`);
            } catch (err: unknown) {
                // rc-9: surface failure reason instead of silent void 0
                const message = err instanceof Error ? err.message : String(err);
                if (!message.includes('duplicate column name')) {
                    console.info(`[PD:WorkflowStore] Schema migration v${fromVersion} → v${toVersion} failed: ${message}`);
                }
            }
        }
    }

    createWorkflow(row: Omit<WorkflowRow, 'cleanup_state'>): void {
        this.db.prepare(`
            INSERT INTO subagent_workflows (
                workflow_id, workflow_type, transport, parent_session_id, child_session_key,
                run_id, state, cleanup_state, created_at, updated_at, last_observed_at, duration_ms, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?)
        `).run(
            row.workflow_id,
            row.workflow_type,
            row.transport,
            row.parent_session_id,
            row.child_session_key,
            row.run_id,
            row.state,
            row.created_at,
            row.updated_at,
            row.last_observed_at ?? null,
            row.duration_ms ?? null,
            row.metadata_json
        );
    }
    
    updateWorkflowState(workflowId: string, state: WorkflowState, reason?: string): void {
        const now = Date.now();
        const current = this.getWorkflow(workflowId);
        if (!current) return;
        
        this.db.prepare(`
            UPDATE subagent_workflows SET state = ?, updated_at = ?, last_observed_at = ? WHERE workflow_id = ?
        `).run(state, now, now, workflowId);
        
        if (reason) {
            this.recordEvent(workflowId, 'state_change', current.state, state, reason, {});
        }
    }
    
    updateWorkflowRunId(workflowId: string, runId: string): void {
        const now = Date.now();
        this.db.prepare(`
            UPDATE subagent_workflows SET run_id = ?, updated_at = ? WHERE workflow_id = ?
        `).run(runId, now, workflowId);
    }
    
    updateCleanupState(workflowId: string, cleanupState: 'none' | 'pending' | 'failed' | 'completed'): void {
        const now = Date.now();
        this.db.prepare(`
            UPDATE subagent_workflows SET cleanup_state = ?, updated_at = ? WHERE workflow_id = ?
        `).run(cleanupState, now, workflowId);
    }
    
    touchWorkflow(workflowId: string): void {
        const now = Date.now();
        this.db.prepare(`
            UPDATE subagent_workflows SET last_observed_at = ?, updated_at = ? WHERE workflow_id = ?
        `).run(now, now, workflowId);
    }
    
    getWorkflow(workflowId: string): WorkflowRow | null {
        const row = this.db.prepare('SELECT * FROM subagent_workflows WHERE workflow_id = ?').get(workflowId) as WorkflowRow | undefined;
        return row ?? null;
    }
    
    getWorkflowByChildSession(childSessionKey: string): WorkflowRow | null {
        const row = this.db.prepare('SELECT * FROM subagent_workflows WHERE child_session_key = ?').get(childSessionKey) as WorkflowRow | undefined;
        return row ?? null;
    }
    
    getWorkflowByParentSession(parentSessionId: string, workflowType?: string): WorkflowRow | null {
        let sql = 'SELECT * FROM subagent_workflows WHERE parent_session_id = ?';
        const params: unknown[] = [parentSessionId];
        
        if (workflowType) {
            sql += ' AND workflow_type = ?';
            params.push(workflowType);
        }
        
        sql += ' ORDER BY created_at DESC LIMIT 1';
        
        const row = this.db.prepare(sql).get(...params) as WorkflowRow | undefined;
        return row ?? null;
    }
    
    getActiveWorkflows(workflowType?: string): WorkflowRow[] {
        let sql = "SELECT * FROM subagent_workflows WHERE state NOT IN ('completed', 'terminal_error', 'expired')";
        const params: unknown[] = [];
        
        if (workflowType) {
            sql += ' AND workflow_type = ?';
            params.push(workflowType);
        }
        
        sql += ' ORDER BY created_at ASC';
        
        return this.db.prepare(sql).all(...params) as WorkflowRow[];
    }
    
    getExpiredWorkflows(maxAgeMs: number): WorkflowRow[] {
        const cutoff = Date.now() - maxAgeMs;
        return this.db.prepare(`
            SELECT * FROM subagent_workflows
            WHERE last_observed_at IS NOT NULL
            AND last_observed_at < ?
            AND state NOT IN ('completed', 'terminal_error', 'expired')
            ORDER BY last_observed_at ASC
        `).all(cutoff) as WorkflowRow[];
    }

    listWorkflows(state?: string): WorkflowRow[] {
        if (state) {
            return this.db.prepare(`
                SELECT * FROM subagent_workflows
                WHERE state = ?
                ORDER BY created_at DESC
            `).all(state) as WorkflowRow[];
        }
        return this.db.prepare(`
            SELECT * FROM subagent_workflows
            ORDER BY created_at DESC
        `).all() as WorkflowRow[];
    }
    
    recordEvent(
        workflowId: string,
        eventType: string,
        fromState: WorkflowState | null,
        toState: WorkflowState,
        reason: string,
        payload: Record<string, unknown>
    ): void {
        const now = Date.now();
        this.db.prepare(`
            INSERT INTO subagent_workflow_events (
                workflow_id, event_type, from_state, to_state, reason, payload_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            workflowId,
            eventType,
            fromState,
            toState,
            reason,
            JSON.stringify(payload),
            now
        );
    }
    
    getEvents(workflowId: string): WorkflowEventRow[] {
        return this.db.prepare(`
            SELECT * FROM subagent_workflow_events WHERE workflow_id = ? ORDER BY created_at ASC
        `).all(workflowId) as WorkflowEventRow[];
    }

    deleteWorkflow(workflowId: string): void {
        this.db.prepare('DELETE FROM subagent_workflows WHERE workflow_id = ?').run(workflowId);
    }

    recordDuration(workflowId: string, durationMs: number): void {
        this.db.prepare(`
            UPDATE subagent_workflows SET duration_ms = ?, updated_at = ? WHERE workflow_id = ?
        `).run(durationMs, Date.now(), workflowId);
    }

    getCompletionDurations(workflowType: string, limit = 50): number[] {
        const rows = this.db.prepare(`
            SELECT duration_ms FROM subagent_workflows
            WHERE workflow_type = ?
            AND state = 'completed'
            AND duration_ms IS NOT NULL
            AND duration_ms > 0
            ORDER BY created_at DESC
            LIMIT ?
        `).all(workflowType, limit) as { duration_ms: number }[];

        return rows.map(r => r.duration_ms);
    }
}

/**
 * Initialize subagent_workflows.db schema at the given workspace directory.
 *
 * Opens the DB in write mode, applies the full schema (tables + indexes + migrations),
 * then closes the DB. Used by `pd runtime init` for unified DB initialization.
 *
 * Idempotent: safe to call on an existing DB; all CREATE statements use IF NOT EXISTS.
 *
 * @returns list of created/verified table names and any warnings
 */
export function initWorkflowSchema(workspaceDir: string): { tables: string[]; warnings: string[] } {
    const resolvedDir = path.resolve(workspaceDir);
    const stateDir = path.join(resolvedDir, '.state');
    const dbPath = path.join(stateDir, 'subagent_workflows.db');
    const warnings: string[] = [];
    const tables = ['schema_version', 'subagent_workflows', 'subagent_workflow_events'];

    fs.mkdirSync(stateDir, { recursive: true });

    const db = new Database(dbPath);
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.pragma('synchronous = NORMAL');
        db.pragma(`busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);

        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS subagent_workflows (
                workflow_id TEXT PRIMARY KEY,
                workflow_type TEXT NOT NULL,
                transport TEXT NOT NULL,
                parent_session_id TEXT NOT NULL,
                child_session_key TEXT NOT NULL,
                run_id TEXT,
                state TEXT NOT NULL DEFAULT 'pending',
                cleanup_state TEXT NOT NULL DEFAULT 'none',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_observed_at INTEGER,
                duration_ms INTEGER,
                metadata_json TEXT NOT NULL DEFAULT '{}'
            );
            CREATE TABLE IF NOT EXISTS subagent_workflow_events (
                workflow_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                from_state TEXT,
                to_state TEXT NOT NULL,
                reason TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                FOREIGN KEY (workflow_id) REFERENCES subagent_workflows(workflow_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_workflows_parent_session ON subagent_workflows(parent_session_id);
            CREATE INDEX IF NOT EXISTS idx_workflows_child_session ON subagent_workflows(child_session_key);
            CREATE INDEX IF NOT EXISTS idx_workflows_state ON subagent_workflows(state);
            CREATE INDEX IF NOT EXISTS idx_workflows_type ON subagent_workflows(workflow_type);
            CREATE INDEX IF NOT EXISTS idx_events_workflow ON subagent_workflow_events(workflow_id);
        `);

        // Run migrations to bring schema up to SCHEMA_VERSION
        const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
        const currentVersion = row?.version ?? 0;
        if (currentVersion === 0) {
            db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        } else if (currentVersion < SCHEMA_VERSION) {
            // Inline migration logic (mirrors WorkflowStore.runMigrations)
            if (currentVersion < 2 && SCHEMA_VERSION >= 2) {
                try {
                    db.exec('ALTER TABLE subagent_workflows ADD COLUMN duration_ms INTEGER');
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : String(err);
                    if (!message.includes('duplicate column name')) {
                        warnings.push(`migration v${currentVersion}→v${SCHEMA_VERSION} duration_ms failed: ${message}`);
                    }
                }
            }
            db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
        }

        return { tables, warnings };
    } finally {
        db.close();
    }
}
