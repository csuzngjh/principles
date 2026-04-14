/**
 * CorrectionObserverWorkflowManager
 *
 * Workflow manager that dispatches an LLM subagent to optimize correction
 * keywords based on recent match performance data and user feedback.
 *
 * Follows the established WorkflowManagerBase pattern from EmpathyObserverWorkflowManager.
 */

import type { PluginLogger } from '../openclaw-sdk.js';
import type {
    SubagentWorkflowSpec,
    WorkflowMetadata,
    WorkflowResultContext,
    WorkflowPersistContext,
    WorkflowHandle,
} from './subagent-workflow/types.js';
import type { RuntimeDirectDriver } from './subagent-workflow/runtime-direct-driver.js';
import { WorkflowManagerBase } from './subagent-workflow/workflow-manager-base.js';
import { isSubagentRuntimeAvailable } from '../utils/subagent-probe.js';
import type {
    CorrectionObserverPayload,
    CorrectionObserverResult,
} from './correction-observer-types.js';

const WORKFLOW_SESSION_PREFIX = 'agent:main:subagent:workflow-correction-';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// ── Options ─────────────────────────────────────────────────────────────────

export interface CorrectionObserverWorkflowOptions {
    workspaceDir: string;
    logger: PluginLogger;
    subagent: RuntimeDirectDriver['subagent'];
    /** Pass api.runtime.agent.session to enable heartbeat-safe cleanup (#188) */
    agentSession?: RuntimeDirectDriver['agentSession'];
}

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Extract raw assistant text from messages or assistantTexts array.
 */
function extractAssistantTextForSpec(messages: unknown[], assistantTexts?: string[]): string {
    if (assistantTexts && assistantTexts.length > 0) {
        return assistantTexts[assistantTexts.length - 1] || '';
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i] as { role?: string; content?: unknown };
        if (msg?.role !== 'assistant') continue;
        if (typeof msg.content === 'string') return msg.content;
        if (Array.isArray(msg.content)) {
            const txt = msg.content
                .filter((part: unknown) => part && typeof part === 'object' && (part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
                .map((part: unknown) => (part as { text: string }).text)
                .join('\n');
            if (txt) return txt;
        }
    }
    return '';
}

/**
 * Parse correction observer JSON payload from raw text.
 */
function parseCorrectionObserverPayload(rawText: string): CorrectionObserverResult | null {
    if (!rawText?.trim()) return null;
    try {
        return JSON.parse(rawText.trim()) as CorrectionObserverResult;
    } catch {
        const match = /\{[\s\S]*\}/.exec(rawText);
        if (!match) return null;
        try {
            return JSON.parse(match[0]) as CorrectionObserverResult;
        } catch {
            return null;
        }
    }
}

// ── Workflow Spec ─────────────────────────────────────────────────────────────

export const correctionObserverWorkflowSpec: SubagentWorkflowSpec<CorrectionObserverResult> = {
    workflowType: 'correction_observer',
    transport: 'runtime_direct',
    timeoutMs: 30_000,
    ttlMs: 300_000,
    shouldDeleteSessionAfterFinalize: true,

    buildPrompt(taskInput: unknown, _metadata: WorkflowMetadata): string {
        const payload = taskInput as CorrectionObserverPayload;
        const { keywordStoreSummary, recentMessages, trajectoryHistory } = payload;

        const termsList = keywordStoreSummary.terms
            .map(t => `  - term="${t.term}", weight=${t.weight}, hits=${t.hitCount}, TP=${t.truePositiveCount}, FP=${t.falsePositiveCount}`)
            .join('\n');

        const messages = recentMessages.length > 0
            ? recentMessages.map(m => `  - ${JSON.stringify(m)}`).join('\n')
            : '  (none)';

        const trajectory = trajectoryHistory.length > 0
            ? trajectoryHistory.map(t => `  - [${t.sessionId}] ${t.term} (${t.timestamp}): ${t.userMessage.substring(0, 80)}`)
              .join('\n')
            : '  (none)';

        return [
            'You are a correction keyword optimizer.',
            '',
            '## TASK',
            'Analyze the current correction keyword store and recent user messages.',
            'Recommend ADD/UPDATE/REMOVE actions to improve correction cue accuracy.',
            '',
            '## Current Keyword Store (' + keywordStoreSummary.totalKeywords + ' terms):',
            termsList,
            '',
            '## Recent User Messages (' + recentMessages.length + ' messages):',
            messages,
            '',
            '## Correction Trajectory (recent confirmed corrections, D-40-08):',
            trajectory,
            '',
            '## Rules:',
            '- ADD: If a correction pattern is detected in messages but not in store',
            '- UPDATE: If a term\'s weight should change based on TP/FP ratio',
            '- REMOVE: If a term has 0 hits after many uses AND high false positive rate (>0.3)',
            '- Keep reasoning concise (max 100 chars)',
            '- Weight range: 0.1-0.9',
            '',
            'Return strict JSON (no markdown):',
            '{"updated": boolean, "updates": {...}, "summary": string}',
        ].join('\n');
    },

    async parseResult(ctx: WorkflowResultContext): Promise<CorrectionObserverResult | null> {
        const rawText = extractAssistantTextForSpec(ctx.messages, ctx.assistantTexts);
        return parseCorrectionObserverPayload(rawText);
    },

    async persistResult(_ctx: WorkflowPersistContext<CorrectionObserverResult>): Promise<void> {
        // Result persistence is handled by the caller (evolution-worker.ts)
        // which reads the result and applies keyword store updates.
        // This spec handles only the LLM dispatch and result parsing.
    },

    shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
        return status === 'ok';
    },
};

// ── Manager Class ─────────────────────────────────────────────────────────────

export class CorrectionObserverWorkflowManager extends WorkflowManagerBase {
    constructor(opts: CorrectionObserverWorkflowOptions) {
        super({
            workspaceDir: opts.workspaceDir,
            logger: opts.logger,
            subagent: opts.subagent,
            agentSession: opts.agentSession,
            workflowType: 'correction_observer',
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
            this.logger.info(`[PD:CorrectionObserver] Skipping workflow: boot session`);
            throw new Error(`CorrectionObserverWorkflowManager: cannot start workflow for boot session`);
        }

        // Surface degrade: check subagent runtime availability
        if (!isSubagentRuntimeAvailable(this.driver.getSubagent())) {
            this.logger.info(`[PD:CorrectionObserver] Skipping workflow: subagent runtime unavailable`);
            throw new Error(`CorrectionObserverWorkflowManager: subagent runtime unavailable`);
        }

        if (spec.transport !== 'runtime_direct') {
            throw new Error(`CorrectionObserverWorkflowManager only supports runtime_direct transport`);
        }

        return super.startWorkflow(spec, options);
    }

     
    protected override createWorkflowMetadata<TResult>(
        spec: SubagentWorkflowSpec<TResult>,
        options: {
            parentSessionId: string;
            workspaceDir?: string;
            taskInput: unknown;
            metadata?: Record<string, unknown>;
        },
        now: number
    ): WorkflowMetadata {
        return {
            parentSessionId: options.parentSessionId,
            workspaceDir: options.workspaceDir,
            taskInput: options.taskInput,
            startedAt: now,
            workflowType: spec.workflowType,
            ...options.metadata,
        };
    }
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createCorrectionObserverWorkflowManager(
    opts: CorrectionObserverWorkflowOptions
): CorrectionObserverWorkflowManager {
    return new CorrectionObserverWorkflowManager(opts);
}
