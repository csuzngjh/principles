import type {
  ApiResponse,
  TaskZones,
  TaskEvidence,
  SystemStatus,
  ActivityEvent,
} from "../types.js";

interface OverviewHealth {
  status: 'healthy' | 'degraded' | 'error';
  gfi: { current: number; stage: string; peakToday: number; threshold: number };
  trust: { stage: number; score: number };
  principles: { candidate: number; probation: number; active: number; deprecated: number };
  queue: { pending: number; inProgress: number; completed: number };
}

interface OverviewData {
  workspaceDir: string;
  generatedAt: string;
  dataFreshness: 'fresh' | 'stale' | 'error';
  summary: {
    repeatErrorRate: number;
    userCorrectionRate: number;
    pendingSamples: number;
    approvedSamples: number;
    painEvents: number;
    principleEventCount: number;
    gateBlocks: number;
    taskOutcomes: number;
  };
  health: OverviewHealth;
  dailyTrend: { day: string; toolCalls: number; failures: number; userCorrections: number; painEvents: number }[];
  topRegressions: { toolName: string; errorType: string; occurrences: number }[];
  sampleQueue: { counters: Record<string, number>; preview: unknown[] };
}

interface GateStats {
  generatedAt: string;
  today: { gfiBlocks: number; stageBlocks: number; bypassAttempts: number };
  trust: { stage: number; score: number; status: 'healthy' | 'warning' | 'critical' };
  evolution: { tier: string; points: number; status: string };
  gfi: {
    current: number;
    peakToday: number;
    threshold: number;
    trend: { hour: string; value: number }[];
    sources: Record<string, number>;
    stage: 'stable' | 'elevated' | 'critical' | 'saturated';
  };
}

interface FeedbackGfi {
  current: number;
  peakToday: number;
  threshold: number;
  trend: { hour: string; value: number }[];
  sources: Record<string, number>;
}

interface EmpathyEvent {
  timestamp: string;
  severity: 'low' | 'medium' | 'high';
  score: number;
  reason: string;
  origin: string;
  gfiAfter: number;
}

interface GateBlockItem {
  timestamp: string;
  toolName: string;
  filePath: string | null;
  reason: string;
  gateType: 'gfi' | 'stage' | 'p03' | 'other';
  gfi: number;
  trustStage: number;
}

interface WorkspaceEntry {
  name: string;
  path: string;
  lastSync: string | null;
  config: { workspaceName: string; enabled: boolean; displayName: string | null; syncEnabled: boolean } | null;
}

interface SampleListItem {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: "pending" | "approved" | "rejected";
  confidence: number | null;
  createdAt: string;
}

interface SampleDetail {
  sampleId: string;
  taskId: string;
  title: string;
  description: string;
  reviewStatus: "pending" | "approved" | "rejected";
  confidence: number | null;
  createdAt: string;
  artifactContent: Record<string, unknown> | null;
  recommendation: {
    title?: string;
    text?: string;
    triggerPattern?: string;
    action?: string;
    abstractedPrinciple?: string;
  } | null;
}

interface SamplesData {
  counters: Record<string, number>;
  items: SampleListItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface CentralOverview {
  generatedAt: string;
  workspaceCount: number;
  workspaces: { name: string; path: string; status: 'healthy' | 'degraded' | 'error'; gfi: number; principleCount: number }[];
}

interface CentralHealth {
  generatedAt: string;
  overallStatus: 'healthy' | 'degraded' | 'error';
  workspaces: { name: string; status: 'healthy' | 'degraded' | 'error'; gfi: number; activePrinciples: number; pendingTasks: number }[];
}

function getToken(): string | null {
  return sessionStorage.getItem("pd_token");
}

function setToken(token: string): void {
  sessionStorage.setItem("pd_token", token);
}

function clearToken(): void {
  sessionStorage.removeItem("pd_token");
}

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<ApiResponse<T>> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...headers,
        ...(options?.headers as Record<string, string> | undefined),
      },
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const parsed = await response.json() as { error?: string; message?: string };
        if (parsed && typeof parsed.message === 'string') {
          errorMessage = parsed.message;
        } else if (parsed && typeof parsed.error === 'string') {
          errorMessage = parsed.error;
        }
      } catch {
        // ignore parse errors
      }
      return { success: false, error: errorMessage };
    }

    const json = await response.json() as { success?: boolean; data?: T };
    if (json.success === true && json.data !== undefined) {
      return { success: true, data: json.data };
    }
    return { success: true, data: json as unknown as T };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

async function checkAuth(): Promise<boolean> {
  const result = await request<unknown>("/api/health");
  return result.success;
}

async function fetchTasks(): Promise<ApiResponse<TaskZones>> {
  return request<TaskZones>("/api/tasks");
}

async function fetchTaskEvidence(id: string): Promise<ApiResponse<TaskEvidence>> {
  return request<TaskEvidence>(`/api/tasks/${id}/evidence`);
}

async function approveTask(id: string): Promise<ApiResponse<{ success: boolean }>> {
  return request<{ success: boolean }>(`/api/tasks/${id}/approve`, { method: "POST" });
}

async function rejectTask(id: string): Promise<ApiResponse<{ success: boolean }>> {
  return request<{ success: boolean }>(`/api/tasks/${id}/reject`, { method: "POST" });
}

async function cleanupTask(id: string): Promise<ApiResponse<{ success: boolean }>> {
  return request<{ success: boolean }>(`/api/tasks/${id}/cleanup`, { method: "POST" });
}

async function fetchStatus(): Promise<ApiResponse<SystemStatus>> {
  return request<SystemStatus>("/api/status");
}

async function fetchActivity(): Promise<ApiResponse<ActivityEvent[]>> {
  return request<ActivityEvent[]>("/api/activity");
}

async function fetchOverview(): Promise<ApiResponse<OverviewData>> {
  return request<OverviewData>("/api/overview");
}

async function fetchOverviewHealth(): Promise<ApiResponse<OverviewHealth>> {
  return request<OverviewHealth>("/api/overview/health");
}

async function fetchGateStats(): Promise<ApiResponse<GateStats>> {
  return request<GateStats>("/api/gate/stats");
}

async function fetchGateBlocks(limit?: number): Promise<ApiResponse<GateBlockItem[]>> {
  const query = limit ? `?limit=${limit}` : '';
  return request<GateBlockItem[]>(`/api/gate/blocks${query}`);
}

async function fetchFeedbackGfi(): Promise<ApiResponse<FeedbackGfi>> {
  return request<FeedbackGfi>("/api/feedback/gfi");
}

async function fetchEmpathyEvents(limit?: number): Promise<ApiResponse<EmpathyEvent[]>> {
  const query = limit ? `?limit=${limit}` : '';
  return request<EmpathyEvent[]>(`/api/feedback/empathy-events${query}`);
}

async function fetchFeedbackGateBlocks(limit?: number): Promise<ApiResponse<GateBlockItem[]>> {
  const query = limit ? `?limit=${limit}` : '';
  return request<GateBlockItem[]>(`/api/feedback/gate-blocks${query}`);
}

async function fetchWorkspaces(): Promise<ApiResponse<WorkspaceEntry[]>> {
  return request<WorkspaceEntry[]>("/api/workspaces");
}

async function addWorkspace(name: string, path: string): Promise<ApiResponse<WorkspaceEntry>> {
  return request<WorkspaceEntry>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, path }),
  });
}

async function removeWorkspace(name: string): Promise<ApiResponse<{ removed: string }>> {
  return request<{ removed: string }>(`/api/workspaces/${encodeURIComponent(name)}`, { method: "DELETE" });
}

async function syncWorkspace(name: string): Promise<ApiResponse<{ success: boolean; syncedAt: string }>> {
  return request<{ success: boolean; syncedAt: string }>(`/api/workspaces/${encodeURIComponent(name)}/sync`, { method: "POST" });
}

async function fetchCentralOverview(): Promise<ApiResponse<CentralOverview>> {
  return request<CentralOverview>("/api/central/overview");
}

async function fetchCentralHealth(): Promise<ApiResponse<CentralHealth>> {
  return request<CentralHealth>("/api/central/health");
}

async function fetchSamples(status?: string, page?: number): Promise<ApiResponse<SamplesData>> {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (page) params.set('page', String(page));
  const query = params.toString() ? `?${params.toString()}` : '';
  return request<SamplesData>(`/api/samples${query}`);
}

async function fetchSampleDetail(sampleId: string): Promise<ApiResponse<SampleDetail>> {
  return request<SampleDetail>(`/api/samples/${encodeURIComponent(sampleId)}`);
}

async function reviewSample(sampleId: string, decision: 'approved' | 'rejected'): Promise<ApiResponse<{ success: boolean; reviewStatus: string }>> {
  return request<{ success: boolean; reviewStatus: string }>(`/api/samples/${encodeURIComponent(sampleId)}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

interface EvolutionStats {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  stageDistribution: { stage: string; count: number }[];
}

interface EvolutionTaskItem {
  taskId: string;
  taskKind: string;
  status: string;
  createdAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

interface EvolutionTasksData {
  items: EvolutionTaskItem[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

interface EvolutionPrinciplesData {
  summary: { candidate: number; probation: number; active: number; deprecated: number; archived: number; total: number };
  recent: { principleId: string; status: string; text: string; triggerPattern: string; action: string; evaluability: string; createdAt: string; updatedAt: string }[];
}

interface PrincipleListItem {
  id: string;
  text: string;
  triggerPattern: string;
  action: string;
  status: 'candidate' | 'active' | 'archived' | 'deprecated' | 'probation';
  priority: 'P0' | 'P1' | 'P2';
  scope: 'general' | 'domain';
  domain: string | null;
  evaluability: 'manual_only' | 'deterministic' | 'weak_heuristic';
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  ruleCount: number;
  conflictsWithCount: number;
  createdAt: string;
  updatedAt: string;
}

interface RuleItem {
  id: string;
  name: string;
  description: string;
  type: 'hook' | 'gate' | 'skill' | 'lora' | 'test' | 'prompt';
  triggerCondition: string;
  enforcement: 'block' | 'warn' | 'log';
  action: string;
  status: 'proposed' | 'implemented' | 'enforced' | 'retired';
  coverageRate: number;
  falsePositiveRate: number;
}

interface PrincipleDetail extends PrincipleListItem {
  coreAxiomId: string | null;
  lastPainPreventedAt: string | null;
  derivedFromPainIds: string[];
  ruleIds: string[];
  conflictsWithPrincipleIds: string[];
  supersedesPrincipleId: string | null;
  rules: RuleItem[];
}

interface PrinciplesListData {
  principles: PrincipleListItem[];
  summary: { candidate: number; probation: number; active: number; deprecated: number; archived: number; total: number };
}

interface PrincipleDetailData {
  principle: PrincipleDetail;
}

interface QueueHealthData {
  pendingCount: number;
  retryWaitCount: number;
  countsByTaskKind: Record<string, number>;
  countsByChannel: Record<string, number>;
  invalidMetadataCount: number;
  blockedCount: number;
  dependencyFailedCount: number;
  readyTaskCount: number;
  noReadyTasksReason: string | null;
}

async function fetchEvolutionStats(): Promise<ApiResponse<EvolutionStats>> {
  return request<EvolutionStats>("/api/evolution/stats");
}

async function fetchEvolutionTasks(status?: string, page?: number): Promise<ApiResponse<EvolutionTasksData>> {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (page) params.set('page', String(page));
  const query = params.toString() ? `?${params.toString()}` : '';
  return request<EvolutionTasksData>(`/api/evolution/tasks${query}`);
}

async function fetchEvolutionPrinciples(): Promise<ApiResponse<EvolutionPrinciplesData>> {
  return request<EvolutionPrinciplesData>("/api/evolution/principles");
}

async function fetchPrinciples(): Promise<ApiResponse<PrinciplesListData>> {
  return request<PrinciplesListData>("/api/principles");
}

async function fetchPrincipleDetail(principleId: string): Promise<ApiResponse<PrincipleDetailData>> {
  return request<PrincipleDetailData>(`/api/principles/${encodeURIComponent(principleId)}`);
}

async function fetchEvolutionQueue(): Promise<ApiResponse<QueueHealthData>> {
  return request<QueueHealthData>("/api/evolution/queue");
}

interface ThinkingModelOverview {
  totalModels: number;
  models: { id: string; name: string; trigger: string; must: string; forbidden: string }[];
  source: string;
}

async function fetchThinkingModels(): Promise<ApiResponse<ThinkingModelOverview>> {
  return request<ThinkingModelOverview>("/api/thinking-models");
}

interface HealthCheckItem {
  id: string;
  name: string;
  status: 'healthy' | 'warning' | 'error';
  message: string;
  lastCheck: string;
}

interface PipelineTimestamps {
  lastPainSignal: string | null;
  lastTaskCreated: string | null;
  lastCandidateGenerated: string | null;
  lastPrincipleAdded: string | null;
}

interface SystemHealthStatus {
  overall: 'healthy' | 'degraded' | 'error';
  checks: HealthCheckItem[];
  pipeline: PipelineTimestamps;
  generatedAt: string;
}

async function fetchSystemHealth(): Promise<ApiResponse<SystemHealthStatus>> {
  return request<SystemHealthStatus>("/api/health");
}

interface PipelineStage {
  id: string;
  name: string;
  status: 'normal' | 'slow' | 'stuck';
  count: number;
  avgDuration: number | null;
  lastProcessed: string | null;
  gapMinutes: number | null;
}

interface Bottleneck {
  fromStage: string;
  toStage: string;
  gapMinutes: number;
  severity: 'warning' | 'critical';
  description: string;
}

interface PipelineStats {
  generatedAt: string;
  stages: PipelineStage[];
  bottlenecks: Bottleneck[];
  totalProcessed: number;
  throughput: number;
}

async function fetchPipelineStats(): Promise<ApiResponse<PipelineStats>> {
  return request<PipelineStats>("/api/pipeline");
}

interface EventLogEntry {
  id: string;
  ts: string;
  type: string;
  category?: string;
  data?: Record<string, unknown>;
}

interface EventsResponse {
  events: EventLogEntry[];
  total: number;
  totalPages: number;
}

interface RelatedEventsResponse {
  events: EventLogEntry[];
}

async function fetchEvents(options: {
  types?: string[];
  startDate?: string;
  endDate?: string;
  searchQuery?: string;
  page?: number;
  pageSize?: number;
}): Promise<ApiResponse<EventsResponse>> {
  const params = new URLSearchParams();
  if (options.types) options.types.forEach(type => params.append('type', type));
  if (options.startDate) params.set('startDate', options.startDate);
  if (options.endDate) params.set('endDate', options.endDate);
  if (options.searchQuery) params.set('q', options.searchQuery);
  if (options.page) params.set('page', options.page.toString());
  if (options.pageSize) params.set('pageSize', options.pageSize.toString());
  const queryStr = params.toString() ? `?${params.toString()}` : '';
  return request<EventsResponse>(`/api/events${queryStr}`);
}

async function fetchEventsGrouped(options?: {
  startDate?: string;
  endDate?: string;
}): Promise<ApiResponse<Record<string, number>>> {
  const params = new URLSearchParams();
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  const queryStr = params.toString() ? `?${params.toString()}` : '';
  return request<Record<string, number>>(`/api/events/grouped${queryStr}`);
}

async function fetchRelatedEvents(eventId: string, maxDistance?: number): Promise<ApiResponse<RelatedEventsResponse>> {
  const params = new URLSearchParams();
  if (maxDistance) params.set('maxDistance', maxDistance.toString());
  const queryStr = params.toString() ? `?${params.toString()}` : '';
  return request<RelatedEventsResponse>(`/api/events/${encodeURIComponent(eventId)}/related${queryStr}`);
}

export {
  getToken,
  setToken,
  clearToken,
  checkAuth,
  request,
  fetchTasks,
  fetchTaskEvidence,
  approveTask,
  rejectTask,
  cleanupTask,
  fetchStatus,
  fetchActivity,
  fetchOverview,
  fetchOverviewHealth,
  fetchGateStats,
  fetchGateBlocks,
  fetchFeedbackGfi,
  fetchEmpathyEvents,
  fetchFeedbackGateBlocks,
  fetchWorkspaces,
  addWorkspace,
  removeWorkspace,
  syncWorkspace,
  fetchCentralOverview,
  fetchCentralHealth,
  fetchSamples,
  fetchSampleDetail,
  reviewSample,
  fetchEvolutionStats,
  fetchEvolutionTasks,
  fetchEvolutionPrinciples,
  fetchPrinciples,
  fetchPrincipleDetail,
  fetchEvolutionQueue,
  fetchThinkingModels,
  fetchSystemHealth,
  fetchPipelineStats,
  fetchEvents,
  fetchEventsGrouped,
  fetchRelatedEvents,
};

export type {
  OverviewData,
  OverviewHealth,
  GateStats,
  FeedbackGfi,
  EmpathyEvent,
  GateBlockItem,
  WorkspaceEntry,
  CentralOverview,
  CentralHealth,
  SampleListItem,
  SampleDetail,
  SamplesData,
  EvolutionStats,
  EvolutionTaskItem,
  EvolutionTasksData,
  EvolutionPrinciplesData,
  PrincipleListItem,
  RuleItem,
  PrincipleDetail,
  PrinciplesListData,
  PrincipleDetailData,
  QueueHealthData,
  ThinkingModelOverview,
  HealthCheckItem,
  PipelineTimestamps,
  SystemHealthStatus,
  PipelineStage,
  Bottleneck,
  PipelineStats,
  EventLogEntry,
  EventsResponse,
  RelatedEventsResponse,
};
