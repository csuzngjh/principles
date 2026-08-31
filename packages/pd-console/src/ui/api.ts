import type { ApiResponse } from "../types.js";
import type { OwnerDecisionsData, OwnerResolutionResultData } from "./utils/validators.js";
import {
  listActiveSignalKeywords,
  listPendingSignalTerms,
  fetchKeywordStore,
  fetchPendingTerms,
  updateKeywordStore,
  admitPendingTerm,
  rejectPendingTerm,
} from "./utils/signal-keywords-api.js";
import {
  validateErrorResponse,
  validateHeaders,
  validateFeedbackReport,
  validateFeedbackDraftsList,
  validateFeedbackDraftEnvelope,
  validateFeedbackChannels,
  validateFeedbackSubmitResult,
  validateDeleteEnvelope,
  validateWorkspaceEntry,
  validateWorkspaceList,
  validateRemovedEnvelope,
  validateSyncResult,
  validateConfigSummary,
  validateConfigCatalog,
  validateAgentBindingUpdate,
  validateDefaultRuntimeUpdate,
  validateRuntimeProfileMutation,
  validateReadinessCheck,
  validateFeatureFlagUpdate,
  validateOutputLanguage,
  validateGovernanceQueue,
  validateRecoveryResult,
  validateOwnerDecisionsData,
  validateOwnerResolutionResult,
  validateActivations,
  validateDisableActivation,
  validateLifecycleMetrics,
  validateUpdateStatus,
  validateUpdateHistory,
  validateApplyUpdateResult,
  validateRollbackResult,
  validateApprovalRecordDirect,
  validatePrinciplesList,
  validateApprovalsGrouped,
  validateEvidenceChain,
  validateTrajectoryData,
  validateIntentSummary,
  validateIntentDecisionList,
  validateIntentDecisionResult,
  validateIntentDecisionSummary,
  validateFollowUpResponse,
  validateIntentInitResult,
  validateIntentSaveResult,
  validateIntentRawContent,
  validateIntentVersions,
  validateOwnerGovernanceView,
  validateGovernanceExperienceSnapshot,
  validateRuleCodeOwnerReview,
  validateRuleCodeMutation,
  validateOwnerIdentityView,
  validateOwnerIdentityRegister,
  validateOwnerIdentityUnregister,
} from "./utils/validators.js";
import type { GovernanceExperienceSnapshot, OwnerGovernanceView } from '@principles/core/runtime-v2';
import type {
  OwnerIdentityViewData,
  OwnerIdentityRegisterData,
  OwnerIdentityUnregisterData,
} from "./utils/validators.js";
import type {
  FeedbackReportData,
  FeedbackDraftSummaryData,
  FeedbackDraftEnvelopeData,
  FeedbackChannelsData,
  FeedbackSubmitResultData,
  DeleteEnvelopeData,
  WorkspaceEntryData,
  RemovedEnvelopeData,
  SyncResultData,
  ConfigSummaryData,
  ConfigCatalogData,
  AgentBindingUpdateData,
  DefaultRuntimeUpdateData,
  RuntimeProfileMutationData,
  ReadinessCheckData,
  FeatureFlagUpdateData,
  OutputLanguageData,
  GovernanceQueueData,
  RecoveryResultData,
  ActivationsData,
  DisableActivationData,
  LifecycleMetricsData,
  UpdateStatusData,
  UpdateHistoryData,
  ApplyUpdateResultData,
  RollbackResultData,
  ApprovalRecordData,
  PrinciplesListData,
  ApprovalsGroupedData,
  EvidenceChainData,
  TrajectoryData,
  IntentSummaryData,
  IntentDecisionRecordData,
  IntentDecisionResultData,
  IntentDecisionSummaryData,
  FollowUpResponseData,
  IntentInitResultData,
  IntentSaveResultData,
  IntentRawContentData,
  IntentVersionData,
  RuleCodeOwnerReviewData,
  RuleCodeMutationData,
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
      let reason: string | undefined;
      try {
        const raw = await response.json();
        const parsed = validateErrorResponse(raw);
        if (parsed) {
          if (parsed.message) {
            errorMessage = parsed.message;
          } else if (parsed.error) {
            errorMessage = parsed.error;
          }
          if (parsed.reason) {
            ({ reason } = parsed);
          }
          if (parsed.nextAction) {
            ({ nextAction } = parsed);
          }
        }
      } catch {
        // ignore parse errors
      }
      return { success: false, error: errorMessage, reason, nextAction };
    }

    const raw = await response.json();
    const apiData = (raw && typeof raw === "object" && Object.hasOwn(raw, "success") && Object.hasOwn(raw, "data"))
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

async function fetchPrinciples(filter?: 'all' | 'actionable'): Promise<ApiResponse<PrinciplesListData>> {
  const query = filter && filter !== 'all' ? `?filter=${filter}` : '';
  return request<PrinciplesListData>(`/api/principles${query}`, undefined, validatePrinciplesList);
}

// Principle detail is deeply nested; for now we accept unvalidated until a
// dedicated validator is added (the page already handles missing fields gracefully).
// This endpoint is marked legacy/deferred for full validation.
async function fetchPrincipleDetail(principleId: string): Promise<ApiResponse<unknown>> {
  return request(`/api/principles/${encodeURIComponent(principleId)}`);
}

async function fetchPrincipleGovernance(principleId: string): Promise<ApiResponse<OwnerGovernanceView>> {
  return request<OwnerGovernanceView>(`/api/v1/principles/${encodeURIComponent(principleId)}/governance`, undefined, validateOwnerGovernanceView);
}

async function archivePrinciple(principleId: string): Promise<ApiResponse<unknown>> {
  return request(`/api/principles/${encodeURIComponent(principleId)}/archive`, {
    method: "POST",
  });
}

async function unarchivePrinciple(principleId: string): Promise<ApiResponse<unknown>> {
  return request(`/api/principles/${encodeURIComponent(principleId)}/unarchive`, {
    method: "POST",
  });
}

// ── Principle Trajectory ──────────────────────────────────────────────────────

async function fetchPrincipleTrajectory(principleId: string): Promise<ApiResponse<TrajectoryData>> {
  return request<TrajectoryData>(`/api/principles/${encodeURIComponent(principleId)}/trajectory`, undefined, validateTrajectoryData);
}

// ── Principle Receipts (PRI-533) ──────────────────────────────────────────────

export interface ReceiptEventData {
  kind: "rule_blocked" | "auto_correct_applied" | "self_reported" | "prompt_injected";
  level: "effect" | "presence";
  sessionId: string | null;
  toolName: string | null;
  filePath: string | null;
  digest: string | null;
  createdAt: string;
}

export interface PrincipleReceiptsData {
  status: "ok" | "degraded";
  reason?: string;
  nextAction?: string;
  principleId: string;
  effectCount: number;
  presenceCount: number;
  lastEffectAt: string | null;
  events: ReceiptEventData[];
  coverage: ReceiptEvidenceCoverageData;
}

export interface ReceiptCountEntryData {
  principleId: string;
  effectCount: number;
  presenceCount: number;
  lastEffectAt: string | null;
}

export interface ReceiptCountsData {
  status: "ok" | "degraded";
  reason?: string;
  nextAction?: string;
  counts: ReceiptCountEntryData[];
  coverage: ReceiptEvidenceCoverageData;
}

// ── Receipt evidence coverage disclosure (PRI-590) ────────────────────────────

export type ReceiptSourceStatusData = "available" | "disabled" | "unavailable";
export type ReceiptValidationStatusData = "valid" | "partial" | "malformed";

export interface ReceiptEvidenceCoverageData {
  sourceStatus: ReceiptSourceStatusData;
  validationStatus: ReceiptValidationStatusData;
  observedFrom: string | null;
  asOf: string;
  retentionPolicyDays: number;
  reasonCode?: string;
  nextActionCode?: string;
}

const RECEIPT_SOURCE_STATUSES = new Set(["available", "disabled", "unavailable"]);
const RECEIPT_VALIDATION_STATUSES = new Set(["valid", "partial", "malformed"]);

function validateReceiptCoverage(value: unknown): ReceiptEvidenceCoverageData | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.sourceStatus !== "string" || !RECEIPT_SOURCE_STATUSES.has(rec.sourceStatus)) return null;
  if (typeof rec.validationStatus !== "string" || !RECEIPT_VALIDATION_STATUSES.has(rec.validationStatus)) return null;
  if (rec.observedFrom !== null && typeof rec.observedFrom !== "string") return null;
  if (typeof rec.asOf !== "string") return null;
  if (typeof rec.retentionPolicyDays !== "number") return null;
  return {
    sourceStatus: rec.sourceStatus as ReceiptSourceStatusData,
    validationStatus: rec.validationStatus as ReceiptValidationStatusData,
    observedFrom: rec.observedFrom,
    asOf: rec.asOf,
    retentionPolicyDays: rec.retentionPolicyDays,
    ...(typeof rec.reasonCode === "string" ? { reasonCode: rec.reasonCode } : {}),
    ...(typeof rec.nextActionCode === "string" ? { nextActionCode: rec.nextActionCode } : {}),
  };
}

const RECEIPT_KINDS = new Set(["rule_blocked", "auto_correct_applied", "self_reported", "prompt_injected"]);

function validateReceiptEvent(value: unknown): ReceiptEventData | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.kind !== "string" || !RECEIPT_KINDS.has(rec.kind)) return null;
  if (rec.level !== "effect" && rec.level !== "presence") return null;
  if (typeof rec.createdAt !== "string") return null;
  const asStr = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    kind: rec.kind as ReceiptEventData["kind"],
    level: rec.level,
    sessionId: asStr(rec.sessionId),
    toolName: asStr(rec.toolName),
    filePath: asStr(rec.filePath),
    digest: asStr(rec.digest),
    createdAt: rec.createdAt,
  };
}

function validatePrincipleReceipts(data: unknown): PrincipleReceiptsData | null {
  if (typeof data !== "object" || data === null) return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.principleId !== "string") return null;
  // PRI-590: coverage is a required field of the receipt contract — a missing
  // or malformed block means server/client contract skew; reject loudly.
  const coverage = validateReceiptCoverage(rec.coverage);
  if (coverage === null) return null;
  const events: ReceiptEventData[] = [];
  if (Array.isArray(rec.events)) {
    for (const item of rec.events) {
      const event = validateReceiptEvent(item);
      if (event) events.push(event);
    }
  }
  return {
    status: rec.status === "ok" ? "ok" : "degraded",
    reason: typeof rec.reason === "string" ? rec.reason : undefined,
    nextAction: typeof rec.nextAction === "string" ? rec.nextAction : undefined,
    principleId: rec.principleId,
    effectCount: typeof rec.effectCount === "number" ? rec.effectCount : 0,
    presenceCount: typeof rec.presenceCount === "number" ? rec.presenceCount : 0,
    lastEffectAt: typeof rec.lastEffectAt === "string" ? rec.lastEffectAt : null,
    events,
    coverage,
  };
}

function validateReceiptCounts(data: unknown): ReceiptCountsData | null {
  if (typeof data !== "object" || data === null) return null;
  const rec = data as Record<string, unknown>;
  const coverage = validateReceiptCoverage(rec.coverage);
  if (coverage === null) return null;
  const counts: ReceiptCountEntryData[] = [];
  if (Array.isArray(rec.counts)) {
    for (const item of rec.counts) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.principleId !== "string") continue;
      counts.push({
        principleId: entry.principleId,
        effectCount: typeof entry.effectCount === "number" ? entry.effectCount : 0,
        presenceCount: typeof entry.presenceCount === "number" ? entry.presenceCount : 0,
        lastEffectAt: typeof entry.lastEffectAt === "string" ? entry.lastEffectAt : null,
      });
    }
  }
  return {
    status: rec.status === "ok" ? "ok" : "degraded",
    reason: typeof rec.reason === "string" ? rec.reason : undefined,
    nextAction: typeof rec.nextAction === "string" ? rec.nextAction : undefined,
    counts,
    coverage,
  };
}

async function fetchPrincipleReceipts(principleId: string): Promise<ApiResponse<PrincipleReceiptsData>> {
  return request<PrincipleReceiptsData>(`/api/v1/receipts/principles/${encodeURIComponent(principleId)}`, undefined, validatePrincipleReceipts);
}

async function fetchReceiptCounts(): Promise<ApiResponse<ReceiptCountsData>> {
  return request<ReceiptCountsData>("/api/v1/receipts/counts", undefined, validateReceiptCounts);
}

// ── Approvals ─────────────────────────────────────────────────────────────────

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

async function editApproval(
  approvalId: string,
  newArtifactId: string,
  editReason: string,
): Promise<ApiResponse<ApprovalRecordData>> {
  return request<ApprovalRecordData>('/api/v1/approvals/' + encodeURIComponent(approvalId) + '/edit', {
    method: 'POST',
    body: JSON.stringify({ newArtifactId, editReason }),
  }, validateApprovalRecordDirect);
}

// ── MVP seed feedback report drafts (PRI-285) ────────────────────────────────

async function createFeedbackReport(
  input: unknown,
  diagnostics: unknown,
): Promise<ApiResponse<FeedbackReportData>> {
  // Ensure diagnostics is always present in the serialized body — when
  // undefined, JSON.stringify drops the field entirely, leaving the server
  // with `{ input }` and no diagnostics. Coerce to `{}` so the server's
  // `obj.diagnostics ?? {}` fallback still receives an explicit object.
  // rc-9: the empty object is the explicit "no diagnostics collected" shape;
  // the server's collectDiagnostics records `unavailableReason` for each field.
  return request<FeedbackReportData>('/api/feedback/reports', {
    method: 'POST',
    body: JSON.stringify({ input, diagnostics: diagnostics ?? {} }),
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

// ── Feedback submit ladder (Slice 3, spec §8) ─────────────────────────────────

async function fetchFeedbackChannels(): Promise<ApiResponse<FeedbackChannelsData>> {
  return request<FeedbackChannelsData>('/api/feedback/submit/channels', undefined, validateFeedbackChannels);
}

async function submitFeedbackReport(
  id: string,
  channel: 'ingest' | 'github',
): Promise<ApiResponse<FeedbackSubmitResultData>> {
  return request<FeedbackSubmitResultData>('/api/feedback/reports/' + encodeURIComponent(id) + '/submit', {
    method: 'POST',
    body: JSON.stringify({ channel }),
  }, validateFeedbackSubmitResult);
}

/**
 * Manually mark a draft as sent (mailto/export channels, spec §11.4). The
 * console cannot server-confirm delivery for these channels, so this is an
 * honest user-declared status write-back — never a fake acknowledgement.
 */
async function markFeedbackReportSent(
  id: string,
  via: 'email' | 'file',
): Promise<ApiResponse<FeedbackSubmitResultData>> {
  return request<FeedbackSubmitResultData>('/api/feedback/reports/' + encodeURIComponent(id) + '/mark-sent', {
    method: 'POST',
    body: JSON.stringify({ via }),
  }, validateFeedbackSubmitResult);
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

// ── Owner identity (ADR-0022 / PRI-578) ──────────────────────────────────────

export async function fetchOwnerIdentity(): Promise<ApiResponse<OwnerIdentityViewData>> {
  return request<OwnerIdentityViewData>('/api/v1/owner-identity', undefined, validateOwnerIdentityView);
}

export async function registerOwnerIdentity(
  ownerId: string,
  credentialId: string,
): Promise<ApiResponse<OwnerIdentityRegisterData>> {
  return request<OwnerIdentityRegisterData>(
    '/api/v1/owner-identity',
    {
      method: 'POST',
      body: JSON.stringify({ ownerId, credentialId }),
    },
    validateOwnerIdentityRegister,
  );
}

export async function unregisterOwnerIdentity(): Promise<ApiResponse<OwnerIdentityUnregisterData>> {
  return request<OwnerIdentityUnregisterData>(
    '/api/v1/owner-identity',
    { method: 'DELETE' },
    validateOwnerIdentityUnregister,
  );
}

// ── Runtime Profile CRUD (POST/PATCH/DELETE /api/v1/config/profiles) ──────────

/**
 * Create a new runtime profile.
 *
 * Body shape: `{ id: string, profile: { type, provider?, model?, ... } }`.
 * Server validates per-type requirements (pi-ai needs provider/model/apiKeyEnv)
 * and returns 400 with a message on validation failure. The server response is
 * `{ profileId, profile }`; we validate the contract fields and rely on the
 * caller to re-fetch the catalog for display.
 *
 * rc-9: server-side validation errors surface as `result.error` (no silent
 * fallback) — the request() helper extracts the message from the error envelope.
 */
async function createRuntimeProfile(
  id: string,
  profile: Record<string, unknown>,
): Promise<ApiResponse<RuntimeProfileMutationData>> {
  return request<RuntimeProfileMutationData>(
    '/api/v1/config/profiles',
    {
      method: 'POST',
      body: JSON.stringify({ id, profile }),
    },
    validateRuntimeProfileMutation,
  );
}

/**
 * Update an existing runtime profile (partial patch).
 *
 * Body shape: a partial profile object (e.g. `{ model: 'new-model' }`).
 * The server rejects type changes with 400; other fields are merged.
 */
async function updateRuntimeProfile(
  profileId: string,
  patch: Record<string, unknown>,
): Promise<ApiResponse<RuntimeProfileMutationData>> {
  return request<RuntimeProfileMutationData>(
    `/api/v1/config/profiles/${encodeURIComponent(profileId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
    validateRuntimeProfileMutation,
  );
}

/**
 * Delete a runtime profile.
 *
 * The server rejects deletion with 400 when the profile is the defaultRuntime
 * or is referenced by any agent (error message lists the agent names). The
 * caller must surface this error to the user (rc-9: no silent fallback).
 */
async function deleteRuntimeProfile(
  profileId: string,
): Promise<ApiResponse<RuntimeProfileMutationData>> {
  return request<RuntimeProfileMutationData>(
    `/api/v1/config/profiles/${encodeURIComponent(profileId)}`,
    { method: 'DELETE' },
    validateRuntimeProfileMutation,
  );
}

/**
 * Fetch dynamic readiness for a single agent (GET /api/v1/config/readiness/:name).
 *
 * The summary/catalog endpoints return a static, pessimistic readiness that
 * doesn't probe the actual provider. This endpoint performs a live check
 * (e.g. testing whether the API key env var is set and the provider responds).
 *
 * Used by AgentCard when L2 is expanded and the static readiness is 'unknown'
 * — the pessimistic value is replaced with the live result. On failure the
 * caller falls back to the static value (rc-9: the error is surfaced via the
 * ApiResponse error envelope, not silently swallowed).
 */
async function fetchAgentReadiness(
  agentName: string,
): Promise<ApiResponse<ReadinessCheckData>> {
  return request<ReadinessCheckData>(
    `/api/v1/config/readiness/${encodeURIComponent(agentName)}`,
    undefined,
    validateReadinessCheck,
  );
}

// ── Feature Flag Toggle (spec 2026-06-27 §13.5) ─────────────────────────────

async function patchFeatureFlag(
  featureName: string,
  enabled: boolean,
): Promise<ApiResponse<FeatureFlagUpdateData>> {
  return request<FeatureFlagUpdateData>(
    `/api/v1/config/features/${encodeURIComponent(featureName)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    },
    validateFeatureFlagUpdate,
  );
}

// ── Principles Output Language (PRI-332 P1-1) ────────────────────────────────

async function fetchOutputLanguage(): Promise<ApiResponse<OutputLanguageData>> {
  return request<OutputLanguageData>('/api/v1/config/principles/output-language', undefined, validateOutputLanguage);
}

async function updateOutputLanguage(outputLanguage: string): Promise<ApiResponse<OutputLanguageData>> {
  return request<OutputLanguageData>(
    '/api/v1/config/principles/output-language',
    {
      method: 'PATCH',
      body: JSON.stringify({ outputLanguage }),
    },
    validateOutputLanguage,
  );
}

// ── CR8: Backend Data Contract (G.1) ─────────────────────────────────────────

async function fetchGovernanceQueue(): Promise<ApiResponse<GovernanceQueueData>> {
  return request<GovernanceQueueData>('/api/v1/governance/queue', undefined, validateGovernanceQueue);
}

// PRI-586: read-only governance experience snapshot. Only called when the
// governance_experience_v1 flag is enabled — flag-off the endpoint 403s and
// the Console keeps the legacy Focus experience (ERR-102: disabled ≠ unavailable).
async function fetchGovernanceExperience(): Promise<ApiResponse<GovernanceExperienceSnapshot>> {
  return request<GovernanceExperienceSnapshot>('/api/v1/governance/experience', undefined, validateGovernanceExperienceSnapshot);
}

// Governance Recovery Actions v1: Owner-triggered recovery of a failed /
// needs_human_review internalization task (failed→pending | needs_human_review→pending).
// force=true recovers a task whose attempt budget is exhausted (core raises
// its maxAttempts); it only affects the failed path.
async function recoverFailedTask(taskId: string, reason?: string, force?: boolean): Promise<ApiResponse<RecoveryResultData>> {
  const body: Record<string, string | boolean> = {};
  if (reason !== undefined && reason.length > 0) {
    body.reason = reason;
  }
  if (force === true) {
    body.force = true;
  }
  return request<RecoveryResultData>('/api/v1/failed-tasks/' + encodeURIComponent(taskId) + '/recover', {
    method: 'POST',
    body: JSON.stringify(body),
  }, validateRecoveryResult);
}

// PRI-629: unified Owner Decision inbox — read projection + resolution.
async function fetchOwnerDecisions(): Promise<ApiResponse<OwnerDecisionsData>> {
  return request<OwnerDecisionsData>('/api/v1/governance/owner-decisions', undefined, validateOwnerDecisionsData);
}

async function resolveOwnerDecision(taskId: string, body: {
  action: 'accept_current' | 'revise_once' | 'reject_current';
  reviewKey: string;
  expectedRevisionEpoch: number;
  expectedSourceRunId: string;
  expectedSourceArtifactId: string;
  expectedSourceArtifactHash: string;
  expectedEvidenceDigest: string;
  acknowledgement?: { kind: 'partial_evidence'; acknowledged: true };
  ownerInstruction?: string | null;
}): Promise<ApiResponse<OwnerResolutionResultData>> {
  return request<OwnerResolutionResultData>(
    '/api/v1/governance/owner-decisions/' + encodeURIComponent(taskId) + '/resolve',
    { method: 'POST', body: JSON.stringify(body) },
    validateOwnerResolutionResult,
  );
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

async function fetchRuleCodeOwnerReview(activationId: string): Promise<ApiResponse<RuleCodeOwnerReviewData>> {
  return request(`/api/v1/activations/${encodeURIComponent(activationId)}/owner-review`, undefined, validateRuleCodeOwnerReview);
}

async function mutateRuleCode(path: string, body: Record<string, unknown>): Promise<ApiResponse<RuleCodeMutationData>> {
  return request(path, { method: 'POST', body: JSON.stringify(body) }, validateRuleCodeMutation);
}

function ruleCodeDecision(activationId: string, action: 'continue-observing' | 'reject-after-shadow' | 'emergency-deactivate' | 'promote' | 'recover-to-shadow', body: Record<string, unknown>): Promise<ApiResponse<RuleCodeMutationData>> {
  return mutateRuleCode(`/api/v1/activations/${encodeURIComponent(activationId)}/${action}`, body);
}

function pauseAllRuleCode(body: Record<string, unknown>): Promise<ApiResponse<RuleCodeMutationData>> { return mutateRuleCode('/api/v1/activations/emergency-pause', body); }
function releaseRuleCodePause(pauseId: string, body: Record<string, unknown>): Promise<ApiResponse<RuleCodeMutationData>> { return mutateRuleCode(`/api/v1/activations/emergency-pause/${encodeURIComponent(pauseId)}/release`, body); }

async function fetchLifecycleMetrics(principleId: string): Promise<ApiResponse<LifecycleMetricsData>> {
  return request<LifecycleMetricsData>(`/api/v1/lifecycle/principles/${encodeURIComponent(principleId)}`, undefined, validateLifecycleMetrics);
}

// ── Updates (CR9) ─────────────────────────────────────────────────────────────

async function fetchUpdateStatus(): Promise<ApiResponse<UpdateStatusData>> {
  return request<UpdateStatusData>('/api/update/check', undefined, validateUpdateStatus);
}

async function fetchUpdateHistory(): Promise<ApiResponse<UpdateHistoryData>> {
  return request<UpdateHistoryData>('/api/update/history', undefined, validateUpdateHistory);
}

async function applyUpdate(): Promise<ApiResponse<ApplyUpdateResultData>> {
  return request<ApplyUpdateResultData>('/api/update/apply', {
    method: 'POST',
    body: JSON.stringify({ mergeStrategy: 'smart', createBackup: true }),
  }, validateApplyUpdateResult);
}

async function applyFullUpdate(): Promise<ApiResponse<ApplyUpdateResultData>> {
  return request<ApplyUpdateResultData>('/api/update/apply-full', {
    method: 'POST',
    body: JSON.stringify({}),
  }, validateApplyUpdateResult);
}

async function rollbackUpdate(backupDir: string): Promise<ApiResponse<RollbackResultData>> {
  return request<RollbackResultData>('/api/update/rollback', {
    method: 'POST',
    body: JSON.stringify({ backupDir }),
  }, validateRollbackResult);
}

// ── Evidence Chain (PRI-331) ──────────────────────────────────────────────────

async function fetchEvidenceChain(): Promise<ApiResponse<EvidenceChainData>> {
  return request<EvidenceChainData>('/api/v1/evidence-chain', undefined, validateEvidenceChain);
}


// ── Intent Summary (PRI-466) ─────────────────────────────────────────────────

async function fetchIntentSummary(lang: 'zh-CN' | 'en' = 'zh-CN'): Promise<ApiResponse<IntentSummaryData>> {
  return request<IntentSummaryData>(`/api/v1/intent?lang=${lang}`, undefined, validateIntentSummary);
}

// ── Intent Init / Edit (PRI-477 onboarding) ──────────────────────────────────

/**
 * Fetch raw INTENT.md content for editing via GET /api/v1/intent/content.
 */
async function fetchIntentContent(lang: 'zh-CN' | 'en' = 'zh-CN'): Promise<ApiResponse<IntentRawContentData>> {
  return request<IntentRawContentData>(
    `/api/v1/intent/content?lang=${lang}`,
    undefined,
    validateIntentRawContent,
  );
}

/**
 * Create INTENT.md from the SPEC §7 template via POST /api/v1/intent/init.
 * Does NOT overwrite an existing file unless force=true.
 */
async function createIntentTemplate(force = false, lang: 'zh-CN' | 'en' = 'zh-CN'): Promise<ApiResponse<IntentInitResultData>> {
  return request<IntentInitResultData>(
    `/api/v1/intent/init?lang=${lang}`,
    {
      method: 'POST',
      body: JSON.stringify({ force }),
    },
    validateIntentInitResult,
  );
}

/**
 * Save user-edited INTENT.md content via PUT /api/v1/intent/content.
 */
async function saveIntentContent(content: string, lang: 'zh-CN' | 'en' = 'zh-CN'): Promise<ApiResponse<IntentSaveResultData>> {
  return request<IntentSaveResultData>(
    `/api/v1/intent/content?lang=${lang}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    },
    validateIntentSaveResult,
  );
}

async function fetchIntentVersions(lang: 'zh-CN' | 'en' = 'zh-CN'): Promise<ApiResponse<IntentVersionData>> {
  return request<IntentVersionData>(
    `/api/v1/intent/versions?lang=${lang}`,
    undefined,
    validateIntentVersions,
  );
}

// ── Intent Decisions (PRI-470) ───────────────────────────────────────────────

/**
 * Frontend-friendly payload for recording an Owner decision on an intent tension.
 * Field names match the server's `IntentDecisionInput` contract (SPEC §21.7).
 */
export interface IntentDecisionInputPayload {
  id: string;
  taskId: string;
  source: string;
  evidenceStrength: string;
  relatedIntentFields: string[];
  evidenceRefs: string[];
  ownerAction: string;
  painId?: string;
  intentDocHash?: string;
  note?: string;
}

async function recordIntentDecision(
  payload: IntentDecisionInputPayload,
): Promise<ApiResponse<IntentDecisionResultData>> {
  return request<IntentDecisionResultData>(
    '/api/v1/intent-decisions',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    validateIntentDecisionResult,
  );
}

async function listIntentDecisionsByPainId(
  painId: string,
): Promise<ApiResponse<IntentDecisionRecordData[]>> {
  return request<IntentDecisionRecordData[]>(
    `/api/v1/intent-decisions?painId=${encodeURIComponent(painId)}`,
    undefined,
    validateIntentDecisionList,
  );
}

async function listIntentDecisionsByTaskId(
  taskId: string,
): Promise<ApiResponse<IntentDecisionRecordData[]>> {
  return request<IntentDecisionRecordData[]>(
    `/api/v1/intent-decisions?taskId=${encodeURIComponent(taskId)}`,
    undefined,
    validateIntentDecisionList,
  );
}

async function fetchIntentDecisionSummary(): Promise<ApiResponse<IntentDecisionSummaryData>> {
  return request<IntentDecisionSummaryData>(
    '/api/v1/intent-decisions/summary',
    undefined,
    validateIntentDecisionSummary,
  );
}

// ── Intent Decision Follow-up (PRI-471) ──────────────────────────────────────

/**
 * Payload for dispatching a governed follow-up action after an Owner decision
 * has been persisted (SPEC §22.1.4).
 *
 * - `link_candidate`: link an existing principle candidate to this decision.
 *   `candidateId` is required.
 * - `guide_rulehost`: get CLI guidance for promoting to RuleHost. No DB write.
 * - `generate_patch_proposal`: generate a read-only Intent Patch Proposal.
 *
 * The server validates `type` and `candidateId` (when required); the frontend
 * trusts the server to fail loud on invalid input (Rule 3).
 */
export interface FollowUpPayload {
  type: 'link_candidate' | 'guide_rulehost' | 'generate_patch_proposal';
  candidateId?: string;
}

async function dispatchFollowUp(
  decisionId: string,
  payload: FollowUpPayload,
): Promise<ApiResponse<FollowUpResponseData>> {
  return request<FollowUpResponseData>(
    `/api/v1/intent-decisions/${encodeURIComponent(decisionId)}/follow-up`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
    validateFollowUpResponse,
  );
}
// ── Exports ───────────────────────────────────────────────────────────────────

export {
  request,
  // signal-keywords (UI stubs, see signal-keywords-api.ts)
  listActiveSignalKeywords,
  listPendingSignalTerms,
  fetchKeywordStore,
  fetchPendingTerms,
  updateKeywordStore,
  admitPendingTerm,
  rejectPendingTerm,

  // auth
  getToken,
  setToken,
  clearToken,
  checkAuth,
  approveApproval,
  rejectApproval,
  editApproval,
  fetchPrinciples,
  fetchPrincipleDetail,
  fetchPrincipleGovernance,
  fetchPrincipleTrajectory,
  fetchPrincipleReceipts,
  fetchReceiptCounts,
  archivePrinciple,
  unarchivePrinciple,
  createFeedbackReport,
  listFeedbackReports,
  getFeedbackReport,
  deleteFeedbackReport,
  // Feedback submit ladder (Slice 3, spec §8)
  fetchFeedbackChannels,
  submitFeedbackReport,
  markFeedbackReportSent,
  fetchConfigSummary,
  fetchConfigCatalog,
  updateAgentBinding,
  updateDefaultRuntime,
  createRuntimeProfile,
  updateRuntimeProfile,
  deleteRuntimeProfile,
  fetchAgentReadiness,
  patchFeatureFlag,
  fetchOutputLanguage,
  updateOutputLanguage,
  fetchWorkspaces,
  addWorkspace,
  removeWorkspace,
  syncWorkspace,
  fetchGovernanceQueue,
  fetchGovernanceExperience,
  recoverFailedTask,
  fetchOwnerDecisions,
  resolveOwnerDecision,
  fetchApprovalsGrouped,
  fetchAllActivations,
  disableActivation,
  fetchRuleCodeOwnerReview,
  ruleCodeDecision,
  pauseAllRuleCode,
  releaseRuleCodePause,
  fetchLifecycleMetrics,
  fetchUpdateStatus,
  fetchUpdateHistory,
  applyUpdate,
  applyFullUpdate,
  rollbackUpdate,
  fetchEvidenceChain,
  fetchIntentSummary,
  fetchIntentContent,
  createIntentTemplate,
  saveIntentContent,
  fetchIntentVersions,
  recordIntentDecision,
  listIntentDecisionsByPainId,
  listIntentDecisionsByTaskId,
  fetchIntentDecisionSummary,
  dispatchFollowUp,
};

// ── Type re-exports (consumer-facing aliases) ─────────────────────────────────
// These types are imported by page components. They are defined in validators.ts
// and re-exported here under both the canonical name and the consumer-facing alias.

export type {
  FeedbackReportData,
  FeedbackDraftSummaryData,
  FeedbackDraftEnvelopeData,
  FeedbackChannelsData,
  FeedbackSubmitResultData,
  DeleteEnvelopeData,
  WorkspaceEntryData,
  RemovedEnvelopeData,
  SyncResultData,
  ConfigSummaryData,
  ConfigCatalogData,
  AgentBindingUpdateData,
  DefaultRuntimeUpdateData,
  RuntimeProfileMutationData,
  ReadinessCheckData,
  FeatureFlagUpdateData,
  OutputLanguageData,
  GovernanceQueueData,
  RecoveryResultData,
  ActivationsData,
  DisableActivationData,
  RuleCodeOwnerReviewData,
  RuleCodeMutationData,
  LifecycleMetricsData,
  UpdateStatusData,
  UpdateHistoryData,
  ApplyUpdateResultData,
  RollbackResultData,
  ApprovalRecordData,
  PrinciplesListData,
  ApprovalsGroupedData,
  EvidenceChainData,
  EvidenceChainRecordData,
  EvidenceChainStateData,
  TrajectoryData,
  TrajectoryStageData,
  IntentSummaryData,
  IntentSectionsData,
  IntentDocWarningData,
  IntentDecisionRecordData,
  IntentDecisionResultData,
  IntentDecisionSummaryData,
  FollowUpResponseData,
  LinkCandidateFollowUpData,
  GuideRulehostFollowUpData,
  GeneratePatchProposalFollowUpData,
  IntentVersionEntry,
  IntentVersionData,
} from "./utils/validators.js";

// Consumer-facing type aliases (old names that pages import)
export type { SignalKeyword, PendingSignalTerm } from "./utils/signal-keywords-types.js";
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
export type { OwnerIdentityViewData, OwnerIdentityRegisterData, OwnerIdentityUnregisterData } from "./utils/validators.js";
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
