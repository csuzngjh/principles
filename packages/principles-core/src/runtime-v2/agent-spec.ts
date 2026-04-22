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
import { Type, type Static } from '@sinclair/typebox';

import { RuntimeKindSchema } from './runtime-protocol.js';

// ── Capability requirements that an agent declares it needs ──

export const AgentCapabilityRequirementsSchema = Type.Object({
  /** Agent requires structured JSON output from the runtime. */
  structuredJson: Type.Boolean(),
  /** Agent needs to invoke tools during execution. */
  toolUse: Type.Optional(Type.Boolean()),
  /** Agent needs a specific working directory context. */
  workingDirectory: Type.Optional(Type.Boolean()),
});
 
export type AgentCapabilityRequirements = Static<typeof AgentCapabilityRequirementsSchema>;

// ── Timeout policy ──

export const AgentTimeoutPolicySchema = Type.Object({
  /** Default timeout in milliseconds for a single execution attempt. */
  defaultTimeoutMs: Type.Number({ minimum: 0 }),
});
 
export type AgentTimeoutPolicy = Static<typeof AgentTimeoutPolicySchema>;

// ── Retry policy ──

export const AgentRetryPolicySchema = Type.Object({
  /** Maximum number of execution attempts before marking the task as failed. */
  maxAttempts: Type.Integer({ minimum: 1 }),
});
 
export type AgentRetryPolicy = Static<typeof AgentRetryPolicySchema>;

// ── AgentSpec: the canonical agent description ──

export const AgentSpecSchema = Type.Object({
  /** Unique agent identifier (e.g., "diagnostician", "explorer"). */
  agentId: Type.String({ minLength: 1 }),

  /** Human-readable role name. */
  role: Type.String({ minLength: 1 }),

  /**
   * Schema version for this AgentSpec.
   * Allows explicit evolution of agent contracts.
   */
  schemaVersion: Type.String({ minLength: 1 }),

  /** Reference to the input schema this agent expects. */
  inputSchemaRef: Type.String({ minLength: 1 }),

  /** Reference to the output schema this agent produces. */
  outputSchemaRef: Type.String({ minLength: 1 }),

  /** Reference to the artifact contract, if the agent produces artifacts. */
  artifactContractRef: Type.Optional(Type.String()),

  /** Timeout policy for this agent's executions. */
  timeoutPolicy: AgentTimeoutPolicySchema,

  /** Retry policy for failed executions. */
  retryPolicy: AgentRetryPolicySchema,

  /** Capability requirements that the runtime must satisfy. */
  capabilitiesRequired: AgentCapabilityRequirementsSchema,

  /** Preferred runtime kinds, in order of preference. */
  preferredRuntimeKinds: Type.Optional(Type.Array(RuntimeKindSchema)),

  /** Preferred model profile (e.g., "strong-reasoning", "fast-lightweight"). */
  preferredModelProfile: Type.Optional(Type.String()),
});
 
export type AgentSpec = Static<typeof AgentSpecSchema>;

// ── Well-known agent IDs ──

export const AGENT_IDS = {
  DIAGNOSTICIAN: 'diagnostician',
  EXPLORER: 'explorer',
  DREAMER: 'dreamer',
  PHILOSOPHER: 'philosopher',
  SCRIBE: 'scribe',
  ARTIFICER: 'artificer',
  REPLAY_JUDGE: 'replay-judge',
  RULE_AUTHOR: 'rule-author',
} as const;

export type WellKnownAgentId = (typeof AGENT_IDS)[keyof typeof AGENT_IDS];
