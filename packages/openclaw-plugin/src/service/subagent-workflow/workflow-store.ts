import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowRow, WorkflowEventRow, WorkflowState, WorkflowTransport } from './types.js';

const SCHEMA_VERSION = 1;

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
        if (!row) {
            this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
        } else if (row.version !== SCHEMA_VERSION) {
            this.db.prepare('UPDATE schema_version SET version = ?').run(SCHEMA_VERSION);
        }
    }
    
    createWorkflow(row: Omit<WorkflowRow, 'cleanup_state'>): void {
        const now = Date.now();
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
}
