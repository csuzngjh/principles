/**
 * Subagent Workflow Helper - Type Definitions
 * 
 * This file defines the TypeScript interfaces for the workflow helper system
 * that manages subagent lifecycle (empathy observer, deep-reflect, etc.).
 * 
 * Design reference: docs/design/2026-03-31-subagent-workflow-helper-design.md
 * 
 * @module subagent-workflow/types
 */

// ── Workflow Transport ────────────────────────────────────────────────────────

/**
 * First-phase helper transport.
 * This helper currently models only plugin-owned runtime_direct workflows.
 */
export type WorkflowTransport = 'runtime_direct';

// ── Workflow State Machine ───────────────────────────────────────────────────

/**
 * States in the workflow state machine.
 * 
 * State transitions:
 * 
 *   PENDING ──→ ACTIVE ──→ WAIT_RESULT ──→ FINALIZING ──→ COMPLETED
 *                   │              │                              │
 *                   │              ├──────────────────────────────┤
 *                   │              │ (on timeout/error)           │
 *                   │              ▼                              ▼
 *                   │         TERMINAL_ERROR ◄─────────────────┘
 *                   │              │
 *                   │              │ (cleanup_pending if deleteSession fails)
 *                   │              ▼
 *                   └──────── CLEANUP_PENDING
 * 
 * States marked with (*) are terminal states.
 */
export type WorkflowState =
    | 'pending'           // Workflow created, not yet started
    | 'active'           // Subagent spawned, running
    | 'wait_result'      // Waiting for result (runtime_direct path)
    | 'finalizing'       // Reading and parsing result
    | 'completed'        // Successfully finalized and cleaned up (*)
    | 'terminal_error'   // Finalized with error (*)
    | 'cleanup_pending'  // Cleanup failed, pending retry (*)
    | 'expired';        // TTL expired, cleaned up (*)

// ── Workflow Metadata ────────────────────────────────────────────────────────

/**
 * Metadata stored with each workflow for auditing and debugging.
 */
export interface WorkflowMetadata {
    parentSessionId: string;
    workspaceDir?: string;
    taskInput: unknown;
    startedAt: number;
    /** Human-readable workflow type for debugging */
    workflowType: string;
    /** Extra custom metadata specific to workflow type */
    [key: string]: unknown;
}

// ── Workflow Context Types ────────────────────────────────────────────────────

/**
 * Context passed to parseResult() when reading subagent output.
 */
export interface WorkflowResultContext {
    /** Raw messages from getSessionMessages() */
    messages: unknown[];
    /** Convenience: pre-extracted assistant texts */
    assistantTexts?: string[];
    /** The workflow run metadata */
    metadata: WorkflowMetadata;
    /** The subagent run result status (only for runtime_direct) */
    waitStatus?: 'ok' | 'error' | 'timeout';
    /** Error message if waitStatus is 'error' */
    waitError?: string;
}

/**
 * Context passed to persistResult() after successful parsing.
 */
export interface WorkflowPersistContext<TResult> {
    /** Parsed result from parseResult() */
    result: TResult;
    /** The workflow run metadata */
    metadata: WorkflowMetadata;
    /** Workspace context directory */
    workspaceDir: string;
}

// ── Workflow Spec ─────────────────────────────────────────────────────────────

/**
 * Result of calling startWorkflow().
 * Returned to caller so they can track the workflow.
 */
export interface WorkflowHandle {
    /** Unique workflow ID */
    workflowId: string;
    /** Child session key for the subagent */
    childSessionKey: string;
    /** Run ID (only for runtime_direct transport) */
    runId?: string;
    /** The workflow state at creation */
    state: WorkflowState;
}

/**
 * Specification for a subagent workflow.
 * Each workflow type (empathy observer, deep-reflect) implements this spec.
 * 
 * @example
 * ```ts
 * const empathySpec: SubagentWorkflowSpec<EmpathyResult> = {
 *   workflowType: 'empathy-observer',
 *   transport: 'runtime_direct',
 *   timeoutMs: 30_000,
 *   ttlMs: 5 * 60 * 1000,
 *   shouldDeleteSessionAfterFinalize: true,
 *   parseResult: async (ctx) => parseEmpathyResult(ctx),
 *   persistResult: async (ctx) => { /* persist to trajectory *\/ },
 *   shouldFinalizeOnWaitStatus: (status) => status === 'ok',
 * };
 * ```
 */
export interface SubagentWorkflowSpec<TResult> {
    /** Unique identifier for this workflow type */
    workflowType: string;
    /** Which transport mechanism to use */
    transport: WorkflowTransport;
    /** Build the prompt / input payload for the child subagent */
    buildPrompt: (taskInput: unknown, metadata: WorkflowMetadata) => string;
    /** Max time to wait for subagent completion */
    timeoutMs: number;
    /** Time-to-live for orphan cleanup (e.g., 5 minutes) */
    ttlMs: number;
    /** Whether to delete session after successful finalize */
    shouldDeleteSessionAfterFinalize: boolean;
    /**
     * Parse subagent output into structured result.
     * Return null if parsing fails or result is invalid.
     */
    parseResult: (ctx: WorkflowResultContext) => Promise<TResult | null>;
    /**
     * Persist the parsed result to storage (trajectory, pain signal, etc.)
     */
    persistResult: (ctx: WorkflowPersistContext<TResult>) => Promise<void>;
    /**
     * Determine if workflow should finalize given wait status.
     * For runtime_direct: typically finalize only on 'ok', skip on 'timeout'/'error'.
     */
    shouldFinalizeOnWaitStatus: (status: 'ok' | 'error' | 'timeout') => boolean;
}

// ── Empathy Observer Specific Types ──────────────────────────────────────────

/**
 * Payload returned by empathy observer subagent.
 */
export type EmpathyObserverPayload = {
    damageDetected?: boolean;
    severity?: 'mild' | 'moderate' | 'severe' | string;
    confidence?: number;
    reason?: string;
};

/**
 * Empathy observer workflow result.
 */
export interface EmpathyResult {
    damageDetected: boolean;
    severity: 'mild' | 'moderate' | 'severe';
    confidence: number;
    reason: string;
    /** Derived pain score based on severity */
    painScore: number;
}

/**
 * Deep-reflect workflow result.
 */
export interface DeepReflectResult {
    insights: string;
    context: string;
    depth: number;
    modelId: string;
    passed: boolean;
}

/**
 * Empathy observer workflow specification.
 * This is the concrete spec for PR2 migration.
 */
export interface EmpathyObserverWorkflowSpec extends SubagentWorkflowSpec<EmpathyResult> {
    workflowType: 'empathy-observer';
    transport: 'runtime_direct';
    timeoutMs: 30_000;
    ttlMs: 300_000; // 5 minutes
    shouldDeleteSessionAfterFinalize: true;
}

// ── Workflow Manager Interface ─────────────────────────────────────────────────

/**
 * The main workflow manager interface.
 * This is what the helper exposes to business modules.
 */
export interface WorkflowManager {
    /**
     * Start a new workflow.
     * Creates workflow state, spawns subagent, and returns handle.
     */
    startWorkflow: <TResult>(
        spec: SubagentWorkflowSpec<TResult>,
        options: {
            parentSessionId: string;
            workspaceDir?: string;
            taskInput: unknown;
            metadata?: Record<string, unknown>;
        }
    ) => Promise<WorkflowHandle>;

    /**
     * Notify workflow of wait result (runtime_direct path).
     * Called by the wait polling logic after waitForRun completes.
     */
    notifyWaitResult: (
        workflowId: string,
        status: 'ok' | 'error' | 'timeout',
        error?: string
    ) => Promise<void>;

    /**
     * Optional fallback observation path.
     * This is not the primary completion contract for runtime_direct workflows.
     * Use it only for recovery / compatibility if a lifecycle event is observed later.
     */
    notifyLifecycleEvent: (
        workflowId: string,
        event: 'subagent_spawned' | 'subagent_ended',
        data?: {
            outcome?: 'ok' | 'error' | 'timeout' | 'killed' | 'reset' | 'deleted';
            error?: string;
        }
    ) => Promise<void>;

    /**
     * Finalize a workflow exactly once (idempotent).
     * Reads result, parses, persists, and cleans up.
     */
    finalizeOnce: (workflowId: string) => Promise<void>;

    /**
     * Sweep expired workflows (orphan cleanup).
     * Should be called periodically by the evolution worker.
     */
    sweepExpiredWorkflows: (maxAgeMs?: number) => Promise<number>;

    /**
     * Return a compact workflow-centric debug view for operators.
     */
    getWorkflowDebugSummary: (workflowId: string, eventLimit?: number) => Promise<WorkflowDebugSummary | null>;

    /**
     * Release resources (DB connections, timers).
     */
    dispose: () => void;
}

// ── Workflow Store (for SQLite persistence) ──────────────────────────────────

/**
 * Database row for subagent_workflows table.
 */
export interface WorkflowRow {
    workflow_id: string;
    workflow_type: string;
    transport: WorkflowTransport;
    parent_session_id: string;
    child_session_key: string;
    run_id: string | null;
    state: WorkflowState;
    cleanup_state: 'none' | 'pending' | 'failed' | 'completed';
    created_at: number;
    updated_at: number;
    last_observed_at?: number | null;
    metadata_json: string;
}

/**
 * Database row for subagent_workflow_events table.
 */
export interface WorkflowEventRow {
    workflow_id: string;
    event_type: string;
    from_state: WorkflowState | null;
    to_state: WorkflowState;
    reason: string;
    payload_json: string;
    created_at: number;
}

export interface WorkflowDebugSummary {
    workflowId: string;
    workflowType: string;
    transport: WorkflowTransport;
    parentSessionId: string;
    childSessionKey: string;
    runId: string | null;
    state: WorkflowState;
    cleanupState: 'none' | 'pending' | 'failed' | 'completed';
    lastObservedAt: number | null;
    metadata: WorkflowMetadata;
    recentEvents: Array<{
        eventType: string;
        fromState: WorkflowState | null;
        toState: WorkflowState;
        reason: string;
        createdAt: number;
        payload: Record<string, unknown>;
    }>;
}

// ── Convenience Re-exports ────────────────────────────────────────────────────

export type {
    SubagentRunResult,
    SubagentWaitResult,
    SubagentGetSessionMessagesResult,
} from '../../openclaw-sdk.js';

export type { PluginLogger } from '../../openclaw-sdk.js';
