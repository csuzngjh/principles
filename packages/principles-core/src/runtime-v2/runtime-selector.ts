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

import { Type, type Static } from '@sinclair/typebox';

import { RuntimeKindSchema } from './runtime-protocol.js';
import type { AgentSpec } from './agent-spec.js';
import type { PDRuntimeAdapter, RuntimeCapabilities, RuntimeHealth, RuntimeKind } from './runtime-protocol.js';

export const RuntimeSelectionCriteriaSchema = Type.Object({
  agentSpec: Type.Object({
    agentId: Type.String(),
    role: Type.String(),
    schemaVersion: Type.String(),
    inputSchemaRef: Type.String(),
    outputSchemaRef: Type.String(),
    timeoutPolicy: Type.Object({ defaultTimeoutMs: Type.Number() }),
    retryPolicy: Type.Object({ maxAttempts: Type.Number() }),
    capabilitiesRequired: Type.Object({
      structuredJson: Type.Boolean(),
      toolUse: Type.Optional(Type.Boolean()),
      workingDirectory: Type.Optional(Type.Boolean()),
    }),
  }),
  workspacePolicy: Type.Optional(Type.Object({
    allowedRuntimes: Type.Optional(Type.Array(RuntimeKindSchema)),
    blockedRuntimes: Type.Optional(Type.Array(RuntimeKindSchema)),
  })),
  fallbackEnabled: Type.Optional(Type.Boolean()),
});
// eslint-disable-next-line @typescript-eslint/no-redeclare
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
