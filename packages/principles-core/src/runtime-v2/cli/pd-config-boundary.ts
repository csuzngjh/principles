/**
 * pd-config-boundary.ts — Pure configuration and explicit Runtime V2 scheduling SDK boundary.
 *
 * Core vs Plugin Boundary (ADR-0012 / ADR-0014):
 * This file is purely logic, containing no physical I/O, filesystem reads (fs, path),
 * or direct access to process.env. All external variables and configuration files
 * are explicitly passed in as inputs.
 */

export type PDOperatorAction = 
  | 'diagnose_run' 
  | 'diagnose_status' 
  | 'internalization_run_once' 
  | 'probe';

export interface PDConfig {
  readonly workspaceDir: string;
  readonly runtimeKind: 'test-double' | 'pi-ai' | 'openclaw-cli';
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

export interface PDConfigResolverInputs {
  readonly workspaceDir: string;
  readonly cliOptions: {
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
  };
  readonly envVars: Record<string, string | undefined>;
  readonly fileConfig?: {
    readonly runtimeKind?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly apiKeyEnv?: string;
    readonly baseUrl?: string;
    readonly maxRetries?: number;
    readonly timeoutMs?: number;
  };
}

export interface PDConfigFailure {
  readonly error: string;
  readonly nextAction: string;
}

export type PDConfigResult = 
  | { readonly success: true; readonly config: PDConfig }
  | { readonly success: false; readonly failure: PDConfigFailure };

/**
 * Pure configuration resolver for Runtime V2 execution.
 * Establishes explicit prioritization: CLI options > Environment variables > file policy > defaults.
 * Performs fail-loud validation returning structured failures and actionable operator nextActions.
 */
export function resolvePDConfig(inputs: PDConfigResolverInputs): PDConfigResult {
  if (!inputs.workspaceDir) {
    return {
      success: false,
      failure: {
        error: 'Missing workspace directory.',
        nextAction: 'Provide a workspace directory via --workspace <path> or set the PD_WORKSPACE_DIR environment variable.',
      },
    };
  }

  // 1. Resolve runtime kind: CLI > file config > default ('test-double')
  let resolvedRuntimeStr = inputs.cliOptions.runtime ?? inputs.fileConfig?.runtimeKind ?? 'test-double';
  if (resolvedRuntimeStr === 'config') {
    resolvedRuntimeStr = inputs.fileConfig?.runtimeKind ?? 'pi-ai';
  }

  
  if (resolvedRuntimeStr !== 'test-double' && resolvedRuntimeStr !== 'pi-ai' && resolvedRuntimeStr !== 'openclaw-cli') {
    return {
      success: false,
      failure: {
        error: `Unsupported runtime kind '${resolvedRuntimeStr}'.`,
        nextAction: "Supported runtimes are: 'test-double', 'pi-ai', 'openclaw-cli'. Check your CLI arguments or workflows.yaml config.",
      },
    };
  }

  const runtimeKind: 'test-double' | 'pi-ai' | 'openclaw-cli' = resolvedRuntimeStr;

  // 2. Resolve other properties with CLI > file config
  const provider = inputs.cliOptions.provider ?? inputs.fileConfig?.provider;
  const model = inputs.cliOptions.model ?? inputs.fileConfig?.model;
  const apiKeyEnv = inputs.cliOptions.apiKeyEnv ?? inputs.fileConfig?.apiKeyEnv;
  const baseUrl = inputs.cliOptions.baseUrl ?? inputs.fileConfig?.baseUrl;
  const maxRetries = inputs.cliOptions.maxRetries ?? inputs.fileConfig?.maxRetries;
  const timeoutMs = inputs.cliOptions.timeoutMs ?? inputs.fileConfig?.timeoutMs;
  const { openclawLocal, openclawGateway, agent } = inputs.cliOptions;
  const intake = inputs.cliOptions.intake !== false;

  const config: PDConfig = {
    workspaceDir: inputs.workspaceDir,
    runtimeKind,
    provider,
    model,
    apiKeyEnv,
    baseUrl,
    maxRetries,
    timeoutMs,
    openclawLocal,
    openclawGateway,
    agent,
    intake,
  };

  // 3. Fail-loud validation for runtime kinds
  if (runtimeKind === 'pi-ai') {
    const missing: string[] = [];
    if (!provider) missing.push('provider');
    if (!model) missing.push('model');
    if (!apiKeyEnv) missing.push('apiKeyEnv');

    if (missing.length > 0) {
      return {
        success: false,
        failure: {
          error: `Missing required pi-ai config: ${missing.join(', ')}.`,
          nextAction: `Pass via CLI flags (--provider/--model/--apiKeyEnv) or add to workflows.yaml pd-runtime-v2-diagnosis funnel policy.`,
        },
      };
    }

    // After validation: all fields are confirmed non-null
    const apiKeyEnvName = apiKeyEnv as string;
    if (!inputs.envVars[apiKeyEnvName]) {
      return {
        success: false,
        failure: {
          error: `Environment variable '${apiKeyEnvName}' is not set.`,
          nextAction: `Set the environment variable '${apiKeyEnvName}' in your shell or process environment before running.`,
        },
      };
    }
  }

  if (runtimeKind === 'openclaw-cli') {
    if (openclawLocal && openclawGateway) {
      return {
        success: false,
        failure: {
          error: '--openclaw-local and --openclaw-gateway are mutually exclusive.',
          nextAction: 'Remove one of the flags so only --openclaw-local or --openclaw-gateway is specified.',
        },
      };
    }

    if (!openclawLocal && !openclawGateway) {
      return {
        success: false,
        failure: {
          error: '--openclaw-local or --openclaw-gateway is required when using --runtime openclaw-cli.',
          nextAction: "Specify either '--openclaw-local' or '--openclaw-gateway' CLI flag.",
        },
      };
    }
  }

  return {
    success: true,
    config,
  };
}
