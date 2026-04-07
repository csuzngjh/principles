import type { PluginLogger } from '../../openclaw-sdk.js';
import type {
    SubagentWorkflowSpec,
    WorkflowMetadata,
    EmpathyObserverPayload,
    EmpathyResult,
    WorkflowResultContext,
    WorkflowPersistContext,
} from './types.js';
import { RuntimeDirectDriver } from './runtime-direct-driver.js';
import { WorkspaceContext } from '../../core/workspace-context.js';
import { trackFriction } from '../../core/session-tracker.js';
import { isSubagentRuntimeAvailable } from '../../utils/subagent-probe.js';
import { WorkflowManagerBase } from './workflow-manager-base.js';
import { applyKeywordUpdates } from '../../core/empathy-keyword-matcher.js';
import { loadKeywordStore, saveKeywordStore } from '../../core/empathy-keyword-matcher.js';
import * as path from 'path';

const WORKFLOW_SESSION_PREFIX = 'agent:main:subagent:workflow-';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface EmpathyObserverWorkflowOptions {
    workspaceDir: string;
    logger: PluginLogger;
    subagent: RuntimeDirectDriver['subagent'];
}

export class EmpathyObserverWorkflowManager extends WorkflowManagerBase {
    constructor(opts: EmpathyObserverWorkflowOptions) {
        super({
            workspaceDir: opts.workspaceDir,
            logger: opts.logger,
            subagent: opts.subagent,
            workflowType: 'empathy-observer',
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
    ): Promise<import('./types.js').WorkflowHandle> {
        // Surface degrade: skip boot sessions (they run outside gateway request context)
        if (options.parentSessionId.startsWith('boot-')) {
            this.logger.info(`[PD:EmpathyObserverWorkflow] Skipping workflow: boot session (gateway request context unavailable)`);
            throw new Error(`EmpathyObserverWorkflowManager: cannot start workflow for boot session`);
        }

        // Surface degrade: check subagent runtime availability before calling run()
        if (!isSubagentRuntimeAvailable(this.driver.getSubagent())) {
            this.logger.info(`[PD:EmpathyObserverWorkflow] Skipping workflow: subagent runtime unavailable`);
            throw new Error(`EmpathyObserverWorkflowManager: subagent runtime unavailable`);
        }

        if (spec.transport !== 'runtime_direct') {
            throw new Error(`EmpathyObserverWorkflowManager only supports runtime_direct transport`);
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
        // EmpathyObserver stores standard metadata
        return {
            parentSessionId: options.parentSessionId,
            workspaceDir: options.workspaceDir,
            taskInput: options.taskInput,
            startedAt: now,
            workflowType: spec.workflowType,
            ...options.metadata,
        };
    }

    // ── EmpathyObserver-Specific Methods ─────────────────────────────────────

    static buildEmpathyPrompt(userMessage: string): string {
        return [
            'You are an empathy observer.',
            'Analyze ONLY the user message and return strict JSON (no markdown):',
            '{"damageDetected": boolean, "severity": "mild|moderate|severe", "confidence": number, "reason": string}',
            `User message: ${JSON.stringify(userMessage.trim())}`,
        ].join('\n');
    }

    private extractAssistantText(messages: unknown[], assistantTexts?: string[]): string {
        if (assistantTexts && assistantTexts.length > 0) {
            return assistantTexts[assistantTexts.length - 1] || '';
        }

        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i] as { role?: string; content?: unknown };
            if (msg?.role !== 'assistant') continue;
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) {
                const txt = msg.content
                    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                    .map((part: any) => part.text)
                    .join('\n');
                if (txt) return txt;
            }
        }

        return '';
    }

    parseEmpathyPayload(rawText: string): EmpathyObserverPayload | null {
        if (!rawText?.trim()) return null;

        try {
            return JSON.parse(rawText.trim()) as EmpathyObserverPayload;
        } catch {
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) {
                this.logger.warn('[PD:EmpathyObserverWorkflow] Observer payload is not valid JSON');
                return null;
            }
            try {
                return JSON.parse(match[0]) as EmpathyObserverPayload;
            } catch {
                this.logger.warn('[PD:EmpathyObserverWorkflow] Failed to parse observer JSON payload');
                return null;
            }
        }
    }

    protected override generateWorkflowId(): string {
        return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createEmpathyObserverWorkflowManager(
    opts: EmpathyObserverWorkflowOptions
): EmpathyObserverWorkflowManager {
    return new EmpathyObserverWorkflowManager(opts);
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

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
                .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
                .map((part: any) => part.text)
                .join('\n');
            if (txt) return txt;
        }
    }
    return '';
}

/**
 * Parse empathy observer JSON payload from raw text.
 */
function parseEmpathyPayloadForSpec(rawText: string): EmpathyObserverPayload | null {
    if (!rawText?.trim()) return null;
    try {
        return JSON.parse(rawText.trim()) as EmpathyObserverPayload;
    } catch {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]) as EmpathyObserverPayload;
        } catch {
            return null;
        }
    }
}

/**
 * Normalize severity to valid enum.
 */
function normalizeSeverityForSpec(severity: string | undefined): 'mild' | 'moderate' | 'severe' {
    if (severity === 'severe') return 'severe';
    if (severity === 'moderate') return 'moderate';
    return 'mild';
}

/**
 * Normalize confidence to [0, 1] range.
 */
function normalizeConfidenceForSpec(value: number | undefined): number {
    if (!Number.isFinite(value)) return 1;
    return Math.max(0, Math.min(1, Number(value)));
}

/**
 * Calculate pain score from severity using config.
 */
function scoreFromSeverityForSpec(severity: string | undefined, wctx: WorkspaceContext): number {
    if (severity === 'severe') return Number(wctx.config.get('empathy_engine.penalties.severe') ?? 40);
    if (severity === 'moderate') return Number(wctx.config.get('empathy_engine.penalties.moderate') ?? 25);
    return Number(wctx.config.get('empathy_engine.penalties.mild') ?? 10);
}

// ─── Workflow Spec ─────────────────────────────────────────────────────────────

export const empathyObserverWorkflowSpec: SubagentWorkflowSpec<EmpathyResult> = {
    workflowType: 'empathy-observer',
    transport: 'runtime_direct',
    timeoutMs: 30_000,
    ttlMs: 300_000,
    shouldDeleteSessionAfterFinalize: true,

    buildPrompt(taskInput: unknown, _metadata: WorkflowMetadata): string {
        const userMessage = String(taskInput).trim();
        return [
            'You are an empathy observer.',
            'Analyze ONLY the user message and return strict JSON (no markdown):',
            '{"damageDetected": boolean, "severity": "mild|moderate|severe", "confidence": number, "reason": string}',
            `User message: ${JSON.stringify(userMessage)}`,
        ].join('\n');
    },

    async parseResult(ctx: WorkflowResultContext): Promise<EmpathyResult | null> {
        const rawText = extractAssistantTextForSpec(ctx.messages, ctx.assistantTexts);
        const payload = parseEmpathyPayloadForSpec(rawText);
        if (!payload) return null;

        return {
            damageDetected: payload.damageDetected ?? false,
            severity: normalizeSeverityForSpec(payload.severity),
            confidence: normalizeConfidenceForSpec(payload.confidence),
            reason: payload.reason ?? '',
            painScore: 0,
        };
    },

    async persistResult(ctx: WorkflowPersistContext<EmpathyResult>): Promise<void> {
        const { result, metadata, workspaceDir } = ctx;
        if (!result.damageDetected) return;

        const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
        const painScore = scoreFromSeverityForSpec(result.severity, wctx);

        trackFriction(
            metadata.parentSessionId,
            painScore,
            `observer_empathy_${result.severity}`,
            workspaceDir,
            { source: 'user_empathy' }
        );

        const eventId = `emp_obs_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        wctx.eventLog.recordPainSignal(metadata.parentSessionId, {
            score: painScore,
            source: 'user_empathy',
            reason: result.reason || 'Empathy observer detected likely user frustration.',
            isRisky: false,
            origin: 'system_infer',
            severity: result.severity,
            confidence: result.confidence,
            detection_mode: 'structured',
            deduped: false,
            trigger_text_excerpt: String(metadata.taskInput ?? '').substring(0, 120),
            raw_score: painScore,
            calibrated_score: painScore,
            eventId,
        });

        try {
            wctx.trajectory?.recordPainEvent?.({
                sessionId: metadata.parentSessionId,
                source: 'user_empathy',
                score: painScore,
                reason: result.reason || 'Empathy observer detected likely user frustration.',
                severity: result.severity,
                origin: 'system_infer',
                confidence: result.confidence,
                // Use runtime check instead of type assertion
                text: typeof metadata.taskInput === 'string' ? metadata.taskInput : undefined,
            });
        } catch (error) {
            console.warn(`[PD:EmpathyObserverWorkflow] Failed to persist trajectory: ${String(error)}`);
        }
    },

    shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
        return status === 'ok';
    },
};

// ─── Keyword Optimizer Workflow Spec ────────────────────────────────────────

export const empathyOptimizerWorkflowSpec: SubagentWorkflowSpec<{ added: number; updated: number; removed: number }> = {
    workflowType: 'empathy-optimizer',
    transport: 'runtime_direct',
    timeoutMs: 90_000,
    ttlMs: 300_000,
    shouldDeleteSessionAfterFinalize: false,

    buildPrompt(taskInput: unknown, _metadata: WorkflowMetadata): string {
        const input = taskInput as { prompt: string };
        return input.prompt || 'Optimize empathy keywords.';
    },

    async parseResult(ctx: WorkflowResultContext): Promise<{ added: number; updated: number; removed: number } | null> {
        const rawText = extractAssistantTextForSpec(ctx.messages, ctx.assistantTexts);
        if (!rawText) return null;

        // Extract JSON from the response
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn(`[PD:EmpathyOptimizer] No JSON found in subagent response`);
            return null;
        }

        try {
            const updates = JSON.parse(jsonMatch[0]);
            if (!updates.updates || typeof updates.updates !== 'object') {
                console.warn(`[PD:EmpathyOptimizer] Invalid updates format: ${JSON.stringify(updates).substring(0, 100)}`);
                return null;
            }

            // Get keyword store from metadata
            const metadata = ctx.metadata;
            const stateDir = metadata.workspaceDir ? path.join(metadata.workspaceDir as string, '.state') : '';
            if (!stateDir) return null;

            const keywordStore = loadKeywordStore(stateDir, (metadata.language as 'zh' | 'en') || 'zh');
            const result = applyKeywordUpdates(keywordStore, updates.updates);

            // Save updated store
            saveKeywordStore(stateDir, keywordStore);
            console.info(`[PD:EmpathyOptimizer] Applied updates: +${result.added}, ~${result.updated}, -${result.removed}`);

            return result;
        } catch (err) {
            console.warn(`[PD:EmpathyOptimizer] Failed to parse updates JSON: ${String(err)}`);
            return null;
        }
    },

    async persistResult(ctx: WorkflowPersistContext<{ added: number; updated: number; removed: number }>): Promise<void> {
        const { result } = ctx;
        if (!result || (result.added === 0 && result.updated === 0 && result.removed === 0)) {
            console.info(`[PD:EmpathyOptimizer] No changes applied`);
            return;
        }
        console.info(`[PD:EmpathyOptimizer] Persisted optimization results: +${result.added}, ~${result.updated}, -${result.removed}`);
    },

    shouldFinalizeOnWaitStatus(status: 'ok' | 'error' | 'timeout'): boolean {
        return status === 'ok';
    },
};
