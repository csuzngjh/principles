import * as fs from 'fs';
import * as path from 'path';
import { readPainFlagData } from '../core/pain.js';
import { resolvePdPath } from '../core/paths.js';
import { listSessions, type SessionState } from '../core/session-tracker.js';
import { listDeployments } from '../core/model-deployment-registry.js';
import { ControlUiDatabase } from '../core/control-ui-db.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import type { EventLogEntry } from '../types/event-types.js';

type HealthStage = 'healthy' | 'warning' | 'critical';

interface QueueItem {
  status?: string;
}

interface AgentScorecard {
  trustStage?: number;
  trust_stage?: number;
  stage?: number;
  trustScore?: number;
  trust_score?: number;
  score?: number;
}

interface EvolutionScorecard {
  totalPoints?: number;
  total_points?: number;
  currentTier?: number | string;
  current_tier?: number | string;
}

interface EvolutionStreamRecord {
  ts?: string;
  type?: string;
  data?: Record<string, unknown>;
}

interface GateBlockRow {
  created_at: string;
  tool_name: string;
  file_path?: string | null;
  reason: string;
  gfi?: number | null;
  gfi_after?: number | null;
  trust_stage?: number | null;
  gate_type?: string | null;
}

interface NocturnalSampleRecord {
  artifactId?: string;
  status?: string;
  createdAt?: string;
  arbiter?: {
    passed?: boolean;
  };
}

interface RecentPrincipleChange {
  principleId: string;
  status: string;
  triggerPattern: string;
  action: string;
  fromStatus: string;
  toStatus: string;
  timestamp: string;
}

export class HealthQueryService {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private readonly trajectory;
  private readonly config;
  private readonly eventLog;
  private readonly evolutionReducer;
  private readonly uiDb: ControlUiDatabase;
  private readonly tableColumnCache = new Map<string, Set<string>>();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
    this.stateDir = wctx.stateDir;
    this.trajectory = wctx.trajectory;
    this.config = wctx.config;
    this.eventLog = wctx.eventLog;
    this.evolutionReducer = wctx.evolutionReducer;
    this.uiDb = new ControlUiDatabase({ workspaceDir });
    this.ensureTables();
    this.syncGfiFromSession();
  }

  dispose(): void {
    this.uiDb.dispose();
  }

  /**
   * Ensure all tables required by HealthQueryService exist.
   * This is a safety net for workspaces created before TrajectoryDatabase
   * had full schema initialization, or where initSchema() was never called.
   * Uses CREATE TABLE IF NOT EXISTS so it's idempotent.
   */
  private ensureTables(): void {
    try {
      this.uiDb.execute(`
        CREATE TABLE IF NOT EXISTS pain_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          source TEXT NOT NULL,
          score REAL NOT NULL DEFAULT 0,
          reason TEXT DEFAULT '',
          severity TEXT DEFAULT 'mild',
          origin TEXT DEFAULT '',
          confidence REAL DEFAULT 0,
          text TEXT DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.uiDb.execute(`
        CREATE INDEX IF NOT EXISTS idx_pain_events_created_at ON pain_events(created_at)
      `);
      this.uiDb.execute(`
        CREATE TABLE IF NOT EXISTS gate_blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          file_path TEXT,
          reason TEXT NOT NULL,
          gfi REAL,
          gfi_after REAL,
          trust_stage INTEGER,
          gate_type TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      this.uiDb.execute(`
        CREATE INDEX IF NOT EXISTS idx_gate_blocks_created_at ON gate_blocks(created_at)
      `);
    } catch (err) {
      console.warn('[HealthQueryService] Table ensure failed (non-fatal):', err);
    }
  }

  getOverviewHealth(): {
    gfi: { current: number; peakToday: number; threshold: number; trend: { hour: string; value: number }[] };
    trust: { stage: number; stageLabel: string; score: number };
    evolution: { tier: string; points: number };
    painFlag: { active: boolean; source: string | null; score: number | null };
    principles: { candidate: number; probation: number; active: number; deprecated: number };
    queue: { pending: number; inProgress: number; completed: number };
    activeStage: HealthStage;
  } {
    const threshold = this.getGfiThreshold();
    const trust = this.readTrust();
    const evolution = this.readEvolutionScore();
    const reducerStats = this.evolutionReducer.getStats();
    const queue = this.readQueueStats();
    const painFlag = this.readPainFlag();

    // GFI: Re-sync from session JSON on every request for real-time data
    this.syncGfiFromSession();
    const gfiData = this.readGfiFromDb();
    const {currentGfi} = gfiData;
    const peakToday = gfiData.dailyGfiPeak;

    // GFI history trend: aggregate pain_events by hour
    const today = new Date().toISOString().slice(0, 10);
    const gfiTrend = this.readGfiTrend(today);

    return {
      gfi: {
        current: currentGfi,
        peakToday,
        threshold,
        trend: gfiTrend,
      },
      trust,
      evolution,
      painFlag,
      principles: {
        candidate: reducerStats.candidateCount,
        probation: reducerStats.probationCount,
        active: reducerStats.activeCount,
        deprecated: reducerStats.deprecatedCount,
      },
      queue,
      activeStage: HealthQueryService.computeHealthStage(currentGfi, threshold, painFlag.active),
    };
  }

  getEvolutionPrinciples(): {
    principles: {
      summary: { candidate: number; probation: number; active: number; deprecated: number };
      recent: {
        principleId: string;
        status: string;
        triggerPattern: string;
        action: string;
        fromStatus: string;
        toStatus: string;
        timestamp: string;
      }[];
    };
    nocturnalTraining: {
      queue: { pending: number; inProgress: number; completed: number };
      trinityRecords: { artifactId: string; status: string; createdAt: string }[];
      arbiterPassRate: number;
      orpoSampleCount: number;
      deployments: { modelId: string; status: string; checkpointPath: string | null }[];
    };
    painSourceDistribution: Record<string, number>;
    activeStage: string;
  } {
    const stats = this.evolutionReducer.getStats();
    const recent = this.readRecentPrincipleChanges(30);
    const nocturnal = this.readNocturnalTraining();
    const painSourceDistribution = this.readPainSourceDistribution();
    const activeStage = this.readEvolutionActiveStage(nocturnal.queue);

    return {
      principles: {
        summary: {
          candidate: stats.candidateCount,
          probation: stats.probationCount,
          active: stats.activeCount,
          deprecated: stats.deprecatedCount,
        },
        recent,
      },
      nocturnalTraining: nocturnal,
      painSourceDistribution,
      activeStage,
    };
  }

  /**
   * Read GFI trend for a specific day by aggregating pain_events by hour.
   * Used by getOverviewHealth() to provide historical GFI context.
   */
  private readGfiTrend(date: string): { hour: string; value: number }[] {
    try {
      const rows = this.uiDb.all<{ hour: string; value: number }>(`
        SELECT substr(created_at, 1, 13) || ':00:00Z' AS hour, ROUND(SUM(score), 2) AS value
        FROM pain_events
        WHERE substr(created_at, 1, 10) = ?
        GROUP BY substr(created_at, 1, 13)
        ORDER BY hour ASC
      `, date);
      return rows.map(row => ({ hour: row.hour, value: this.asNumber(row.value, 0) }));
    } catch {
      // pain_events table may not exist in this workspace — return empty trend
      return [];
    }
  }

  getFeedbackGfi(): {
    current: number;
    peakToday: number;
    threshold: number;
    trend: { hour: string; value: number }[];
    sources: Record<string, number>;
  } {
    const threshold = this.getGfiThreshold();
    const today = new Date().toISOString().slice(0, 10);

    const trendRows = this.uiDb.all<{ hour: string; value: number }>(`
      SELECT substr(created_at, 1, 13) || ':00:00Z' AS hour, ROUND(SUM(score), 2) AS value
      FROM pain_events
      WHERE substr(created_at, 1, 10) = ?
      GROUP BY substr(created_at, 1, 13)
      ORDER BY hour ASC
    `, today);

    const sourceRows = this.uiDb.all<{ source: string; total: number }>(`
      SELECT source, COUNT(*) AS total
      FROM pain_events
      WHERE substr(created_at, 1, 10) = ?
      GROUP BY source
      ORDER BY total DESC
    `, today);

    // GFI: Re-sync from session JSON for real-time data
    this.syncGfiFromSession();
    const gfiData = this.readGfiFromDb();

    return {
      current: gfiData.currentGfi,
      peakToday: gfiData.dailyGfiPeak,
      threshold,
      trend: trendRows.map((row) => ({ hour: row.hour, value: this.asNumber(row.value, 0) })),
      sources: Object.fromEntries(sourceRows.map((row) => [row.source, this.asNumber(row.total, 0)])),
    };
  }

  getFeedbackEmpathyEvents(limit = 50): {
    timestamp: string;
    severity: string;
    score: number;
    reason: string;
    origin: string;
    gfiAfter: number;
  }[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const events = this.readMergedEvents()
      .filter((entry) => entry.type === 'pain_signal' && String(entry.data?.source ?? '') === 'user_empathy')
      .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
      .slice(0, safeLimit);

    return events.map((entry) => {
      const data = entry.data ?? {};
      return {
        timestamp: String(entry.ts ?? ''),
        severity: typeof data.severity === 'string' ? data.severity : 'mild',
        score: this.asNumber(data.score, 0),
        reason: typeof data.reason === 'string' ? data.reason : '',
        origin: typeof data.origin === 'string' ? data.origin : 'unknown',
        gfiAfter: this.asNumber(data.gfiAfter ?? data.gfi_after ?? data.gfi, 0),
      };
    });
  }

  getFeedbackGateBlocks(limit = 50): {
    timestamp: string;
    toolName: string;
    reason: string;
    gfi: number;
    trustStage: number;
  }[] {
    const trust = this.readTrust();
    const rows = this.readGateBlocksRaw(limit);

    return rows.map((row) => ({
      timestamp: row.created_at,
      toolName: row.tool_name,
      reason: row.reason,
      gfi: this.resolveGateBlockGfi(row),
      trustStage: this.resolveGateBlockTrustStage(row, trust.stage),
    }));
  }

  getGateStats(): {
    today: {
      gfiBlocks: number;
      stageBlocks: number;
      p03Blocks: number;
      bypassAttempts: number;
      p16Exemptions: number;
    };
    trust: { stage: number; score: number; status: string };
    evolution: { tier: string; points: number; status: string };
  } {
    const today = new Date().toISOString().slice(0, 10);
    const rows = this.uiDb.all<{ reason: string }>(`
      SELECT reason
      FROM gate_blocks
      WHERE substr(created_at, 1, 10) = ?
    `, today);

    let gfiBlocks = 0;
    let stageBlocks = 0;
    let p03Blocks = 0;
    let bypassAttempts = 0;
    let p16Exemptions = 0;

    for (const row of rows) {
      const reason = String(row.reason || '').toLowerCase();
      if (reason.includes('gfi')) gfiBlocks++;
      if (reason.includes('tier') || reason.includes('stage') || reason.includes('trust')) stageBlocks++;
      if (reason.includes('p-03') || reason.includes('edit verification') || reason.includes('oldtext')) p03Blocks++;
      if (reason.includes('bypass')) bypassAttempts++;
      if (reason.includes('p-16') || reason.includes('exemption')) p16Exemptions++;
    }

    const trust = this.readTrust();
    const evolution = this.readEvolutionScore();

    return {
      today: {
        gfiBlocks,
        stageBlocks,
        p03Blocks,
        bypassAttempts,
        p16Exemptions,
      },
      trust: {
        stage: trust.stage,
        score: trust.score,
        status: this.scoreToStatus(trust.score),
      },
      evolution: {
        tier: evolution.tier,
        points: evolution.points,
        status: this.evolutionToStatus(evolution.tier, evolution.points),
      },
    };
  }

  getGateBlocks(limit = 50): {
    timestamp: string;
    toolName: string;
    filePath: string | null;
    reason: string;
    gateType: string;
    gfi: number;
    trustStage: number;
  }[] {
    const trust = this.readTrust();
    const rows = this.readGateBlocksRaw(limit);

    return rows.map((row) => ({
      timestamp: row.created_at,
      toolName: row.tool_name,
      filePath: row.file_path ?? null,
      reason: row.reason,
      gateType: this.resolveGateType(row),
      gfi: this.resolveGateBlockGfi(row),
      trustStage: this.resolveGateBlockTrustStage(row, trust.stage),
    }));
  }

  private readTrust(): { stage: number; stageLabel: string; score: number } {
    const scorecardPath = resolvePdPath(this.workspaceDir, 'AGENT_SCORECARD');
    const scorecard = this.readJsonFile<AgentScorecard>(scorecardPath, {});
    const score = this.asNumber(
      scorecard.trustScore ?? scorecard.trust_score ?? scorecard.score,
      0,
    );
    const rawStage = this.asNumber(
      scorecard.trustStage ?? scorecard.trust_stage ?? scorecard.stage,
      HealthQueryService.inferTrustStageFromScore(score),
    );
    const stage = Math.max(1, Math.min(4, Math.round(rawStage)));

    return {
      stage,
      stageLabel: HealthQueryService.getTrustStageLabel(stage),
      score,
    };
  }

  private readEvolutionScore(): { tier: string; points: number } {
    const scorecardPath = path.join(this.stateDir, 'evolution-scorecard.json');
    const scorecard = this.readJsonFile<EvolutionScorecard>(scorecardPath, {});
    const points = this.asNumber(scorecard.totalPoints ?? scorecard.total_points, 0);
    const tierRaw = scorecard.currentTier ?? scorecard.current_tier ?? 1;
    return {
      tier: this.normalizeTierName(tierRaw),
      points,
    };
  }

  private readQueueStats(): { pending: number; inProgress: number; completed: number } {
    const queuePath = resolvePdPath(this.workspaceDir, 'EVOLUTION_QUEUE');
    const queue = this.readJsonFile<QueueItem[]>(queuePath, []);
    const stats = { pending: 0, inProgress: 0, completed: 0 };
    for (const item of queue) {
      const status = String(item?.status ?? 'pending');
      if (status === 'completed') stats.completed++;
      else if (status === 'in_progress') stats.inProgress++;
      else stats.pending++;
    }
    return stats;
  }

  private readPainFlag(): { active: boolean; source: string | null; score: number | null } {
    const painFlagPath = resolvePdPath(this.workspaceDir, 'PAIN_FLAG');
    if (!fs.existsSync(painFlagPath)) {
      return { active: false, source: null, score: null };
    }

    const data = readPainFlagData(this.workspaceDir);
    return {
      active: true,
      source: typeof data.source === 'string' ? data.source : null,
      score: this.asNullableNumber(data.score),
    };
  }

  private getCurrentSession(): SessionState | null {
    // First, try in-memory sessions (live sessions from session-tracker)
    const sessions = listSessions(this.workspaceDir);
    if (sessions.length > 0) {
      const sorted = [...sessions].sort((a, b) => {
        const aTs = Number(a.lastControlActivityAt ?? a.lastActivityAt ?? 0);
        const bTs = Number(b.lastControlActivityAt ?? b.lastActivityAt ?? 0);
        return bTs - aTs;
      });
      return sorted[0] ?? null;
    }

    // Fallback: read session JSON files directly (handles process restarts where
    // loadAllSessions may not have reloaded all sessions, or workspaceDir mismatch)
    return this.readLatestSessionFromFile();
  }

  private getGfiThreshold(): number {
    const fromConfig = this.asNullableNumber(this.config.get('gfi_gate.thresholds.low_risk_block'));
    if (fromConfig !== null) return fromConfig;
    const fallbackPath = resolvePdPath(this.workspaceDir, 'PAIN_SETTINGS');
    const raw = this.readJsonFile<Record<string, unknown>>(fallbackPath, {});
    const fallback = this.asNullableNumber(
      ((raw.gfi_gate as { thresholds?: { low_risk_block?: unknown } } | undefined)?.thresholds?.low_risk_block),
    );
    return fallback ?? 70;
  }

  private static computeHealthStage(currentGfi: number, threshold: number, painFlagActive: boolean): HealthStage {
    if (painFlagActive || currentGfi >= threshold) {
      return 'critical';
    }
    if (currentGfi >= threshold * 0.7) {
      return 'warning';
    }
    return 'healthy';
  }

  private static getTrustStageLabel(stage: number): string {
    switch (stage) {
      case 1:
        return 'Observer';
      case 2:
        return 'Editor';
      case 3:
        return 'Developer';
      case 4:
        return 'Architect';
      default:
        return 'Observer';
    }
  }

  private static inferTrustStageFromScore(score: number): number {
    if (score >= 80) return 4;
    if (score >= 60) return 3;
    if (score >= 30) return 2;
    return 1;
  }

  private normalizeTierName(rawTier: number | string): string {
    if (typeof rawTier === 'string') {
      const t = rawTier.trim();
      if (t.length > 0) return t;
    }
    const n = this.asNumber(rawTier, 1);
    if (n === 1) return 'Seed';
    if (n === 2) return 'Sprout';
    if (n === 3) return 'Sapling';
    if (n === 4) return 'Tree';
    if (n === 5) return 'Forest';
    return `Tier-${n}`;
  }

  private readRecentPrincipleChanges(limit: number): RecentPrincipleChange[] {
    const streamPath = resolvePdPath(this.workspaceDir, 'EVOLUTION_STREAM');
    if (!fs.existsSync(streamPath)) return [];

    // eslint-disable-next-line no-useless-assignment -- Reason: initial value unused due to immediate reassignment
    let lines: string[] = [];
    try {
      const raw = fs.readFileSync(streamPath, 'utf8').trim();
      if (!raw) return [];
      lines = raw.split('\n');
    } catch {
      return [];
    }

    const records: RecentPrincipleChange[] = [];
    for (const line of lines) {
      // eslint-disable-next-line no-useless-assignment -- Reason: initial value unused due to immediate reassignment in try/catch
      let event: EvolutionStreamRecord | null = null;
      try {
        event = JSON.parse(line) as EvolutionStreamRecord;
      } catch {
        event = null;
      }
      if (!event?.type || !event.data) continue;

      const mapped = this.mapPrincipleEvent(event);
      if (mapped) records.push(mapped);
    }

    return records
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  private mapPrincipleEvent(event: EvolutionStreamRecord): RecentPrincipleChange | null {
    const data = event.data ?? {};
    const type = String(event.type);
    const principleId = typeof data.principleId === 'string' ? data.principleId : '';
    if (!principleId) return null;

    const principle = this.evolutionReducer.getPrincipleById(principleId);
    const triggerPattern =
      typeof data.trigger === 'string'
        ? data.trigger
        : typeof principle?.trigger === 'string'
          ? principle.trigger
          : '';
    const action =
      typeof data.action === 'string'
        ? data.action
        : typeof principle?.action === 'string'
          ? principle.action
          : '';

    if (type === 'candidate_created') {
      const toStatus = typeof data.status === 'string' ? data.status : 'candidate';
      return {
        principleId,
        status: toStatus,
        triggerPattern,
        action,
        fromStatus: 'none',
        toStatus,
        timestamp: String(event.ts ?? ''),
      };
    }

    if (type === 'principle_promoted') {
      const fromStatus = typeof data.from === 'string' ? data.from : 'candidate';
      const toStatus = typeof data.to === 'string' ? data.to : 'probation';
      return {
        principleId,
        status: toStatus,
        triggerPattern,
        action,
        fromStatus,
        toStatus,
        timestamp: String(event.ts ?? ''),
      };
    }

    if (type === 'principle_deprecated') {
      return {
        principleId,
        status: 'deprecated',
        triggerPattern,
        action,
        fromStatus: 'active',
        toStatus: 'deprecated',
        timestamp: String(event.ts ?? ''),
      };
    }

    if (type === 'principle_rolled_back') {
      return {
        principleId,
        status: 'deprecated',
        triggerPattern,
        action,
        fromStatus: 'probation',
        toStatus: 'deprecated',
        timestamp: String(event.ts ?? ''),
      };
    }

    return null;
  }

  private readNocturnalTraining(): {
    queue: { pending: number; inProgress: number; completed: number };
    trinityRecords: { artifactId: string; status: string; createdAt: string }[];
    arbiterPassRate: number;
    orpoSampleCount: number;
    deployments: { modelId: string; status: string; checkpointPath: string | null }[];
  } {
    const sampleDir = resolvePdPath(this.workspaceDir, 'NOCTURNAL_SAMPLES_DIR');
    const exportDir = resolvePdPath(this.workspaceDir, 'NOCTURNAL_EXPORTS_DIR');
    const reviewQueuePath = path.join(this.stateDir, 'nocturnal', 'review-queue.json');

    const sampleFiles = this.safeListFiles(sampleDir, (name) => name.endsWith('.json') && name !== 'lineage-index.json');
    const samples: NocturnalSampleRecord[] = sampleFiles.map((filePath) =>
      this.readJsonFile<NocturnalSampleRecord>(filePath, {}),
    );

    const queue = { pending: 0, inProgress: 0, completed: 0 };
    for (const sample of samples) {
      const status = String(sample.status ?? '').toLowerCase();
      if (status === 'in_progress' || status === 'running') queue.inProgress++;
      else if (status === 'pending' || status === 'pending_review') queue.pending++;
      else queue.completed++;
    }

    const reviewQueue = this.readJsonFile<unknown[]>(reviewQueuePath, []);
    queue.pending += reviewQueue.length;

    const trinityRecords = samples
      .map((sample) => ({
        artifactId: String(sample.artifactId ?? ''),
        status: String(sample.status ?? 'unknown'),
        createdAt: String(sample.createdAt ?? ''),
      }))
      .filter((row) => row.artifactId.length > 0)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);

    let passed = 0;
    for (const sample of samples) {
      const status = String(sample.status ?? '').toLowerCase();
      const arbiterPassed = sample.arbiter?.passed === true;
      if (arbiterPassed || status === 'approved' || status === 'approved_for_training') {
        passed++;
      }
    }
    const total = samples.length;
    const arbiterPassRate = total > 0 ? Number((passed / total).toFixed(4)) : 0;

    const exportFiles = this.safeListFiles(exportDir, (name) => name.endsWith('.jsonl'));
    const orpoSampleCount = exportFiles.length;

    const deployments = listDeployments(this.stateDir).map((deployment) => ({
      modelId: deployment.workerProfile,
      status: deployment.routingEnabled ? 'active' : 'inactive',
      checkpointPath: deployment.activeCheckpointId,
    }));

    return {
      queue,
      trinityRecords,
      arbiterPassRate,
      orpoSampleCount,
      deployments,
    };
  }

  private readPainSourceDistribution(): Record<string, number> {
    const rows = this.uiDb.all<{ source: string; total: number }>(`
      SELECT source, COUNT(*) AS total
      FROM pain_events
      GROUP BY source
      ORDER BY total DESC
    `);
    return Object.fromEntries(rows.map((row) => [row.source, this.asNumber(row.total, 0)]));
  }

  private readEvolutionActiveStage(queue: { pending: number; inProgress: number; completed: number }): string {
    const events = this.trajectory.listEvolutionEvents(undefined, { limit: 1, offset: 0 });
    if (events.length > 0) {
      return events[0].stage;
    }
    if (queue.inProgress > 0) return 'in_progress';
    if (queue.pending > 0) return 'pending';
    if (queue.completed > 0) return 'completed';
    return 'idle';
  }

  private readMergedEvents(): EventLogEntry[] {
    const persistedEvents = this.readPersistedEvents();
    const bufferedEvents = this.getBufferedEvents();
    const merged = new Map<string, EventLogEntry>();
    for (const entry of [...persistedEvents, ...bufferedEvents]) {
      merged.set(this.getEventDedupKey(entry), entry);
    }
    return [...merged.values()].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  }

  private readPersistedEvents(): EventLogEntry[] {
    const eventsPath = path.join(this.stateDir, 'logs', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return [];
    try {
      const raw = fs.readFileSync(eventsPath, 'utf8').trim();
      if (!raw) return [];
      return raw
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line) as EventLogEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is EventLogEntry => entry !== null);
    } catch {
      return [];
    }
  }

  private getBufferedEvents(): EventLogEntry[] {
    const candidate = this.eventLog as { getBufferedEvents?: () => EventLogEntry[] };
    if (typeof candidate.getBufferedEvents === 'function') {
      return candidate.getBufferedEvents();
    }
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Reason: Private helper doesn't use instance state
  private getEventDedupKey(entry: EventLogEntry): string {
    const eventId = typeof entry.data?.eventId === 'string' ? entry.data.eventId : null;
    if (eventId) {
      return `${entry.type}:${entry.sessionId ?? 'none'}:${eventId}`;
    }

    return [
      entry.ts ?? 'no-ts',
      entry.type ?? 'no-type',
      entry.category ?? 'no-category',
      entry.sessionId ?? 'no-session',
      typeof entry.data?.source === 'string' ? entry.data.source : 'no-source',
      typeof entry.data?.toolName === 'string' ? entry.data.toolName : 'no-tool',
      typeof entry.data?.reason === 'string' ? entry.data.reason : 'no-reason',
    ].join('::');
  }

  private readGateBlocksRaw(limit: number): GateBlockRow[] {
    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const hasGfi = this.hasTableColumn('gate_blocks', 'gfi');
    const hasGfiAfter = this.hasTableColumn('gate_blocks', 'gfi_after');
    const hasTrustStage = this.hasTableColumn('gate_blocks', 'trust_stage');
    const hasGateType = this.hasTableColumn('gate_blocks', 'gate_type');

    const sql = `
      SELECT
        created_at,
        tool_name,
        file_path,
        reason,
        ${hasGfi ? 'gfi' : 'NULL'} AS gfi,
        ${hasGfiAfter ? 'gfi_after' : 'NULL'} AS gfi_after,
        ${hasTrustStage ? 'trust_stage' : 'NULL'} AS trust_stage,
        ${hasGateType ? 'gate_type' : 'NULL'} AS gate_type
      FROM gate_blocks
      ORDER BY created_at DESC
      LIMIT ?
    `;

    return this.uiDb.all<GateBlockRow>(sql, safeLimit);
  }

  private resolveGateBlockGfi(row: GateBlockRow): number {
    const direct = this.asNullableNumber(row.gfi ?? row.gfi_after);
    if (direct !== null) return direct;

    const reason = String(row.reason ?? '');
    const match = /gfi\s*[:=]\s*(-?\d+(?:\.\d+)?)/i.exec(reason);
    if (match) {
      return this.asNumber(Number(match[1]), 0);
    }

    const session = this.getCurrentSession();
    return this.asNumber(session?.currentGfi, 0);
  }

  private resolveGateBlockTrustStage(row: GateBlockRow, fallbackStage: number): number {
    const direct = this.asNullableNumber(row.trust_stage);
    if (direct !== null) return Math.max(1, Math.min(4, Math.round(direct)));

    const reason = String(row.reason ?? '').toLowerCase();
    const match = /stage\s*(\d+)/i.exec(reason);
    if (match) {
      return Math.max(1, Math.min(4, Math.round(this.asNumber(Number(match[1]), fallbackStage))));
    }

    return fallbackStage;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Reason: Private helper doesn't use instance state
  private resolveGateType(row: GateBlockRow): string {
    if (typeof row.gate_type === 'string' && row.gate_type.trim().length > 0) {
      return row.gate_type;
    }

    const reason = String(row.reason ?? '').toLowerCase();
    if (reason.includes('gfi')) return 'gfi';
    if (reason.includes('tier') || reason.includes('stage') || reason.includes('trust')) return 'stage';
    if (reason.includes('p-03') || reason.includes('edit verification') || reason.includes('oldtext')) return 'p03';
    if (reason.includes('p-16') || reason.includes('exemption')) return 'p16';
    return 'general';
  }

  private hasTableColumn(tableName: string, columnName: string): boolean {
    let cached = this.tableColumnCache.get(tableName);
    if (!cached) {
      const rows = this.uiDb.all<{ name: string }>(`PRAGMA table_info(${tableName})`);
      cached = new Set(rows.map((row) => row.name));
      this.tableColumnCache.set(tableName, cached);
    }
    return cached.has(columnName);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Reason: Private helper doesn't use instance state
  private scoreToStatus(score: number): string {
    if (score >= 70) return 'healthy';
    if (score >= 40) return 'warning';
    return 'critical';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Reason: Private helper doesn't use instance state
  private evolutionToStatus(tier: string, points: number): string {
    const lower = tier.toLowerCase();
    if (lower === 'forest' || lower === 'tree') return 'healthy';
    if (lower === 'sapling' || points >= 200) return 'warning';
    return 'critical';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this, no-unused-vars -- Reason: Private helper doesn't use instance state
  private safeListFiles(dirPath: string, predicate: (_name: string) => boolean): string[] {
    if (!fs.existsSync(dirPath)) return [];
    try {
      return fs.readdirSync(dirPath)
        .filter((name) => predicate(name))
        .map((name) => path.join(dirPath, name));
    } catch {
      return [];
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Reason: Private helper doesn't use instance state
  private readJsonFile<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Reason: Private helper doesn't use instance state
  private asNumber(value: unknown, fallback: number): number {
    return Number.isFinite(value) ? Number(value) : fallback;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Reason: Private helper doesn't use instance state
  private asNullableNumber(value: unknown): number | null {
    if (Number.isFinite(value)) return Number(value);
    if (typeof value === 'string' && value.trim().length > 0) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  /**
   * Sync GFI from the latest session JSON file into SQLite.
   * Called at construction time so all queries read from a single source (SQLite).
   */
  private syncGfiFromSession(): void {
    const session = this.readLatestSessionFromFile();
    const currentGfi = this.asNumber(session?.currentGfi, 0);
    const dailyGfiPeak = this.asNumber(session?.dailyGfiPeak, currentGfi);
    const today = new Date().toISOString().slice(0, 10);

    // Debug log: show what's being synced
    console.log(`[HealthQueryService] GFI sync: sessionId=${session?.sessionId?.slice(0, 8) || 'none'}, currentGfi=${currentGfi}, peak=${dailyGfiPeak}, sources=${JSON.stringify(session?.gfiBySource || {})}`);

    try {
      this.uiDb.execute(`
        CREATE TABLE IF NOT EXISTS gfi_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          current_gfi REAL NOT NULL DEFAULT 0,
          daily_gfi_peak REAL NOT NULL DEFAULT 0,
          gfi_date TEXT NOT NULL DEFAULT ''
        )
      `);
      this.uiDb.run(
        'INSERT OR REPLACE INTO gfi_state (id, current_gfi, daily_gfi_peak, gfi_date) VALUES (1, ?, ?, ?)',
        currentGfi,
        dailyGfiPeak,
        today,
      );
      console.log(`[HealthQueryService] GFI sync complete: ${currentGfi} → SQLite`);
    } catch (err) {
      console.warn('[HealthQueryService] Failed to sync GFI from session:', err);
    }
  }

  /**
   * Read current GFI state from SQLite.
   */
  private readGfiFromDb(): { currentGfi: number; dailyGfiPeak: number } {
    try {
      const row = this.uiDb.get<{ current_gfi: number; daily_gfi_peak: number }>(
        'SELECT current_gfi, daily_gfi_peak FROM gfi_state WHERE id = 1',
      );
      if (!row) return { currentGfi: 0, dailyGfiPeak: 0 };
      return {
        currentGfi: row.current_gfi ?? 0,
        dailyGfiPeak: row.daily_gfi_peak ?? 0,
      };
    } catch {
      return { currentGfi: 0, dailyGfiPeak: 0 };
    }
  }

  /**
   * Read the most recent session JSON file from disk.
   * Used to sync GFI from session-tracker's persistence into SQLite.
   */
  private readLatestSessionFromFile(): SessionState | null {
    const sessionsDir = path.join(this.stateDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      console.log(`[HealthQueryService] Sessions dir not found: ${sessionsDir}`);
      return null;
    }

    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
      if (files.length === 0) {
        console.log(`[HealthQueryService] No session files found in ${sessionsDir}`);
        return null;
      }

      let latest: SessionState | null = null;
      let latestTs = 0;
      let skippedCount = 0;

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
          const state = JSON.parse(content) as SessionState;
          if (state.workspaceDir && state.workspaceDir !== this.workspaceDir) {
            skippedCount++;
            continue;
          }
          const ts = Number(state.lastControlActivityAt ?? state.lastActivityAt ?? 0);
          if (ts > latestTs) {
            latestTs = ts;
            latest = state;
          }
        } catch {
          // Skip corrupted files
        }
      }

      console.log(`[HealthQueryService] readLatestSession: ${files.length} files, ${skippedCount} skipped (different workspace), latest=${latest?.sessionId?.slice(0, 8) || 'none'}`);
      return latest;
    } catch (err) {
      console.warn(`[HealthQueryService] Failed to read sessions dir: ${err}`);
      return null;
    }
  }
}
