/**
 * Canonical AgentSpec definition for PD Runtime v2.
 *
 * Source: PD Runtime Protocol SPEC v1, Section 11
 * Source: PD Runtime-Agnostic Architecture v2, Section 7.3
 * Source: Agent Execution Modes Appendix
 *
 * PD specialized agents are first-class objects, not prompt aliases.
 * Each agent defines its own input/output contracts, capability needs,
 * timeout/retry policies, and runtime preferences.
 */
import { type Static } from '@sinclair/typebox';
export declare const AgentCapabilityRequirementsSchema: import("@sinclair/typebox").TObject<{
    /** Agent requires structured JSON output from the runtime. */
    structuredJson: import("@sinclair/typebox").TBoolean;
    /** Agent needs to invoke tools during execution. */
    toolUse: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    /** Agent needs a specific working directory context. */
    workingDirectory: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
}>;
export type AgentCapabilityRequirements = Static<typeof AgentCapabilityRequirementsSchema>;
export declare const AgentTimeoutPolicySchema: import("@sinclair/typebox").TObject<{
    /** Default timeout in milliseconds for a single execution attempt. */
    defaultTimeoutMs: import("@sinclair/typebox").TNumber;
}>;
export type AgentTimeoutPolicy = Static<typeof AgentTimeoutPolicySchema>;
export declare const AgentRetryPolicySchema: import("@sinclair/typebox").TObject<{
    /** Maximum number of execution attempts before marking the task as failed. */
    maxAttempts: import("@sinclair/typebox").TInteger;
}>;
export type AgentRetryPolicy = Static<typeof AgentRetryPolicySchema>;
export declare const AgentSpecSchema: import("@sinclair/typebox").TObject<{
    /** Unique agent identifier (e.g., "diagnostician", "explorer"). */
    agentId: import("@sinclair/typebox").TString;
    /** Human-readable role name. */
    role: import("@sinclair/typebox").TString;
    /**
     * Schema version for this AgentSpec.
     * Allows explicit evolution of agent contracts.
     */
    schemaVersion: import("@sinclair/typebox").TString;
    /** Reference to the input schema this agent expects. */
    inputSchemaRef: import("@sinclair/typebox").TString;
    /** Reference to the output schema this agent produces. */
    outputSchemaRef: import("@sinclair/typebox").TString;
    /** Reference to the artifact contract, if the agent produces artifacts. */
    artifactContractRef: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Timeout policy for this agent's executions. */
    timeoutPolicy: import("@sinclair/typebox").TObject<{
        /** Default timeout in milliseconds for a single execution attempt. */
        defaultTimeoutMs: import("@sinclair/typebox").TNumber;
    }>;
    /** Retry policy for failed executions. */
    retryPolicy: import("@sinclair/typebox").TObject<{
        /** Maximum number of execution attempts before marking the task as failed. */
        maxAttempts: import("@sinclair/typebox").TInteger;
    }>;
    /** Capability requirements that the runtime must satisfy. */
    capabilitiesRequired: import("@sinclair/typebox").TObject<{
        /** Agent requires structured JSON output from the runtime. */
        structuredJson: import("@sinclair/typebox").TBoolean;
        /** Agent needs to invoke tools during execution. */
        toolUse: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
        /** Agent needs a specific working directory context. */
        workingDirectory: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    /** Preferred runtime kinds, in order of preference. */
    preferredRuntimeKinds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"openclaw">, import("@sinclair/typebox").TLiteral<"openclaw-history">, import("@sinclair/typebox").TLiteral<"claude-cli">, import("@sinclair/typebox").TLiteral<"codex-cli">, import("@sinclair/typebox").TLiteral<"gemini-cli">, import("@sinclair/typebox").TLiteral<"local-worker">, import("@sinclair/typebox").TLiteral<"test-double">]>>>;
    /** Preferred model profile (e.g., "strong-reasoning", "fast-lightweight"). */
    preferredModelProfile: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
}>;
export type AgentSpec = Static<typeof AgentSpecSchema>;
export declare const AGENT_IDS: {
    readonly DIAGNOSTICIAN: "diagnostician";
    readonly EXPLORER: "explorer";
    readonly DREAMER: "dreamer";
    readonly PHILOSOPHER: "philosopher";
    readonly SCRIBE: "scribe";
    readonly ARTIFICER: "artificer";
    readonly REPLAY_JUDGE: "replay-judge";
    readonly RULE_AUTHOR: "rule-author";
};
export type WellKnownAgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
//# sourceMappingURL=agent-spec.d.ts.map