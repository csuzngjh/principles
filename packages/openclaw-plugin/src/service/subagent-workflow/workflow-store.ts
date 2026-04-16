/* eslint-disable no-console */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowRow, WorkflowEventRow, WorkflowState } from './types.js';
import type { DreamerOutput, PhilosopherOutput } from '../../core/nocturnal-trinity.js';

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
            CREATE TABLE IF NOT EXISTS subagent_workflow_stage_outputs (
                workflow_id TEXT NOT NULL,
                stage TEXT NOT NULL CHECK (stage IN ('dreamer', 'philosopher')),
                output_json TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (workflow_id) REFERENCES subagent_workflows(workflow_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_stage_outputs_workflow ON subagent_workflow_stage_outputs(workflow_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_outputs_idempotency ON subagent_workflow_stage_outputs(idempotency_key);

            CREATE INDEX IF NOT EXISTS idx_events_workflow ON subagent_workflow_events(workflow_id);
        `);
        
        const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: number } | undefined;
        const currentVersion = row?.version ?? 0;
        if (currentVersion === 0) {
            this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        } else if (currentVersion < SCHEMA_VERSION) {
            // Run migrations for existing databases
            this.runMigrations(currentVersion, SCHEMA_VERSION);
            this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
        }
    }

    private runMigrations(fromVersion: number, toVersion: number): void {
        if (fromVersion < 2 && toVersion >= 2) {
            // v1 → v2: Add duration_ms column for adaptive timeout tracking
            try {
                this.db.exec('ALTER TABLE subagent_workflows ADD COLUMN duration_ms INTEGER');
                console.info(`[PD:WorkflowStore] Schema migration v${fromVersion} → v${toVersion}: added duration_ms column`);
            } catch {
                // Column may already exist if migration was partially applied
            }
        }
    }

    createWorkflow(row: Omit<WorkflowRow, 'cleanup_state'>): void {
        this.db.prepare(`
            INSERT INTO subagent_workflows (
                workflow_id, workflow_type, transport, parent_session_id, child_session_key,
                run_id, state, cleanup_state, created_at, updated_at, last_observed_at, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, NULL, ?)
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

    /** List all workflows, optionally filtered by state. */
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
    
    /**
     * Record a Trinity stage output to the database (NOC-11).
     * idempotencyKey must be unique per (workflow_id, stage). If a row with the
     * same idempotency_key already exists, this is a no-op (idempotent).
     */
     
     
    recordStageOutput(
        workflowId: string,
        stage: 'dreamer' | 'philosopher',
        output: DreamerOutput | PhilosopherOutput,
        idempotencyKey: string
    ): void {
        const now = Date.now();
        // Use INSERT OR IGNORE for idempotency — if idempotency_key already exists, silently skip
        this.db.prepare(`
            INSERT OR IGNORE INTO subagent_workflow_stage_outputs (
                workflow_id, stage, output_json, idempotency_key, created_at
            ) VALUES (?, ?, ?, ?, ?)
        `).run(
            workflowId,
            stage,
            JSON.stringify(output),
            idempotencyKey,
            now
        );
    }

    /**
     * Get all stage outputs for a workflow (NOC-13 crash recovery).
     * Returns outputs ordered by created_at ascending.
     */
    getStageOutputs(workflowId: string): {
        stage: string;
        output: DreamerOutput | PhilosopherOutput;
        idempotencyKey: string;
        createdAt: number;
    }[] {
        const rows = this.db.prepare(`
            SELECT workflow_id, stage, output_json, idempotency_key, created_at
            FROM subagent_workflow_stage_outputs
            WHERE workflow_id = ?
            ORDER BY created_at ASC
        `).all(workflowId) as {
            workflow_id: string;
            stage: string;
            output_json: string;
            idempotency_key: string;
            created_at: number;
        }[];

        return rows.map(row => ({
            workflowId: row.workflow_id,
            stage: row.stage,
            output: JSON.parse(row.output_json) as DreamerOutput | PhilosopherOutput,
            idempotencyKey: row.idempotency_key,
            createdAt: row.created_at,
        }));
    }

    /**
     * Get a stage output by its idempotency key (NOC-12 idempotency check).
     * Returns null if not found.
     */
    getStageOutputByKey(idempotencyKey: string): {
        stage: string;
        output: DreamerOutput | PhilosopherOutput;
        workflowId: string;
        createdAt: number;
    } | null {
        const row = this.db.prepare(`
            SELECT workflow_id, stage, output_json, idempotency_key, created_at
            FROM subagent_workflow_stage_outputs
            WHERE idempotency_key = ?
        `).get(idempotencyKey) as {
            workflow_id: string;
            stage: string;
            output_json: string;
            idempotency_key: string;
            created_at: number;
        } | undefined;

        if (!row) return null;

        return {
            workflowId: row.workflow_id,
            stage: row.stage,
            output: JSON.parse(row.output_json) as DreamerOutput | PhilosopherOutput,
            createdAt: row.created_at,
        };
    }

    deleteWorkflow(workflowId: string): void {
        this.db.prepare('DELETE FROM subagent_workflows WHERE workflow_id = ?').run(workflowId);
    }

    /**
     * Record the actual completion duration for a workflow.
     * Used by adaptive timeout learning.
     */
    recordDuration(workflowId: string, durationMs: number): void {
        this.db.prepare(`
            UPDATE subagent_workflows SET duration_ms = ?, updated_at = ? WHERE workflow_id = ?
        `).run(durationMs, Date.now(), workflowId);
    }

    /**
     * Get completion durations for a specific workflow type, ordered by most recent first.
     * Returns an array of duration_ms values for adaptive timeout calculation.
     */
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
