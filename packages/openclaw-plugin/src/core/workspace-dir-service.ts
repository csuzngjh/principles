import type { OpenClawPluginApi, PluginLogger } from '../openclaw-sdk.js';
import { validateWorkspaceDir } from './workspace-dir-validation.js';

export interface WorkspaceResolutionContext {
  workspaceDir?: string;
  agentId?: string;
}

export interface WorkspaceResolutionOptions {
  source?: string;
  required?: boolean;
  fallbackAgentId?: string;
  logger?: PluginLogger;
}

function buildResolutionFailureMessage(source: string, attempts: string[]): string {
  const suffix = attempts.length > 0 ? ` Attempts: ${attempts.join(' | ')}` : '';
  return `[PD:WorkspaceDir] ${source}: unable to resolve a valid workspace directory.${suffix}`;
}

function tryResolveFromAgent(
  api: OpenClawPluginApi,
  agentId: string,
  attempts: string[],
): string | undefined {
  try {
    const resolved = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
    const issue = validateWorkspaceDir(resolved);
    if (!issue) {
      return resolved;
    }
    attempts.push(`agent:${agentId} invalid (${issue})`);
  } catch (error) {
    attempts.push(`agent:${agentId} threw (${String(error)})`);
  }

  return undefined;
}

export function resolveWorkspaceDir(
  api: OpenClawPluginApi,
  ctx: WorkspaceResolutionContext,
  options: WorkspaceResolutionOptions = {},
): string | undefined {
  const source = options.source ?? 'unknown';
  const logger = options.logger ?? api.logger;
  const attempts: string[] = [];

  if (ctx.workspaceDir) {
    const issue = validateWorkspaceDir(ctx.workspaceDir);
    if (!issue) {
      logger.info(`[PD:WorkspaceDir] ${source}: resolved from ctx.workspaceDir`);
      return ctx.workspaceDir;
    }
    attempts.push(`ctx.workspaceDir invalid (${issue})`);
  } else {
    attempts.push('ctx.workspaceDir missing');
  }

  const agentCandidates = [ctx.agentId, options.fallbackAgentId]
    .filter((value, index, all): value is string => !!value && all.indexOf(value) === index);

  for (const agentId of agentCandidates) {
    const resolved = tryResolveFromAgent(api, agentId, attempts);
    if (resolved) {
      logger.info(`[PD:WorkspaceDir] ${source}: resolved from agent:${agentId}`);
      return resolved;
    }
  }

  const message = buildResolutionFailureMessage(source, attempts);
  if (options.required) {
    logger.error(message);
    throw new Error(message);
  }

  logger.warn(message);
  return undefined;
}

export function resolveRequiredWorkspaceDir(
  api: OpenClawPluginApi,
  ctx: WorkspaceResolutionContext,
  options: Omit<WorkspaceResolutionOptions, 'required'> = {},
): string {
  return resolveWorkspaceDir(api, ctx, { ...options, required: true }) as string;
}
