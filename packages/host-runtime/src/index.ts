import {
  isHostEvent,
  isHostEventResult,
  type HostEvent,
  type HostEventResult,
} from '@principles/core/host';
import { buildActivePrinciplePromptContext } from './active-principle-prompt.js';
import { createProductionRuleHostGate, type RuleContextProvider, type RuleInputEnrichmentProvider } from './production-rulehost-gate.js';
import type { RuleImplementationRuntime } from './rule-implementation-runtime.js';
import { createProductionPainEvidenceHandler, type PainDatabaseFactory, type PainEnrichmentProvider } from './production-pain-evidence.js';

export * from './active-principle-prompt.js';
export * from './pd-config.js';
export * from './production-rulehost-gate.js';
export * from './rule-implementation-runtime.js';
export * from './production-pain-evidence.js';
export * from './governance-observation-store.js';
export * from './governance-signal-admission.js';
export * from './host-liveness-contract.js';
// PRI-624 Slice C: shared internalization consumer execution (OpenClaw
// auto-consumer + Companion workspace worker call the same cycle).
export * from './internalization-consumer-governance.js';
export * from './internalization-consumer-cycle.js';
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
  } = {},
): HostRuntime {
  const productionGate = createProductionRuleHostGate({
    ...(options.ruleContextProvider ? { ruleContextProvider: options.ruleContextProvider } : {}),
    ...(options.ruleInputEnrichmentProvider ? { ruleInputEnrichmentProvider: options.ruleInputEnrichmentProvider } : {}),
    ...(options.ruleImplementationRuntime ? { implementationRuntime: options.ruleImplementationRuntime } : {}),
  });
  return createHostRuntime({
    afterToolCall: options.afterToolCall ?? createProductionPainEvidenceHandler({
      ...(options.painEnrichmentProvider ? { painEnrichmentProvider: options.painEnrichmentProvider } : {}),
      ...(options.painDatabaseFactory ? { painDatabaseFactory: options.painDatabaseFactory } : {}),
    }),
    beforeToolCall: options.beforeToolCall ?? productionGate,
    async beforePromptBuild(event) {
      const prompt = await buildActivePrinciplePromptContext({
        workspaceDir: event.context.workspaceDir,
        excludePrincipleIds: options.promptExcludePrincipleIds?.(event),
      });
      if (options.beforePromptBuild) return options.beforePromptBuild(event, prompt);
      return {
        decision: prompt.additionalContext.length > 0 ? 'modify' : 'allow',
        source: event.source,
        ...(prompt.additionalContext.length > 0 ? { additionalContext: prompt.additionalContext } : {}),
      };
    },
  });
}
