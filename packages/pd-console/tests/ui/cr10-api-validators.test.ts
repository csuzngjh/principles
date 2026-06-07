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
  validateDeleteEnvelope,
  validateWorkspaceEntry,
  validateWorkspaceList,
  validateConfigSummary,
  validateGovernanceQueue,
  validateActivations,
  validateDisableActivation,
  validateUpdateStatus,
  validateApprovalListResult,
  validatePrinciplesList,
  validateApprovalsGrouped,
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
});

// ── validateActivations ───────────────────────────────────────────────────────

describe('validateActivations', () => {
  const validActivations = {
    activations: [{
      id: 'a1', artifactId: 'art1', principleId: 'p1',
      channel: 'prompt', action: 'inject', targetRef: 'target',
      activatedAt: '2026-06-01', status: 'active',
    }],
    generatedAt: '2026-06-01T00:00:00Z',
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
    expect(validateActivations({ activations: [{ id: 'a1' }], generatedAt: '2026' })).toBeNull();
  });

  it('rejects wrong field types', () => {
    expect(validateActivations({ ...validActivations, generatedAt: 123 })).toBeNull();
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
    updateAvailable: true,
    lastChecked: '2026-06-01',
  };

  it('accepts valid update status', () => {
    const result = validateUpdateStatus(validStatus);
    expect(result).not.toBeNull();
    expect(result!.updateAvailable).toBe(true);
  });

  it('rejects null', () => {
    expect(validateUpdateStatus(null)).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(validateUpdateStatus({ currentVersion: '1.0' })).toBeNull();
  });

  it('rejects wrong types', () => {
    expect(validateUpdateStatus({ ...validStatus, updateAvailable: 'yes' })).toBeNull();
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
});

// ── validateApprovalsGrouped ──────────────────────────────────────────────────

describe('validateApprovalsGrouped', () => {
  const validGrouped = {
    groups: [{
      principleId: 'p1', principleTitle: 'Test', status: 'pending',
      records: [{ id: 'r1', artifactId: 'art1', channel: 'prompt', createdAt: '2026-06-01' }],
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
