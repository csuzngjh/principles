import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WorkspaceNotFoundError } from '../config/index.js';

const CENTRAL_DB_DIR = '.central';
const CENTRAL_DB_NAME = 'aggregated.db';

export interface WorkspaceInfo {
  name: string;
  path: string;
  lastSync: string | null;
}

/**
 * Central database that aggregates data from all agent workspaces.
 * Stored in ~/.openclaw/.central/ (NOT in memory/ which is for embeddings)
 */
export class CentralDatabase {
  private readonly dbPath: string;
  private readonly db: Database.Database;
  private readonly workspaces: WorkspaceInfo[] = [];

  constructor() {
    const openClawDir = os.homedir();
    this.dbPath = path.join(openClawDir, '.openclaw', CENTRAL_DB_DIR, CENTRAL_DB_NAME);
    
    // Ensure directory exists
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    
    this.initSchema();
    this.discoverWorkspaces();
  }

  dispose(): void {
    this.db.close();
  }

  private tableExists(db: Database.Database, tableName: string): boolean {
    const result = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name=?
    `).get(tableName);
    return !!result;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS workspaces (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        last_sync TEXT
      );

      CREATE TABLE IF NOT EXISTS workspace_config (
        workspace_name TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        display_name TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS global_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS aggregated_sessions (
        session_id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aggregated_tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms INTEGER,
        error_type TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aggregated_pain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        score REAL NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aggregated_user_corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        correction_cue TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aggregated_principle_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        principle_id TEXT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aggregated_thinking_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        matched_pattern TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aggregated_correction_samples (
        sample_id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        bad_assistant_turn_id INTEGER NOT NULL,
        quality_score REAL,
        review_status TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aggregated_task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT,
        outcome TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        records_synced INTEGER NOT NULL
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace ON aggregated_tool_calls(workspace);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_outcome ON aggregated_tool_calls(outcome);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_created ON aggregated_tool_calls(created_at);
      CREATE INDEX IF NOT EXISTS idx_pain_workspace ON aggregated_pain_events(workspace);
      CREATE INDEX IF NOT EXISTS idx_pain_created ON aggregated_pain_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_thinking_workspace ON aggregated_thinking_events(workspace);
      CREATE INDEX IF NOT EXISTS idx_thinking_model ON aggregated_thinking_events(model_id);
      CREATE INDEX IF NOT EXISTS idx_corrections_workspace ON aggregated_correction_samples(workspace);
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON aggregated_sessions(workspace);
    `);
  }

  private discoverWorkspaces(): void {
    const openClawDir = os.homedir();
    const workspacesDir = path.join(openClawDir, '.openclaw');
    
    this.workspaces.length = 0;
    
    const entries = fs.readdirSync(workspacesDir);
    for (const entry of entries) {
      if (entry.startsWith('workspace-') && entry !== 'workspace') {
        const workspacePath = path.join(workspacesDir, entry);
        const stat = fs.statSync(workspacePath);
        if (stat.isDirectory()) {
          this.workspaces.push({
            name: entry,
            path: workspacePath,
            lastSync: null,
          });
        }
      }
    }
  }

  /**
   * Sync data from a single workspace into the central database
   */
  syncWorkspace(workspaceName: string): number {
    const workspace = this.workspaces.find(w => w.name === workspaceName);
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceName);
    }

    const trajectoryDbPath = path.join(workspace.path, '.state', 'trajectory.db');
    if (!fs.existsSync(trajectoryDbPath)) {
      return 0;
    }

    const sourceDb = new Database(trajectoryDbPath, { readonly: true });
    let totalSynced = 0;

    try {
      // Sync sessions
      const sessions = sourceDb.prepare(`
        SELECT session_id, started_at, updated_at FROM sessions
      `).all() as Array<{session_id: string; started_at: string; updated_at: string}>;
      
      const insertSession = this.db.prepare(`
        INSERT OR REPLACE INTO aggregated_sessions (session_id, workspace, started_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      
      for (const s of sessions) {
        insertSession.run(s.session_id, workspaceName, s.started_at, s.updated_at);
        totalSynced++;
      }

      // Sync tool_calls
      const toolCalls = sourceDb.prepare(`
        SELECT session_id, tool_name, outcome, duration_ms, error_type, error_message, created_at
        FROM tool_calls
      `).all() as Array<{
        session_id: string; tool_name: string; outcome: string; 
        duration_ms: number | null; error_type: string | null; 
        error_message: string | null; created_at: string
      }>;
      
      const insertTool = this.db.prepare(`
        INSERT INTO aggregated_tool_calls 
        (workspace, session_id, tool_name, outcome, duration_ms, error_type, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const t of toolCalls) {
        insertTool.run(
          workspaceName, t.session_id, t.tool_name, t.outcome, 
          t.duration_ms, t.error_type, t.error_message, t.created_at
        );
        totalSynced++;
      }

      // Sync pain_events
      const painEvents = sourceDb.prepare(`
        SELECT session_id, source, score, reason, created_at FROM pain_events
      `).all() as Array<{
        session_id: string; source: string; score: number; 
        reason: string | null; created_at: string
      }>;
      
      const insertPain = this.db.prepare(`
        INSERT INTO aggregated_pain_events (workspace, session_id, source, score, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      
      for (const p of painEvents) {
        insertPain.run(workspaceName, p.session_id, p.source, p.score, p.reason, p.created_at);
        totalSynced++;
      }

      // Sync user corrections
      const corrections = sourceDb.prepare(`
        SELECT session_id, correction_cue, created_at FROM user_turns
        WHERE correction_detected = 1
      `).all() as Array<{
        session_id: string; correction_cue: string | null; created_at: string
      }>;
      
      const insertCorr = this.db.prepare(`
        INSERT INTO aggregated_user_corrections (workspace, session_id, correction_cue, created_at)
        VALUES (?, ?, ?, ?)
      `);
      
      for (const c of corrections) {
        insertCorr.run(workspaceName, c.session_id, c.correction_cue, c.created_at);
        totalSynced++;
      }

      // Sync principle_events
      const principles = sourceDb.prepare(`
        SELECT principle_id, event_type, created_at FROM principle_events
      `).all() as Array<{
        principle_id: string | null; event_type: string; created_at: string
      }>;
      
      const insertPrinciple = this.db.prepare(`
        INSERT INTO aggregated_principle_events (workspace, principle_id, event_type, created_at)
        VALUES (?, ?, ?, ?)
      `);
      
      for (const p of principles) {
        insertPrinciple.run(workspaceName, p.principle_id, p.event_type, p.created_at);
        totalSynced++;
      }

      // Sync thinking_model_events (may not exist in older workspaces)
      if (this.tableExists(sourceDb, 'thinking_model_events')) {
        const thinking = sourceDb.prepare(`
          SELECT session_id, model_id, matched_pattern, created_at FROM thinking_model_events
        `).all() as Array<{
          session_id: string; model_id: string; matched_pattern: string; created_at: string
        }>;
        
        const insertThinking = this.db.prepare(`
          INSERT INTO aggregated_thinking_events (workspace, session_id, model_id, matched_pattern, created_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        
        for (const t of thinking) {
          insertThinking.run(workspaceName, t.session_id, t.model_id, t.matched_pattern, t.created_at);
          totalSynced++;
        }
      }

      // Sync correction_samples
      const samples = sourceDb.prepare(`
        SELECT sample_id, session_id, bad_assistant_turn_id, quality_score, review_status, created_at
        FROM correction_samples
      `).all() as Array<{
        sample_id: string; session_id: string; bad_assistant_turn_id: number;
        quality_score: number | null; review_status: string | null; created_at: string
      }>;
      
      const insertSample = this.db.prepare(`
        INSERT OR REPLACE INTO aggregated_correction_samples
        (sample_id, workspace, session_id, bad_assistant_turn_id, quality_score, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      for (const s of samples) {
        insertSample.run(
          s.sample_id, workspaceName, s.session_id, s.bad_assistant_turn_id,
          s.quality_score, s.review_status, s.created_at
        );
        totalSynced++;
      }

      // Sync task_outcomes
      const outcomes = sourceDb.prepare(`
        SELECT session_id, task_id, outcome, created_at FROM task_outcomes
      `).all() as Array<{
        session_id: string; task_id: string | null; outcome: string; created_at: string
      }>;
      
      const insertOutcome = this.db.prepare(`
        INSERT INTO aggregated_task_outcomes (workspace, session_id, task_id, outcome, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      for (const o of outcomes) {
        insertOutcome.run(workspaceName, o.session_id, o.task_id, o.outcome, o.created_at);
        totalSynced++;
      }

      // Update last sync time
      this.db.prepare(`
        INSERT OR REPLACE INTO workspaces (name, path, last_sync)
        VALUES (?, ?, datetime('now'))
      `).run(workspaceName, workspace.path);

      // Log sync
      this.db.prepare(`
        INSERT INTO sync_log (workspace, synced_at, records_synced)
        VALUES (?, datetime('now'), ?)
      `).run(workspaceName, totalSynced);

      return totalSynced;
    } finally {
      sourceDb.close();
    }
  }

  syncEnabled(): Map<string, number> {
    const results = new Map<string, number>();
    for (const ws of this.getEnabledWorkspaces()) {
      try {
        const count = this.syncWorkspace(ws.name);
        results.set(ws.name, count);
      } catch (error) {
        console.error(`Failed to sync workspace ${ws.name}:`, error);
        results.set(ws.name, 0);
      }
    }
    return results;
  }

  /**
   * Sync all workspaces (legacy method - syncs all regardless of config)
   */
  syncAll(): Map<string, number> {
    const results = new Map<string, number>();
    for (const ws of this.workspaces) {
      try {
        const count = this.syncWorkspace(ws.name);
        results.set(ws.name, count);
      } catch (error) {
        console.error(`Failed to sync workspace ${ws.name}:`, error);
        results.set(ws.name, 0);
      }
    }
    return results;
  }

  private getEnabledWorkspaceFilter(): string {
    const enabled = this.getWorkspaceConfigs().filter(c => c.enabled && c.syncEnabled);
    if (enabled.length === 0) return "''";
    return enabled.map(c => `'${c.workspaceName.replace(/'/g, "''")}'`).join(', ');
  }

  /**
   * Get aggregated overview stats (only from enabled workspaces)
   */
  getOverviewStats(): {
    totalSessions: number;
    totalToolCalls: number;
    totalFailures: number;
    totalPainEvents: number;
    totalCorrections: number;
    totalThinkingEvents: number;
    totalSamples: number;
    pendingSamples: number;
    approvedSamples: number;
    rejectedSamples: number;
    workspaceCount: number;
    enabledWorkspaceCount: number;
    workspaceNames: string[];
    enabledWorkspaceNames: string[];
  } {
    const filter = this.getEnabledWorkspaceFilter();

    const totalSessions = this.db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count FROM aggregated_sessions
      WHERE workspace IN (${filter})
    `).get() as { count: number };

    const toolStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures
      FROM aggregated_tool_calls
      WHERE workspace IN (${filter})
    `).get() as { total: number; failures: number };

    const painEvents = this.db.prepare(`
      SELECT COUNT(*) as count FROM aggregated_pain_events
      WHERE workspace IN (${filter})
    `).get() as { count: number };

    const corrections = this.db.prepare(`
      SELECT COUNT(*) as count FROM aggregated_user_corrections
      WHERE workspace IN (${filter})
    `).get() as { count: number };

    const thinkingEvents = this.db.prepare(`
      SELECT COUNT(*) as count FROM aggregated_thinking_events
      WHERE workspace IN (${filter})
    `).get() as { count: number };

    const sampleStats = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM aggregated_correction_samples
      WHERE workspace IN (${filter})
    `).get() as { total: number; pending: number; approved: number; rejected: number };

    const workspaces = this.db.prepare(`
      SELECT name FROM workspaces ORDER BY name
    `).all() as Array<{ name: string }>;

    const enabledConfigs = this.getWorkspaceConfigs().filter(c => c.enabled && c.syncEnabled);
    const enabledWorkspaceNames = enabledConfigs.map(c => c.workspaceName);

    return {
      totalSessions: totalSessions.count,
      totalToolCalls: toolStats.total,
      totalFailures: toolStats.failures || 0,
      totalPainEvents: painEvents.count,
      totalCorrections: corrections.count,
      totalThinkingEvents: thinkingEvents.count,
      totalSamples: sampleStats.total,
      pendingSamples: sampleStats.pending || 0,
      approvedSamples: sampleStats.approved || 0,
      rejectedSamples: sampleStats.rejected || 0,
      workspaceCount: workspaces.length,
      enabledWorkspaceCount: enabledConfigs.length,
      workspaceNames: workspaces.map(w => w.name),
      enabledWorkspaceNames,
    };
  }

  /**
   * Get daily trend data
   */
  getDailyTrend(days: number = 7): Array<{
    day: string;
    toolCalls: number;
    failures: number;
    userCorrections: number;
    thinkingTurns: number;
  }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const toolDaily = this.db.prepare(`
      SELECT 
        substr(created_at, 1, 10) as day,
        COUNT(*) as tool_calls,
        SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures
      FROM aggregated_tool_calls
      WHERE substr(created_at, 1, 10) >= ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day
    `).all(cutoffStr) as Array<{
      day: string; tool_calls: number; failures: number
    }>;

    const correctionsDaily = this.db.prepare(`
      SELECT 
        substr(created_at, 1, 10) as day,
        COUNT(*) as corrections
      FROM aggregated_user_corrections
      WHERE substr(created_at, 1, 10) >= ?
      GROUP BY substr(created_at, 1, 10)
    `).all(cutoffStr) as Array<{
      day: string; corrections: number
    }>;

    const thinkingDaily = this.db.prepare(`
      SELECT 
        substr(created_at, 1, 10) as day,
        COUNT(*) as thinking_turns
      FROM aggregated_thinking_events
      WHERE substr(created_at, 1, 10) >= ?
      GROUP BY substr(created_at, 1, 10)
    `).all(cutoffStr) as Array<{
      day: string; thinking_turns: number
    }>;

    // Merge all trends
    const dayMap = new Map<string, {
      day: string;
      toolCalls: number;
      failures: number;
      userCorrections: number;
      thinkingTurns: number;
    }>();

    for (const t of toolDaily) {
      dayMap.set(t.day, {
        day: t.day,
        toolCalls: t.tool_calls,
        failures: t.failures || 0,
        userCorrections: 0,
        thinkingTurns: 0,
      });
    }

    for (const c of correctionsDaily) {
      const existing = dayMap.get(c.day);
      if (existing) {
        existing.userCorrections = c.corrections;
      } else {
        dayMap.set(c.day, {
          day: c.day,
          toolCalls: 0,
          failures: 0,
          userCorrections: c.corrections,
          thinkingTurns: 0,
        });
      }
    }

    for (const t of thinkingDaily) {
      const existing = dayMap.get(t.day);
      if (existing) {
        existing.thinkingTurns = t.thinking_turns;
      } else {
        dayMap.set(t.day, {
          day: t.day,
          toolCalls: 0,
          failures: 0,
          userCorrections: 0,
          thinkingTurns: t.thinking_turns,
        });
      }
    }

    return Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day));
  }

  /**
   * Get top regressions
   */
  getTopRegressions(limit: number = 5): Array<{
    toolName: string;
    errorType: string;
    occurrences: number;
  }> {
    return this.db.prepare(`
      SELECT 
        tool_name as toolName,
        error_type as errorType,
        COUNT(*) as occurrences
      FROM aggregated_tool_calls
      WHERE outcome = 'failure' AND error_type IS NOT NULL
      GROUP BY tool_name, error_type
      ORDER BY occurrences DESC
      LIMIT ?
    `).all(limit) as Array<{
      toolName: string;
      errorType: string;
      occurrences: number;
    }>;
  }

  /**
   * Get thinking model stats
   */
  getThinkingModelStats(): {
    totalModels: number;
    activeModels: number;
    models: Array<{
      modelId: string;
      hits: number;
      coverageRate: number;
    }>;
  } {
    const totalModels = this.db.prepare(`
      SELECT COUNT(DISTINCT model_id) as count FROM aggregated_thinking_events
    `).get() as { count: number };

    // Consider a model "active" if it has events in the last 7 days
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 7);
    const recentStr = recentDate.toISOString();

    const activeModels = this.db.prepare(`
      SELECT COUNT(DISTINCT model_id) as count FROM aggregated_thinking_events
      WHERE created_at >= ?
    `).get(recentStr) as { count: number };

    const totalToolCalls = this.db.prepare(`
      SELECT COUNT(*) as count FROM aggregated_tool_calls
    `).get() as { count: number };

    const models = this.db.prepare(`
      SELECT 
        model_id as modelId,
        COUNT(*) as hits
      FROM aggregated_thinking_events
      GROUP BY model_id
      ORDER BY hits DESC
    `).all() as Array<{ modelId: string; hits: number }>;

    const coverageRate = totalToolCalls.count > 0 
      ? models.reduce((sum, m) => sum + m.hits, 0) / totalToolCalls.count 
      : 0;

    return {
      totalModels: totalModels.count,
      activeModels: activeModels.count,
      models: models.map(m => ({
        ...m,
        coverageRate: totalToolCalls.count > 0 ? m.hits / totalToolCalls.count : 0,
      })),
    };
  }

  /**
   * Get workspace list
   */
  getWorkspaces(): WorkspaceInfo[] {
    return this.db.prepare(`
      SELECT name, path, last_sync as lastSync FROM workspaces ORDER BY name
    `).all() as WorkspaceInfo[];
  }

  getWorkspaceConfigs(): Array<{
    workspaceName: string;
    enabled: boolean;
    displayName: string | null;
    syncEnabled: boolean;
  }> {
    const configs = this.db.prepare(`
      SELECT workspace_name, enabled, display_name, sync_enabled 
      FROM workspace_config
      ORDER BY workspace_name
    `).all() as Array<{
      workspace_name: string;
      enabled: number;
      display_name: string | null;
      sync_enabled: number;
    }>;
    
    return configs.map(c => ({
      workspaceName: c.workspace_name,
      enabled: c.enabled === 1,
      displayName: c.display_name,
      syncEnabled: c.sync_enabled === 1,
    }));
  }

  updateWorkspaceConfig(
    workspaceName: string,
    updates: {
      enabled?: boolean;
      displayName?: string | null;
      syncEnabled?: boolean;
    }
  ): void {
    const existing = this.db.prepare(`
      SELECT workspace_name FROM workspace_config WHERE workspace_name = ?
    `).get(workspaceName);

    if (existing) {
      const setClauses: string[] = ['updated_at = datetime(\'now\')'];
      const params: unknown[] = [];
      
      if (updates.enabled !== undefined) {
        setClauses.push('enabled = ?');
        params.push(updates.enabled ? 1 : 0);
      }
      if (updates.displayName !== undefined) {
        setClauses.push('display_name = ?');
        params.push(updates.displayName);
      }
      if (updates.syncEnabled !== undefined) {
        setClauses.push('sync_enabled = ?');
        params.push(updates.syncEnabled ? 1 : 0);
      }
      
      params.push(workspaceName);
      this.db.prepare(`
        UPDATE workspace_config SET ${setClauses.join(', ')} WHERE workspace_name = ?
      `).run(...params);
    } else {
      this.db.prepare(`
        INSERT INTO workspace_config (workspace_name, enabled, display_name, sync_enabled)
        VALUES (?, ?, ?, ?)
      `).run(
        workspaceName,
        updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : 1,
        updates.displayName ?? null,
        updates.syncEnabled !== undefined ? (updates.syncEnabled ? 1 : 0) : 1
      );
    }
  }

  isWorkspaceEnabled(workspaceName: string): boolean {
    const config = this.db.prepare(`
      SELECT enabled, sync_enabled FROM workspace_config WHERE workspace_name = ?
    `).get(workspaceName) as { enabled: number; sync_enabled: number } | undefined;
    
    if (!config) return true;
    return config.enabled === 1 && config.sync_enabled === 1;
  }

  getEnabledWorkspaces(): WorkspaceInfo[] {
    return this.workspaces.filter(ws => this.isWorkspaceEnabled(ws.name));
  }

  addCustomWorkspace(name: string, workspacePath: string): void {
    if (!this.workspaces.find(ws => ws.name === name)) {
      this.workspaces.push({ name, path: workspacePath, lastSync: null });
      this.db.prepare(`
        INSERT INTO workspaces (name, path, last_sync) VALUES (?, ?, NULL)
      `).run(name, workspacePath);
      this.db.prepare(`
        INSERT INTO workspace_config (workspace_name, enabled, display_name, sync_enabled)
        VALUES (?, 1, ?, 1)
      `).run(name, name);
    }
  }

  removeWorkspace(workspaceName: string): void {
    this.updateWorkspaceConfig(workspaceName, { enabled: false, syncEnabled: false });
  }

  getGlobalConfig(key: string): string | null {
    const result = this.db.prepare(`
      SELECT value FROM global_config WHERE key = ?
    `).get(key) as { value: string } | undefined;
    return result?.value ?? null;
  }

  setGlobalConfig(key: string, value: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO global_config (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
    `).run(key, value);
  }

  /**
   * Clear all aggregated data (for testing/reset)
   */
  clearAll(): void {
    this.db.exec(`
      DELETE FROM aggregated_sessions;
      DELETE FROM aggregated_tool_calls;
      DELETE FROM aggregated_pain_events;
      DELETE FROM aggregated_user_corrections;
      DELETE FROM aggregated_principle_events;
      DELETE FROM aggregated_thinking_events;
      DELETE FROM aggregated_correction_samples;
      DELETE FROM aggregated_task_outcomes;
      DELETE FROM workspaces;
      DELETE FROM sync_log;
    `);
  }

  /**
   * Get total task outcomes count across enabled workspaces (D-02)
   */
  getTaskOutcomes(): number {
    const filter = this.getEnabledWorkspaceFilter();
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM aggregated_task_outcomes
      WHERE workspace IN (${filter})
    `).get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Get total principle events count across enabled workspaces (D-03)
   */
  getPrincipleEventCount(): number {
    const filter = this.getEnabledWorkspaceFilter();
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM aggregated_principle_events
      WHERE workspace IN (${filter})
    `).get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Get sample counts grouped by review_status across enabled workspaces (D-06)
   */
  getSampleCountersByStatus(): Record<string, number> {
    const filter = this.getEnabledWorkspaceFilter();
    const rows = this.db.prepare(`
      SELECT review_status, COUNT(*) as count
      FROM aggregated_correction_samples
      WHERE workspace IN (${filter})
      GROUP BY review_status
    `).all() as Array<{ review_status: string; count: number }>;
    return Object.fromEntries(rows.map(r => [r.review_status, r.count]));
  }

  /**
   * Get top N most recent pending/approved samples across all enabled workspaces (D-04)
   */
  getSamplePreview(limit: number = 5): Array<{
    sampleId: string;
    sessionId: string;
    workspace: string;
    qualityScore: number;
    reviewStatus: string;
    createdAt: string;
  }> {
    const filter = this.getEnabledWorkspaceFilter();
    const rows = this.db.prepare(`
      SELECT sample_id, session_id, workspace, quality_score, review_status, created_at
      FROM aggregated_correction_samples
      WHERE workspace IN (${filter})
        AND review_status IN ('pending', 'approved')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      sample_id: string;
      session_id: string;
      workspace: string;
      quality_score: number;
      review_status: string;
      created_at: string;
    }>;
    return rows.map(r => ({
      sampleId: r.sample_id,
      sessionId: r.session_id,
      workspace: r.workspace,
      qualityScore: r.quality_score ?? 0,
      reviewStatus: r.review_status ?? 'pending',
      createdAt: r.created_at,
    }));
  }

  /**
   * Get the most recent lastSync timestamp across all workspaces (D-05)
   */
  getMostRecentSync(): string | null {
    const row = this.db.prepare(`
      SELECT MAX(last_sync) as lastSync FROM workspaces
    `).get() as { lastSync: string | null } | undefined;
    return row?.lastSync ?? null;
  }
}

// Singleton instance
let centralDbInstance: CentralDatabase | null = null;

export function getCentralDatabase(): CentralDatabase {
  if (!centralDbInstance) {
    centralDbInstance = new CentralDatabase();
  }
  return centralDbInstance;
}
