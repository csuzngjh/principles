import {
  RuntimeStateManager,
  SqliteConnection,
  SqliteHistoryQuery,
  SqliteDiagnosticianCommitter,
  DefaultDiagnosticianValidator,
  SqliteContextAssembler,
  resolveRuntimeConfig,
  CandidateIntakeService,
  PrincipleTreeLedgerAdapter,
  PainSignalBridge,
  PiAiRuntimeAdapter,
  storeEmitter,
} from './packages/principles-core/dist/runtime-v2/index.js';

async function main() {
  const workspaceDir = 'D:\\.openclaw\\workspace';
  const stateDir = `${workspaceDir}/.state`;

  const runtimeConfig = resolveRuntimeConfig(stateDir);
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  console.log('1. RuntimeStateManager initialized');

  const connection = new SqliteConnection(workspaceDir);
  connection.getDb();
  console.log('2. SqliteConnection ready');

  const historyQuery = new SqliteHistoryQuery(connection);
  const committer = new SqliteDiagnosticianCommitter(connection);
  const validator = new DefaultDiagnosticianValidator();
  const contextAssembler = new SqliteContextAssembler(
    stateManager.taskStore,
    historyQuery,
    stateManager.runStore,
  );
  console.log('3. ContextAssembler ready');

  const runtimeAdapter = new PiAiRuntimeAdapter({
    provider: String(runtimeConfig.provider),
    model: String(runtimeConfig.model),
    apiKeyEnv: String(runtimeConfig.apiKeyEnv),
    maxRetries: runtimeConfig.maxRetries,
    timeoutMs: runtimeConfig.timeoutMs,
    baseUrl: runtimeConfig.baseUrl,
    workspace: workspaceDir,
  });
  console.log('4. PiAiRuntimeAdapter ready');

  const { DiagnosticianRunner } = await import('./packages/principles-core/dist/runtime-v2/runner/diagnostician-runner.js');
  const runner = new DiagnosticianRunner(
    {
      stateManager,
      contextAssembler,
      runtimeAdapter,
      eventEmitter: storeEmitter,
      validator,
      committer,
    },
    {
      owner: 'debug-test',
      runtimeKind: runtimeConfig.runtimeKind,
      pollIntervalMs: 5000,
      timeoutMs: runtimeConfig.timeoutMs,
      agentId: runtimeConfig.agentId,
    },
  );
  console.log('5. DiagnosticianRunner ready');

  const ledgerAdapter = new PrincipleTreeLedgerAdapter({ stateDir });
  const intakeService = new CandidateIntakeService({ stateManager, ledgerAdapter });
  console.log('6. IntakeService ready');

  const bridge = new PainSignalBridge({
    stateManager,
    runner,
    intakeService,
    autoIntakeEnabled: true,
  });
  console.log('7. PainSignalBridge ready');

  console.log('\nCalling bridge.onPainDetected...');
  try {
    const result = await bridge.onPainDetected({
      painId: `test_${Date.now()}_debug`,
      painType: 'user_frustration',
      source: 'manual',
      reason: 'debug test',
      score: 85,
      sessionId: 'cli',
      agentId: 'debug-test',
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('onPainDetected FAILED:', err.message);
    console.error('Code:', err.code);
    console.error('Stack:', err.stack?.split('\n').slice(0, 10).join('\n'));
  }

  await stateManager.close();
  connection.close();
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error('Stack:', err.stack?.split('\n').slice(0, 5).join('\n'));
});
