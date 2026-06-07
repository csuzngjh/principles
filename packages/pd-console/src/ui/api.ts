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
 * Two overloads:
 * 1. request(path, options?) → ApiResponse<unknown>
 *    For endpoints without a runtime validator (health checks, etc.).
 *    The caller receives unvalidated data and must not assume a specific shape.
 *
 * 2. request<T>(path, options, validate) → ApiResponse<T>
 *    For endpoints with a runtime validator. The validator is applied to the
 *    raw response; if validation fails, returns an error envelope instead.
 */
function request(
  path: string,
  options?: RequestInit,
): Promise<ApiResponse<unknown>>;
function request<T>(
  path: string,
  options: RequestInit | undefined,
  validate: (value: unknown) => T | null,
): Promise<ApiResponse<T>>;
async function request<T = unknown>(
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
      if (response.status === 401) {
        const hadToken = getToken() !== null;
        clearToken();
        // eslint-disable-next-line no-undef
        if (hadToken && !window.location.hash.startsWith("#/login")) {
          // eslint-disable-next-line no-undef
          window.location.hash = "#/login?session_expired=true";
        }
      }
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
    const apiData = (raw && typeof raw === "object" && "success" in raw && "data" in raw)
      ? (raw as { data: unknown }).data
      : raw;

    if (validate) {
      const validated = validate(apiData);
      if (validated !== null) {
        return { success: true, data: validated };
      }
      return {
        success: false,
        error: "Response validation failed: unexpected data shape from server",
        nextAction: "Try refreshing the page. If the problem persists, report it.",
      };
    }

    // No validator provided — returns ApiResponse<unknown>.
    // The caller must not assume a specific data shape.
    return { success: true, data: apiData };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

async function checkAuth(): Promise<boolean> {
  const result = await request("/api/health");
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
  return request(`/api/principles/${encodeURIComponent(principleId)}`);
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

// ── Type re-exports (consumer-facing aliases) ─────────────────────────────────
// These types are imported by page components. They are defined in validators.ts
// and re-exported here under both the canonical name and the consumer-facing alias.

export type {
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

// Consumer-facing type aliases (old names that pages import)
export type { ActivationRecordData as ActivationRecord } from "./utils/validators.js";
export type { ApprovalRecordData as ApprovalRecord } from "./utils/validators.js";
export type { WorkspaceEntryData as WorkspaceEntry } from "./utils/validators.js";
export type { PrincipleListItemData as PrincipleListItem } from "./utils/validators.js";
export type { StagnationSignalData as StagnationSignal } from "./utils/validators.js";
export type { DegradedSignalData as DegradedSignal } from "./utils/validators.js";
export type { ApprovalGroupData as ApprovalGroup } from "./utils/validators.js";
export type { LifecycleAdherenceData as LifecycleAdherence } from "./utils/validators.js";
export type { LifecycleRuleMetricData as LifecycleRuleMetric } from "./utils/validators.js";
export type { RedactedRuntimeProfileSummaryData as RedactedRuntimeProfileSummary } from "./utils/validators.js";
export type { RedactedFeatureSummaryData as RedactedFeatureSummary } from "./utils/validators.js";
export type { RedactedAgentSummaryData as RedactedAgentSummary } from "./utils/validators.js";
export type { UpdateHistoryEntryData as UpdateHistoryEntry } from "./utils/validators.js";
export type { ReadinessStatus } from "./utils/validators.js";
export type { ConfigSource } from "./utils/validators.js";

// PrincipleDetail and PrincipleDetailData are deeply nested types
// used only by PrincipleDetailPage. They are not validated at the API level
// (fetchPrincipleDetail returns unknown). Define them locally for the page.
// PrincipleDetail represents the validated principle data used by PrincipleDetailPage.
// The page's own validatePrincipleDetail() handles runtime validation and
// normalizes the API response into this shape.
export interface PrincipleDetail {
  id: string;
  text: string;
  triggerPattern: string;
  action: string;
  status: string;
  priority: string;
  scope: string;
  domain: string | null;
  evaluability: string;
  valueScore: number;
  adherenceRate: number;
  painPreventedCount: number;
  ruleCount: number;
  conflictsWith: string[];
  supersedes: string[] | null;
  coreAxiom: string | null;
  createdAt: string;
  updatedAt: string;
  channels: string[];
  confidence: number | undefined;
  rules: unknown[];
  painIds: string[];
  derivedFromPainIds: string[];
  [key: string]: unknown;
}

export interface PrincipleDetailRule {
  ruleId: string;
  condition: string;
  action: string;
  scope: string;
}

export interface PrincipleDetailData {
  principle: PrincipleDetail;
}
