/**
 * Unit tests for /pd-workflow-debug command (workflow-debug.ts)
 *
 * Covers the rc-1/rc-2/rc-5 defensive paths added to harden JSON.parse
 * handling: isRecord() validation, readStringField() safety, taskInput
 * type guard, not-found branch, no-args usage, and error catch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// PRI-686: os mock must register before any src import so command resolvers
// (which now prioritize PD explicit sources) stay on this suite's
// ctx-provided mock workspace instead of the host's real PD canonical config.
import { isolatePdCanonicalConfig } from '../utils/isolate-pd-canonical.js';
isolatePdCanonicalConfig();
import type { WorkflowRow, WorkflowEventRow } from '../../src/service/subagent-workflow/types.js';
import { handleWorkflowDebugCommand } from '../../src/commands/workflow-debug.js';

const mockGetWorkflow = vi.fn<(id: string) => WorkflowRow | null>();
const mockGetEvents = vi.fn<(id: string) => WorkflowEventRow[]>();
const mockDispose = vi.fn();

vi.mock('../../src/service/subagent-workflow/workflow-store.js', () => ({
    WorkflowStore: class {
        getWorkflow = mockGetWorkflow;
        getEvents = mockGetEvents;
        dispose = mockDispose;
    },
}));

function createRow(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
    return {
        workflow_id: overrides.workflow_id ?? 'wf-1',
        workflow_type: overrides.workflow_type ?? 'empathy-observer',
        transport: overrides.transport ?? 'runtime_direct',
        parent_session_id: overrides.parent_session_id ?? 'parent-1',
        child_session_key: overrides.child_session_key ?? 'child-1',
        run_id: overrides.run_id ?? null,
        state: overrides.state ?? 'active',
        cleanup_state: overrides.cleanup_state ?? 'none',
        created_at: overrides.created_at ?? 1700000000000,
        updated_at: overrides.updated_at ?? 1700000001000,
        last_observed_at: overrides.last_observed_at ?? 1700000002000,
        duration_ms: overrides.duration_ms ?? null,
        metadata_json: overrides.metadata_json ?? '{}',
    };
}

function ctx(args?: string | string[]) {
    return { config: { workspaceDir: '/mock/ws' }, args } as any;
}

describe('handleWorkflowDebugCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns usage text when no workflowId is provided', () => {
        const result = handleWorkflowDebugCommand(ctx(''));
        expect(result.text).toContain('Usage: /pd-workflow-debug <workflowId>');
        expect(mockGetWorkflow).not.toHaveBeenCalled();
    });

    it('returns usage text when args is undefined', () => {
        const result = handleWorkflowDebugCommand(ctx(undefined));
        expect(result.text).toContain('Usage: /pd-workflow-debug <workflowId>');
    });

    it('handles string[] args via normalizeCommandArgs', () => {
        const result = handleWorkflowDebugCommand(ctx(['wf-arr-1']));
        expect(result.text).toContain('Workflow Debug: wf-arr-1');
    });

    it('shows not-found message when workflow does not exist', () => {
        mockGetWorkflow.mockReturnValue(null);
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-missing'));
        expect(result.text).toContain('❌ Workflow not found');
        expect(result.text).toContain('Workspace: /mock/ws');
    });

    it('renders summary with empty metadata object', () => {
        mockGetWorkflow.mockReturnValue(createRow({ metadata_json: '{}' }));
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('Workflow Debug: wf-1');
        expect(result.text).toContain('- Workspace: --');
        expect(result.text).toContain('- Task Input: --');
        expect(result.text).toContain('- (no events)');
    });

    it('renders workspaceDir and taskInput as strings when present', () => {
        mockGetWorkflow.mockReturnValue(createRow({
            metadata_json: JSON.stringify({
                workspaceDir: '/real/ws',
                taskInput: 'do the thing',
            }),
        }));
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('- Workspace: /real/ws');
        expect(result.text).toContain('- Task Input: do the thing');
    });

    it('truncates long taskInput to 100 chars with ellipsis', () => {
        const longInput = 'x'.repeat(150);
        mockGetWorkflow.mockReturnValue(createRow({
            metadata_json: JSON.stringify({ taskInput: longInput }),
        }));
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('x'.repeat(100) + '...');
    });

    it('falls back to -- when taskInput is not a string (rc-4)', () => {
        mockGetWorkflow.mockReturnValue(createRow({
            metadata_json: JSON.stringify({ taskInput: { nested: true } }),
        }));
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('- Task Input: --');
    });

    it('falls back to {} when metadata_json is a non-object JSON array (rc-1 isRecord false branch)', () => {
        mockGetWorkflow.mockReturnValue(createRow({ metadata_json: '[1, 2, 3]' }));
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        // Should not throw; workspace/taskInput fall back to --
        expect(result.text).toContain('- Workspace: --');
        expect(result.text).toContain('- Task Input: --');
    });

    it('falls back to {} when metadata_json is a JSON primitive string (rc-1 isRecord false branch)', () => {
        mockGetWorkflow.mockReturnValue(createRow({ metadata_json: '"just a string"' }));
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('- Workspace: --');
    });

    it('falls back to -- when workspaceDir is present but not a string (rc-4)', () => {
        mockGetWorkflow.mockReturnValue(createRow({
            metadata_json: JSON.stringify({ workspaceDir: 12345 }),
        }));
        mockGetEvents.mockReturnValue([]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('- Workspace: --');
    });

    it('renders recent events when present', () => {
        mockGetWorkflow.mockReturnValue(createRow());
        mockGetEvents.mockReturnValue([
            {
                workflow_id: 'wf-1',
                event_type: 'state_change',
                from_state: 'pending',
                to_state: 'active',
                reason: 'spawned',
                payload_json: '{}',
                created_at: 1700000003000,
            },
        ]);
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('Recent Events (1)');
        expect(result.text).toContain('state_change: pending → active (spawned)');
    });

    it('returns error text when WorkflowStore constructor throws', () => {
        // Re-mock the constructor to throw by making getWorkflow throw via a fresh mock
        mockGetWorkflow.mockImplementation(() => {
            throw new Error('db locked');
        });
        const result = handleWorkflowDebugCommand(ctx('wf-1'));
        expect(result.text).toContain('❌ Error: Error: db locked');
        expect(result.text).toContain('Workspace: /mock/ws');
    });
});
