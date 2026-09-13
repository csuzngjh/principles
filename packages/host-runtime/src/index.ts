import {
  isHostEvent,
  isHostEventResult,
  type HostEvent,
  type HostEventResult,
  type HostEventEmitter,
} from '@principles/core/host';
import { RUNTIME_V2_PRINCIPLE_BUDGET } from '@principles/core/runtime-v2';
import { buildActivePrinciplePromptContext } from './active-principle-prompt.js';
import { createProductionRuleHostGate, type RuleContextProvider, type RuleInputEnrichmentProvider } from './production-rulehost-gate.js';
import type { RuleImplementationRuntime } from './rule-implementation-runtime.js';
import { createProductionPainEvidenceHandler, type PainDatabaseFactory, type PainEnrichmentProvider } from './production-pain-evidence.js';
import type { GovernanceHostKind, ToolSemanticRegistry } from '@principles/core/runtime-v2';

export * from './active-principle-prompt.js';
export * from './pd-config.js';
export * from './production-rulehost-gate.js';
export * from './rule-implementation-runtime.js';
export * from './production-pain-evidence.js';
export * from './governance-observation-store.js';
export * from './governance-signal-admission.js';
// PRI-642 Scope B: shared Pain Evidence Ingress — one validated gate for
// every emitter (OpenClaw / Codex / CLI adapters).
export * from './pain-evidence-ingress.js';
export * from './host-liveness-contract.js';
// PRI-624 Slice C: shared internalization consumer execution (OpenClaw
// auto-consumer + Companion workspace worker call the same cycle).
export * from './internalization-consumer-governance.js';
export * from './internalization-consumer-cycle.js';
// PRI-634-F R2: durable host-authored tool declaration — hosts persist, host-
// neutral consumers (pd-cli/pd-console) resolve through the ONE resolver.
export * from './host-tool-declaration.js';
export * from './host-tool-semantic-resolver.js';
// PRI-661: ONE evaluator replay-context builder for host-neutral CLI entries.
export * from './evaluator-runtime-context.js';
// PRI-634 A3: workspace-scoped critical telemetry — canonical implementation
// moved from openclaw-plugin so both hosts share ONE semantics.
export * from './workspace-telemetry-emitter.js';
// Anonymous Product Telemetry v1 (PRI-595~603) — opt-in, default-off,
// read-only with respect to all PD governance facts.
export * from './product-telemetry/consent-store.js';
export * from './product-telemetry/eligibility.js';
export * from './product-telemetry/exporter.js';
export * from './product-telemetry/milestone-readers.js';
export * from './product-telemetry/service.js';
// PRI-625 Slice D: Codex conversation-ingestion consent — G2A frozen
// disclosure SSoT constant + workspace consent record (governance layer; the
// runtime gate remains the feature flag alone).
export * from './codex-disclosure.js';
export * from './codex-ingestion-consent.js';
// PRI-625 Slice D: ONE §15 worker-mode authority, moved from codex-adapter so
// the CLI, the Console, and the worker share the same semantics.
export * from './codex-worker-status.js';
// PRI-625 Slice D: ONE legacy-registration predicate (installer refusal,
// health dualRegistration, and future setup flows all read the same fact).
export * from './codex-legacy-registration.js';
// PRI-625 Slice D: transcript locator moved here so the §15 health service
// computes per-rollout lag with the SAME locator the catch-up path uses.
export * from './codex-transcript-locate.js';

export const HOST_RUNTIME_ROUTES = [
  'before_prompt_build',
  'before_tool_call',
  'after_tool_call',
] as const;

export type HostRuntimeRoute = (typeof HOST_RUNTIME_ROUTES)[number];
export type HostRuntimePort = (event: HostEvent) => HostEventResult | Promise<HostEventResult>;

export interface HostRuntimeOptions {
  beforePromptBuild: HostRuntimePort;
  beforeToolCall: HostRuntimePort;
  afterToolCall: HostRuntimePort;
}

export interface HostRuntimeHealth {
  ok: boolean;
  workspaceDir: string;
  routes: readonly HostRuntimeRoute[];
  reason?: string;
  nextAction?: string;
}

export interface HostRuntime {
  dispatch(event: HostEvent): Promise<HostEventResult>;
  health(workspaceDir: string): Promise<HostRuntimeHealth>;
}

export class HostRuntimeDispatchError extends Error {
  constructor(
    readonly reason: 'invalid_host_event' | 'unsupported_host_event' | 'invalid_handler_result' | 'lineage_mismatch',
    readonly nextAction: string,
  ) {
    super(`${reason}: ${nextAction}`);
    this.name = 'HostRuntimeDispatchError';
  }
}

function portFor(event: HostEvent, options: HostRuntimeOptions): HostRuntimePort {
  switch (event.kind) {
    case 'before_prompt_build':
      return options.beforePromptBuild;
    case 'before_tool_call':
      return options.beforeToolCall;
    case 'after_tool_call':
      return options.afterToolCall;
    default:
      throw new HostRuntimeDispatchError(
        'unsupported_host_event',
        `Only ${HOST_RUNTIME_ROUTES.join(', ')} are supported by the MVP host runtime`,
      );
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbsoluteWorkspace(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value);
}

function hasValidRouteSemantics(event: HostEvent): boolean {
  if (!isNonEmptyString(event.context.workspaceDir) || !isAbsoluteWorkspace(event.context.workspaceDir)) return false;
  if (!isNonEmptyString(event.context.sessionId) || !isNonEmptyString(event.source)) return false;
  if (event.kind === 'before_tool_call' || event.kind === 'after_tool_call') {
    return isNonEmptyString(event.context.toolName);
  }
  return true;
}

function hasNonEmptyOptionalString(value: string | undefined): boolean {
  return value === undefined || isNonEmptyString(value);
}

function hasValidResultSemantics(event: HostEvent, result: HostEventResult): boolean {
  if (result.warnings !== undefined && (!Array.isArray(result.warnings) || !result.warnings.every(isNonEmptyString))) return false;
  if (result.metadata !== undefined && (typeof result.metadata !== 'object' || result.metadata === null || Array.isArray(result.metadata))) return false;
  if (!isNonEmptyString(result.source) || !hasNonEmptyOptionalString(result.reason) || !hasNonEmptyOptionalString(result.additionalContext)) {
    return false;
  }
  const hasReason = result.reason !== undefined;
  const hasModifiedInput = result.modifiedInput !== undefined;
  const hasAdditionalContext = result.additionalContext !== undefined;

  switch (event.kind) {
    case 'before_prompt_build':
      return (result.decision === 'allow' || result.decision === 'modify') && !hasReason && !hasModifiedInput;
    case 'before_tool_call':
      if (result.decision === 'observe') return false;
      if (result.decision === 'deny') return hasReason && !hasModifiedInput && !hasAdditionalContext;
      if (hasReason) return false;
      return !hasModifiedInput || result.decision === 'modify';
    case 'after_tool_call':
      return result.decision === 'observe' && !hasReason && !hasModifiedInput && !hasAdditionalContext;
    default:
      return false;
  }
}

export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
  return {
    async dispatch(event: HostEvent): Promise<HostEventResult> {
      if (!isHostEvent(event) || !hasValidRouteSemantics(event)) {
        throw new HostRuntimeDispatchError(
          'invalid_host_event',
          'Decode and validate the host event before dispatch',
        );
      }

      const result: unknown = await portFor(event, options)(event);
      if (!isHostEventResult(result) || !hasValidResultSemantics(event, result)) {
        throw new HostRuntimeDispatchError(
          'invalid_handler_result',
          `Handler for ${event.kind} must return a valid HostEventResult`,
        );
      }
      if (result.source !== event.source) {
        throw new HostRuntimeDispatchError(
          'lineage_mismatch',
          `Handler result source must match event source ${event.source}`,
        );
      }
      return result;
    },

    async health(workspaceDir: string): Promise<HostRuntimeHealth> {
      if (workspaceDir.trim().length === 0) {
        return {
          ok: false,
          workspaceDir,
          routes: HOST_RUNTIME_ROUTES,
          reason: 'workspace_dir_missing',
          nextAction: 'Resolve an absolute workspace directory before probing host runtime health',
        };
      }
      if (!isAbsoluteWorkspace(workspaceDir)) {
        return {
          ok: false,
          workspaceDir,
          routes: HOST_RUNTIME_ROUTES,
          reason: 'workspace_dir_invalid',
          nextAction: 'Resolve an absolute workspace directory before probing host runtime health',
        };
      }
      return { ok: true, workspaceDir, routes: HOST_RUNTIME_ROUTES };
    },
  };
}

export function createProductionHostRuntime(
  options: Partial<Pick<HostRuntimeOptions, 'afterToolCall'>> & {
    beforeToolCall?: HostRuntimePort;
    beforePromptBuild?: (event: HostEvent, prompt: Awaited<ReturnType<typeof buildActivePrinciplePromptContext>>) => HostEventResult | Promise<HostEventResult>;
    promptExcludePrincipleIds?: (event: HostEvent) => ReadonlySet<string>;
    ruleContextProvider?: RuleContextProvider;
    ruleInputEnrichmentProvider?: RuleInputEnrichmentProvider;
    ruleImplementationRuntime?: RuleImplementationRuntime;
    painEnrichmentProvider?: PainEnrichmentProvider;
    painDatabaseFactory?: PainDatabaseFactory;
    /** PRI-640: host attribution supplied by the constructing host adapter (OpenClaw / Codex). */
    hostKind?: GovernanceHostKind;
    /** PRI-634-F: host-declared tool semantics supplied by the constructing host adapter. */
    toolSemantics?: ToolSemanticRegistry;
    /**
     * PRI-750: optional event emission port. When present, the shared-path
     * handlers record injection/tool events carrying the host's natural
     * turn/tool ids (turnId/toolCallId) in the same events_*.jsonl format as
     * the OpenClaw path (whose events additionally bind to
     * assistant_turns.run_id). Only the Codex host adapter wires this; the
     * OpenClaw plugin path owns its own emission.
     */
    events?: HostEventEmitter;
  } = {},
): HostRuntime {
  const productionGate = createProductionRuleHostGate({
    ...(options.ruleContextProvider ? { ruleContextProvider: options.ruleContextProvider } : {}),
    ...(options.ruleInputEnrichmentProvider ? { ruleInputEnrichmentProvider: options.ruleInputEnrichmentProvider } : {}),
    ...(options.ruleImplementationRuntime ? { implementationRuntime: options.ruleImplementationRuntime } : {}),
    ...(options.toolSemantics ? { toolSemantics: options.toolSemantics } : {}),
  });
  return createHostRuntime({
    afterToolCall: options.afterToolCall ?? createProductionPainEvidenceHandler({
      ...(options.painEnrichmentProvider ? { painEnrichmentProvider: options.painEnrichmentProvider } : {}),
      ...(options.painDatabaseFactory ? { painDatabaseFactory: options.painDatabaseFactory } : {}),
      ...(options.hostKind ? { hostKind: options.hostKind } : {}),
      ...(options.events ? { events: options.events } : {}),
    }),
    beforeToolCall: options.beforeToolCall ?? productionGate,
    async beforePromptBuild(event) {
      const prompt = await buildActivePrinciplePromptContext({
        workspaceDir: event.context.workspaceDir,
        excludePrincipleIds: options.promptExcludePrincipleIds?.(event),
      });
      // PRI-750: record the injection event on the shared path with the host
      // turn id (Codex turn_id → runId) so receipt events carry a turn-level
      // anchor in the same events_*.jsonl format as the OpenClaw path. The
      // OpenClaw plugin additionally persists these to assistant_turns.run_id;
      // the Codex DB-side anchor is a follow-up. Optional port — absent means
      // no-op (the OpenClaw plugin path emits this event itself). Emission
      // failure must not block the prompt result — it degrades to an
      // observable warning (rc-9).
      const emissionWarnings: string[] = [];
      try {
        options.events?.recordRuntimeV2ActivationsInjected({
          sessionId: event.context.sessionId,
          workspaceDir: event.context.workspaceDir,
          principleIds: prompt.principleIds,
          activationIds: prompt.activationIds,
          artifactIds: prompt.artifactIds,
          injectedCount: prompt.principleIds.length,
          skippedWarnings: prompt.warnings,
          injectedCharCount: prompt.additionalContext.length,
          budget: RUNTIME_V2_PRINCIPLE_BUDGET,
          ...(prompt.truncated !== undefined ? { v2Truncated: prompt.truncated } : {}),
          ...(event.context.turnId !== undefined ? { runId: event.context.turnId } : {}),
        });
      } catch (err) {
        emissionWarnings.push(`receipt_event_write_failed:${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
      }
      if (options.beforePromptBuild) return options.beforePromptBuild(event, prompt);
      return {
        decision: prompt.additionalContext.length > 0 ? 'modify' : 'allow',
        source: event.source,
        ...(prompt.additionalContext.length > 0 ? { additionalContext: prompt.additionalContext } : {}),
        ...(emissionWarnings.length > 0 ? { warnings: emissionWarnings } : {}),
      };
    },
  });
}
