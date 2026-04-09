import type { PluginLogger } from '../../openclaw-sdk.js';
import type {
    SubagentWorkflowSpec,
    WorkflowMetadata,
    DeepReflectResult,
    WorkflowResultContext,
    WorkflowPersistContext,
    WorkflowHandle,
} from './types.js';

// Re-export DeepReflectResult so index.ts can re-export it
export type { DeepReflectResult } from './types.js';
import type { RuntimeDirectDriver } from './runtime-direct-driver.js';
import { isSubagentRuntimeAvailable } from '../../utils/subagent-probe.js';
import { buildCritiquePromptV2 } from '../../tools/critique-prompt.js';
import { WorkflowManagerBase } from './workflow-manager-base.js';

const WORKFLOW_SESSION_PREFIX = 'agent:main:subagent:workflow-';

const DEFAULT_TIMEOUT_MS = 60_000; // Deep-reflect needs more time than empathy
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface DeepReflectWorkflowOptions {
    workspaceDir: string;
    logger: PluginLogger;
    subagent: RuntimeDirectDriver['subagent'];
    /** Pass api.runtime.agent.session to enable heartbeat-safe cleanup (#188) */
    agentSession?: RuntimeDirectDriver['agentSession'];
}

export class DeepReflectWorkflowManager extends WorkflowManagerBase {
    constructor(opts: DeepReflectWorkflowOptions) {
        super({
            workspaceDir: opts.workspaceDir,
            logger: opts.logger,
            subagent: opts.subagent,
            agentSession: opts.agentSession,
            workflowType: 'deep-reflect',
            sessionPrefix: WORKFLOW_SESSION_PREFIX,
            defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
            defaultTtlMs: DEFAULT_TTL_MS,
        });
    }

    async startWorkflow<TResult>(
        spec: SubagentWorkflowSpec<TResult>,
        options: {
            parentSessionId: string;
            workspaceDir?: string;
            taskInput: unknown;
            metadata?: Record<string, unknown>;
        }
    ): Promise<WorkflowHandle> {
        // Surface degrade: skip boot sessions
        if (options.parentSessionId.startsWith('boot-')) {
            this.logger.info(`[PD:DeepReflectWorkflow] Skipping workflow: boot session`);
            throw new Error(`DeepReflectWorkflowManager: cannot start workflow for boot session`);
        }

        // Surface degrade: check subagent runtime availability
        if (!isSubagentRuntimeAvailable(this.driver.getSubagent())) {
            this.logger.info(`[PD:DeepReflectWorkflow] Skipping workflow: subagent runtime unavailable`);
            throw new Error(`DeepReflectWorkflowManager: subagent runtime unavailable`);
        }

        if (spec.transport !== 'runtime_direct') {
            throw new Error(`DeepReflectWorkflowManager only supports runtime_direct transport`);
        }

        return super.startWorkflow(spec, options);
    }

    protected override generateWorkflowId(): string {
        return `wf_dr_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface DeepReflectTaskInput {
    context: string;
    depth: number;
    model_id?: string;
}

export interface DeepReflectBuildPromptContext {
    parentSessionId: string;
    workspaceDir?: string;
    taskInput: unknown;
    startedAt: number;
    workflowType: string;
}

// ─── Workflow Spec ─────────────────────────────────────────────────────────────

export const deepReflectWorkflowSpec: SubagentWorkflowSpec<DeepReflectResult> = {
    workflowType: 'deep-reflect',
    transport: 'runtime_direct',
    timeoutMs: 60_000,
    ttlMs: 10 * 60 * 1000,
    shouldDeleteSessionAfterFinalize: true,

    buildPrompt(taskInput: unknown, ctx: DeepReflectBuildPromptContext): string {
        const input = taskInput as DeepReflectTaskInput;
        // Use the existing critique prompt builder
        return buildCritiquePromptV2({
            context: input.context,
            depth: input.depth,
            model_id: input.model_id,
            api: undefined, // Not available in workflow context
            workspaceDir: ctx.workspaceDir,
        });
    },

    shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
        return status === 'ok';
    },

    async parseResult(ctx: WorkflowResultContext): Promise<DeepReflectResult | null> {
        const { assistantTexts, messages } = ctx;

        let insights = '';
        if (assistantTexts && assistantTexts.length > 0) {
            insights = assistantTexts[assistantTexts.length - 1] || '';
        } else if (messages && messages.length > 0) {
            const lastMessage = messages[messages.length - 1] as { role?: string; content?: unknown };
            if (typeof lastMessage?.content === 'string') {
                insights = lastMessage.content;
            } else if (Array.isArray(lastMessage?.content)) {
                insights = (lastMessage.content as { type?: string; text?: string }[])
                    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Reason: filter ensures c.text is a string
                    .map((c) => c.text!)
                    .join('\n');
            }
        }

        if (!insights?.trim()) {
            return null;
        }

        const taskInput = ctx.metadata.taskInput as DeepReflectTaskInput | undefined;

        return {
            insights,
            context: taskInput?.context ?? '',
            depth: taskInput?.depth ?? 2,
            modelId: taskInput?.model_id ?? 'auto-select',
            passed: !insights.includes('REFLECTION_FAIL'),
        };
    },

    async persistResult(ctx: WorkflowPersistContext<DeepReflectResult>): Promise<void> {
        const { result, metadata, workspaceDir } = ctx;

        if (!result || !result.insights) return;

        try {
            const fs = await import('fs');
            const pathMod = await import('path');
            const { resolvePdPath } = await import('../../core/paths.js');

            const reflectionLogPath = resolvePdPath(workspaceDir, 'REFLECTION_LOG');
            const memoryDir = pathMod.default.dirname(reflectionLogPath);
            if (!fs.default.existsSync(memoryDir)) {
                fs.default.mkdirSync(memoryDir, { recursive: true });
            }

            const timestamp = new Date().toISOString();
            const taskInput = metadata.taskInput as DeepReflectTaskInput | undefined;
            const entry = `
---
## Reflection at ${timestamp}
**Model**: ${result.modelId || 'auto-select'}
**Depth**: ${result.depth || 2}

### Context
${(taskInput?.context ?? '').substring(0, 500)}${(taskInput?.context ?? '').length > 500 ? '...' : ''}

### Insights
${result.insights}

`;

            const header = `# Reflection Log\n\n> Auto-generated by Deep Reflection Tool\n> Retention: 30 days\n`;

            let existingContent = '';
            if (fs.default.existsSync(reflectionLogPath)) {
                existingContent = fs.default.readFileSync(reflectionLogPath, 'utf8');
            }

            const newContent = header + entry + existingContent.replace(header, '');

            const tempPath = `${reflectionLogPath}.tmp`;
            fs.default.writeFileSync(tempPath, newContent, 'utf8');
            fs.default.renameSync(tempPath, reflectionLogPath);
        } catch (err) {
            // Let the error propagate to finalizeOnce for proper event logging
            throw new Error(`DeepReflectWorkflow persistResult failed: ${String(err)}`, { cause: err });
        }
    },
};
