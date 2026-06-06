import type { ApiResponse } from "../types.js";
import {
  validateErrorResponse,
  validateHeaders,
  validateFeedbackReport,
  validateFeedbackDraftsList,
  validateFeedbackDraftEnvelope,
  validateDeleteEnvelope,
  validateWorkspaceEntry,
  validateWorkspaceList,
  validateRemovedEnvelope,
  validateSyncResult,
  validateConfigReadiness,
  validateConfigSummary,
  validateConfigCatalog,
  validateAgentBindingUpdate,
  validateReadinessCheck,
  validateDefaultRuntimeUpdate,
  validateGovernanceQueue,
  validateActivations,
  validateDisableActivation,
  validateLifecycleMetrics,
  validateUpdateStatus,
  validateUpdateHistory,
  validateApprovalListResult,
  validateApprovalRecordDirect,
  validatePrinciplesList,
  validateApprovalsGrouped,
} from "./utils/validators.js";
import type {
  FeedbackReportData,
  FeedbackDraftSummaryData,
  FeedbackDraftEnvelopeData,
  DeleteEnvelopeData,
  WorkspaceEntryData,
  RemovedEnvelopeData,
  SyncResultData,
  ConfigReadinessData,
  ConfigSummaryData,
  ConfigCatalogData,
  AgentBindingUpdateData,
  ReadinessCheckData,
  DefaultRuntimeUpdateData,
  GovernanceQueueData,
  ActivationsData,
  DisableActivationData,
  LifecycleMetricsData,
  UpdateStatusData,
  UpdateHistoryData,
  ApprovalRecordData,
  ApprovalListResultData,
  PrinciplesListData,
  ApprovalsGroupedData,
} from "./utils/validators.js";

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

/**
 * Send an authenticated request to the Console API.
 *
 * @param validate - Runtime validator for the response data. Required for
 *   all endpoints that return typed data. When provided, the raw response
 *   is passed through this validator; if validation fails, the request
 *   returns `{ success: false, error, nextAction }` instead of `as T`.
 *   Omit only for `unknown` responses (e.g. health checks).
 */
async function request<T>(
  path: string,
  options?: RequestInit,
  validate?: (value: unknown) => T | null,
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
        ...(validateHeaders(options?.headers) ?? {}),
      },
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      let nextAction: string | undefined;
      try {
        const raw = await response.json();
        const parsed = validateErrorResponse(raw);
        if (parsed) {
          if (parsed.message) {
            errorMessage = parsed.message;
          } else if (parsed.error) {
            errorMessage = parsed.error;
          }
          if (parsed.nextAction) {
            ({ nextAction } = parsed);
          }
        }
      } catch {
        // ignore parse errors
      }
      return { success: false, error: errorMessage, nextAction };
    }

    const raw = await response.json();

    if (validate) {
      const validated = validate(raw);
      if (validated !== null) {
        return { success: true, data: validated };
      }
      return {
        success: false,
        error: "Response validation failed: unexpected data shape from server",
        nextAction: "Try refreshing the page. If the problem persists, report it.",
      };
    }

    // No validator provided — only allowed for unknown/health-check endpoints.
    // The caller explicitly accepts the risk of unvalidated data.
    return { success: true, data: raw as T };
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

async function fetchConfigReadiness(): Promise<ApiResponse<ConfigReadinessData>> {
  return request<ConfigReadinessData>("/api/health", undefined, validateConfigReadiness);
}

// ── Workspaces ────────────────────────────────────────────────────────────────

async function fetchWorkspaces(): Promise<ApiResponse<WorkspaceEntryData[]>> {
  return request<WorkspaceEntryData[]>("/api/workspaces", undefined, validateWorkspaceList);
}

async function addWorkspace(name: string, path: string): Promise<ApiResponse<WorkspaceEntryData>> {
  return request<WorkspaceEntryData>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, path }),
  }, validateWorkspaceEntry);
}

async function removeWorkspace(name: string): Promise<ApiResponse<RemovedEnvelopeData>> {
  return request<RemovedEnvelopeData>(`/api/workspaces/${encodeURIComponent(name)}`, { method: "DELETE" }, validateRemovedEnvelope);
}

async function syncWorkspace(name: string): Promise<ApiResponse<SyncResultData>> {
  return request<SyncResultData>(`/api/workspaces/${encodeURIComponent(name)}/sync`, { method: "POST" }, validateSyncResult);
}

// ── Principles ────────────────────────────────────────────────────────────────

async function fetchPrinciples(): Promise<ApiResponse<PrinciplesListData>> {
  return request<PrinciplesListData>("/api/principles", undefined, validatePrinciplesList);
}

// Principle detail is deeply nested; for now we accept unvalidated until a
// dedicated validator is added (the page already handles missing fields gracefully).
// This endpoint is marked legacy/deferred for full validation.
async function fetchPrincipleDetail(principleId: string): Promise<ApiResponse<unknown>> {
  return request<unknown>(`/api/principles/${encodeURIComponent(principleId)}`);
}

// ── Approvals ─────────────────────────────────────────────────────────────────

async function fetchApprovals(params?: {
  status?: string;
  channel?: string;
  page?: number;
  pageSize?: number;
}): Promise<ApiResponse<ApprovalListResultData>> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.channel) searchParams.set('channel', params.channel);
  if (params?.page) searchParams.set('page', String(params.page));
  if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
  const qs = searchParams.toString() ? '?' + searchParams.toString() : '';
  return request<ApprovalListResultData>('/api/v1/approvals' + qs, undefined, validateApprovalListResult);
}

async function fetchApprovalDetail(approvalId: string): Promise<ApiResponse<ApprovalRecordData>> {
  return request<ApprovalRecordData>('/api/v1/approvals/' + encodeURIComponent(approvalId), undefined, validateApprovalRecordDirect);
}

async function approveApproval(approvalId: string, note?: string): Promise<ApiResponse<ApprovalRecordData>> {
  return request<ApprovalRecordData>('/api/v1/approvals/' + encodeURIComponent(approvalId) + '/approve', {
    method: 'POST',
    body: JSON.stringify({ note }),
  }, validateApprovalRecordDirect);
}

async function rejectApproval(approvalId: string, reason: string): Promise<ApiResponse<ApprovalRecordData>> {
  return request<ApprovalRecordData>('/api/v1/approvals/' + encodeURIComponent(approvalId) + '/reject', {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }, validateApprovalRecordDirect);
}

// ── MVP seed feedback report drafts (PRI-285) ────────────────────────────────

async function createFeedbackReport(
  input: unknown,
  diagnostics: unknown,
): Promise<ApiResponse<FeedbackReportData>> {
  return request<FeedbackReportData>('/api/feedback/reports', {
    method: 'POST',
    body: JSON.stringify({ input, diagnostics }),
  }, validateFeedbackReport);
}

async function listFeedbackReports(): Promise<ApiResponse<{ drafts: FeedbackDraftSummaryData[] }>> {
  // The API returns { drafts: [...] } — validate the drafts array inside
  return request<{ drafts: FeedbackDraftSummaryData[] }>('/api/feedback/reports', undefined, (v): { drafts: FeedbackDraftSummaryData[] } | null => {
    const drafts = validateFeedbackDraftsList(v);
    if (drafts === null) return null;
    return { drafts };
  });
}

async function getFeedbackReport(id: string): Promise<ApiResponse<FeedbackDraftEnvelopeData>> {
  return request<FeedbackDraftEnvelopeData>('/api/feedback/reports/' + encodeURIComponent(id), undefined, validateFeedbackDraftEnvelope);
}

async function deleteFeedbackReport(id: string): Promise<ApiResponse<DeleteEnvelopeData>> {
  return request<DeleteEnvelopeData>('/api/feedback/reports/' + encodeURIComponent(id), {
    method: 'DELETE',
  }, validateDeleteEnvelope);
}

// ── Config / Control Center API (PRI-303, PRI-309) ───────────────────────────

async function fetchConfigSummary(): Promise<ApiResponse<ConfigSummaryData>> {
  return request<ConfigSummaryData>('/api/v1/config/summary', undefined, validateConfigSummary);
}

async function fetchConfigCatalog(): Promise<ApiResponse<ConfigCatalogData>> {
  return request<ConfigCatalogData>('/api/v1/config/catalog', undefined, validateConfigCatalog);
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
    validateAgentBindingUpdate,
  );
}

async function checkAgentReadiness(agentName: string): Promise<ApiResponse<ReadinessCheckData>> {
  return request<ReadinessCheckData>(
    `/api/v1/config/readiness/${encodeURIComponent(agentName)}`,
    undefined,
    validateReadinessCheck,
  );
}

async function updateDefaultRuntime(defaultRuntime: string): Promise<ApiResponse<DefaultRuntimeUpdateData>> {
  return request<DefaultRuntimeUpdateData>(
    '/api/v1/config/default-runtime',
    {
      method: 'PATCH',
      body: JSON.stringify({ defaultRuntime }),
    },
    validateDefaultRuntimeUpdate,
  );
}

// ── CR8: Backend Data Contract (G.1) ─────────────────────────────────────────

async function fetchGovernanceQueue(): Promise<ApiResponse<GovernanceQueueData>> {
  return request<GovernanceQueueData>('/api/v1/governance/queue', undefined, validateGovernanceQueue);
}

async function fetchApprovalsGrouped(): Promise<ApiResponse<ApprovalsGroupedData>> {
  return request<ApprovalsGroupedData>('/api/v1/approvals/grouped', undefined, validateApprovalsGrouped);
}

async function fetchAllActivations(): Promise<ApiResponse<ActivationsData>> {
  return request<ActivationsData>('/api/v1/activations', undefined, validateActivations);
}

async function disableActivation(activationId: string): Promise<ApiResponse<DisableActivationData>> {
  return request<DisableActivationData>(
    `/api/v1/activations/${encodeURIComponent(activationId)}/disable`,
    {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
    },
    validateDisableActivation,
  );
}

async function fetchLifecycleMetrics(principleId: string): Promise<ApiResponse<LifecycleMetricsData>> {
  return request<LifecycleMetricsData>(`/api/v1/lifecycle/principles/${encodeURIComponent(principleId)}`, undefined, validateLifecycleMetrics);
}

// ── Updates (CR9) ─────────────────────────────────────────────────────────────

async function fetchUpdateStatus(): Promise<ApiResponse<UpdateStatusData>> {
  return request<UpdateStatusData>('/api/update', undefined, validateUpdateStatus);
}

async function fetchUpdateHistory(): Promise<ApiResponse<UpdateHistoryData>> {
  return request<UpdateHistoryData>('/api/update/history', undefined, validateUpdateHistory);
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
  fetchUpdateStatus,
  fetchUpdateHistory,
};
