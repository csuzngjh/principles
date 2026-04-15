/**
 * Unit tests for workflow-watchdog.ts
 *
 * Tests BUG-01, BUG-02, and BUG-03 behavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEventRow, WorkflowRow } from '../../src/service/subagent-workflow/types.js';
import { runWorkflowWatchdog } from '../../src/service/workflow-watchdog.js';

const mockListWorkflows = vi.fn<() => WorkflowRow[]>();
const mockGetEvents = vi.fn<() => WorkflowEventRow[]>();
const mockUpdateWorkflowState = vi.fn();
const mockRecordEvent = vi.fn();
const mockDispose = vi.fn();

vi.mock('../../src/service/subagent-workflow/workflow-store.js', () => ({
    WorkflowStore: class {
        listWorkflows = mockListWorkflows;
        getEvents = mockGetEvents;
        updateWorkflowState = mockUpdateWorkflowState;
        recordEvent = mockRecordEvent;
        dispose = mockDispose;
    },
}));

vi.mock('../../src/service/subagent-workflow/subagent-error-utils.js', () => ({
    isExpectedSubagentError: vi.fn(),
}));

vi.mock('../../src/config/defaults/runtime.js', () => ({
    WORKFLOW_TTL_MS: 5 * 60 * 1000, // 5 minutes
}));

import { isExpectedSubagentError } from '../../src/service/subagent-workflow/subagent-error-utils.js';

function createWorkflow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
    return {
        workflow_id: overrides.workflow_id ?? 'wf-1',
        workflow_type: overrides.workflow_type ?? 'empathy-observer',
        transport: overrides.transport ?? 'runtime_direct',
        parent_session_id: overrides.parent_session_id ?? 'parent-1',
        child_session_key: overrides.child_session_key ?? 'child-session-1',
        run_id: overrides.run_id ?? null,
        state: overrides.state ?? 'active',
        cleanup_state: overrides.cleanup_state ?? 'none',
        created_at: overrides.created_at ?? Date.now() - (1 * 60 * 1000),
        updated_at: overrides.updated_at ?? Date.now(),
        last_observed_at: overrides.last_observed_at ?? null,
        duration_ms: overrides.duration_ms ?? null,
        metadata_json: overrides.metadata_json ?? '{}',
    };
}

function createEvent(workflowId: string, reason = 'unknown'): WorkflowEventRow {
    return {
        workflow_id: workflowId,
        event_type: 'state_change',
        from_state: null,
        to_state: 'active',
        reason,
        payload_json: '{}',
        created_at: Date.now() - (1 * 60 * 1000),
    };
}

describe('runWorkflowWatchdog', () => {
    let mockLogger: { debug?: ReturnType<typeof vi.fn>; info?: ReturnType<typeof vi.fn>; warn?: ReturnType<typeof vi.fn> };
    let mockApi: Parameters<typeof runWorkflowWatchdog>[1];

    beforeEach(() => {
        vi.clearAllMocks();
        mockListWorkflows.mockReturnValue([]);
        mockGetEvents.mockReturnValue([]);
        mockUpdateWorkflowState.mockReturnValue(undefined);
        mockRecordEvent.mockReturnValue(undefined);
        mockDispose.mockReturnValue(undefined);
        isExpectedSubagentError.mockReturnValue(false);

        mockLogger = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        mockApi = {
            runtime: {
                subagent: {
                    deleteSession: vi.fn().mockResolvedValue(undefined),
                },
                agent: {
                    session: {
                        resolveStorePath: vi.fn().mockReturnValue('/tmp/sessions.json'),
                        loadSessionStore: vi.fn().mockReturnValue({}),
                        saveSessionStore: vi.fn().mockResolvedValue(undefined),
                    },
                },
            },
        } as unknown as Parameters<typeof runWorkflowWatchdog>[1];
    });

    // ── BUG-01: isExpectedSubagentError guard ───────────────────────────────

    describe('BUG-01: isExpectedSubagentError guard', () => {
        it('skips marking stale workflow as terminal_error when last event is expected subagent error', async () => {
            const staleWorkflowId = 'wf-stale-001';
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: staleWorkflowId,
                    state: 'active',
                    created_at: now - (15 * 60 * 1000), // 15 minutes old (> 2x 5min TTL)
                }),
            ]);
            mockGetEvents.mockReturnValue([
                createEvent(staleWorkflowId, 'subagent_not_available'),
            ]);
            isExpectedSubagentError.mockReturnValue(true);

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                mockApi,
                mockLogger,
            );

            expect(mockUpdateWorkflowState).not.toHaveBeenCalled();
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('Skipping stale active workflow'),
            );
            expect(result.anomalies).toBe(1);
        });

        it('marks stale workflow as terminal_error when last event is unexpected error', async () => {
            const staleWorkflowId = 'wf-stale-002';
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: staleWorkflowId,
                    state: 'active',
                    created_at: now - (15 * 60 * 1000),
                }),
            ]);
            mockGetEvents.mockReturnValue([
                createEvent(staleWorkflowId, 'unexpected_crash'),
            ]);
            isExpectedSubagentError.mockReturnValue(false);

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                mockApi,
                mockLogger,
            );

            expect(mockUpdateWorkflowState).toHaveBeenCalledWith(staleWorkflowId, 'terminal_error');
            expect(mockRecordEvent).toHaveBeenCalledWith(
                staleWorkflowId,
                'watchdog_timeout',
                'active',
                'terminal_error',
                expect.stringContaining('Stale active'),
                expect.any(Object),
            );
            expect(result.anomalies).toBe(1);
        });
    });

    // ── BUG-02: Gateway fallback for child session cleanup ──────────────────

    describe('BUG-02: gateway fallback for child session cleanup', () => {
        it('cleans up child session via agentSession fallback when subagentRuntime is unavailable', async () => {
            const staleWorkflowId = 'wf-stale-003';
            const childSessionKey = 'child-session-003';
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: staleWorkflowId,
                    child_session_key: childSessionKey,
                    state: 'active',
                    created_at: now - (15 * 60 * 1000),
                }),
            ]);
            mockGetEvents.mockReturnValue([
                createEvent(staleWorkflowId, 'unexpected_crash'),
            ]);
            isExpectedSubagentError.mockReturnValue(false);

            const apiWithNoSubagentRuntime = {
                runtime: {
                    subagent: null,
                    agent: {
                        session: {
                            resolveStorePath: vi.fn().mockReturnValue('/tmp/sessions.json'),
                            loadSessionStore: vi.fn().mockReturnValue({ [childSessionKey.toLowerCase()]: { data: true } }),
                            saveSessionStore: vi.fn().mockResolvedValue(undefined),
                        },
                    },
                },
            } as unknown as Parameters<typeof runWorkflowWatchdog>[1];

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                apiWithNoSubagentRuntime,
                mockLogger,
            );

            expect(apiWithNoSubagentRuntime.runtime!.agent!.session!.saveSessionStore).toHaveBeenCalled();
            expect(result.anomalies).toBe(1);
        });

        it('retries with agentSession fallback after gateway request error', async () => {
            const staleWorkflowId = 'wf-stale-004';
            const childSessionKey = 'child-session-004';
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: staleWorkflowId,
                    child_session_key: childSessionKey,
                    state: 'active',
                    created_at: now - (15 * 60 * 1000),
                }),
            ]);
            mockGetEvents.mockReturnValue([
                createEvent(staleWorkflowId, 'unexpected_crash'),
            ]);
            isExpectedSubagentError.mockReturnValue(false);

            const apiWithFailingSubagent = {
                runtime: {
                    subagent: {
                        deleteSession: vi.fn().mockRejectedValue(new Error('gateway request failed')),
                    },
                    agent: {
                        session: {
                            resolveStorePath: vi.fn().mockReturnValue('/tmp/sessions.json'),
                            loadSessionStore: vi.fn().mockReturnValue({ [childSessionKey.toLowerCase()]: { data: true } }),
                            saveSessionStore: vi.fn().mockResolvedValue(undefined),
                        },
                    },
                },
            } as unknown as Parameters<typeof runWorkflowWatchdog>[1];

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                apiWithFailingSubagent,
                mockLogger,
            );

            expect(apiWithFailingSubagent.runtime!.agent!.session!.saveSessionStore).toHaveBeenCalled();
            expect(result.anomalies).toBe(1);
        });
    });

    // ── BUG-03: Nocturnal snapshot validation ─────────────────────────────

    describe('BUG-03: nocturnal snapshot validation', () => {
        it('detects fallback_snapshot when nocturnal workflow uses pain_context_fallback', async () => {
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: 'wf-nocturnal-001',
                    workflow_type: 'nocturnal',
                    state: 'completed',
                    created_at: now - (60 * 60 * 1000),
                    metadata_json: JSON.stringify({
                        snapshot: {
                            _dataSource: 'pain_context_fallback',
                            stats: { totalToolCalls: 0, totalGateBlocks: 0, failureCount: 0 },
                        },
                    }),
                }),
            ]);

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                mockApi,
                mockLogger,
            );

            expect(result.details).toContainEqual(
                expect.stringContaining('fallback_snapshot: nocturnal workflow wf-nocturnal-001 uses pain-context fallback'),
            );
            expect(result.details).toContainEqual(
                expect.stringContaining('fallback_snapshot_stats: nocturnal workflow wf-nocturnal-001 has empty fallback stats'),
            );
        });

        it('does not flag fallback_snapshot_stats when nocturnal workflow has real stats', async () => {
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: 'wf-nocturnal-002',
                    workflow_type: 'nocturnal',
                    state: 'completed',
                    created_at: now - (60 * 60 * 1000),
                    metadata_json: JSON.stringify({
                        snapshot: {
                            _dataSource: 'pain_context_fallback',
                            stats: { totalToolCalls: 5, totalGateBlocks: 2, failureCount: 1 },
                        },
                    }),
                }),
            ]);

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                mockApi,
                mockLogger,
            );

            expect(result.details).toContainEqual(
                expect.stringContaining('fallback_snapshot: nocturnal workflow wf-nocturnal-002 uses pain-context fallback'),
            );
            expect(result.details).not.toContainEqual(
                expect.stringContaining('fallback_snapshot_stats'),
            );
        });
    });

    // ── General behavior ───────────────────────────────────────────────────

    describe('general behavior', () => {
        it('returns anomalies=0 and no details when all workflows are healthy', async () => {
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: 'wf-healthy-001',
                    state: 'active',
                    created_at: now - (1 * 60 * 1000), // 1 minute old — healthy
                }),
            ]);

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                mockApi,
                mockLogger,
            );

            expect(result.anomalies).toBe(0);
            expect(result.details).toHaveLength(0);
        });

        it('handles malformed metadata_json gracefully', async () => {
            const now = Date.now();

            mockListWorkflows.mockReturnValue([
                createWorkflow({
                    workflow_id: 'wf-malformed-001',
                    workflow_type: 'nocturnal',
                    state: 'completed',
                    created_at: now - (60 * 60 * 1000),
                    metadata_json: 'not valid json {{{',
                }),
            ]);

            const result = await runWorkflowWatchdog(
                { workspaceDir: '/tmp', stateDir: '/tmp/.state' } as any,
                mockApi,
                mockLogger,
            );

            expect(result.anomalies).toBe(1);
            expect(result.details.some((d: string) => d.includes('malformed_metadata'))).toBe(true);
        });
    });
});
