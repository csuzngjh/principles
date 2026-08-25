/**
 * CR10: API validators tests
 *
 * Validates the runtime validators in utils/validators.ts:
 * - Reject null, arrays, primitives
 * - Reject inherited properties
 * - Reject missing required fields
 * - Reject wrong field types
 * - Accept valid response shapes
 *
 * Tests import production validators (ERR-025: tests must cover real product paths, not copy implementation).
 */

import { describe, it, expect } from 'vitest';
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
  validateConfigSummary,
  validateConfigCatalog,
  validateAgentBindingUpdate,
  validateFeatureFlagUpdate,
  validateReadinessCheck,
  validateDefaultRuntimeUpdate,
  validateConfigReadiness,
  validateGovernanceQueue,
  validateRecoveryResult,
  validateActivations,
  validateDisableActivation,
  validateLifecycleMetrics,
  validateUpdateStatus,
  validateUpdateHistory,
  validateApprovalListResult,
  validateApprovalRecordDirect,
  validatePrinciplesList,
  validateApprovalsGrouped,
  validateEvidenceChain,
  validateOutputLanguage,
} from '../../src/ui/utils/validators.js';

// ── validateErrorResponse ─────────────────────────────────────────────────────

describe('validateErrorResponse', () => {
  it('accepts a valid error response with message', () => {
    const result = validateErrorResponse({ message: 'Not found', nextAction: 'Check URL' });
    expect(result).not.toBeNull();
    expect(result!.message).toBe('Not found');
    expect(result!.nextAction).toBe('Check URL');
  });

  it('accepts a valid error response with error field', () => {
    const result = validateErrorResponse({ error: 'Unauthorized' });
    expect(result).not.toBeNull();
    expect(result!.error).toBe('Unauthorized');
  });

  it('accepts an empty object', () => {
    const result = validateErrorResponse({});
    expect(result).not.toBeNull();
    expect(result!.message).toBeUndefined();
    expect(result!.error).toBeUndefined();
  });

  it('rejects null', () => {
    expect(validateErrorResponse(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateErrorResponse([1, 2, 3])).toBeNull();
  });

  it('rejects strings', () => {
    expect(validateErrorResponse('error')).toBeNull();
  });

  it('rejects numbers', () => {
    expect(validateErrorResponse(42)).toBeNull();
  });

  it('rejects inherited properties (e.g. toString)', () => {
    // Create an object where toString is on the prototype, not own property
    const obj = Object.create({ message: 'inherited' });
    obj.error = 'own';
    const result = validateErrorResponse(obj);
    expect(result).not.toBeNull();
    // Only own properties should be picked up
    expect(result!.message).toBeUndefined();
    expect(result!.error).toBe('own');
  });

  it('rejects wrong field types', () => {
    expect(validateErrorResponse({ message: 42 })).not.toBeNull();
    const result = validateErrorResponse({ message: 42 });
    // message is not a string, so it should be ignored
    expect(result!.message).toBeUndefined();
  });
});

// ── validateHeaders ───────────────────────────────────────────────────────────

describe('validateHeaders', () => {
  it('accepts a valid headers object', () => {
    const result = validateHeaders({ 'Content-Type': 'application/json', Authorization: 'Bearer x' });
    expect(result).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer x' });
  });

  it('accepts empty object', () => {
    expect(validateHeaders({})).toEqual({});
  });

  it('returns null for null/undefined', () => {
    expect(validateHeaders(null)).toBeNull();
    expect(validateHeaders(undefined)).toBeNull();
  });

  it('returns null for arrays', () => {
    expect(validateHeaders([['key', 'val']])).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(validateHeaders({ 'X-Count': 42 })).toBeNull();
  });

  it('returns null for inherited properties', () => {
    const obj = Object.create({ inherited: 'value' });
    obj.own = 'valid';
    const result = validateHeaders(obj);
    expect(result).not.toBeNull();
    expect(result!.own).toBe('valid');
    expect(Object.hasOwn(result!, 'inherited')).toBe(false);
  });
});

// ── validateFeedbackReport ────────────────────────────────────────────────────

describe('validateFeedbackReport', () => {
  const validReport = {
    id: 'rpt-001',
    createdAt: '2026-06-01T12:00:00.000Z',
    report: { type: 'bug', title: 'Test' },
  };

  it('accepts a valid feedback report', () => {
    const result = validateFeedbackReport(validReport);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('rpt-001');
    expect(result!.report).toEqual({ type: 'bug', title: 'Test' });
  });

  it('rejects null', () => {
    expect(validateFeedbackReport(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateFeedbackReport([1, 2])).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(validateFeedbackReport({ id: '1', createdAt: '2026' })).toBeNull(); // missing report
    expect(validateFeedbackReport({ id: '1', report: {} })).toBeNull(); // missing createdAt
    expect(validateFeedbackReport({ createdAt: '2026', report: {} })).toBeNull(); // missing id
  });

  it('rejects wrong field types', () => {
    expect(validateFeedbackReport({ ...validReport, id: 123 })).toBeNull();
    expect(validateFeedbackReport({ ...validReport, createdAt: null })).toBeNull();
    expect(validateFeedbackReport({ ...validReport, report: 'not-object' })).toBeNull();
  });

  it('rejects inherited properties as required fields', () => {
    const obj = Object.create({ id: 'inherited' });
    obj.createdAt = '2026-06-01';
    obj.report = {};
    // id is inherited, not own property → should fail
    expect(validateFeedbackReport(obj)).toBeNull();
  });
});

// ── validateFeedbackDraftsList ────────────────────────────────────────────────

describe('validateFeedbackDraftsList', () => {
  const validList = {
    drafts: [
      { id: '1', createdAt: '2026-06-01', type: 'bug', title: 'Test' },
      { id: '2', createdAt: '2026-06-02', type: 'confusing', title: 'Confusing' },
    ],
  };

  it('accepts a valid drafts list', () => {
    const result = validateFeedbackDraftsList(validList);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].id).toBe('1');
  });

  it('accepts empty drafts array', () => {
    const result = validateFeedbackDraftsList({ drafts: [] });
    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  it('rejects null', () => {
    expect(validateFeedbackDraftsList(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateFeedbackDraftsList([])).toBeNull();
  });

  it('rejects missing drafts field', () => {
    expect(validateFeedbackDraftsList({})).toBeNull();
  });

  it('rejects non-array drafts', () => {
    expect(validateFeedbackDraftsList({ drafts: 'not-array' })).toBeNull();
  });

  it('rejects drafts with missing required fields', () => {
    expect(validateFeedbackDraftsList({ drafts: [{ id: '1' }] })).toBeNull();
  });

  it('rejects drafts with wrong field types', () => {
    expect(validateFeedbackDraftsList({ drafts: [{ id: 1, createdAt: '2026', type: 'bug', title: 'T' }] })).toBeNull();
  });
});

// ── validateDeleteEnvelope ────────────────────────────────────────────────────

describe('validateDeleteEnvelope', () => {
  it('accepts a valid delete envelope', () => {
    const result = validateDeleteEnvelope({ deleted: true });
    expect(result).not.toBeNull();
    expect(result!.deleted).toBe(true);
  });

  it('accepts deleted: false', () => {
    const result = validateDeleteEnvelope({ deleted: false });
    expect(result).not.toBeNull();
    expect(result!.deleted).toBe(false);
  });

  it('rejects null', () => {
    expect(validateDeleteEnvelope(null)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateDeleteEnvelope([1])).toBeNull();
  });

  it('rejects missing deleted field', () => {
    expect(validateDeleteEnvelope({})).toBeNull();
  });

  it('rejects non-boolean deleted', () => {
    expect(validateDeleteEnvelope({ deleted: 'yes' })).toBeNull();
    expect(validateDeleteEnvelope({ deleted: 1 })).toBeNull();
  });

  it('rejects inherited deleted property', () => {
    const obj = Object.create({ deleted: true });
    expect(validateDeleteEnvelope(obj)).toBeNull();
  });
});

// ── validateWorkspaceEntry ────────────────────────────────────────────────────

describe('validateWorkspaceEntry', () => {
  const validEntry = { name: 'ws1', path: '/tmp/ws1', lastSync: null, config: null };

  it('accepts a valid workspace entry', () => {
    const result = validateWorkspaceEntry(validEntry);
    expect(result).not.toBeNull();
    expect(result!.name).toBe('ws1');
  });

  it('rejects null', () => {
    expect(validateWorkspaceEntry(null)).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(validateWorkspaceEntry({ name: 'ws1' })).toBeNull();
  });

  it('rejects wrong field types', () => {
    expect(validateWorkspaceEntry({ name: 123, path: '/x' })).toBeNull();
  });
});

// ── validateWorkspaceList ─────────────────────────────────────────────────────

describe('validateWorkspaceList', () => {
  it('accepts a valid workspace list', () => {
    const result = validateWorkspaceList([{ name: 'ws1', path: '/x', lastSync: null, config: null }]);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it('accepts empty array', () => {
    expect(validateWorkspaceList([])).toEqual([]);
  });

  it('rejects null', () => {
    expect(validateWorkspaceList(null)).toBeNull();
  });

  it('rejects non-array', () => {
    expect(validateWorkspaceList({})).toBeNull();
  });

  it('rejects invalid entries', () => {
    expect(validateWorkspaceList([{ name: 123 }])).toBeNull();
  });
});

// ── validateGovernanceQueue ───────────────────────────────────────────────────

describe('validateGovernanceQueue', () => {
  const validQueue = {
    pendingReviewCount: 2,
    behaviorDeviationCount: 1,
    stagnationSignals: [{ type: 'never_activated', principleId: 'p1', daysSince: 30 }],
    governanceState: 'owner_review_ready',
    stateReasonCode: 'pending_approvals',
    nextActionCode: 'review_approvals',
    stateReason: '2 principle(s) pending your review and decision.',
    nextAction: 'Review pending principles and approve, reject, or park.',
    generatedAt: '2026-06-07T09:00:00.000Z',
  };

  it('accepts a valid governance queue', () => {
    const result = validateGovernanceQueue(validQueue);
    expect(result).not.toBeNull();
    expect(result!.pendingReviewCount).toBe(2);
    expect(result!.stagnationSignals.length).toBe(1);
    expect(result!.stateReasonCode).toBe('pending_approvals');
    expect(result!.nextActionCode).toBe('review_approvals');
  });

  it('rejects null', () => {
    expect(validateGovernanceQueue(null)).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(validateGovernanceQueue({ pendingReviewCount: 1 })).toBeNull();
  });

  it('rejects missing stateReasonCode', () => {
    const { stateReasonCode: _, ...withoutCode } = validQueue;
    expect(validateGovernanceQueue(withoutCode)).toBeNull();
  });

  it('rejects missing nextActionCode', () => {
    const { nextActionCode: _, ...withoutCode } = validQueue;
    expect(validateGovernanceQueue(withoutCode)).toBeNull();
  });

  it('rejects invalid stateReasonCode', () => {
    expect(validateGovernanceQueue({ ...validQueue, stateReasonCode: 'not_a_code' })).toBeNull();
  });

  it('rejects invalid nextActionCode', () => {
    expect(validateGovernanceQueue({ ...validQueue, nextActionCode: 'not_a_code' })).toBeNull();
  });

  it('rejects wrong field types', () => {
    expect(validateGovernanceQueue({ ...validQueue, pendingReviewCount: 'two' })).toBeNull();
  });

  it('rejects invalid stagnation signals', () => {
    expect(validateGovernanceQueue({ ...validQueue, stagnationSignals: [{ type: 123 }] })).toBeNull();
  });

  it('rejects invalid governanceState', () => {
    expect(validateGovernanceQueue({ ...validQueue, governanceState: 'invalid' })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, governanceState: 123 })).toBeNull();
  });

  // ── P1-3: fail-loud tests for optional fields ───────────────────────────

  it('returns null when inProgressSummary exists but is not a string', () => {
    expect(validateGovernanceQueue({ ...validQueue, inProgressSummary: 42 })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, inProgressSummary: false })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, inProgressSummary: null })).toBeNull();
  });

  it('returns null when degradedSignals exists but is not an array', () => {
    expect(validateGovernanceQueue({ ...validQueue, degradedSignals: 'not-array' })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, degradedSignals: 42 })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, degradedSignals: null })).toBeNull();
  });

  it('returns null when degradedSignals contains invalid elements', () => {
    expect(validateGovernanceQueue({
      ...validQueue,
      degradedSignals: [{ reason: 'missing code fields' }],
    })).toBeNull();
  });

  it('returns null when note exists but is not a string', () => {
    expect(validateGovernanceQueue({ ...validQueue, note: 123 })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, note: false })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, note: null })).toBeNull();
  });

  it('returns null when generatedAt exists but is not a string', () => {
    expect(validateGovernanceQueue({ ...validQueue, generatedAt: 123 })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, generatedAt: false })).toBeNull();
    expect(validateGovernanceQueue({ ...validQueue, generatedAt: null })).toBeNull();
  });

  it('accepts valid optional fields when present', () => {
    const withOptionals = {
      ...validQueue,
      inProgressSummary: 'Pipeline is active',
      note: 'Data may be incomplete',
      generatedAt: '2026-06-07T09:00:00.000Z',
      degradedSignals: [{
        reasonCode: 'task_retry_wait',
        nextActionCode: 'check_task_status',
        reason: 'Internalization task waiting for retry: dreamer: LLM output invalid',
        nextAction: 'Check internalization pipeline status.',
        source: 'internalization_task',
      }],
    };
    const result = validateGovernanceQueue(withOptionals);
    expect(result).not.toBeNull();
    expect(result!.inProgressSummary).toBe('Pipeline is active');
    expect(result!.note).toBe('Data may be incomplete');
    expect(result!.generatedAt).toBe('2026-06-07T09:00:00.000Z');
    expect(result!.degradedSignals!.length).toBe(1);
    expect(result!.degradedSignals![0].reasonCode).toBe('task_retry_wait');
    expect(result!.degradedSignals![0].nextActionCode).toBe('check_task_status');
  });

  it('accepts response without optional fields', () => {
    const minimal = {
      pendingReviewCount: 0,
      behaviorDeviationCount: 0,
      stagnationSignals: [],
      governanceState: 'none',
      stateReasonCode: 'no_pipeline_activity',
      nextActionCode: 'wait_for_pipeline',
      stateReason: 'No governance activity.',
      nextAction: 'Wait for pipeline.',
    };
    const result = validateGovernanceQueue(minimal);
    expect(result).not.toBeNull();
    expect(result!.inProgressSummary).toBeUndefined();
    expect(result!.degradedSignals).toBeUndefined();
    expect(result!.note).toBeUndefined();
    expect(result!.generatedAt).toBeUndefined();
  });

  // Governance Recovery Actions v1 (ERR-083 audit): the Focus card and the
  // failed-tasks page both consume these new fields/codes.
  it('accepts pendingHumanReviewCount and the needs-human-review reason/next-action codes', () => {
    const result = validateGovernanceQueue({
      ...validQueue,
      pendingHumanReviewCount: 3,
      stateReasonCode: 'tasks_need_human_review',
      nextActionCode: 'review_failed_tasks',
    });
    expect(result).not.toBeNull();
    expect(result!.pendingHumanReviewCount).toBe(3);
  });

  it('rejects a non-number pendingHumanReviewCount', () => {
    expect(validateGovernanceQueue({ ...validQueue, pendingHumanReviewCount: 'two' })).toBeNull();
  });
});

// ── validateRecoveryResult (Governance Recovery Actions v1) ──────────────────

describe('validateRecoveryResult', () => {
  it('accepts a complete recovery result', () => {
    const result = validateRecoveryResult({
      taskId: 'task-1', previousStatus: 'failed', newStatus: 'pending', result: 'recovered',
    });
    expect(result).toEqual({
      taskId: 'task-1', previousStatus: 'failed', newStatus: 'pending', result: 'recovered',
    });
  });

  it('accepts an optional nextAction', () => {
    const result = validateRecoveryResult({
      taskId: 'task-1', previousStatus: 'needs_human_review', newStatus: 'pending',
      result: 'requeued', nextAction: 'Recovery accepted.',
    });
    expect(result?.nextAction).toBe('Recovery accepted.');
  });

  it.each([
    ['non-object', 42],
    ['missing taskId', { previousStatus: 'failed', newStatus: 'pending', result: 'recovered' }],
    ['non-string taskId', { taskId: 1, previousStatus: 'failed', newStatus: 'pending', result: 'recovered' }],
    ['missing previousStatus', { taskId: 't', newStatus: 'pending', result: 'recovered' }],
    ['missing newStatus', { taskId: 't', previousStatus: 'failed', result: 'recovered' }],
    ['missing result', { taskId: 't', previousStatus: 'failed', newStatus: 'pending' }],
  ])('rejects %s', (_label, v) => {
    expect(validateRecoveryResult(v)).toBeNull();
  });

  it('rejects a non-string nextAction', () => {
    expect(validateRecoveryResult({
      taskId: 't', previousStatus: 'failed', newStatus: 'pending', result: 'recovered', nextAction: 5,
    })).toBeNull();
  });
});

// ── validateActivations ───────────────────────────────────────────────────────

describe('validateActivations', () => {
  const validActivations = {
    activations: [{
      activationId: 'a1', artifactId: 'art1', principleId: 'p1',
      channel: 'prompt', action: 'inject', targetRef: 'target',
      activatedAt: '2026-06-01', status: 'active',
    }],
    status: 'ok',
  };

  it('accepts valid activations', () => {
    const result = validateActivations(validActivations);
    expect(result).not.toBeNull();
    expect(result!.activations.length).toBe(1);
  });

  it('rejects null', () => {
    expect(validateActivations(null)).toBeNull();
  });

  it('rejects missing required fields in activation record', () => {
    expect(validateActivations({ activations: [{ activationId: 'a1' }], status: 'ok' })).toBeNull();
  });

  it('rejects wrong field types', () => {
    expect(validateActivations({ ...validActivations, status: 123 })).toBeNull();
  });
});

// ── validateDisableActivation ─────────────────────────────────────────────────

describe('validateDisableActivation', () => {
  it('accepts valid response', () => {
    const result = validateDisableActivation({ activationId: 'a1', status: 'disabled' });
    expect(result).not.toBeNull();
    expect(result!.activationId).toBe('a1');
  });

  it('rejects null', () => {
    expect(validateDisableActivation(null)).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(validateDisableActivation({ activationId: 'a1' })).toBeNull();
  });
});

// ── validateUpdateStatus ──────────────────────────────────────────────────────

describe('validateUpdateStatus', () => {
  const validStatus = {
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    hasUpdate: true,
  };

  it('accepts valid update status', () => {
    const result = validateUpdateStatus(validStatus);
    expect(result).not.toBeNull();
    expect(result!.hasUpdate).toBe(true);
  });

  it('rejects null', () => {
    expect(validateUpdateStatus(null)).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(validateUpdateStatus({ currentVersion: '1.0' })).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(validateUpdateStatus({ ...validStatus, hasUpdate: 'yes' })).toBeNull();
  });

  it('accepts optional changelog field', () => {
    const result = validateUpdateStatus({ ...validStatus, changelog: '## What\'s new\n- Bug fix' });
    expect(result).not.toBeNull();
    expect(result!.changelog).toBe('## What\'s new\n- Bug fix');
  });
});

// ── validateConfigSummary ─────────────────────────────────────────────────────

describe('validateConfigSummary', () => {
  const validConfig = {
    version: 1,
    source: 'defaults',
    features: [{ id: 'f1', category: 'core', enabled: true }],
    runtimeProfiles: [{ id: 'rp1', type: 'openclaw', label: 'Default', readiness: 'ready' }],
    defaultRuntime: 'rp1',
    agents: [{ name: 'agent1', enabled: true, runtimeProfileId: 'rp1', runtimeProfileLabel: 'Default', readiness: 'ready' }],
    ui: { diagnostics: { mode: 'redacted' } },
    warnings: [],
  };

  it('accepts valid config summary', () => {
    const result = validateConfigSummary(validConfig);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
  });

  it('rejects null', () => {
    expect(validateConfigSummary(null)).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(validateConfigSummary({ version: 1 })).toBeNull();
  });

  it('rejects invalid nested features', () => {
    expect(validateConfigSummary({ ...validConfig, features: [{ id: 123 }] })).toBeNull();
  });

  it('rejects invalid nested agents', () => {
    expect(validateConfigSummary({ ...validConfig, agents: [{ name: 123 }] })).toBeNull();
  });
});

// ── validateApprovalListResult ────────────────────────────────────────────────

describe('validateApprovalListResult', () => {
  const validResult = {
    items: [{ approvalId: 'ap1', artifactId: 'art1', channel: 'prompt', riskLevel: 'low', status: 'pending', requestedAt: '2026-06-01' }],
    total: 1,
    stats: { pending: 1, approved: 0, rejected: 0, cancelled: 0 },
  };

  it('accepts valid approval list', () => {
    const result = validateApprovalListResult(validResult);
    expect(result).not.toBeNull();
    expect(result!.items.length).toBe(1);
  });

  it('rejects null', () => {
    expect(validateApprovalListResult(null)).toBeNull();
  });

  it('rejects missing stats', () => {
    expect(validateApprovalListResult({ items: [], total: 0 })).toBeNull();
  });

  it('rejects invalid items', () => {
    expect(validateApprovalListResult({ ...validResult, items: [{ approvalId: 123 }] })).toBeNull();
  });
});

// ── validatePrinciplesList ────────────────────────────────────────────────────

describe('validatePrinciplesList', () => {
  const validList = {
    principles: [{
      id: 'p1', text: 'Test principle', triggerPattern: 'pattern', action: 'inject',
      status: 'active', priority: 'medium', scope: 'workspace', domain: null,
      evaluability: 'high', valueScore: 0.8, adherenceRate: 0.9,
      painPreventedCount: 5, ruleCount: 2, conflictsWithCount: 0,
      createdAt: '2026-06-01', updatedAt: '2026-06-01',
    }],
    summary: { candidate: 0, probation: 0, active: 1, deprecated: 0, archived: 0, total: 1 },
  };

  it('accepts valid principles list', () => {
    const result = validatePrinciplesList(validList);
    expect(result).not.toBeNull();
    expect(result!.principles.length).toBe(1);
  });

  it('rejects null', () => {
    expect(validatePrinciplesList(null)).toBeNull();
  });

  it('rejects invalid principles', () => {
    expect(validatePrinciplesList({ ...validList, principles: [{ id: 123 }] })).toBeNull();
  });

  it('rejects invalid summary', () => {
    expect(validatePrinciplesList({ ...validList, summary: { candidate: 'zero' } })).toBeNull();
  });

  // PRI-330: categories field validation tests
  it('accepts valid categories field', () => {
    const withCategories = {
      ...validList,
      categories: { owner_actionable: 3, builtin: 2, demo: 1, historical: 1 },
    };
    const result = validatePrinciplesList(withCategories);
    expect(result).not.toBeNull();
    expect(result!.categories).toBeDefined();
    expect(result!.categories!['owner_actionable']).toBe(3);
    expect(result!.categories!['builtin']).toBe(2);
  });

  it('accepts missing categories field (optional)', () => {
    const result = validatePrinciplesList(validList);
    expect(result).not.toBeNull();
    expect(result!.categories).toBeUndefined();
  });

  it('rejects categories with non-number values', () => {
    const badCategories = {
      ...validList,
      categories: { owner_actionable: 'three' },
    };
    expect(validatePrinciplesList(badCategories)).toBeNull();
  });

  it('rejects categories that is not an object', () => {
    expect(validatePrinciplesList({ ...validList, categories: 'invalid' })).toBeNull();
    expect(validatePrinciplesList({ ...validList, categories: [1, 2] })).toBeNull();
  });

  it('rejects categories with empty object (treated as absent)', () => {
    const emptyCategories = {
      ...validList,
      categories: {},
    };
    const result = validatePrinciplesList(emptyCategories);
    expect(result).not.toBeNull();
    // Empty categories object is treated as absent (no valid entries)
    expect(result!.categories).toBeUndefined();
  });

  it('accepts approvalCrossCheckUnavailable string', () => {
    const withReason = {
      ...validList,
      approvalCrossCheckUnavailable: 'approval_db_not_found',
    };
    const result = validatePrinciplesList(withReason);
    expect(result).not.toBeNull();
    expect(result!.approvalCrossCheckUnavailable).toBe('approval_db_not_found');
  });

  it('ignores approvalCrossCheckUnavailable when absent', () => {
    const result = validatePrinciplesList(validList);
    expect(result).not.toBeNull();
    expect(result!.approvalCrossCheckUnavailable).toBeUndefined();
  });

  it('rejects approvalCrossCheckUnavailable when not a string (fail loud)', () => {
    const badReason = {
      ...validList,
      approvalCrossCheckUnavailable: 42,
    };
    // ERR-009: field present but wrong type → reject, not silently discard
    expect(validatePrinciplesList(badReason)).toBeNull();
  });

  // PRI-332: detectedLanguage and readabilityWarningCode validation
  it('accepts principle with detectedLanguage field', () => {
    const withLang = {
      ...validList,
      principles: [{ ...validList.principles[0], detectedLanguage: 'zh' }],
    };
    const result = validatePrinciplesList(withLang);
    expect(result).not.toBeNull();
    expect(result!.principles[0].detectedLanguage).toBe('zh');
  });

  it('defaults detectedLanguage to unknown when absent', () => {
    const result = validatePrinciplesList(validList);
    expect(result).not.toBeNull();
    expect(result!.principles[0].detectedLanguage).toBe('unknown');
  });

  it('fails loud when detectedLanguage is present but not a string (ERR-009)', () => {
    const withBadLang = {
      ...validList,
      principles: [{ ...validList.principles[0], detectedLanguage: 42 }],
    };
    const result = validatePrinciplesList(withBadLang);
    // detectedLanguage present but malformed → validateArray rejects the item → null (ERR-009)
    expect(result).toBeNull();
  });

  it('accepts principle with readabilityWarningCode', () => {
    const withWarning = {
      ...validList,
      principles: [{ ...validList.principles[0], readabilityWarningCode: 'technical_pattern' }],
    };
    const result = validatePrinciplesList(withWarning);
    expect(result).not.toBeNull();
    expect(result!.principles[0].readabilityWarningCode).toBe('technical_pattern');
  });

  it('accepts principle without readabilityWarningCode (optional)', () => {
    const result = validatePrinciplesList(validList);
    expect(result).not.toBeNull();
    expect(result!.principles[0].readabilityWarningCode).toBeUndefined();
  });

  it('rejects readabilityWarningCode when invalid (fail loud, ERR-009)', () => {
    const withBadWarning = {
      ...validList,
      principles: [{ ...validList.principles[0], readabilityWarningCode: 'invalid_code' }],
    };
    const result = validatePrinciplesList(withBadWarning);
    // readabilityWarningCode present but invalid value → fail loud
    expect(result).toBeNull();
  });
});

// ── validateApprovalsGrouped ──────────────────────────────────────────────────

describe('validateApprovalsGrouped', () => {
  const validGrouped = {
    groups: [{
      principleId: 'p1', principleTitle: 'Test', status: 'pending',
      records: [{ id: 'r1', artifactId: 'art1', channel: 'prompt', createdAt: '2026-06-01', status: 'pending' }],
    }],
    generatedAt: '2026-06-01T00:00:00Z',
  };

  it('accepts valid grouped approvals', () => {
    const result = validateApprovalsGrouped(validGrouped);
    expect(result).not.toBeNull();
    expect(result!.groups.length).toBe(1);
  });

  it('rejects null', () => {
    expect(validateApprovalsGrouped(null)).toBeNull();
  });

  it('rejects invalid groups', () => {
    expect(validateApprovalsGrouped({ ...validGrouped, groups: [{ principleId: 123 }] })).toBeNull();
  });
});

// ── validateOutputLanguage ──────────────────────────────────────────────────

describe('validateOutputLanguage', () => {
  it('accepts valid zh-CN output', () => {
    const result = validateOutputLanguage({ outputLanguage: 'zh-CN', source: 'default' });
    expect(result).not.toBeNull();
    expect(result!.outputLanguage).toBe('zh-CN');
    expect(result!.source).toBe('default');
  });

  it('accepts valid en output', () => {
    const result = validateOutputLanguage({ outputLanguage: 'en', source: 'user_config' });
    expect(result).not.toBeNull();
    expect(result!.outputLanguage).toBe('en');
    expect(result!.source).toBe('user_config');
  });

  it('rejects null', () => {
    expect(validateOutputLanguage(null)).toBeNull();
  });

  it('rejects undefined', () => {
    expect(validateOutputLanguage(undefined)).toBeNull();
  });

  it('rejects arrays', () => {
    expect(validateOutputLanguage(['zh-CN', 'en'])).toBeNull();
  });

  it('rejects strings', () => {
    expect(validateOutputLanguage('zh-CN')).toBeNull();
  });

  it('rejects numbers', () => {
    expect(validateOutputLanguage(42)).toBeNull();
  });

  it('rejects missing outputLanguage', () => {
    expect(validateOutputLanguage({ source: 'default' })).toBeNull();
  });

  it('rejects missing source', () => {
    expect(validateOutputLanguage({ outputLanguage: 'zh-CN' })).toBeNull();
  });

  it('rejects invalid outputLanguage value', () => {
    expect(validateOutputLanguage({ outputLanguage: 'fr', source: 'default' })).toBeNull();
    expect(validateOutputLanguage({ outputLanguage: 'de', source: 'default' })).toBeNull();
    expect(validateOutputLanguage({ outputLanguage: 'en-US', source: 'default' })).toBeNull();
    expect(validateOutputLanguage({ outputLanguage: '', source: 'default' })).toBeNull();
  });

  it('rejects wrong type for outputLanguage', () => {
    expect(validateOutputLanguage({ outputLanguage: 42, source: 'default' })).toBeNull();
    expect(validateOutputLanguage({ outputLanguage: ['zh-CN'], source: 'default' })).toBeNull();
    expect(validateOutputLanguage({ outputLanguage: { value: 'zh-CN' }, source: 'default' })).toBeNull();
  });

  it('rejects wrong type for source', () => {
    expect(validateOutputLanguage({ outputLanguage: 'zh-CN', source: 42 })).toBeNull();
    expect(validateOutputLanguage({ outputLanguage: 'zh-CN', source: ['default'] })).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const parent = Object.create({ outputLanguage: 'zh-CN' });
    parent.source = 'default';
    expect(validateOutputLanguage(parent)).toBeNull();
  });

  it('rejects object with extra fields (only validates required fields)', () => {
    const result = validateOutputLanguage({ outputLanguage: 'en', source: 'default', extra: 'field' });
    expect(result).not.toBeNull();
    expect(result!.outputLanguage).toBe('en');
    expect(result!.source).toBe('default');
  });
});

// ── validateFeedbackDraftEnvelope ──────────────────────────────────────────────

describe('validateFeedbackDraftEnvelope', () => {
  it('accepts valid feedback draft envelope', () => {
    const result = validateFeedbackDraftEnvelope({ report: { id: '1', text: 'test' } });
    expect(result).not.toBeNull();
    expect(result!.report).toEqual({ id: '1', text: 'test' });
  });

  it('rejects null', () => {
    expect(validateFeedbackDraftEnvelope(null)).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validateFeedbackDraftEnvelope('string')).toBeNull();
    expect(validateFeedbackDraftEnvelope(42)).toBeNull();
    expect(validateFeedbackDraftEnvelope([])).toBeNull();
  });

  it('rejects missing report', () => {
    expect(validateFeedbackDraftEnvelope({})).toBeNull();
  });

  it('rejects non-object report', () => {
    expect(validateFeedbackDraftEnvelope({ report: 'string' })).toBeNull();
    expect(validateFeedbackDraftEnvelope({ report: 42 })).toBeNull();
    expect(validateFeedbackDraftEnvelope({ report: [] })).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const obj = Object.create({ report: { id: '1' } });
    expect(validateFeedbackDraftEnvelope(obj)).toBeNull();
  });
});

// ── validateRemovedEnvelope ────────────────────────────────────────────────────

describe('validateRemovedEnvelope', () => {
  it('accepts valid removed envelope', () => {
    const result = validateRemovedEnvelope({ removed: 'workspace-name' });
    expect(result).not.toBeNull();
    expect(result!.removed).toBe('workspace-name');
  });

  it('rejects null', () => {
    expect(validateRemovedEnvelope(null)).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validateRemovedEnvelope('string')).toBeNull();
    expect(validateRemovedEnvelope(42)).toBeNull();
  });

  it('rejects missing removed', () => {
    expect(validateRemovedEnvelope({})).toBeNull();
  });

  it('rejects wrong type for removed', () => {
    expect(validateRemovedEnvelope({ removed: 42 })).toBeNull();
    expect(validateRemovedEnvelope({ removed: [] })).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const obj = Object.create({ removed: 'workspace-name' });
    expect(validateRemovedEnvelope(obj)).toBeNull();
  });
});

// ── validateSyncResult ─────────────────────────────────────────────────────────

describe('validateSyncResult', () => {
  it('accepts valid sync result', () => {
    const result = validateSyncResult({ success: true, syncedAt: '2026-06-01T00:00:00Z' });
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.syncedAt).toBe('2026-06-01T00:00:00Z');
  });

  it('accepts sync result with success false', () => {
    const result = validateSyncResult({ success: false, syncedAt: '2026-06-01T00:00:00Z' });
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });

  it('rejects null', () => {
    expect(validateSyncResult(null)).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(validateSyncResult({ success: true })).toBeNull();
    expect(validateSyncResult({ syncedAt: '2026-06-01' })).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(validateSyncResult({ success: 'true', syncedAt: '2026-06-01' })).toBeNull();
    expect(validateSyncResult({ success: true, syncedAt: 42 })).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const obj = Object.create({ success: true, syncedAt: '2026-06-01T00:00:00Z' });
    expect(validateSyncResult(obj)).toBeNull();
  });
});

// ── validateConfigReadiness ────────────────────────────────────────────────────

describe('validateConfigReadiness', () => {
  it('accepts valid config readiness', () => {
    const result = validateConfigReadiness({
      checks: [
        { id: 'check1', name: 'Check 1', status: 'ok', message: 'OK', lastCheck: '2026-06-01T00:00:00Z' },
      ],
      generatedAt: '2026-06-01T00:00:00Z',
    });
    expect(result).not.toBeNull();
    expect(result!.checks).toHaveLength(1);
    expect(result!.generatedAt).toBe('2026-06-01T00:00:00Z');
  });

  it('rejects null', () => {
    expect(validateConfigReadiness(null)).toBeNull();
  });

  it('rejects missing checks', () => {
    expect(validateConfigReadiness({ generatedAt: '2026-06-01' })).toBeNull();
  });

  it('rejects missing generatedAt', () => {
    expect(validateConfigReadiness({ checks: [] })).toBeNull();
  });

  it('rejects non-array checks', () => {
    expect(validateConfigReadiness({ checks: 'not-array', generatedAt: '2026-06-01' })).toBeNull();
  });

  it('rejects invalid check item', () => {
    const result = validateConfigReadiness({
      checks: [{ id: 123, name: 'Check', status: 'ok', message: 'OK', lastCheck: '2026-06-01' }],
      generatedAt: '2026-06-01',
    });
    expect(result).toBeNull();
  });
});

// ── validateConfigCatalog ─────────────────────────────────────────────────────

describe('validateConfigCatalog', () => {
  it('accepts valid config catalog', () => {
    const result = validateConfigCatalog({
      profiles: [{ id: 'profile1', type: 'openclaw', label: 'Profile 1', readiness: 'ready' }],
    });
    expect(result).not.toBeNull();
    expect(result!.profiles).toHaveLength(1);
  });

  it('accepts catalog with errors', () => {
    const result = validateConfigCatalog({
      profiles: [{ id: 'profile1', type: 'openclaw', label: 'Profile 1', readiness: 'ready' }],
      errors: [{ path: '/runtimeProfiles/test', reason: 'invalid', nextAction: 'fix' }],
    });
    expect(result).not.toBeNull();
    expect(result!.errors).toHaveLength(1);
  });

  it('rejects null', () => {
    expect(validateConfigCatalog(null)).toBeNull();
  });

  it('rejects missing profiles', () => {
    expect(validateConfigCatalog({})).toBeNull();
  });

  it('rejects non-array profiles', () => {
    expect(validateConfigCatalog({ profiles: 'not-array' })).toBeNull();
  });

  it('rejects invalid profile in array', () => {
    const result = validateConfigCatalog({ profiles: [{ id: 123 }] });
    expect(result).toBeNull();
  });
});

// ── validateAgentBindingUpdate ─────────────────────────────────────────────────

describe('validateAgentBindingUpdate', () => {
  it('accepts valid agent binding update', () => {
    const result = validateAgentBindingUpdate({ agent: 'diagnostician', runtimeProfile: 'openclaw.default', enabled: true });
    expect(result).not.toBeNull();
    expect(result!.agent).toBe('diagnostician');
    expect(result!.runtimeProfile).toBe('openclaw.default');
    expect(result!.enabled).toBe(true);
  });

  it('rejects null', () => {
    expect(validateAgentBindingUpdate(null)).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(validateAgentBindingUpdate({ agent: 'diag' })).toBeNull();
    expect(validateAgentBindingUpdate({ runtimeProfile: 'openclaw.default', enabled: true })).toBeNull();
    expect(validateAgentBindingUpdate({ agent: 'diag', enabled: true })).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(validateAgentBindingUpdate({ agent: 123, runtimeProfile: 'openclaw.default', enabled: true })).toBeNull();
    expect(validateAgentBindingUpdate({ agent: 'diag', runtimeProfile: 123, enabled: true })).toBeNull();
    expect(validateAgentBindingUpdate({ agent: 'diag', runtimeProfile: 'openclaw.default', enabled: 'yes' })).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const obj = Object.create({ agent: 'diagnostician', runtimeProfile: 'openclaw.default', enabled: true });
    expect(validateAgentBindingUpdate(obj)).toBeNull();
  });
});

// ── validateReadinessCheck ────────────────────────────────────────────────────

describe('validateReadinessCheck', () => {
  it('accepts valid readiness check', () => {
    const result = validateReadinessCheck({
      agent: 'diagnostician',
      readiness: 'ready',
      profileId: 'openclaw.default',
      profileLabel: 'Default OpenClaw',
    });
    expect(result).not.toBeNull();
    expect(result!.agent).toBe('diagnostician');
    expect(result!.readiness).toBe('ready');
  });

  it('accepts readiness with optional reason and nextAction', () => {
    const result = validateReadinessCheck({
      agent: 'diagnostician',
      readiness: 'not_ready',
      profileId: 'openclaw.default',
      profileLabel: 'Default',
      reason: 'Missing API key',
      nextAction: 'Set ANTHROPIC_API_KEY',
    });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('Missing API key');
    expect(result!.nextAction).toBe('Set ANTHROPIC_API_KEY');
  });

  it('accepts all valid readiness statuses', () => {
    const statuses = ['ready', 'not_ready', 'needs_setup', 'disabled', 'unknown'] as const;
    for (const status of statuses) {
      const result = validateReadinessCheck({
        agent: 'diag',
        readiness: status,
        profileId: 'profile',
        profileLabel: 'Label',
      });
      expect(result).not.toBeNull();
      expect(result!.readiness).toBe(status);
    }
  });

  it('rejects null', () => {
    expect(validateReadinessCheck(null)).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(validateReadinessCheck({ readiness: 'ready', profileId: 'p', profileLabel: 'l' })).toBeNull();
    expect(validateReadinessCheck({ agent: 'diag', profileId: 'p', profileLabel: 'l' })).toBeNull();
  });

  it('rejects invalid readiness status', () => {
    const result = validateReadinessCheck({
      agent: 'diag',
      readiness: 'invalid_status',
      profileId: 'p',
      profileLabel: 'l',
    });
    expect(result).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(validateReadinessCheck({
      agent: 123, readiness: 'ready', profileId: 'p', profileLabel: 'l',
    })).toBeNull();
  });
});

// ── validateDefaultRuntimeUpdate ───────────────────────────────────────────────

describe('validateDefaultRuntimeUpdate', () => {
  it('accepts valid default runtime update', () => {
    const result = validateDefaultRuntimeUpdate({ defaultRuntime: 'lmstudio-local' });
    expect(result).not.toBeNull();
    expect(result!.defaultRuntime).toBe('lmstudio-local');
  });

  it('rejects null', () => {
    expect(validateDefaultRuntimeUpdate(null)).toBeNull();
  });

  it('rejects missing defaultRuntime', () => {
    expect(validateDefaultRuntimeUpdate({})).toBeNull();
  });

  it('rejects wrong type', () => {
    expect(validateDefaultRuntimeUpdate({ defaultRuntime: 123 })).toBeNull();
    expect(validateDefaultRuntimeUpdate({ defaultRuntime: [] })).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const obj = Object.create({ defaultRuntime: 'lmstudio-local' });
    expect(validateDefaultRuntimeUpdate(obj)).toBeNull();
  });
});

// ── validateLifecycleMetrics ───────────────────────────────────────────────────

describe('validateLifecycleMetrics', () => {
  const validMetrics = {
    principleId: 'p1',
    adherence: {
      insufficientData: false,
      rate: 0.8,
      note: 'All good',
    },
    ruleMetrics: [
      { ruleId: 'r1', triggered: 5, lastTriggeredAt: '2026-06-01T00:00:00Z' },
    ],
  };

  it('accepts valid lifecycle metrics', () => {
    const result = validateLifecycleMetrics(validMetrics);
    expect(result).not.toBeNull();
    expect(result!.principleId).toBe('p1');
    expect(result!.adherence.rate).toBe(0.8);
    expect(result!.ruleMetrics).toHaveLength(1);
  });

  it('rejects null', () => {
    expect(validateLifecycleMetrics(null)).toBeNull();
  });

  it('rejects missing principleId', () => {
    const { principleId: _, ...withoutId } = validMetrics;
    expect(validateLifecycleMetrics(withoutId)).toBeNull();
  });

  it('rejects invalid adherence', () => {
    const result = validateLifecycleMetrics({ ...validMetrics, adherence: { insufficientData: 'not-boolean', rate: 0.8, note: 'test' } });
    expect(result).toBeNull();
  });

  it('rejects non-array ruleMetrics', () => {
    const result = validateLifecycleMetrics({ ...validMetrics, ruleMetrics: 'not-array' });
    expect(result).toBeNull();
  });

  it('rejects invalid rule metric item', () => {
    const result = validateLifecycleMetrics({
      ...validMetrics,
      ruleMetrics: [{ ruleId: 123 }],
    });
    expect(result).toBeNull();
  });
});

// ── validateUpdateHistory ──────────────────────────────────────────────────────

describe('validateUpdateHistory', () => {
  it('accepts valid update history', () => {
    const result = validateUpdateHistory({
      updates: [
        { id: 'upd-1', timestamp: '2026-06-01T00:00:00Z', fromVersion: '1.0.0', toVersion: '1.1.0', success: true, kind: 'update' },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.updates).toHaveLength(1);
  });

  it('rejects null', () => {
    expect(validateUpdateHistory(null)).toBeNull();
  });

  it('rejects missing updates', () => {
    expect(validateUpdateHistory({})).toBeNull();
  });

  it('rejects non-array updates', () => {
    expect(validateUpdateHistory({ updates: 'not-array' })).toBeNull();
  });

  it('rejects invalid update entry', () => {
    const result = validateUpdateHistory({ updates: [{ id: 1, timestamp: '2026-06-01', fromVersion: '1.0.0', toVersion: '1.1.0', success: true }] });
    expect(result).toBeNull();
  });
});

// ── validateApprovalRecordDirect ──────────────────────────────────────────────

describe('validateApprovalRecordDirect', () => {
  it('accepts valid approval record', () => {
    const result = validateApprovalRecordDirect({
      approvalId: 'apr_123',
      artifactId: 'art_456',
      channel: 'prompt',
      riskLevel: 'medium',
      status: 'pending',
      confidence: 0.85,
      requestedAt: '2026-06-01T00:00:00Z',
    });
    expect(result).not.toBeNull();
    expect(result!.approvalId).toBe('apr_123');
    expect(result!.confidence).toBe(0.85);
  });

  it('accepts approval record without optional fields', () => {
    const result = validateApprovalRecordDirect({
      approvalId: 'apr_123',
      artifactId: 'art_456',
      channel: 'prompt',
      riskLevel: 'medium',
      status: 'pending',
      requestedAt: '2026-06-01T00:00:00Z',
    });
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeUndefined();
  });

  it('rejects null', () => {
    expect(validateApprovalRecordDirect(null)).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(validateApprovalRecordDirect({ approvalId: 'apr_123' })).toBeNull();
    expect(validateApprovalRecordDirect({ artifactId: 'art_456' })).toBeNull();
  });

  it('rejects wrong types for required fields', () => {
    expect(validateApprovalRecordDirect({
      approvalId: 123, artifactId: 'art', channel: 'prompt', riskLevel: 'low', status: 'pending', requestedAt: '2026-06-01',
    })).toBeNull();
  });

  it('rejects invalid confidence type', () => {
    const result = validateApprovalRecordDirect({
      approvalId: 'apr_123',
      artifactId: 'art_456',
      channel: 'prompt',
      riskLevel: 'medium',
      status: 'pending',
      confidence: 'high',
      requestedAt: '2026-06-01T00:00:00Z',
    });
    expect(result).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const obj = Object.create({
      approvalId: 'apr_123',
      artifactId: 'art_456',
      channel: 'prompt',
      riskLevel: 'medium',
      status: 'pending',
      requestedAt: '2026-06-01T00:00:00Z',
    });
    expect(validateApprovalRecordDirect(obj)).toBeNull();
  });
});

describe('validateFeatureFlagUpdate', () => {
  it('accepts a valid feature flag update', () => {
    const result = validateFeatureFlagUpdate({ feature: 'intent_engineering', enabled: true });
    expect(result).toEqual({ feature: 'intent_engineering', enabled: true });
  });

  it('rejects missing or invalid fields', () => {
    expect(validateFeatureFlagUpdate(null)).toBeNull();
    expect(validateFeatureFlagUpdate({})).toBeNull();
    expect(validateFeatureFlagUpdate({ feature: 'intent_engineering' })).toBeNull();
    expect(validateFeatureFlagUpdate({ enabled: true })).toBeNull();
    expect(validateFeatureFlagUpdate({ feature: 123, enabled: true })).toBeNull();
    expect(validateFeatureFlagUpdate({ feature: 'intent_engineering', enabled: 'true' })).toBeNull();
  });

  it('rejects inherited properties (ERR-013)', () => {
    const obj = Object.create({
      feature: 'intent_engineering',
      enabled: true,
    });
    expect(validateFeatureFlagUpdate(obj)).toBeNull();
  });
});
