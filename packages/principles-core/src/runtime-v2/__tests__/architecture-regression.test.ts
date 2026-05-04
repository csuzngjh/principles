/**
 * Architecture regression guard — verifies critical PRI-12/13/14/15/16/28
 * module boundaries are present and exportable.
 *
 * Add entries here whenever a new service/read-model boundary is established.
 */
import { describe, it, expect } from 'vitest';

// ── Source-file existence ──────────────────────────────────────────────────

const REQUIRED_SOURCE_FILES = [
  'pain-to-principle-service.ts',
  'pain-chain-read-model.ts',
  'pain-signal-bridge.ts',
  'pain-signal-runtime-factory.ts',
  'pain-signal-observability.ts',
  'pruning-read-model.ts',
  'pruning-review-log.ts',
  // PRI-28
  'operator-health-read-model.ts',
  'candidate-audit.ts',
  // PRI-42
  'internalization/rule-host-contracts.ts',
  'internalization/rule-host-helpers.ts',
  'internalization/index.ts',
  // PRI-43
  'internalization/internalization-route.ts',
  // PRI-44
  'internalization/template-generator.ts',
  'internalization/rule-code-validator.ts',
  'internalization/compile-result.ts',
  // PRI-45
  'internalization/rule-host-evaluator.ts',
  'internalization/rule-host-adapter.ts',
] as const;

const REQUIRED_TEST_FILES = [
  'pain-to-principle-service.test.ts',
  'pain-chain-read-model.test.ts',
  'pruning-read-model.test.ts',
  'pruning-review-log.test.ts',
  // PRI-28
  'operator-health-read-model.test.ts',
  'candidate-audit.test.ts',
];

const REQUIRED_DOC_FILES = [
  '../../../../../docs/adr/0001-runtime-v2-service-boundaries.md',
];

for (const file of REQUIRED_SOURCE_FILES) {
  it(`source file ${file} is present`, async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', file))).toBe(true);
  });
}

for (const file of REQUIRED_TEST_FILES) {
  it(`test file __tests__/${file} is present`, async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, file))).toBe(true);
  });
}

for (const file of REQUIRED_DOC_FILES) {
  it(`doc file ${file} is present`, async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, file))).toBe(true);
  });
}

// ── Public API exports ─────────────────────────────────────────────────────

describe('runtime-v2 public API (index.ts barrel)', () => {
  const barrel = import('../index.js');

  const REQUIRED_EXPORTS = [
    // PRI-12
    'PainToPrincipleService',
    // PRI-14
    'PainChainReadModel',
    // M8
    'PainSignalBridge',
    'createPainSignalBridge',
    'recordPainSignalObservability',
    // PRI-15
    'PruningReadModel',
    // PRI-13 → factory
    'resolveRuntimeConfig',
    'validateRuntimeConfig',
    // PRI-28
    'OperatorHealthReadModel',
    'auditCandidateLedgerConsistency',
    // PRI-43
    'decideInternalizationRoute',
    // PRI-44
    'generateFromTemplate',
    'checkForbiddenPatterns',
    // PRI-45
    'mergeDecisions',
  ];

  for (const name of REQUIRED_EXPORTS) {
    it(`exports ${name}`, async () => {
      const mod = (await barrel) as Record<string, unknown>;
      expect(mod).toHaveProperty(name);
      expect(typeof mod[name]).toBe('function');
    });
  }
});

// ── OpenClawPlugin pain hook integration ───────────────────────────────────

describe('openclaw-plugin pain hook integration', () => {
  it('pain.ts uses PainToPrincipleService (not createPainSignalBridge)', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const painHookPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/hooks/pain.ts',
    );
    expect(existsSync(painHookPath)).toBe(true);
    const src = readFileSync(painHookPath, 'utf-8');
    expect(src).toContain('PainToPrincipleService');
    expect(src).not.toContain('createPainSignalBridge');
  });

  // PRI-29: emitPainDetectedEvent → PainToPrincipleService service contract
  it('pain.ts emitPainDetectedEvent calls PainToPrincipleService.recordPain on pain_detected', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const painHookPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/hooks/pain.ts',
    );
    expect(existsSync(painHookPath)).toBe(true);
    const src = readFileSync(painHookPath, 'utf-8');
    // Must call service.recordPain() inside emitPainDetectedEvent
    expect(src).toMatch(/service\.recordPain\(/);
    // Must log PAIN_SERVICE_FAILED for failure results
    expect(src).toMatch(/PAIN_SERVICE_FAILED/);
    // Must log PAIN_SERVICE_SKIPPED for skipped results
    expect(src).toMatch(/PAIN_SERVICE_SKIPPED/);
    // Must log PAIN_SERVICE_ERROR for exceptions
    expect(src).toMatch(/PAIN_SERVICE_ERROR/);
    // Must NOT use legacy createPainSignalBridge
    expect(src).not.toMatch(/createPainSignalBridge/);
  });
});

// ── PRI-42: Internalization boundary guards ──────────────────────────────────

describe('PRI-42 internalization boundary', () => {
  const CONTRACT_TYPES = [
    'RuleHostInput',
    'RuleHostResult',
    'RuleHostDecision',
    'RuleHostMeta',
    'LoadedImplementation',
  ];

  it('core internalization has zero openclaw-plugin imports', async () => {
    const { existsSync, readdirSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const intDir = resolve(__dirname, '..', 'internalization');
    expect(existsSync(intDir)).toBe(true);

    const files = readdirSync(intDir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const src = readFileSync(join(intDir, file), 'utf-8');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('../../../openclaw-plugin');
    }
  });

  it('plugin does not re-define RuleHost contract types locally', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const typesPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/rule-host-types.ts',
    );
    expect(existsSync(typesPath)).toBe(true);
    const src = readFileSync(typesPath, 'utf-8');

    // After PRI-42, rule-host-types.ts should re-export from core, not define interfaces
    for (const typeName of CONTRACT_TYPES) {
      expect(src).toContain(typeName);
      expect(src).toContain("from '@principles/core/runtime-v2'");
    }
  });

  it('plugin does not re-define RuleHostHelpers locally', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const helpersPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/rule-host-helpers.ts',
    );
    expect(existsSync(helpersPath)).toBe(true);
    const src = readFileSync(helpersPath, 'utf-8');

    // After PRI-42, rule-host-helpers.ts should re-export from core, not define interface
    expect(src).toContain('RuleHostHelpers');
    expect(src).toContain('createRuleHostHelpers');
    expect(src).toContain("from '@principles/core/runtime-v2'");
  });

  it('plugin rule-host.ts imports contracts from core barrel', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const ruleHostPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/rule-host.ts',
    );
    expect(existsSync(ruleHostPath)).toBe(true);
    const src = readFileSync(ruleHostPath, 'utf-8');

    // Must import from @principles/core/runtime-v2, not local rule-host-types
    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).not.toContain("from './rule-host-types.js'");
  });

  it('plugin gate.ts imports RuleHostInput from core barrel', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const gatePath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/hooks/gate.ts',
    );
    expect(existsSync(gatePath)).toBe(true);
    const src = readFileSync(gatePath, 'utf-8');

    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).not.toContain("from '../core/rule-host-types.js'");
  });

  it('plugin replay-engine.ts imports contracts from core barrel', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const replayPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/replay-engine.ts',
    );
    expect(existsSync(replayPath)).toBe(true);
    const src = readFileSync(replayPath, 'utf-8');

    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).not.toContain("from './rule-host-types.js'");
    expect(src).not.toContain("from './rule-host-helpers.js'");
  });

  it('plugin nocturnal-rule-implementation-validator.ts imports contracts from core barrel', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const validatorPath = resolve(
      __dirname,
      '../../../../openclaw-plugin/src/core/nocturnal-rule-implementation-validator.ts',
    );
    expect(existsSync(validatorPath)).toBe(true);
    const src = readFileSync(validatorPath, 'utf-8');

    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).not.toContain("from './rule-host-types.js'");
    expect(src).not.toContain("from './rule-host-helpers.js'");
  });
});

// ── PRI-44: Principle-compiler core boundary ──────────────────────────────────

describe('PRI-44 principle-compiler core boundary', () => {
  it('core template-generator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'template-generator.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('core rule-code-validator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-code-validator.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin template-generator.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-compiler/template-generator.ts'
    ), 'utf-8');
    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).toContain('generateFromTemplate');
  });

  it('plugin code-validator.ts imports checkForbiddenPatterns from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-compiler/code-validator.ts'
    ), 'utf-8');
    expect(src).toContain('checkForbiddenPatterns');
    expect(src).toContain('@principles/core/runtime-v2');
  });

  it('plugin compiler.ts imports CompileResult from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-compiler/compiler.ts'
    ), 'utf-8');
    expect(src).toContain("import type { CompileResult } from '@principles/core/runtime-v2'");
  });
});

// ── PRI-47: Store layer modularization Phase 3 ──────────────────────────────

describe('PRI-47 store modularization Phase 3', () => {
  it('store/candidate/index.ts exists and re-exports CandidateStore + SqliteCandidateStore + MemoryCandidateStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'candidate', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('CandidateStore');
    expect(src).toContain('SqliteCandidateStore');
    expect(src).toContain('MemoryCandidateStore');
  });

  it('store/artifact/index.ts exists and re-exports ArtifactStore + SqliteArtifactStore + MemoryArtifactStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'artifact', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('ArtifactStore');
    expect(src).toContain('SqliteArtifactStore');
    expect(src).toContain('MemoryArtifactStore');
  });

  it('store/commit/index.ts re-exports CommitStore + SqliteCommitStore + MemoryCommitStore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'commit', 'index.ts');
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('CommitStore');
    expect(src).toContain('SqliteCommitStore');
    expect(src).toContain('MemoryCommitStore');
  });

  it('store/task/index.ts re-exports MemoryTaskStore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'task', 'index.ts');
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('MemoryTaskStore');
  });

  it('store/run/index.ts re-exports MemoryRunStore', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'run', 'index.ts');
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('MemoryRunStore');
  });

  it('RuntimeStateManager has zero inline SQL (no db.prepare calls)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'store', 'runtime-state-manager.ts'), 'utf-8');
    expect(src).not.toContain('db.prepare');
  });

  it('Memory*Store test double files exist', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const base = resolve(__dirname, '..', 'store');
    expect(existsSync(resolve(base, 'task', 'memory-task-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'run', 'memory-run-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'commit', 'memory-commit-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'candidate', 'memory-candidate-store.ts'))).toBe(true);
    expect(existsSync(resolve(base, 'artifact', 'memory-artifact-store.ts'))).toBe(true);
  });

  it('Phase 3 M5 types NOT defined inline in runtime-state-manager.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'store', 'runtime-state-manager.ts'), 'utf-8');
    // CommitRecord, CandidateRecord, ArtifactRecord, ArtifactWithCandidates should be re-exported from submodules
    expect(src).not.toMatch(/^export interface CommitRecord/m);
    expect(src).not.toMatch(/^export interface CandidateRecord/m);
    expect(src).not.toMatch(/^export interface ArtifactRecord/m);
    expect(src).not.toMatch(/^export interface ArtifactWithCandidates/m);
  });
});

describe('pd-cli command boundaries', () => {
  it('pain-record.ts does not import createPainSignalBridge or recordPainSignalObservability', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/pain-record.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).toContain('PainToPrincipleService');
    expect(src).not.toContain('createPainSignalBridge');
    expect(src).not.toContain('recordPainSignalObservability');
  });

  it('runtime-health-snapshot.ts uses OperatorHealthReadModel (public API)', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../../pd-cli/src/commands/runtime-health-snapshot.ts',
    );
    expect(existsSync(cmdPath)).toBe(true);
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).toContain('OperatorHealthReadModel');
    expect(src).not.toContain('auditCandidateLedgerConsistency');
    expect(src).not.toContain('../candidate-audit');
  });

  it.skip('trace.ts does not import RuntimeStateManager or loadLedger', async () => {
    // TODO: Enable this guard once trace.ts is migrated to PainChainReadModel.
  });
});

// ── PRI-45: RuleHost adapter boundary ────────────────────────────────────────

describe('PRI-45 RuleHost adapter boundary', () => {
  it('core rule-host-evaluator.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-host-evaluator.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('core rule-host-adapter.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rule-host-adapter.ts'), 'utf-8');
    expect(src).not.toContain('node:vm');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin rule-host.ts imports mergeDecisions from core barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/rule-host.ts'
    ), 'utf-8');
    expect(src).toContain('mergeDecisions');
    expect(src).toContain('@principles/core/runtime-v2');
  });

  it('plugin rule-host.ts evaluate method delegates to mergeDecisions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/rule-host.ts'
    ), 'utf-8');
    expect(src).toMatch(/return mergeDecisions\(/);
  });
});

// ── PRI-47: Store layer modularization Phase 1 ──────────────────────────────

describe('PRI-47 store modularization', () => {
  it('store/task/index.ts exists and re-exports TaskStore + SqliteTaskStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'task', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('TaskStore');
    expect(src).toContain('SqliteTaskStore');
  });

  it('store/run/index.ts exists and re-exports RunStore + SqliteRunStore', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'run', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('RunStore');
    expect(src).toContain('SqliteRunStore');
  });

  it('store/commit/index.ts exists and re-exports DiagnosticianCommitter', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'commit', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('DiagnosticianCommitter');
    expect(src).toContain('CommitInput');
    expect(src).toContain('CommitResult');
  });

  it('Phase 1 moved files are NOT in root store/ directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const storeDir = resolve(__dirname, '..', 'store');
    // Phase 1: These files should have been moved to subdirectories
    expect(existsSync(resolve(storeDir, 'task-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-task-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'run-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-run-store.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'diagnostician-committer.ts'))).toBe(false);
  });
});

// ── PRI-47: Store layer modularization Phase 2 ──────────────────────────────

describe('PRI-47 store modularization Phase 2', () => {
  it('store/context/index.ts exists and re-exports ContextAssembler + implementations', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'context', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('ContextAssembler');
    expect(src).toContain('SqliteContextAssembler');
    expect(src).toContain('ResilientContextAssembler');
  });

  it('store/history/index.ts exists and re-exports HistoryQuery + implementations', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'history', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('HistoryQuery');
    expect(src).toContain('SqliteHistoryQuery');
    expect(src).toContain('ResilientHistoryQuery');
  });

  it('store/trajectory/index.ts exists and re-exports TrajectoryLocator + implementation', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'trajectory', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('TrajectoryLocator');
    expect(src).toContain('SqliteTrajectoryLocator');
  });

  it('store/lifecycle/index.ts exists and re-exports lease/retry/recovery', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const indexPath = resolve(__dirname, '..', 'store', 'lifecycle', 'index.ts');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');
    expect(src).toContain('LeaseManager');
    expect(src).toContain('DefaultLeaseManager');
    expect(src).toContain('DefaultRetryPolicy');
    expect(src).toContain('DefaultRecoverySweep');
  });

  it('Phase 2 moved files are NOT in root store/ directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const storeDir = resolve(__dirname, '..', 'store');
    // Phase 2: context
    expect(existsSync(resolve(storeDir, 'context-assembler.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-context-assembler.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'resilient-context-assembler.ts'))).toBe(false);
    // Phase 2: history
    expect(existsSync(resolve(storeDir, 'history-query.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-history-query.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'resilient-history-query.ts'))).toBe(false);
    // Phase 2: trajectory
    expect(existsSync(resolve(storeDir, 'trajectory-locator.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'sqlite-trajectory-locator.ts'))).toBe(false);
    // Phase 2: lifecycle
    expect(existsSync(resolve(storeDir, 'lease-manager.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'retry-policy.ts'))).toBe(false);
    expect(existsSync(resolve(storeDir, 'recovery-sweep.ts'))).toBe(false);
  });

  it('barrel still exports all store symbols', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    const storeSymbols = [
      'SqliteTaskStore', 'SqliteRunStore', 'SqliteConnection',
      'SqliteTrajectoryLocator', 'SqliteHistoryQuery', 'SqliteContextAssembler',
      'SqliteDiagnosticianCommitter',
      'ResilientContextAssembler', 'ResilientHistoryQuery',
      'DefaultLeaseManager', 'DefaultRetryPolicy', 'DefaultRecoverySweep',
      'StoreEventEmitter', 'storeEmitter',
      'RuntimeStateManager', 'EvolutionQueueItemMigrator',
      'DEFAULT_HISTORY_PAGE_SIZE', 'MAX_HISTORY_PAGE_SIZE', 'DEFAULT_TIME_WINDOW_MS',
    ];
    for (const sym of storeSymbols) {
      expect(mod).toHaveProperty(sym);
    }
  });

  it('barrel exports Memory*Store test doubles', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    const memoryStores = [
      'MemoryTaskStore', 'MemoryRunStore', 'MemoryCommitStore',
      'MemoryCandidateStore', 'MemoryArtifactStore',
    ];
    for (const sym of memoryStores) {
      expect(mod).toHaveProperty(sym);
    }
  });
});
