import {
  isHostEvent,
  isHostEventResult,
  type HostEvent,
  type HostEventResult,
} from '@principles/core/host';

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

export function createHostRuntime(options: HostRuntimeOptions): HostRuntime {
  return {
    async dispatch(event: HostEvent): Promise<HostEventResult> {
      if (!isHostEvent(event)) {
        throw new HostRuntimeDispatchError(
          'invalid_host_event',
          'Decode and validate the host event before dispatch',
        );
      }

      const result: unknown = await portFor(event, options)(event);
      if (!isHostEventResult(result)) {
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
      return { ok: true, workspaceDir, routes: HOST_RUNTIME_ROUTES };
    },
  };
}
