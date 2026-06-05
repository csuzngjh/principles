import type { ApiResponse } from "../types.js";

// ── Auth ──────────────────────────────────────────────────────────────────────

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
      let nextAction: string | undefined;
      try {
        const parsed = await response.json() as { error?: string; message?: string; nextAction?: string };
        if (parsed && typeof parsed.message === 'string') {
          errorMessage = parsed.message;
        } else if (parsed && typeof parsed.error === 'string') {
          errorMessage = parsed.error;
        }
        if (parsed && typeof parsed.nextAction === 'string') {
          ({ nextAction } = parsed);
        }
      } catch {
        // ignore parse errors
      }
      return { success: false, error: errorMessage, nextAction };
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

// ── Config Readiness (renamed from fetchSystemHealth) ─────────────────────────

interface HealthCheckItem {
  id: string;
  name: string;
  status: 'healthy' | 'warning' | 'error';
  message: string;
  lastCheck: string;
}

interface ConfigReadinessData {
  checks: HealthCheckItem[];
  generatedAt: string;
}

async function fetchConfigReadiness(): Promise<ApiResponse<ConfigReadinessData>> {
  return request<ConfigReadinessData>("/api/health");
}

// ── Workspaces ────────────────────────────────────────────────────────────────

interface WorkspaceEntry {
  name: string;
  path: string;
  lastSync: string | null;
  config: { workspaceName: string; enabled: boolean; displayName: string | null; syncEnabled: boolean } | null;
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

// ── Principles ────────────────────────────────────────────────────────────────

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

async function fetchPrinciples(): Promise<ApiResponse<PrinciplesListData>> {
  return request<PrinciplesListData>("/api/principles");
}

async function fetchPrincipleDetail(principleId: string): Promise<ApiResponse<PrincipleDetailData>> {
  return request<PrincipleDetailData>(`/api/principles/${encodeURIComponent(principleId)}`);
}

// ── Approvals ─────────────────────────────────────────────────────────────────

interface ApprovalRecord {
  approvalId: string;
  artifactId: string;
  channel: string;
  riskLevel: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  confidence: number | undefined;
  requestedAt: string;
  decidedAt: string | undefined;
  decidedBy: string | undefined;
  decisionNote: string | undefined;
  rejectionReason: string | undefined;
  summary: string | undefined;
  triggerReason: string | undefined;
  confidenceLabel: 'high' | 'medium' | 'low';
  confidenceExplanation: string | undefined;
  effectDescription: string | undefined;
  rejectionEffect: string | undefined;
  isMvpProven?: boolean;
}

interface ApprovalListResult {
  items: ApprovalRecord[];
  total: number;
  stats: { pending: number; approved: number; rejected: number; cancelled: number };
}

async function fetchApprovals(params?: {
  status?: string;
  channel?: string;
  page?: number;
  pageSize?: number;
}): Promise<ApiResponse<ApprovalListResult>> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.channel) searchParams.set('channel', params.channel);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString() ? '?' + searchParams.toString() : '';
  return request<ApprovalListResult>('/api/v1/approvals' + qs);
}

async function fetchApprovalDetail(approvalId: string): Promise<ApiResponse<ApprovalRecord>> {
  return request<ApprovalRecord>('/api/v1/approvals/' + encodeURIComponent(approvalId));
}

async function approveApproval(approvalId: string, note?: string): Promise<ApiResponse<ApprovalRecord>> {
  return request<ApprovalRecord>('/api/v1/approvals/' + encodeURIComponent(approvalId) + '/approve', {
    method: 'POST',
    body: JSON.stringify({ note }),
  });
}

async function rejectApproval(approvalId: string, reason: string): Promise<ApiResponse<ApprovalRecord>> {
  return request<ApprovalRecord>('/api/v1/approvals/' + encodeURIComponent(approvalId) + '/reject', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// ── MVP seed feedback report drafts (PRI-285) ────────────────────────────────

type FeedbackDraftSummary = {
  id: string;
  createdAt: string;
  type: string;
  title: string;
};

type FeedbackReportEnvelope = {
  id: string;
  createdAt: string;
  report: Record<string, unknown>;
};

type FeedbackDraftsListEnvelope = { drafts: FeedbackDraftSummary[] };
type FeedbackDraftEnvelope = { report: Record<string, unknown> };
type FeedbackDeleteEnvelope = { deleted: boolean };

async function createFeedbackReport(
  input: unknown,
  diagnostics: unknown,
): Promise<ApiResponse<FeedbackReportEnvelope>> {
  return request<FeedbackReportEnvelope>('/api/feedback/reports', {
    method: 'POST',
    body: JSON.stringify({ input, diagnostics }),
  });
}

async function listFeedbackReports(): Promise<ApiResponse<FeedbackDraftsListEnvelope>> {
  return request<FeedbackDraftsListEnvelope>('/api/feedback/reports');
}

async function getFeedbackReport(id: string): Promise<ApiResponse<FeedbackDraftEnvelope>> {
  return request<FeedbackDraftEnvelope>('/api/feedback/reports/' + encodeURIComponent(id));
}

async function deleteFeedbackReport(id: string): Promise<ApiResponse<FeedbackDeleteEnvelope>> {
  return request<FeedbackDeleteEnvelope>('/api/feedback/reports/' + encodeURIComponent(id), {
    method: 'DELETE',
  });
}

// ── Config / Control Center API (PRI-303, PRI-309) ───────────────────────────

type ReadinessStatus = 'ready' | 'not_ready' | 'needs_setup' | 'disabled' | 'unknown';

interface RedactedRuntimeProfileSummary {
  id: string;
  type: string;
  label: string;
  apiKeyEnv?: string;
  readiness: ReadinessStatus;
}

interface RedactedAgentSummary {
  name: string;
  enabled: boolean;
  runtimeProfileId: string;
  runtimeProfileLabel: string;
  readiness: ReadinessStatus;
}

interface RedactedFeatureSummary {
  id: string;
  category: string;
  enabled: boolean;
}

interface ConfigSummaryData {
  version: number;
  source: 'defaults' | 'user_config';
  features: RedactedFeatureSummary[];
  runtimeProfiles: RedactedRuntimeProfileSummary[];
  defaultRuntime: string;
  agents: RedactedAgentSummary[];
  ui: { diagnostics: { mode: string } };
  warnings: string[];
  errors?: { path: string; reason: string; nextAction: string }[];
}

interface ConfigCatalogData {
  profiles: RedactedRuntimeProfileSummary[];
  errors?: { path: string; reason: string; nextAction: string }[];
}

interface AgentBindingUpdateData {
  agent: string;
  runtimeProfile: string;
  enabled: boolean;
}

interface ReadinessCheckData {
  agent: string;
  readiness: ReadinessStatus;
  profileId: string;
  profileLabel: string;
  reason?: string;
  nextAction?: string;
}

async function fetchConfigSummary(): Promise<ApiResponse<ConfigSummaryData>> {
  return request<ConfigSummaryData>('/api/v1/config/summary');
}

async function fetchConfigCatalog(): Promise<ApiResponse<ConfigCatalogData>> {
  return request<ConfigCatalogData>('/api/v1/config/catalog');
}

async function updateAgentBinding(
  agentName: string,
  runtimeProfile: string,
  enabled: boolean,
): Promise<ApiResponse<AgentBindingUpdateData>> {
  return request<AgentBindingUpdateData>(
    `/api/v1/config/agents/${encodeURIComponent(agentName)}/binding`,
    {
      method: 'PATCH',
      body: JSON.stringify({ runtimeProfile, enabled }),
    },
  );
}

async function checkAgentReadiness(agentName: string): Promise<ApiResponse<ReadinessCheckData>> {
  return request<ReadinessCheckData>(
    `/api/v1/config/readiness/${encodeURIComponent(agentName)}`,
  );
}

async function updateDefaultRuntime(defaultRuntime: string): Promise<ApiResponse<{ defaultRuntime: string }>> {
  return request<{ defaultRuntime: string }>(
    '/api/v1/config/default-runtime',
    {
      method: 'PATCH',
      body: JSON.stringify({ defaultRuntime }),
    },
  );
}

// ── CR8: Backend Data Contract (G.1) ─────────────────────────────────────────

interface StagnationSignal {
  type: 'no_pain' | 'never_activated';
  principleId: string;
  daysSince: number;
}

interface GovernanceQueueData {
  pendingReviewCount: number;
  behaviorDeviationCount: number;
  stagnationSignals: StagnationSignal[];
  note?: string;
}

interface ApprovalGroupRecord {
  id: string;
  artifactId: string;
  channel: string;
  createdAt: string;
}

interface ApprovalGroup {
  principleId: string;
  principleTitle: string;
  status: 'pending' | 'approved' | 'rejected';
  records: ApprovalGroupRecord[];
}

interface ApprovalsGroupedData {
  groups: ApprovalGroup[];
  generatedAt: string;
  note?: string;
}

interface ActivationRecord {
  id: string;
  artifactId: string;
  principleId: string;
  channel: string;
  action: string;
  targetRef: string;
  activatedAt: string | null;
  status: 'active' | 'inactive';
}

interface ActivationsData {
  activations: ActivationRecord[];
  generatedAt: string;
  note?: string;
}

interface LifecycleAdherence {
  insufficientData: boolean;
  rate: number | null;
  note: string;
}

interface LifecycleRuleMetric {
  ruleId: string;
  triggered: number;
  lastTriggeredAt: string | null;
}

interface LifecycleMetricsData {
  principleId: string;
  adherence: LifecycleAdherence;
  ruleMetrics: LifecycleRuleMetric[];
}

async function fetchGovernanceQueue(): Promise<ApiResponse<GovernanceQueueData>> {
  return request<GovernanceQueueData>('/api/v1/governance/queue');
}

async function fetchApprovalsGrouped(): Promise<ApiResponse<ApprovalsGroupedData>> {
  return request<ApprovalsGroupedData>('/api/v1/approvals/grouped');
}

async function fetchAllActivations(): Promise<ApiResponse<ActivationsData>> {
  return request<ActivationsData>('/api/v1/activations');
}

interface DisableActivationResponse {
  activationId: string;
  status: 'inactive';
}

async function disableActivation(activationId: string): Promise<ApiResponse<DisableActivationResponse>> {
  return request<DisableActivationResponse>(
    `/api/v1/activations/${encodeURIComponent(activationId)}/disable`,
    {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
    },
  );
}

async function fetchLifecycleMetrics(principleId: string): Promise<ApiResponse<LifecycleMetricsData>> {
  return request<LifecycleMetricsData>(`/api/v1/lifecycle/principles/${encodeURIComponent(principleId)}`);
}

// ── Exports ───────────────────────────────────────────────────────────────────

export {
  getToken,
  setToken,
  clearToken,
  checkAuth,
  request,
  fetchApprovals,
  fetchApprovalDetail,
  approveApproval,
  rejectApproval,
  fetchPrinciples,
  fetchPrincipleDetail,
  createFeedbackReport,
  listFeedbackReports,
  getFeedbackReport,
  deleteFeedbackReport,
  fetchConfigSummary,
  fetchConfigCatalog,
  updateAgentBinding,
  checkAgentReadiness,
  updateDefaultRuntime,
  fetchWorkspaces,
  addWorkspace,
  removeWorkspace,
  syncWorkspace,
  fetchConfigReadiness,
  fetchGovernanceQueue,
  fetchApprovalsGrouped,
  fetchAllActivations,
  disableActivation,
  fetchLifecycleMetrics,
};

export type {
  HealthCheckItem,
  ConfigReadinessData,
  WorkspaceEntry,
  PrincipleListItem,
  RuleItem,
  PrincipleDetail,
  PrinciplesListData,
  PrincipleDetailData,
  ApprovalRecord,
  ApprovalListResult,
  FeedbackDraftSummary,
  FeedbackReportEnvelope,
  FeedbackDraftsListEnvelope,
  FeedbackDraftEnvelope,
  FeedbackDeleteEnvelope,
  ReadinessStatus,
  RedactedRuntimeProfileSummary,
  RedactedAgentSummary,
  RedactedFeatureSummary,
  ConfigSummaryData,
  ConfigCatalogData,
  AgentBindingUpdateData,
  ReadinessCheckData,
  StagnationSignal,
  GovernanceQueueData,
  ApprovalGroupRecord,
  ApprovalGroup,
  ApprovalsGroupedData,
  ActivationRecord,
  ActivationsData,
  LifecycleAdherence,
  LifecycleRuleMetric,
  LifecycleMetricsData,
};
