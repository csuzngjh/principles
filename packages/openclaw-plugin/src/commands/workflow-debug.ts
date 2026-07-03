import { WorkflowStore } from '../service/subagent-workflow/workflow-store.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';
import { normalizeCommandArgs } from '../utils/io.js';
import { resolvePluginCommandWorkspaceDir } from '../utils/workspace-resolver.js';

// rc-1/rc-2: Treat JSON.parse output as unknown and validate before use.
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatTimestamp(ts: number | null | undefined): string {
    if (!ts) return '--';
    return new Date(ts).toISOString();
}

function formatState(state: string): string {
    const stateColors: Record<string, string> = {
        'active': '●',
        'wait_result': '◐',
        'finalizing': '◑',
        'completed': '✓',
        'terminal_error': '✗',
        'cleanup_pending': '⚠',
        'expired': '⊘',
    };
    const icon = stateColors[state] || '?';
    return `${icon} ${state}`;
}

// rc-5: Use Object.hasOwn for untrusted object keys. Returns string or '--'.
function readStringField(record: Record<string, unknown>, key: string): string {
    if (Object.hasOwn(record, key) && typeof record[key] === 'string') {
        return record[key] as string;
    }
    return '--';
}

function buildOutput(
    workflowId: string,
    summary: ReturnType<InstanceType<typeof WorkflowStore>['getWorkflow']>,
    events: ReturnType<InstanceType<typeof WorkflowStore>['getEvents']>,
    workspaceDir: string
): string {
    if (!summary) {
        return [
            `Workflow Debug: ${workflowId}`,
            '============================',
            '',
            '❌ Workflow not found',
            '',
            `Workspace: ${workspaceDir}`,
        ].join('\n');
    }

    // rc-1: JSON.parse output is unknown. rc-2: do not bypass with `as`.
    const rawMetadata: unknown = JSON.parse(summary.metadata_json || '{}');
    const metadata: Record<string, unknown> = isRecord(rawMetadata) ? rawMetadata : {};
    const workspaceField = readStringField(metadata, 'workspaceDir');

    // rc-4: Validate taskInput element type before substring.
    let taskInputPreview = '--';
    if (Object.hasOwn(metadata, 'taskInput') && typeof metadata['taskInput'] === 'string') {
        const ti = metadata['taskInput'] as string;
        taskInputPreview = ti.substring(0, 100) + (ti.length > 100 ? '...' : '');
    }

    const recentEvents = events.slice(-10);

    const lines: string[] = [
        `Workflow Debug: ${workflowId}`,
        '============================',
        '',
        'Overview',
        `- Type: ${summary.workflow_type}`,
        `- Transport: ${summary.transport}`,
        `- State: ${formatState(summary.state)}`,
        `- Cleanup: ${summary.cleanup_state}`,
        `- Created: ${formatTimestamp(summary.created_at)}`,
        `- Last Observed: ${formatTimestamp(summary.last_observed_at)}`,
        '',
        'Sessions',
        `- Parent: ${summary.parent_session_id}`,
        `- Child: ${summary.child_session_key}`,
        `- Run ID: ${summary.run_id ?? '--'}`,
        '',
        'Metadata',
        `- Workspace: ${workspaceField}`,
        `- Task Input: ${taskInputPreview}`,
        '',
        `Recent Events (${recentEvents.length})`,
    ];

    if (recentEvents.length === 0) {
        lines.push('- (no events)');
    } else {
        for (const event of recentEvents) {
            const time = formatTimestamp(event.created_at);
            const transition = event.from_state ? `${event.from_state} → ${event.to_state}` : `→ ${event.to_state}`;
            lines.push(`- [${time}] ${event.event_type}: ${transition} (${event.reason})`);
        }
    }

    lines.push('');
    lines.push(`Workspace: ${workspaceDir}`);

    return lines.join('\n');
}

export function handleWorkflowDebugCommand(
    ctx: PluginCommandContext
): { text: string } {
    const workspaceDir = resolvePluginCommandWorkspaceDir(ctx, 'workflow-debug');

    // rc-2: Do not use `as` to bypass; use normalizeCommandArgs for string|string[] union.
    const args = normalizeCommandArgs(ctx.args).trim();
    const [workflowId] = args.split(/\s+/);

    if (!workflowId) {
        return {
            text: [
                'Workflow Debug',
                '============================',
                '',
                'Usage: /pd-workflow-debug <workflowId>',
                '',
                'Description:',
                '- Display debug summary for a helper workflow',
                '- Shows state, cleanup status, and recent events',
                '',
                'To find workflow IDs, check .state/subagent_workflows.db',
            ].join('\n'),
        };
    }

    try {
        const store = new WorkflowStore({ workspaceDir });
        const workflow = store.getWorkflow(workflowId);
        const events = store.getEvents(workflowId);
        store.dispose();

        return { text: buildOutput(workflowId, workflow, events, workspaceDir) };
    } catch (error) {
        return {
            text: [
                `Workflow Debug: ${workflowId}`,
                '============================',
                '',
                `❌ Error: ${String(error)}`,
                '',
                `Workspace: ${workspaceDir}`,
            ].join('\n'),
        };
    }
}
