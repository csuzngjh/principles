import * as path from 'path';
import { resolvePDConfig } from '@principles/core/runtime-v2';
import { WorkflowFunnelLoader } from '@principles/core';
import type { PDConfigResult } from '@principles/core/runtime-v2';

import { resolveWorkspaceDir } from './resolve-workspace.js';

export interface CliLoadOptions {
  readonly runtime?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly openclawLocal?: boolean;
  readonly openclawGateway?: boolean;
  readonly agent?: string;
  readonly intake?: boolean;
}

/**
 * Load configuration from filesystem (.state/workflows.yaml funnel policy)
 * and process environment variables, then invoke the pure core resolvePDConfig.
 */
export async function loadAndResolvePDConfig(
  cliOptions: CliLoadOptions,
  workspaceArg?: string,
): Promise<PDConfigResult> {
  const workspaceDir = resolveWorkspaceDir(workspaceArg);
  const stateDir = path.join(workspaceDir, '.state');

  let fileConfig: {
    runtimeKind?: string;
    provider?: string;
    model?: string;
    apiKeyEnv?: string;
    baseUrl?: string;
    maxRetries?: number;
    timeoutMs?: number;
    openclawMode?: 'local' | 'gateway';
  } | undefined = undefined;

  try {
    const loader = new WorkflowFunnelLoader(stateDir);
    const funnel = loader.getFunnel('pd-runtime-v2-diagnosis');
    if (funnel?.policy) {
      fileConfig = {
        runtimeKind: funnel.policy.runtimeKind,
        provider: funnel.policy.provider,
        model: funnel.policy.model,
        apiKeyEnv: funnel.policy.apiKeyEnv,
        baseUrl: funnel.policy.baseUrl,
        maxRetries: funnel.policy.maxRetries,
        timeoutMs: funnel.policy.timeoutMs,
        openclawMode: funnel.policy.openclawMode,
      };
    }
  } catch {
    // Safe fallback if workflows.yaml is missing or throws
  }

  return resolvePDConfig({
    workspaceDir,
    cliOptions,
    envVars: process.env,
    fileConfig,
  });
}
