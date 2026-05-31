import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import { sendSuccess, sendError, sendNotFound, sendBadRequest } from '../utils/response.js';

const AGENT_REGISTRY = [
  {
    id: 'evolution-worker',
    name: 'Evolution Worker',
    nameZh: '进化工作者',
    description: '总调度引擎，驱动整个进化管道的心跳服务',
    descriptionZh: '总调度引擎，驱动整个进化管道的心跳服务',
    icon: 'Cpu',
    category: 'scheduler',
    taskKind: null,
    prompt: 'N/A - Heartbeat-driven scheduler, no LLM prompt',
    tools: ['processCompilationBackfill', 'processEvolutionQueue', 'processDetectionQueue', 'sweepExpiredWorkflows', 'runWorkflowWatchdog'],
    subAgents: ['correction-observer'],
  },
  {
    id: 'diagnostician',
    name: 'Diagnostician',
    nameZh: '诊断者',
    description: 'Uses 5-Whys method for root cause analysis, extracting principles from pain signals',
    descriptionZh: '使用 5-Whys 方法进行根因分析，从痛苦信号中提取原则',
    icon: 'Stethoscope',
    category: 'analyzer',
    taskKind: 'diagnostician',
    prompt: '## Diagnostic Protocol (5 Whys)\nPhase 1 - Evidence Gathering\nPhase 2 - Causal Chain (5 Whys)\nPhase 3 - Root Cause Classification\nPhase 4 - Principle Extraction',
    tools: ['PainSignalBridge', 'DiagnosticianRunner', 'SqliteContextAssembler'],
    subAgents: [],
  },
  {
    id: 'correction-observer',
    name: 'Correction Observer',
    nameZh: '纠正观察者',
    description: 'Optimizes the correction keyword store by analyzing hit rates and false positive rates',
    descriptionZh: '通过分析命中率和误报率来优化纠正关键词库',
    icon: 'SearchCheck',
    category: 'optimizer',
    taskKind: 'keyword_optimization',
    prompt: 'You are a correction keyword optimizer.\nAnalyze the current correction keyword store and recent user messages.\nRecommend ADD/UPDATE/REMOVE actions to improve correction cue accuracy.\nOutput: {"updated": boolean, "updates": {...}, "fpTerms": [...], "summary": string}',
    tools: ['KeywordOptimizationService', 'CorrectionCueLearner'],
    subAgents: [],
  },
  {
    id: 'pain-diagnostic-gate',
    name: 'Pain Diagnostic Gate',
    nameZh: '痛苦诊断门控',
    description: 'Gatekeeper that decides which pain signals warrant diagnostic analysis based on source, score, and GFI',
    descriptionZh: '守门人，基于来源、分数和 GFI 决定哪些痛苦信号值得诊断分析',
    icon: 'ShieldCheck',
    category: 'gate',
    taskKind: null,
    prompt: 'N/A - Rule-based gate, no LLM prompt. Evaluates: source type, score thresholds (40-70 depending on source), GFI, consecutive errors, cooldown.',
    tools: ['evaluatePainDiagnosticGate'],
    subAgents: [],
  },
];

type AgentStatus = 'running' | 'idle' | 'cooldown' | 'failed' | 'unknown';
type LastStatus = 'succeeded' | 'failed' | 'pending' | 'leased' | null;

interface AgentInfo {
  id: string;
  name: string;
  nameZh: string;
  description: string;
  descriptionZh: string;
  icon: string;
  category: string;
  status: AgentStatus;
  lastRunAt: string | null;
  lastStatus: LastStatus;
  recentTaskCount: number;
  failedTaskCount: number;
  subAgents: string[];
  prompt: string;
  tools: string[];
  taskKind: string | null;
  cooldownRemaining: string | null;
}

interface AgentDetail extends AgentInfo {
  recentTasks: {
    taskId: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    lastError: string | null;
    attemptCount: number;
  }[];
}

interface AgentTasksResponse {
  tasks: {
    taskId: string;
    taskKind: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    lastError: string | null;
    attemptCount: number;
    inputRef: string | null;
    resultRef: string | null;
  }[];
}

interface WorkerStatusReport {
  timestamp: string;
  cycle_start_ms: number;
  duration_ms: number;
  pain_flag: { exists: boolean; score: number | null; source: string | null; enqueued: boolean; skipped_reason: string | null };
  queue: { total: number; pending: number; in_progress: number; completed_this_cycle: number; failed_this_cycle: number };
  errors: string[];
}

interface WorkflowRow {
  workflow_id: string;
  workflow_type: string;
  state: string;
  created_at: number;
  updated_at: number;
  duration_ms: number | null;
}

const WORKER_STALE_THRESHOLD_MS = 30 * 60 * 1000;

function mapTaskStatusToAgentStatus(taskStatus: string): AgentStatus {
  switch (taskStatus) {
    case 'pending':
    case 'leased':
      return 'running';
    case 'succeeded':
      return 'idle';
    case 'failed':
      return 'failed';
    case 'retry_wait':
      return 'cooldown';
    default:
      return 'unknown';
  }
}

function mapTaskStatusToLastStatus(taskStatus: string): LastStatus {
  switch (taskStatus) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'pending':
      return 'pending';
    case 'leased':
      return 'leased';
    default:
      return null;
  }
}

function formatCooldownRemaining(leaseExpiresAt: string | undefined): string | null {
  if (!leaseExpiresAt) return null;
  const remaining = new Date(leaseExpiresAt).getTime() - Date.now();
  if (remaining <= 0) return null;
  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

const models = new Map<string, AgentConsoleModel>();

class AgentConsoleModel {
  private readonly workspaceDir: string;
  private stateManager: RuntimeStateManager | null = null;
  private initPromise: Promise<void> | null = null;
  private stageEventsCache = new Map<string, Record<string, string>>();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private async ensureInitialized(): Promise<RuntimeStateManager> {
    if (this.stateManager) return this.stateManager;
    if (this.initPromise) {
      try {
        await this.initPromise;
        if (this.stateManager) return this.stateManager;
        throw new Error('initPromise resolved but stateManager is null');
      } catch {
        this.initPromise = null;
      }
    }
    const manager = new RuntimeStateManager({ workspaceDir: this.workspaceDir });
    this.initPromise = manager.initialize();
    try {
      await this.initPromise;
      this.stateManager = manager;
      return manager;
    } catch {
      this.stateManager = null;
      this.initPromise = null;
      throw new Error('Failed to initialize RuntimeStateManager');
    }
  }

  private readWorkerStatus(): WorkerStatusReport | null {
    const statusPath = path.join(this.workspaceDir, '.state', 'worker-status.json');
    if (!fs.existsSync(statusPath)) return null;
    try {
      const raw = fs.readFileSync(statusPath, 'utf8');
      return JSON.parse(raw) as WorkerStatusReport;
    } catch {
      return null;
    }
  }

  private readWorkflowData(): WorkflowRow[] {
    const dbPath = path.join(this.workspaceDir, '.state', 'subagent_workflows.db');
    if (!fs.existsSync(dbPath)) return [];
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(`
        SELECT workflow_id, workflow_type, state, created_at, updated_at, duration_ms
        FROM subagent_workflows
        ORDER BY updated_at DESC
        LIMIT 50
      `).all() as WorkflowRow[];
      return rows;
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  private getEvolutionWorkerStatus(): { status: AgentStatus; lastRunAt: string | null } {
    const report = this.readWorkerStatus();
    if (!report) return { status: 'unknown', lastRunAt: null };
    const lastRun = new Date(report.timestamp).getTime();
    const isFresh = Date.now() - lastRun < WORKER_STALE_THRESHOLD_MS;
    return {
      status: isFresh ? 'running' : 'idle',
      lastRunAt: report.timestamp,
    };
  }

  private getStageEvents(workflowId: string): Record<string, string> {
    const cached = this.stageEventsCache.get(workflowId);
    if (cached) return cached;
    return {};
  }

  private refreshStageEvents(): void {
    const dbPath = path.join(this.workspaceDir, '.state', 'subagent_workflows.db');
    if (!fs.existsSync(dbPath)) return;
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const events = db.prepare(`
        SELECT workflow_id, event_type, payload_json
        FROM subagent_workflow_events
        WHERE event_type LIKE 'trinity_%'
        ORDER BY created_at DESC
      `).all() as { workflow_id: string; event_type: string; payload_json: string }[];
      const grouped = new Map<string, Record<string, string>>();
      for (const ev of events) {
        const states = grouped.get(ev.workflow_id) || {};
        const stage = ev.event_type.replace('trinity_', '').replace('_start', '').replace('_complete', '').replace('_failed', '');
        if (!states[stage]) {
          if (ev.event_type.endsWith('_failed')) states[stage] = 'failed';
          else if (ev.event_type.endsWith('_complete')) states[stage] = 'completed';
          else if (ev.event_type.endsWith('_start')) states[stage] = 'started';
        }
        grouped.set(ev.workflow_id, states);
      }
      this.stageEventsCache = grouped;
    } catch {
      this.stageEventsCache.clear();
    } finally {
      db?.close();
    }
  }

  private async buildAgentInfo(
    agent: typeof AGENT_REGISTRY[number],
    allTasks: Awaited<ReturnType<RuntimeStateManager['listTasks']>>,
    _workflows: WorkflowRow[],
  ): Promise<AgentInfo> {
    let status: AgentStatus = 'unknown';
    let lastRunAt: string | null = null;
    let lastStatus: LastStatus = null;
    let recentTaskCount = 0;
    let failedTaskCount = 0;
    let cooldownRemaining: string | null = null;

    if (agent.id === 'evolution-worker') {
      const workerStatus = this.getEvolutionWorkerStatus();
      ({ status, lastRunAt } = workerStatus);
      const queueTasks = allTasks.filter(t =>
        t.taskKind === 'diagnostician' || t.taskKind === 'keyword_optimization',
      );
      recentTaskCount = queueTasks.length;
      failedTaskCount = queueTasks.filter(t => t.status === 'failed').length;
      if (queueTasks.length > 0) {
        const latest = queueTasks.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
        lastStatus = mapTaskStatusToLastStatus(latest.status);
      }
    } else if (agent.taskKind) {
      const agentTasks = allTasks.filter(t => t.taskKind === agent.taskKind);
      recentTaskCount = agentTasks.length;
      failedTaskCount = agentTasks.filter(t => t.status === 'failed').length;

      if (agentTasks.length > 0) {
        const sorted = [...agentTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const [latest] = sorted;
        status = mapTaskStatusToAgentStatus(latest.status);
        lastRunAt = latest.updatedAt;
        lastStatus = mapTaskStatusToLastStatus(latest.status);

        if (latest.status === 'retry_wait') {
          cooldownRemaining = formatCooldownRemaining(latest.leaseExpiresAt);
        }
      } else {
        status = 'idle';
      }
    } else if (agent.id === 'pain-diagnostic-gate') {
      status = 'idle';
    }

    return {
      id: agent.id,
      name: agent.name,
      nameZh: agent.nameZh,
      description: agent.description,
      descriptionZh: agent.descriptionZh,
      icon: agent.icon,
      category: agent.category,
      status,
      lastRunAt,
      lastStatus,
      recentTaskCount,
      failedTaskCount,
      subAgents: agent.subAgents,
      prompt: agent.prompt,
      tools: agent.tools,
      taskKind: agent.taskKind,
      cooldownRemaining,
    };
  }

  async listAgents(): Promise<AgentInfo[]> {
    const mgr = await this.ensureInitialized();
    const allTasks = await mgr.listTasks();
    const workflows = this.readWorkflowData();
    this.refreshStageEvents();
    const results: AgentInfo[] = [];
    for (const agent of AGENT_REGISTRY) {
      results.push(await this.buildAgentInfo(agent, allTasks, workflows));
    }
    return results;
  }

  async getAgentDetail(agentId: string): Promise<AgentDetail | null> {
    const agent = AGENT_REGISTRY.find(a => a.id === agentId);
    if (!agent) return null;

    const mgr = await this.ensureInitialized();
    const allTasks = await mgr.listTasks();
    const workflows = this.readWorkflowData();
    this.refreshStageEvents();
    const info = await this.buildAgentInfo(agent, allTasks, workflows);

    let agentTasks = agent.taskKind
      ? allTasks.filter(t => t.taskKind === agent.taskKind)
      : [];
    agentTasks = [...agentTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const recentTasks = agentTasks.slice(0, 20).map(t => ({
      taskId: t.taskId,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      lastError: t.lastError ?? null,
      attemptCount: t.attemptCount,
    }));

    return { ...info, recentTasks };
  }

  async getAgentTasks(agentId: string): Promise<AgentTasksResponse | null> {
    const agent = AGENT_REGISTRY.find(a => a.id === agentId);
    if (!agent) return null;
    if (!agent.taskKind) return { tasks: [] };

    const mgr = await this.ensureInitialized();
    const agentTasks = await mgr.listTasks({ taskKind: agent.taskKind });
    const sorted = [...agentTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      tasks: sorted.map(t => ({
        taskId: t.taskId,
        taskKind: t.taskKind,
        status: t.status,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        lastError: t.lastError ?? null,
        attemptCount: t.attemptCount,
        inputRef: t.inputRef ?? null,
        resultRef: t.resultRef ?? null,
      })),
    };
  }

  dispose(): void {
    if (this.stateManager) {
      this.stateManager.close().catch((_e: unknown): void => { /* noop */ });
      this.stateManager = null;
    }
    this.initPromise = null;
  }
}

function getModel(workspaceDir: string): AgentConsoleModel {
  let model = models.get(workspaceDir);
  if (!model) {
    model = new AgentConsoleModel(workspaceDir);
    models.set(workspaceDir, model);
  }
  return model;
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleAgentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  if (req.method !== 'GET') {
    sendNotFound(res, `Route /api/agents${subPath} not found`);
    return;
  }

  const model = getModel(workspaceDir);

  if (subPath === '' || subPath === '/') {
    try {
      const result = await model.listAgents();
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'agents_list_error', (err as Error).message);
    }
    return;
  }

  const tasksMatch = /^\/([^/]+)\/tasks\/?$/.exec(subPath);
  if (tasksMatch) {
    const agentId = (() => {
      try {
        return decodeURIComponent(tasksMatch[1]);
      } catch {
        return null;
      }
    })();
    if (!agentId) {
      sendBadRequest(res, 'Invalid agent ID encoding');
      return;
    }
    try {
      const result = await model.getAgentTasks(agentId);
      if (!result) {
        sendNotFound(res, `Agent '${agentId}' not found`);
        return;
      }
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'agent_tasks_error', (err as Error).message);
    }
    return;
  }

  const detailMatch = /^\/([^/]+)\/?$/.exec(subPath);
  if (detailMatch) {
    const agentId = (() => {
      try {
        return decodeURIComponent(detailMatch[1]);
      } catch {
        return null;
      }
    })();
    if (!agentId) {
      sendBadRequest(res, 'Invalid agent ID encoding');
      return;
    }
    try {
      const result = await model.getAgentDetail(agentId);
      if (!result) {
        sendNotFound(res, `Agent '${agentId}' not found`);
        return;
      }
      sendSuccess(res, result);
    } catch (err: unknown) {
      sendError(res, 500, 'agent_detail_error', (err as Error).message);
    }
    return;
  }

  sendNotFound(res, `Route /api/agents${subPath} not found`);
}

export function disposeAgentModels(): void {
  for (const model of models.values()) {
    model.dispose();
  }
  models.clear();
}
