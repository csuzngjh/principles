/**
 * pd diagnose run/status commands — Diagnostician execution and status inspection.
 *
 * Usage:
 *   pd diagnose status --task-id <taskId> --workspace <path>
 *   pd diagnose run --task-id <taskId> --workspace <path>
 */
import {
  RuntimeStateManager,
  SqliteHistoryQuery,
  SqliteContextAssembler,
  SqliteDiagnosticianCommitter,
  StoreEventEmitter,
  storeEmitter,
  DiagnosticianRunner,
  DefaultDiagnosticianValidator,
  TestDoubleRuntimeAdapter,
  OpenClawCliRuntimeAdapter,
  PiAiRuntimeAdapter,
  PDRuntimeError,
  resolveRuntimeConfig,
  run as diagnoseRun,
  status as diagnoseStatus,
} from '@principles/core/runtime-v2';
import type { PDRuntimeAdapter } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface DiagnoseStatusOptions {
  taskId: string;
  workspace?: string;
  json?: boolean;
}

interface DiagnoseRunOptions {
  taskId: string;
  workspace?: string;
  json?: boolean;
  runtime?: string;
  openclawLocal?: boolean;
  openclawGateway?: boolean;
  agent?: string;
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * pd diagnose status --task-id <taskId> [--workspace <path>] [--json]
 *
 * Inspects the current status of a diagnostician task.
 */
export async function handleDiagnoseStatus(opts: DiagnoseStatusOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();
    const result = await diagnoseStatus({
      taskId: opts.taskId,
      stateManager,
    });

    if (!result) {
      console.error(`Task not found: ${opts.taskId}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nDiagnostician Task: ${result.taskId}\n`);
    console.log(`  Status:       ${result.status}`);
    console.log(`  Attempts:     ${result.attemptCount} / ${result.maxAttempts}`);
    if (result.commitId) {
      console.log(`  Result Ref:   commit://${result.commitId}`);
      console.log(`  Commit ID:    ${result.commitId}`);
      console.log(`  Artifact ID:  ${result.artifactId ?? 'N/A'}`);
      console.log(`  Candidates:   ${result.candidateCount ?? 0}`);
    }
    if (result.lastError) {
      console.log(`  Last Error:   ${result.lastError}`);
    }
    console.log('');
  } finally {
    await stateManager.close();
  }
}

/**
 * pd diagnose run --task-id <taskId> [--workspace <path>] [--json]
 *
 * Executes the diagnostician runner for a task.
 */
export async function handleDiagnoseRun(opts: DiagnoseRunOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir(opts.workspace);

  // Validate mutually exclusive flags (HG-03)
  if (opts.openclawLocal && opts.openclawGateway) {
    console.error('error: --openclaw-local and --openclaw-gateway are mutually exclusive');
    process.exit(1);
  }

  // Require explicit runtime mode for openclaw-cli (HG-03, DPB-09)
  const runtimeKind = opts.runtime ?? 'test-double';
  if (runtimeKind === 'openclaw-cli' && !opts.openclawLocal && !opts.openclawGateway) {
    console.error('error: --openclaw-local or --openclaw-gateway is required when using --runtime openclaw-cli');
    process.exit(1);
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    // Build context assembler from internal stores
    const sqliteConn = stateManager.connection;
    const {taskStore} = stateManager;
    const {runStore} = stateManager;
    const historyQuery = new SqliteHistoryQuery(sqliteConn);
    const contextAssembler = new SqliteContextAssembler(taskStore, historyQuery, runStore);

    // Select runtime adapter based on --runtime flag (CLI-02)
    // eslint-disable-next-line @typescript-eslint/init-declarations
    let runtimeAdapter: PDRuntimeAdapter;
    if (runtimeKind === 'openclaw-cli') {
      runtimeAdapter = new OpenClawCliRuntimeAdapter({
        runtimeMode: opts.openclawLocal ? 'local' : 'gateway',
        workspaceDir,
        agentId: opts.agent ?? 'main',
      });

      // TELE-01: runtime_adapter_selected — user explicitly chose openclaw-cli runtime
      storeEmitter.emitTelemetry({
        eventType: 'runtime_adapter_selected',
        traceId: opts.taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'pd-cli-diagnose',
        agentId: 'openclaw-cli-adapter',
        payload: {
          runtimeKind: 'openclaw-cli',
          runtimeMode: opts.openclawLocal ? 'local' : 'gateway',
        },
      });
    } else if (runtimeKind === 'test-double') {
      runtimeAdapter = new TestDoubleRuntimeAdapter({
        onPollRun: (_runId: string) => ({
          runId: _runId,
          status: 'succeeded',
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
        }),
        onFetchOutput: (_runId: string) => ({
          runId: _runId,
          payload: {
            valid: true,
            diagnosisId: `diag-cli-${Date.now()}`,
            taskId: opts.taskId,
            summary: 'CLI test diagnosis — validate tool arguments before execution',
            rootCause: 'Test root cause — missing argument validation',
            violatedPrinciples: [],
            evidence: [],
            recommendations: [
              { kind: 'principle', description: 'Always validate tool arguments before execution to prevent silent failures' },
              { kind: 'rule', description: 'Use schema validation for external inputs' },
            ],
            confidence: 0.9,
          },
        }),
      });
    } else if (runtimeKind === 'pi-ai') {
      // D-06: flags + policy fallback
      // D-01: have flag → use flag, no flag → read from policy
      const stateDir = `${workspaceDir}/.state`;
      let policyConfig: ReturnType<typeof resolveRuntimeConfig>;
      try {
        policyConfig = resolveRuntimeConfig(stateDir);
      } catch {
        policyConfig = { runtimeKind: 'pi-ai', timeoutMs: 300_000, agentId: 'main' };
      }

      const provider = opts.provider ?? policyConfig.provider;
      const model = opts.model ?? policyConfig.model;
      const apiKeyEnv = opts.apiKeyEnv ?? policyConfig.apiKeyEnv;
      const baseUrl = opts.baseUrl ?? policyConfig.baseUrl;
      const maxRetries = opts.maxRetries ?? policyConfig.maxRetries;
      const effectiveTimeoutMs = opts.timeoutMs ?? policyConfig.timeoutMs;

      // D-11: validate config — missing fields + fix suggestion
      const missing: string[] = [];
      if (!provider) missing.push('provider');
      if (!model) missing.push('model');
      if (!apiKeyEnv) missing.push('apiKeyEnv');
      if (missing.length > 0) {
        console.error(
          `error: missing required pi-ai config: ${missing.join(', ')}.\n` +
          `Pass via --flag or add to workflows.yaml pd-runtime-v2-diagnosis funnel policy.\n` +
          `Example:\n` +
          `  pd diagnose run --runtime pi-ai --provider openrouter --model anthropic/claude-sonnet-4 --apiKeyEnv OPENROUTER_API_KEY\n` +
          `  Or add to workflows.yaml:\n` +
          `    policy:\n` +
          `      runtimeKind: pi-ai\n` +
          `      provider: openrouter\n` +
          `      model: anthropic/claude-sonnet-4\n` +
          `      apiKeyEnv: OPENROUTER_API_KEY`,
        );
        process.exit(1);
      }

      // After validation: all fields are defined (process.exit never returns)
      const validProvider = provider!;
      const validModel = model!;
      const validApiKeyEnv = apiKeyEnv!;

      // D-09: validate env var exists
      if (!process.env[validApiKeyEnv]) {
        console.error(`error: environment variable '${validApiKeyEnv}' is not set`);
        process.exit(1);
      }

      runtimeAdapter = new PiAiRuntimeAdapter({
        provider: validProvider,
        model: validModel,
        apiKeyEnv: validApiKeyEnv,
        baseUrl,
        maxRetries,
        timeoutMs: effectiveTimeoutMs,
        workspace: workspaceDir,
      });

      // TELE: runtime_adapter_selected telemetry
      storeEmitter.emitTelemetry({
        eventType: 'runtime_adapter_selected',
        traceId: opts.taskId,
        timestamp: new Date().toISOString(),
        sessionId: 'pd-cli-diagnose',
        agentId: 'pi-ai-adapter',
        payload: { runtimeKind: 'pi-ai', provider: validProvider, model: validModel, baseUrlPresent: !!baseUrl },
      });
    } else {
      console.error(`error: unknown runtime kind '${runtimeKind}' (supported: openclaw-cli, test-double, pi-ai)`);
      process.exit(1);
    }

    const eventEmitter = new StoreEventEmitter();
    const committer = new SqliteDiagnosticianCommitter(sqliteConn);
    const runner = new DiagnosticianRunner(
      {
        stateManager,
        contextAssembler,
        runtimeAdapter,
        eventEmitter,
        validator: new DefaultDiagnosticianValidator(),
        committer,
      },
      {
        owner: 'pd-cli-diagnose',
        runtimeKind,
        pollIntervalMs: 100,
        timeoutMs: 300_000, // 5 min — same as probe timeout for real LLM calls
        agentId: opts.agent,
      },
    );

    console.log(`\nRunning diagnostician for task: ${opts.taskId}`);
    console.log(`Workspace: ${workspaceDir}\n`);

    const result = await diagnoseRun({
      taskId: opts.taskId,
      stateManager,
      runner,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'succeeded') {
        process.exit(1);
      }
      return;
    }

    console.log(`\nResult:`);
    console.log(`  Status:         ${result.status}`);
    console.log(`  Task ID:        ${result.taskId}`);
    if (result.contextHash) {
      console.log(`  Context Hash:  ${result.contextHash.substring(0, 16)}...`);
    }
    if (result.output) {
      console.log(`  Diagnosis ID:   ${result.output.diagnosisId}`);
      console.log(`  Summary:        ${result.output.summary}`);
      if (result.output.recommendations) {
        const principleCount = result.output.recommendations.filter((r: { kind: string }) => r.kind === 'principle').length;
        if (principleCount > 0) {
          console.log(`  Principles:     ${principleCount} candidate(s) generated`);
        }
      }
    }
    if (result.errorCategory) {
      console.log(`  Error Category: ${result.errorCategory}`);
    }
    if (result.failureReason) {
      console.log(`  Failure Reason: ${result.failureReason}`);
    }
    console.log(`  Attempt Count:  ${result.attemptCount}`);
    console.log('');

    if (result.status !== 'succeeded') {
      process.exit(1);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    let errorCategory = 'execution_failed';
    if (error instanceof PDRuntimeError) {
      errorCategory = error.category;
    }
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'failed',
        errorCategory,
        message,
        runtimeKind,
      }, null, 2));
    } else {
      console.error(`error: ${message} (${errorCategory})`);
    }
    process.exit(1);
  } finally {
    await stateManager.close();
  }
}
