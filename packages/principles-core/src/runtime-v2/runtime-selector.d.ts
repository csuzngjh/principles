/**
 * Runtime Selector contract for PD Runtime v2.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 10A
 * Source: PD Runtime-Agnostic Architecture v2, Section 9.5
 *
 * The RuntimeSelector deterministically chooses a runtime backend
 * for a given agent execution request.
 *
 * M1 ONLY: defines the interface. Implementation belongs to later milestones.
 */
import { type Static } from '@sinclair/typebox';
import type { PDRuntimeAdapter, RuntimeCapabilities, RuntimeHealth, RuntimeKind } from './runtime-protocol.js';
export declare const RuntimeSelectionCriteriaSchema: import("@sinclair/typebox").TObject<{
    agentSpec: import("@sinclair/typebox").TObject<{
        agentId: import("@sinclair/typebox").TString;
        role: import("@sinclair/typebox").TString;
        schemaVersion: import("@sinclair/typebox").TString;
        inputSchemaRef: import("@sinclair/typebox").TString;
        outputSchemaRef: import("@sinclair/typebox").TString;
        artifactContractRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        timeoutPolicy: import("@sinclair/typebox").TObject<{
            defaultTimeoutMs: import("@sinclair/typebox").TNumber;
        }>;
        retryPolicy: import("@sinclair/typebox").TObject<{
            maxAttempts: import("@sinclair/typebox").TInteger;
        }>;
        capabilitiesRequired: import("@sinclair/typebox").TObject<{
            structuredJson: import("@sinclair/typebox").TBoolean;
            toolUse: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
            workingDirectory: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        }>;
        preferredRuntimeKinds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"openclaw">, import("@sinclair/typebox").TLiteral<"openclaw-history">, import("@sinclair/typebox").TLiteral<"claude-cli">, import("@sinclair/typebox").TLiteral<"codex-cli">, import("@sinclair/typebox").TLiteral<"gemini-cli">, import("@sinclair/typebox").TLiteral<"local-worker">, import("@sinclair/typebox").TLiteral<"test-double">]>>>;
        preferredModelProfile: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    }>;
    workspacePolicy: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TObject<{
        allowedRuntimes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"openclaw">, import("@sinclair/typebox").TLiteral<"openclaw-history">, import("@sinclair/typebox").TLiteral<"claude-cli">, import("@sinclair/typebox").TLiteral<"codex-cli">, import("@sinclair/typebox").TLiteral<"gemini-cli">, import("@sinclair/typebox").TLiteral<"local-worker">, import("@sinclair/typebox").TLiteral<"test-double">]>>>;
        blockedRuntimes: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"openclaw">, import("@sinclair/typebox").TLiteral<"openclaw-history">, import("@sinclair/typebox").TLiteral<"claude-cli">, import("@sinclair/typebox").TLiteral<"codex-cli">, import("@sinclair/typebox").TLiteral<"gemini-cli">, import("@sinclair/typebox").TLiteral<"local-worker">, import("@sinclair/typebox").TLiteral<"test-double">]>>>;
    }>>;
    fallbackEnabled: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export type RuntimeSelectionCriteria = Static<typeof RuntimeSelectionCriteriaSchema>;
export interface RuntimeSelectionResult {
    /** The selected runtime adapter. */
    adapter: PDRuntimeAdapter;
    /** Why this runtime was selected. */
    reason: string;
    /** Whether this is a fallback selection (not the agent's preferred runtime). */
    isFallback: boolean;
}
/**
 * Selects a runtime adapter for a given agent execution request.
 *
 * The selector considers:
 *   - AgentSpec.preferredRuntimeKinds
 *   - runtime capability probe results
 *   - runtime health state
 *   - workspace policy
 *   - fallback policy
 *
 * If no runtime satisfies the required capabilities, selection must fail
 * explicitly rather than silently degrading into an unsafe runtime.
 */
export interface RuntimeSelector {
    /**
     * Select the best available runtime for the given criteria.
     * Throws PDRuntimeError('capability_missing') if no suitable runtime exists.
     */
    select(criteria: RuntimeSelectionCriteria): Promise<RuntimeSelectionResult>;
    /** Register a runtime adapter for selection. */
    register(adapter: PDRuntimeAdapter): void;
    /** Get a snapshot of all registered runtimes' health. */
    getHealthSnapshot(): Promise<Map<RuntimeKind, RuntimeHealth>>;
    /** Get a snapshot of all registered runtimes' capabilities. */
    getCapabilitiesSnapshot(): Promise<Map<RuntimeKind, RuntimeCapabilities>>;
}
//# sourceMappingURL=runtime-selector.d.ts.map