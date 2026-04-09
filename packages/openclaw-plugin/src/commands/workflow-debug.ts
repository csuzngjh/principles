import { WorkflowStore } from '../service/subagent-workflow/workflow-store.js';
import type { PluginCommandContext } from '../openclaw-sdk.js';

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

// eslint-disable-next-line @typescript-eslint/max-params -- Reason: debug output builder requires all context parameters - refactoring would break API
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

    const metadata = JSON.parse(summary.metadata_json || '{}');
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
        `- Workspace: ${metadata.workspaceDir ?? '--'}`,
        `- Task Input: ${typeof metadata.taskInput === 'string' ? metadata.taskInput.substring(0, 100) + (metadata.taskInput.length > 100 ? '...' : '') : '--'}`,
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
    ctx: PluginCommandContext & { args?: string }
): { text: string } {
    const workspaceDir = (ctx.config?.workspaceDir as string) || process.cwd();
    
    // Parse workflow ID from args
    const args = (ctx as { args?: string }).args?.trim() || '';
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
