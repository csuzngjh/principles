import * as fs from 'fs';
import * as path from 'path';
import { readPainFlagData } from '../core/pain.js';
import { listSessions } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { evaluatePhase3Inputs } from './phase3-input-filter.js';
import { TrajectoryRegistry } from '../core/trajectory.js';
import { getPendingDiagnosticianTasks } from '../core/diagnostician-task-store.js';
import type { WorkflowStage } from '../core/workflow-funnel-loader.js';
import type { RuntimeTruth, AnalyticsTruth } from '../types/runtime-summary.js';

export type RuntimeDataQuality = 'authoritative' | 'partial';
export type RuntimeRewardPolicy =
  | 'frozen_all_positive'
  | 'frozen_atomic_positive_keep_plan_ready';

interface RuntimeSummarySource {
  source: string;
  score?: number;
  ts?: string;
  confidence?: number;
  origin?: string;
}

interface RuntimePainSignal {
  source: string;
  ts: string | null;
  reason: string | null;
}

export interface RuntimeSummary {
  /**
   * Runtime truth represents the current state of the system.
   * Used for control decisions, Phase 3 eligibility, and real-time operations.
   */
  runtime: RuntimeTruth;

  /**
   * Analytics truth represents historical data and aggregated metrics.
   * Used for insights, trends, and supporting evidence (where explicitly allowed).
   * NOT used for control decisions or Phase 3 eligibility.
   */
  analytics: AnalyticsTruth;

  gfi: {
    current: number | null;
    peak: number | null;
    sources: RuntimeSummarySource[];
    dataQuality: RuntimeDataQuality;
  };
  evolution: {
    queue: {
      pending: number;
      inProgress: number;
      completed: number;
    };
    directive: {
      exists: boolean;
      active: boolean | null;
      ageSeconds: number | null;
      taskPreview: string | null;
    };
    dataQuality: RuntimeDataQuality;
  };
  // D: Heartbeat Diagnostician chain — separate from evolution/nocturnal chain
  heartbeatDiagnosis: {
    /** Tasks pending in diagnostician_tasks.json (not yet processed by heartbeat) */
    pendingTasks: number;
    /** Total diagnosis tasks written by evolution worker (today from event log) */
    tasksWrittenToday: number;
    /** Total diagnostician reports written (today from event log) */
    reportsWrittenToday: number;
    /** Total diagnostician reports that were missing JSON (category=missing_json) */
    reportsMissingJsonToday: number;
    /** Total diagnostician reports with incomplete fields (category=incomplete_fields) */
    reportsIncompleteFieldsToday: number;
    /** Total principle candidates created from heartbeat chain (today from event log) */
    candidatesCreatedToday: number;
    /** Heartbeats that injected diagnostician tasks (today from event log) */
    heartbeatsInjectedToday: number;
  };
  phase3: {
    queueTruthReady: boolean;
    phase3ShadowEligible: boolean;
    evolutionEligible: number;
    evolutionReferenceOnly: number;
    evolutionReferenceOnlyReasons: string[];
    evolutionRejected: number;
    evolutionRejectedReasons: string[];
    legacyDirectiveFilePresent: boolean;
    directiveStatus: 'compatibility-only' | 'missing' | 'present';
    directiveIgnoredReason: string;
    /**
     * Source of Phase 3 eligibility calculation.
     * Should always be 'runtime_truth' - analytics not used for control decisions.
     */
    eligibilitySource: 'runtime_truth';
  };
  pain: {
    activeFlag: boolean;
    activeFlagSource: string | null;
    candidates: number | null;
    lastSignal: RuntimePainSignal | null;
  };
  gate: {
    recentBlocks: number | null;
    recentBypasses: number | null;
    dataQuality: RuntimeDataQuality;
  };
  /** YAML-driven funnel counts — only present when funnels param is provided (YAML-SSOT-01) */
  workflowFunnels?: WorkflowFunnelOutput[];
  metadata: {
    generatedAt: string;
    workspaceDir: string;
    sessionId: string | null;
    selectedSessionReason: 'explicit' | 'latest_active' | 'none';
    /** 'degraded' when YAML load errors or unresolved statsField paths exist; 'ok' otherwise */
    status: 'ok' | 'degraded';
    warnings: string[];
  };
}

interface PersistedSessionState {
  sessionId: string;
  currentGfi?: number;
  dailyGfiPeak?: number;
  lastActivityAt?: number;
  lastControlActivityAt?: number;
}

interface QueueItem {
  id?: string;
  status?: string;
  task?: string;
  trigger_text_preview?: string;
  taskId?: string;
  score?: number;
  source?: string;
  reason?: string;
  timestamp?: string;
  enqueued_at?: string;
  started_at?: string;
  assigned_session_key?: string;
}

interface DirectiveFile {
  active?: boolean;
  task?: string;
  taskId?: string;
  timestamp?: string;
}

interface EventLogEntry {
  ts?: string;
  type?: string;
  category?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow Funnel Types (YAML-SSOT-01 / YAML-SSOT-02)
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowFunnelStageOutput {
  key: string;
  label: string;
  statsField: string;
  count: number;
}

export interface WorkflowFunnelOutput {
  funnelKey: string;
  funnelLabel: string;
  stages: WorkflowFunnelStageOutput[];
}

const MAX_SOURCE_EVENTS = 5;
const GFI_PARTIAL_WARNING =
  'GFI source attribution remains partial in Phase 2b because only the empathy slice is source-attributed; most non-empathy friction still lacks full per-source attribution.';
const DAILY_GFI_WARNING =
  'daily-stats.gfi is not authoritative in Phase 1 and is used only as a fallback reference.';
const EVENT_BUFFER_WARNING =
  'Live event buffer is unavailable in this context, so status may lag until events.jsonl flushes.';

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) {
    warnings.push(message);
  }
}

/**
 * YAML-SSOT-03: resolve a dot-path (e.g. 'evolution.nocturnalDreamerCompleted') from dailyStats.
 * Returns { count, resolvable } to distinguish "field not found / non-numeric" from "legitimate zero".
 */
function resolveStatsField(stats: unknown, dotPath: string): { count: number; resolvable: boolean } {
  const parts = dotPath.split('.');
  let current: unknown = stats;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return { count: 0, resolvable: false };
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === 'number') {
    return { count: current, resolvable: true };
  }
  return { count: 0, resolvable: false };
}

export class RuntimeSummaryService {
  static getSummary(
    workspaceDir: string,
    options?: { sessionId?: string | null; loaderWarnings?: string[]; funnels?: Map<string, WorkflowStage[]> }
  ): RuntimeSummary {
    const generatedAt = new Date().toISOString();
    const warnings: string[] = [];
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir });

    const sessions = this.mergeSessionSnapshots(
      this.readSessions(wctx.resolve('SESSION_DIR'), warnings),
      workspaceDir
    );
    const selectedSession = this.selectSession(sessions, options?.sessionId ?? null);
    const selectedSessionId = selectedSession.session?.sessionId ?? null;

    const persistedEvents = this.readEvents(path.join(wctx.stateDir, 'logs', 'events.jsonl'), warnings);
    const hasBufferedEventAccess =
      typeof (wctx.eventLog as { getBufferedEvents?: () => EventLogEntry[] }).getBufferedEvents === 'function';
    const bufferedEvents = hasBufferedEventAccess
      ? (wctx.eventLog as { getBufferedEvents: () => EventLogEntry[] }).getBufferedEvents()
      : [];
    const events = this.mergeEvents(persistedEvents, bufferedEvents);
    const dailyStats = this.readJsonFile<Record<string, {
      gfi?: { peak?: number };
      toolCalls?: number;
      painSignals?: number;
      evolutionTasks?: number;
      evolution?: {
        diagnosisTasksWritten?: number;
        diagnosticianReportsWritten?: number;
        reportsMissingJson?: number;
        reportsIncompleteFields?: number;
        principleCandidatesCreated?: number;
        heartbeatsInjected?: number;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    }>>(
      path.join(wctx.stateDir, 'logs', 'daily-stats.json'),
      warnings,
      false
    );

    // YAML-SSOT-02/03: build workflowFunnels from funnels Map if provided
    // Get most recent date from daily stats, fallback to today
    const today = generatedAt.slice(0, 10);
    const availableDates = Object.keys(dailyStats || {}).sort().reverse();
    const statsDate = availableDates.length > 0 ? availableDates[0] : today;

    let workflowFunnelsOutput: WorkflowFunnelOutput[] | undefined;
    if (options?.funnels) {
      workflowFunnelsOutput = [];
      for (const [funnelKey, stages] of options.funnels) {
        const stageOutputs: WorkflowFunnelStageOutput[] = stages.map(stage => {
          const { count, resolvable } = resolveStatsField(dailyStats?.[statsDate], stage.statsField);
          return {
            key: stage.name,
            label: stage.name,
            statsField: stage.statsField,
            count,
            _resolvable: resolvable, // internal tag for degraded detection
          };
        });
        workflowFunnelsOutput.push({ funnelKey, funnelLabel: funnelKey, stages: stageOutputs });
      }
    }

    // YAML-SSOT-04: warn for any unresolvable statsField paths
    let hasUnresolvableStage = false;
    if (workflowFunnelsOutput) {
      for (const funnel of workflowFunnelsOutput) {
        for (const stage of funnel.stages) {
          if (!(stage as { _resolvable?: boolean })._resolvable) {
            hasUnresolvableStage = true;
            pushWarning(warnings, `statsField not resolvable: ${stage.statsField}`);
          }
        }
      }
    }

    // DEGRADED-01/02: status is degraded when YAML load errors or unresolvable statsField paths exist
    const loaderWarnings = options?.loaderWarnings ?? [];
    if (loaderWarnings.length > 0) {
      for (const w of loaderWarnings) {
        pushWarning(warnings, `YAML load warning: ${w}`);
      }
    }
    const status: 'ok' | 'degraded' =
      (loaderWarnings.length > 0 || hasUnresolvableStage) ? 'degraded' : 'ok';

    // Get most recent date from daily stats, fallback to today
    const dailyGfiPeak = dailyStats?.[statsDate]?.gfi?.peak;

    const gfiCurrent =
      selectedSession.session && Number.isFinite(selectedSession.session.currentGfi)
        ? Number(selectedSession.session.currentGfi)
        : null;

    const sessionPeak =
      selectedSession.session && Number.isFinite(selectedSession.session.dailyGfiPeak)
        ? Number(selectedSession.session.dailyGfiPeak)
        : null;
    const gfiPeak =
      sessionPeak ?? (Number.isFinite(dailyGfiPeak) ? Number(dailyGfiPeak) : null);

    pushWarning(warnings, GFI_PARTIAL_WARNING);
    if (sessionPeak === null && Number.isFinite(dailyGfiPeak)) {
      pushWarning(warnings, DAILY_GFI_WARNING);
    }
    if (!hasBufferedEventAccess) {
      pushWarning(warnings, EVENT_BUFFER_WARNING);
    }

    if (!selectedSession.session) {
      pushWarning(warnings, 'No persisted session state was found; current session GFI is unavailable.');
    }

    const queue = this.readJsonFile<QueueItem[]>(wctx.resolve('EVOLUTION_QUEUE'), warnings, false);
    // compatibility-only display artifact - not a truth source for Phase 3 eligibility
    // queue is the only authoritative execution truth source for Phase 3
    const directive = this.readJsonFile<DirectiveFile>(wctx.resolve('EVOLUTION_DIRECTIVE'), warnings, false);
    const queueStats = this.buildQueueStats(queue);
    const directiveSummary = this.buildDirectiveSummary(queue, directive, generatedAt, warnings);

    const painFlag = readPainFlagData(workspaceDir);
    const painCandidates = this.readJsonFile<{ candidates?: Record<string, unknown> }>(
      wctx.resolve('PAIN_CANDIDATES'),
      warnings,
      false
    );

    const phase3Inputs = evaluatePhase3Inputs(queue ?? []);

    const lastPainSignal = this.findLastPainSignal(events, selectedSessionId);
    const gfiSources = this.buildGfiSources(events, selectedSessionId);
    const gateStats = this.buildGateStats(events, selectedSessionId, warnings);

    // D: Heartbeat Diagnostician chain — separate from evolution/nocturnal chain
    // Read pending tasks from the diagnostician task store
    const pendingDiagTasks = getPendingDiagnosticianTasks(wctx.stateDir);
    // Read heartbeat diagnosis stats from daily event log
    const todayStr = generatedAt.slice(0, 10);
    const diagDailyStats = dailyStats?.[todayStr]?.evolution;
    const heartbeatDiagnosis = {
      pendingTasks: pendingDiagTasks.length,
      tasksWrittenToday: diagDailyStats?.diagnosisTasksWritten ?? 0,
      reportsWrittenToday: diagDailyStats?.diagnosticianReportsWritten ?? 0,
      reportsMissingJsonToday: diagDailyStats?.reportsMissingJson ?? 0,
      reportsIncompleteFieldsToday: diagDailyStats?.reportsIncompleteFields ?? 0,
      candidatesCreatedToday: diagDailyStats?.principleCandidatesCreated ?? 0,
      heartbeatsInjectedToday: diagDailyStats?.heartbeatsInjected ?? 0,
    };

    // Read trajectory analytics data (historical data, NOT runtime truth)
    const trajectoryStats = this.readTrajectoryStats(workspaceDir, warnings);

    // Build runtime truth section (current state for control decisions)
    const activeSessionIds = sessions.map(s => s.sessionId);
    const runtimeTruth: RuntimeTruth = {
      queueState: {
        total: queueStats.pending + queueStats.inProgress + queueStats.completed,
        pending: queueStats.pending,
        inProgress: queueStats.inProgress,
        completed: queueStats.completed,
        lastUpdated: generatedAt,
      },
      activeSessions: activeSessionIds,
    };

    // Build analytics truth section (historical data for insights)
    const analyticsTruth: AnalyticsTruth = {
      trajectoryData: {
        totalTasks: trajectoryStats.assistantTurns + trajectoryStats.userTurns,
        successRate: trajectoryStats.toolCalls > 0
          ? (trajectoryStats.toolCalls - trajectoryStats.failures) / trajectoryStats.toolCalls
          : 0,
        timeoutRate: trajectoryStats.failures > 0
          ? trajectoryStats.failures / (trajectoryStats.assistantTurns + trajectoryStats.userTurns || 1)
          : 0,
        lastUpdated: trajectoryStats.lastIngestAt ?? generatedAt,
      },
      dailyStats: {
        toolCalls: dailyStats?.[statsDate]?.toolCalls ?? 0,
        painSignals: dailyStats?.[statsDate]?.painSignals ?? 0,
        evolutionTasks: dailyStats?.[statsDate]?.evolutionTasks ?? 0,
        lastUpdated: statsDate,
      },
      trends: {
        sevenDay: { successRateChange: 0, toolCallVolumeChange: 0, painSignalRateChange: 0 },
        thirtyDay: { successRateChange: 0, toolCallVolumeChange: 0, painSignalRateChange: 0 },
      },
    };

    return {
      runtime: runtimeTruth,
      analytics: analyticsTruth,
      gfi: {
        current: gfiCurrent,
        peak: gfiPeak,
        sources: gfiSources,
        dataQuality: 'partial',
      },
      evolution: {
        queue: queueStats,
        directive: directiveSummary,
        dataQuality: this.resolveEvolutionDataQuality(queue),
      },
      phase3: {
        queueTruthReady: phase3Inputs.queueTruthReady,
        phase3ShadowEligible: phase3Inputs.phase3ShadowEligible,
        evolutionEligible: phase3Inputs.evolution.eligible.length,
        evolutionReferenceOnly: phase3Inputs.evolution.referenceOnly.length,
        evolutionReferenceOnlyReasons: [...new Set(phase3Inputs.evolution.referenceOnly.map((entry) => entry.classification))],
        evolutionRejected: phase3Inputs.evolution.rejected.length,
        evolutionRejectedReasons: phase3Inputs.evolution.rejected.flatMap((entry) => entry.reasons),
        legacyDirectiveFilePresent: directive !== null,
        directiveStatus: directive ? 'compatibility-only' : 'missing',
        directiveIgnoredReason: 'queue is only truth source',
        eligibilitySource: 'runtime_truth',
      },
      pain: {
        activeFlag: Object.keys(painFlag).length > 0,
        activeFlagSource: painFlag.source || null,
        candidates:
          painCandidates?.candidates && typeof painCandidates.candidates === 'object'
            ? Object.keys(painCandidates.candidates).length
            : null,
        lastSignal: lastPainSignal,
      },
      gate: gateStats,
      // D: Heartbeat Diagnostician chain — separate from evolution/nocturnal
      heartbeatDiagnosis,
      ...(workflowFunnelsOutput && { workflowFunnels: workflowFunnelsOutput }),
      metadata: {
        generatedAt,
        workspaceDir,
        sessionId: selectedSessionId,
        selectedSessionReason: selectedSession.reason,
        status,
        warnings,
      },
    };
  }

  private static readSessions(sessionDir: string, warnings: string[]): PersistedSessionState[] {
    if (!fs.existsSync(sessionDir)) {
      pushWarning(warnings, 'No persisted session directory exists yet; session-scoped runtime state is unavailable.');
      return [];
    }

    const sessions: PersistedSessionState[] = [];
    for (const file of fs.readdirSync(sessionDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
        const parsed = JSON.parse(raw) as PersistedSessionState;
        if (parsed?.sessionId) {
          sessions.push(parsed);
        }
      } catch {
        pushWarning(warnings, `Failed to parse session snapshot: ${file}`);
      }
    }

    return sessions.sort((a, b) => this.resolveSessionSortTime(b) - this.resolveSessionSortTime(a));
  }

  private static selectSession(
    sessions: PersistedSessionState[],
    explicitSessionId: string | null
  ): {
    session: PersistedSessionState | null;
    reason: 'explicit' | 'latest_active' | 'none';
  } {
    if (explicitSessionId) {
      const explicit = sessions.find((session) => session.sessionId === explicitSessionId) ?? null;
      return { session: explicit, reason: explicit ? 'explicit' : 'none' };
    }

    if (sessions.length === 0) {
      return { session: null, reason: 'none' };
    }

    return { session: sessions[0], reason: 'latest_active' };
  }

     
  private static mergeSessionSnapshots(
    persistedSessions: PersistedSessionState[],
    workspaceDir: string
  ): PersistedSessionState[] {
    const merged = new Map<string, PersistedSessionState>();

    for (const session of persistedSessions) {
      merged.set(session.sessionId, { ...session });
    }

    for (const live of listSessions(workspaceDir)) {
      const persisted = merged.get(live.sessionId);
      merged.set(live.sessionId, {
        sessionId: live.sessionId,
        currentGfi:
          Number.isFinite(live.currentGfi) ? Number(live.currentGfi) : persisted?.currentGfi,
        dailyGfiPeak:
          Number.isFinite(live.dailyGfiPeak) ? Number(live.dailyGfiPeak) : persisted?.dailyGfiPeak,
        lastActivityAt:
          Number.isFinite(live.lastActivityAt) ? Number(live.lastActivityAt) : persisted?.lastActivityAt,
        lastControlActivityAt:
          Number.isFinite(live.lastControlActivityAt)
            ? Number(live.lastControlActivityAt)
            : persisted?.lastControlActivityAt,
      });
    }

    return [...merged.values()].sort((a, b) => this.resolveSessionSortTime(b) - this.resolveSessionSortTime(a));
  }

  private static buildQueueStats(queue: QueueItem[] | null): {
    pending: number;
    inProgress: number;
    completed: number;
  } {
    const stats = { pending: 0, inProgress: 0, completed: 0 };
    if (!queue) return stats;

    for (const item of queue) {
      if (item?.status === 'completed') {
        stats.completed++;
      } else if (item?.status === 'in_progress') {
        stats.inProgress++;
      } else {
        stats.pending++;
      }
    }

    return stats;
  }

  /**
   * Builds directive summary for compatibility display only.
   * NOT a truth source for Phase 3 eligibility or decisions.
   * Queue is the only authoritative execution truth source.
   */
   
   
  private static buildDirectiveSummary(
    queue: QueueItem[] | null,
    directive: DirectiveFile | null,
    generatedAt: string,
    warnings: string[]
  ): {
    exists: boolean;
    active: boolean | null;
    ageSeconds: number | null;
    taskPreview: string | null;
  } {
    const inProgressTask = this.selectInProgressTask(queue);
    if (!inProgressTask) {
      if (directive) {
        this.warnOnLegacyDirectiveMismatch(directive, null, warnings);
      }
      return {
        exists: false,
        active: null,
        ageSeconds: null,
        taskPreview: null,
      };
    }

    const derivedTaskPreview = this.buildDirectiveTaskPreview(inProgressTask);
    const timestampMs = this.resolveDirectiveTimestamp(inProgressTask);
    const ageSeconds = Number.isFinite(timestampMs)
      ? Math.max(0, Math.floor((new Date(generatedAt).getTime() - timestampMs) / 1000))
      : null;

    if (directive) {
      this.warnOnLegacyDirectiveMismatch(directive, {
        active: true,
        taskPreview: derivedTaskPreview,
        taskId: inProgressTask.taskId ?? inProgressTask.id ?? null,
      }, warnings);
    }

    return {
      exists: true,
      active: true,
      ageSeconds,
      taskPreview: derivedTaskPreview,
    };
  }

  private static readEvents(eventsPath: string, warnings: string[]): EventLogEntry[] {
    if (!fs.existsSync(eventsPath)) {
      warnings.push('No events.jsonl file exists yet; recent pain and gate summaries are partial.');
      return [];
    }

    try {
      const raw = fs.readFileSync(eventsPath, 'utf8').trim();
      if (!raw) return [];
      let parseFailures = 0;
      const entries = raw
        .split('\n')
        .map((line) => {
          try {
            return JSON.parse(line) as EventLogEntry;
          } catch {
            parseFailures += 1;
            return null;
          }
        })
        .filter((entry): entry is EventLogEntry => entry !== null);
      if (parseFailures > 0) {
        pushWarning(
          warnings,
          `Skipped ${parseFailures} malformed event line${parseFailures === 1 ? '' : 's'} while reading events.jsonl.`
        );
      }
      return entries;
    } catch {
      pushWarning(warnings, 'Failed to read events.jsonl; recent pain and gate summaries are partial.');
      return [];
    }
  }

  private static buildGfiSources(events: EventLogEntry[], sessionId: string | null): RuntimeSummarySource[] {
    const filtered = events
      .filter((entry) => {
        if (sessionId && entry.sessionId !== sessionId) return false;
        return (
          entry.type === 'pain_signal' ||
          (entry.type === 'tool_call' && entry.category === 'failure')
        );
      })
      .slice(-MAX_SOURCE_EVENTS)
      .reverse();
     

     
    return filtered.map((entry) => {
      if (entry.type === 'pain_signal') {
        return {
          source: String(entry.data?.source ?? 'pain_signal'),
          score: this.asFiniteNumber(entry.data?.score),
          ts: entry.ts,
          confidence: this.asFiniteNumber(entry.data?.confidence),
          origin: typeof entry.data?.origin === 'string' ? entry.data.origin : undefined,
        };
      }

      return {
        source: `tool_failure:${String(entry.data?.toolName ?? 'unknown')}`,
        score: this.asFiniteNumber(entry.data?.gfi),
        ts: entry.ts,
      };
    });
  }

  private static findLastPainSignal(
    events: EventLogEntry[],
    sessionId: string | null
  ): RuntimePainSignal | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const entry = events[i];
      if (entry.type !== 'pain_signal') continue;
      if (sessionId && entry.sessionId !== sessionId) continue;
      return {
        source: String(entry.data?.source ?? 'pain_signal'),
        ts: entry.ts ?? null,
        reason: typeof entry.data?.reason === 'string' ? entry.data.reason : null,
      };
    }

    return null;
  }

  private static buildGateStats(
    events: EventLogEntry[],
    sessionId: string | null,
    warnings: string[]
  ): RuntimeSummary['gate'] {
    const scoped = events.filter((entry) => {
      if (sessionId && entry.sessionId !== sessionId) return false;
      return entry.type === 'gate_block' || entry.type === 'gate_bypass';
    });

    if (scoped.length === 0) {
      pushWarning(warnings, 'Gate block counts before Phase 1 may be incomplete because older block events were not recorded to event-log.');
    }

    return {
      recentBlocks: scoped.filter((entry) => entry.type === 'gate_block').length,
      recentBypasses: scoped.filter((entry) => entry.type === 'gate_bypass').length,
      dataQuality: scoped.length > 0 ? 'authoritative' : 'partial',
    };
  }

  private static resolveSessionSortTime(session: PersistedSessionState): number {
    return session.lastControlActivityAt ?? session.lastActivityAt ?? 0;
  }

  private static mergeEvents(persistedEvents: EventLogEntry[], bufferedEvents: EventLogEntry[]): EventLogEntry[] {
    const merged = new Map<string, EventLogEntry>();
    for (const entry of [...persistedEvents, ...bufferedEvents]) {
      merged.set(this.getEventDedupKey(entry), entry);
    }
    return [...merged.values()].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  }

     
  private static getEventDedupKey(entry: EventLogEntry): string {
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

  private static resolveEvolutionDataQuality(
    queue: QueueItem[] | null
  ): RuntimeDataQuality {
    return queue ? 'authoritative' : 'partial';
  }

  private static selectInProgressTask(queue: QueueItem[] | null): QueueItem | null {
    if (!queue || queue.length === 0) return null;

    const inProgress = queue.filter((item) => item?.status === 'in_progress');
    if (inProgress.length === 0) return null;

    for (const item of [...inProgress].sort((a, b) => this.getQueuePriority(b) - this.getQueuePriority(a))) {
      if (this.isResolvableEvolutionTask(item)) {
        return item;
      }
    }

    return null;
  }

  private static getQueuePriority(item: QueueItem): number {
    return Number.isFinite(item.score) ? Number(item.score) : 0;
  }

  private static isResolvableEvolutionTask(item: QueueItem): boolean {
    const rawTask = typeof item.task === 'string' ? item.task.trim() : '';
    if (rawTask && rawTask.toLowerCase() !== 'undefined') {
      return true;
    }

    return typeof item.id === 'string' && item.id.trim().length > 0;
  }

  private static resolveDirectiveTimestamp(item: QueueItem): number {
    const candidate = item.started_at || item.enqueued_at || item.timestamp || null;
    return candidate ? new Date(candidate).getTime() : NaN;
  }

     
  private static buildDirectiveTaskPreview(item: QueueItem): string {
    const task = typeof item.task === 'string' ? item.task.trim() : '';
    if (task && task.toLowerCase() !== 'undefined') {
      return task.slice(0, 160);
    }

    const triggerTextPreview = typeof item.trigger_text_preview === 'string' ? item.trigger_text_preview.trim() : '';

    const taskId = typeof item.taskId === 'string' && item.taskId.trim()
      ? item.taskId.trim()
      : typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : 'unknown';
    const source = typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'unknown';
    const reason = typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : 'Systemic pain detected';
    const preview = triggerTextPreview || 'N/A';
    return `Diagnose systemic pain [ID: ${taskId}]. Source: ${source}. Reason: ${reason}. Trigger text: "${preview}"`.slice(0, 160);
  }

  private static warnOnLegacyDirectiveMismatch(
    directive: DirectiveFile,
    derived: { active: boolean; taskPreview: string | null; taskId: string | null } | null,
    warnings: string[]
  ): void {
    const legacyActive = typeof directive.active === 'boolean' ? directive.active : null;
    const legacyTask = typeof directive.task === 'string' && directive.task.trim() ? directive.task.trim().slice(0, 160) : null;
    const legacyTaskId = typeof directive.taskId === 'string' && directive.taskId.trim() ? directive.taskId.trim() : null;

    const mismatchDetails: string[] = [];
    if (derived === null) {
      if (legacyActive === true || legacyTask || legacyTaskId) {
        mismatchDetails.push('legacy directive exists but queue has no in_progress task');
      }
    } else {
      if (legacyActive !== null && legacyActive !== derived.active) {
        mismatchDetails.push(`active=${String(legacyActive)} vs queue=${String(derived.active)}`);
      }
      if (legacyTask && derived.taskPreview && legacyTask !== derived.taskPreview) {
        mismatchDetails.push('task text differs');
      }
      if (legacyTaskId && derived.taskId && legacyTaskId !== derived.taskId) {
        mismatchDetails.push('task id differs');
      }
    }

    if (mismatchDetails.length > 0) {
      pushWarning(
        warnings,
        `Legacy directive file disagrees with queue-derived evolution state; queue is authoritative (${mismatchDetails.join(', ')}).`
      );
    }
  }

  private static readJsonFile<T>(
    filePath: string,
    warnings: string[],
    warnOnMissing: boolean
  ): T | null {
    if (!fs.existsSync(filePath)) {
      if (warnOnMissing) {
        pushWarning(warnings, `Missing expected file: ${path.basename(filePath)}`);
      }
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      pushWarning(warnings, `Failed to parse ${path.basename(filePath)}.`);
      return null;
    }
  }

  private static asFiniteNumber(value: unknown): number | undefined {
    return Number.isFinite(value) ? Number(value) : undefined;
  }

  /**
   * Read trajectory analytics data from trajectory database.
   *
   * Returns: Analytics data (historical metrics) aggregated from trajectory database.
   * Not: Runtime truth or real-time queue state.
   */
  private static readTrajectoryStats(
    workspaceDir: string,
    warnings: string[]
  ): {
    assistantTurns: number;
    userTurns: number;
    toolCalls: number;
    failures: number;
    lastIngestAt: string | null;
  } {
    try {
      // Use transient database instance to avoid locking issues
      const stats = TrajectoryRegistry.use(workspaceDir, (db) => db.getDataStats());

      return {
        assistantTurns: stats.assistantTurns,
        userTurns: stats.userTurns,
        toolCalls: stats.toolCalls,
        failures: stats.painEvents, // Approximate failures from pain events
        lastIngestAt: stats.lastIngestAt,
      };
    } catch (error) {
      pushWarning(
        warnings,
        `Failed to read trajectory analytics: ${error instanceof Error ? error.message : String(error)}`
      );
      return {
        assistantTurns: 0,
        userTurns: 0,
        toolCalls: 0,
        failures: 0,
        lastIngestAt: null,
      };
    }
  }
}
