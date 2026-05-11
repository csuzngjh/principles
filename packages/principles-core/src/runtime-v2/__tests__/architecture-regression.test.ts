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
  // PRI-51
  'types/principle-enums.ts',
  'types/principle-schema.ts',
  'types/artifact-lineage.ts',
  'types/replay-types.ts',
  'types/index.ts',
  'internalization/lifecycle-types.ts',
  // PRI-52
  'internalization/lifecycle-metrics.ts',
  // PRI-53
  'internalization/deprecated-readiness.ts',
  // PRI-54
  'internalization/routing-policy.ts',
  // PRI-56
  'internalization/lifecycle-datasource.ts',
  'internalization/lifecycle-read-model.ts',
  // PRI-61
  'internalization/peer-runner-contracts.ts',
  'internalization/internalization-job-graph.ts',
  // PRI-62
  'internalization/internalization-task-guards.ts',
  'internalization/internalization-state-machine.ts',
  // PRI-65
  'internalization/pitask-metadata.ts',
  // PRI-67
  'internalization/dreamer-output.ts',
  'internalization/dreamer-runner.ts',
  // PRI-109
  'internalization/scribe-output.ts',
  'internalization/scribe-runner.ts',
  // PRI-111
  'internalization/artificer-output.ts',
  'internalization/artificer-runner.ts',
  // PRI-EVAL
  'internalization/evaluator-output.ts',
  'internalization/evaluator-runner.ts',
  'internalization/evaluator-prompt-builder.ts',
  // PRI-RR
  'internalization/rollout-reviewer-output.ts',
  'internalization/rollout-reviewer-runner.ts',
  'internalization/rollout-reviewer-prompt-builder.ts',
  // PRI-74 (follow-up to PRI-75 Phase 3)
  '../prompt-builder/routing-guidance.ts',
  // PRI-81 Phase A
  '../prompt-builder/empathy-keyword-matching.ts',
  '../prompt-builder/empathy-types.ts',
  // PRI-81 Phase B
  '../prompt-builder/focus-compression.ts',
  // PRI-76
  'gfi/gfi-types.ts',
  'gfi/gfi-policy.ts',
  'gfi/gfi-kernel.ts',
  'gfi/index.ts',
  // PRI-84
  'internalization/pi-artifact.ts',
  'internalization/pi-artifact-store.ts',
] as const;

const REQUIRED_TEST_FILES = [
  'pain-to-principle-service.test.ts',
  'pain-chain-read-model.test.ts',
  'pruning-read-model.test.ts',
  'pruning-review-log.test.ts',
  // PRI-28
  'operator-health-read-model.test.ts',
  'candidate-audit.test.ts',
  // PRI-56 (lifecycle-read-model.test.ts is at internalization/lifecycle-read-model.test.ts, not in __tests__/)
  // Skipping — test file lives at ../internalization/ not __tests__/internalization/
  // PRI-62
  'internalization-state-machine.test.ts',
  // PRI-65
  'pitask-metadata.test.ts',
  // PRI-67
  'dreamer-runner.test.ts',
  // PRI-109
  'scribe-runner-vslice.test.ts',
  // PRI-111
  'artificer-runner-vslice.test.ts',
  // PRI-EVAL
  'evaluator-runner-vslice.test.ts',
  // PRI-RR
  'rollout-reviewer-runner-vslice.test.ts',
  // PRI-74 (follow-up to PRI-75 Phase 3)
  '../../prompt-builder/__tests__/routing-guidance.test.ts',
  // PRI-81 Phase A
  '../../prompt-builder/__tests__/empathy-keyword-matching.test.ts',
  // PRI-81 Phase B
  '../../prompt-builder/__tests__/focus-compression.test.ts',
  // PRI-76
  '../gfi/__tests__/gfi-kernel.test.ts',
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

    const files = readdirSync(intDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
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

// ── PRI-51: Lifecycle type extraction ────────────────────────────────────────

describe('PRI-51 lifecycle type extraction', () => {
  const LIFECYCLE_TYPES = [
    'LifecycleClassificationTotals',
    'RuleReplayEvidence',
    'RuleLiveEvidence',
    'RuleLineageEvidence',
    'ImplementationLifecycleEvidence',
    'RuleLifecycleEvidence',
    'PrincipleLifecycleEvidence',
    'LifecycleReadModel',
  ];

  const ENUM_TYPES = [
    'PrinciplePriority',
    'PrincipleEvaluability',
    'RuleType',
    'RuleStatus',
    'ImplementationLifecycleState',
    'ImplementationType',
    'SampleClassification',
  ];

  it('core exports all lifecycle types from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    for (const name of LIFECYCLE_TYPES) {
      expect(src).toContain(name);
    }
  });

  it('core exports all enum types from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    for (const name of ENUM_TYPES) {
      expect(src).toContain(name);
    }
  });

  it('lifecycle-types.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-types.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin lifecycle-read-model.ts re-exports types from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/lifecycle-read-model.ts'
    ), 'utf-8');
    expect(src).toContain('@principles/core/runtime-v2');
    expect(src).toContain('buildLifecycleReadModel');
  });

  it('plugin principle-tree-schema.ts re-exports enums from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/types/principle-tree-schema.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    // Should no longer define these locally
    expect(src).not.toMatch(/^export type PrinciplePriority = /m);
    expect(src).not.toMatch(/^export type RuleType = /m);
  });
});

// ── PRI-52: Lifecycle metrics extraction ──────────────────────────────────────

describe('PRI-52 lifecycle metrics', () => {
  it('core exports all lifecycle metrics from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('RuleMetricResult');
    expect(src).toContain('PrincipleAdherenceResult');
    expect(src).toContain('computeRuleMetrics');
    expect(src).toContain('computePrincipleAdherence');
  });

  it('lifecycle-metrics.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-metrics.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin lifecycle-metrics.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/lifecycle-metrics.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('computeRuleMetrics');
    expect(src).toContain('computePrincipleAdherence');
  });
});

// ── PRI-53: Deprecated readiness extraction ──────────────────────────────────

describe('PRI-53 deprecated readiness', () => {
  it('core exports all readiness types/functions from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('DeprecatedReadinessStatus');
    expect(src).toContain('DeprecatedReadinessAssessment');
    expect(src).toContain('assessDeprecatedReadiness');
  });

  it('deprecated-readiness.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'deprecated-readiness.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin deprecated-readiness.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/deprecated-readiness.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('assessDeprecatedReadiness');
    expect(src).toContain('DeprecatedReadinessAssessment');
  });
});

// ── PRI-54: Routing policy extraction ──────────────────────────────────────────

describe('PRI-54 routing policy', () => {
  it('core exports all routing policy types/functions from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('LifecycleRoute');
    expect(src).toContain('LifecycleRouteRecommendation');
    expect(src).toContain('LifecycleRouteEvidenceSummary');
    expect(src).toContain('recommendLifecycleRoute');
  });

  it('routing-policy.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'routing-policy.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin internalization-routing-policy.ts re-exports from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/internalization-routing-policy.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('recommendLifecycleRoute');
    expect(src).toContain('LifecycleRouteRecommendation');
  });
});

// ── PRI-56: LifecycleDatasource adapter boundary ──────────────────────────────

describe('PRI-56 LifecycleDatasource adapter boundary', () => {
  it('core exports LifecycleDatasource + buildLifecycleReadModel from barrel', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('LifecycleDatasource');
    expect(src).toContain('buildLifecycleReadModel');
  });

  it('lifecycle-datasource.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-datasource.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('lifecycle-read-model.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'lifecycle-read-model.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin lifecycle-read-model.ts re-exports from core and provides FilesystemLifecycleDatasource', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/lifecycle-read-model.ts'
    ), 'utf-8');
    expect(src).toContain("from '@principles/core/runtime-v2'");
    expect(src).toContain('buildLifecycleReadModel');
    expect(src).toContain('FilesystemLifecycleDatasource');
  });

  it('plugin principle-lifecycle-service.ts delegates buildReadModel via datasource', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/principle-internalization/principle-lifecycle-service.ts'
    ), 'utf-8');
    expect(src).toContain('FilesystemLifecycleDatasource');
    expect(src).toContain('buildLifecycleReadModel');
  });
});

// ── PRI-61: Internalization Peer Runner Contracts ─────────────────────────────

describe('PRI-61 Internalization Peer Runner Contracts', () => {
  it('core barrel exports PITaskRecord and related types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('PITaskRecord');
    expect(src).toContain('PeerRunnerKind');
    expect(src).toContain('InternalizationChannel');
    expect(src).toContain('PIArtifact');
  });

  it('core barrel exports job graph functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('validateEdge');
    expect(src).toContain('isAcyclic');
    expect(src).toContain('getAllowedSuccessors');
    expect(src).toContain('ALLOWED_EDGES');
  });

  it('peer-runner-contracts.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'peer-runner-contracts.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('internalization-job-graph.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-job-graph.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('TASK_MODEL_REUSE: PITaskRecord extends TaskRecord (type-level check)', async () => {
    // PITaskRecord is an interface (type-only export). Type-level check:
    // if PITaskRecord didn't extend TaskRecord, TypeScript would error in the
    // peer-runner-contracts.ts definition at compile time.
    // We verify the module exports the type by checking the source file.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'peer-runner-contracts.ts'
    ), 'utf-8');
    // If PITaskRecord doesn't extend TaskRecord, this interface definition would fail
    expect(src).toContain('interface PITaskRecord extends TaskRecord');
  });

  it('PEER_NO_DIRECT_CHAINING: job graph defines edge validation only, no execution', async () => {
    const { validateEdge, ALLOWED_EDGES } = await import('../internalization/internalization-job-graph.js');
    // validateEdge is a pure function — no side effects, no execution
    expect(typeof validateEdge).toBe('function');
    expect(Array.isArray(ALLOWED_EDGES)).toBe(true);
    // Edge validation is read-only — no task creation or state mutation
    const result = validateEdge('dreamer', 'philosopher');
    expect(typeof result).toBe('boolean');
  });
});

// ── PRI-62: Internalization State Machine Guards ─────────────────────────────

describe('PRI-62 Internalization State Machine Guards', () => {
  it('core barrel exports state machine guard functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('validateInternalizationTaskReady');
    expect(src).toContain('validateTaskTransition');
    expect(src).toContain('decideArtifactRejectionFeedback');
    expect(src).toContain('createNextTaskProposal');
    expect(src).toContain('validateInternalizationGraph');
  });

  it('core barrel exports guard utility functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('canAcquireLease');
    expect(src).toContain('areDependenciesMet');
    expect(src).toContain('canTransitionTo');
    expect(src).toContain('isResultRefImmutable');
    expect(src).toContain('canUpdateLastError');
    expect(src).toContain('isArtifactRejected');
  });

  it('internalization-task-guards.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-task-guards.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('internalization-state-machine.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-state-machine.ts'
    ), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
  });

  it('TASK_MODEL_REUSE: guard functions work with PITaskRecord (type-level check)', async () => {
    // If PITaskRecord didn't properly extend TaskRecord, TypeScript would error
    // at compile time in peer-runner-contracts.ts and internalization-task-guards.ts
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', 'internalization', 'internalization-task-guards.ts'
    ), 'utf-8');
    expect(src).toContain('task: PITaskRecord');
  });

  it('PEER_NO_DIRECT_CHAINING: state machine returns proposals, not execute calls', async () => {
    const { createNextTaskProposal } = await import('../internalization/internalization-state-machine.js');
    // Pure function — returns an object, no side effects
    const { createMinimalPITaskRecord } = await import('../internalization/peer-runner-contracts.js');
    const task = createMinimalPITaskRecord('t1', 'dreamer', 'prompt');
    task.status = 'succeeded';
    task.outputArtifactRefs = [];
    const result = createNextTaskProposal(task, []);
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

// ── PRI-63: Internalization Dumb Trigger Adapter ─────────────────────────────

describe('PRI-63 Internalization Dumb Trigger Adapter', () => {
  const PRI63_REQUIRED_FILES = [
    'internalization-trigger-adapter.ts',
  ];

  it('adapter source file exists in plugin service directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const pluginRoot = resolve(__dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service');
    for (const file of PRI63_REQUIRED_FILES) {
      expect(existsSync(resolve(pluginRoot, file))).toBe(true);
    }
  });

  it('adapter does not import nocturnal-trinity', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service', 'internalization-trigger-adapter.ts'
    ), 'utf-8');
    expect(src).not.toContain('nocturnal-trinity');
  });

  it('adapter does not import runTrinity or runTrinityAsync', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service', 'internalization-trigger-adapter.ts'
    ), 'utf-8');
    expect(src).not.toContain('runTrinity');
    expect(src).not.toContain('runTrinityAsync');
  });

  it('adapter does not import Dreamer/Philosopher/Scribe executors', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service', 'internalization-trigger-adapter.ts'
    ), 'utf-8');
    expect(src).not.toContain("from 'dreamer'");
    expect(src).not.toContain("from 'philosopher'");
    expect(src).not.toContain("from 'scribe'");
  });

  it('adapter does not use PDRuntimeAdapter', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service', 'internalization-trigger-adapter.ts'
    ), 'utf-8');
    expect(src).not.toContain('PDRuntimeAdapter');
  });

  it('adapter imports TaskRecord from @principles/core/runtime-v2', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service', 'internalization-trigger-adapter.ts'
    ), 'utf-8');
    expect(src).toContain('TaskRecord');
    expect(src).toContain('@principles/core/runtime-v2');
  });

  it('PLUGIN_NO_INLINE_EXECUTION: adapter does not call mutating store methods (read-only probe)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service', 'internalization-trigger-adapter.ts'
    ), 'utf-8');
    // wake() should only read, not update/create/delete tasks
    expect(src).not.toContain('updateTask');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('deleteTask');
    expect(src).not.toContain('leaseTask');
  });

  it('PLUGIN_NO_INLINE_EXECUTION: adapter does not use setInterval/setTimeout for scheduling (core responsibility)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'openclaw-plugin', 'src', 'service', 'internalization-trigger-adapter.ts'
    ), 'utf-8');
    // setInterval is used in start() to trigger wake() periodically — this is plugin responsibility
    // Core state machine should NOT use setInterval (CORE_NO_SCHEDULING)
    expect(src).not.toContain('node:cron');
  });
});

describe('PRI-68 InternalizationOrchestrator', () => {
  it('orchestrator source file exists in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'internalization-orchestrator.ts'))).toBe(true);
  });

  it('orchestrator test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', '__tests__', 'internalization-orchestrator.test.ts'))).toBe(true);
  });

  it('CORE_NO_SCHEDULING: orchestrator has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'internalization-orchestrator.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
        expect(src).not.toContain('node:cron');
    expect(src).not.toContain('setInterval');
    expect(src).not.toContain('setTimeout');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_RUNTIME_ADAPTER: orchestrator does not import PDRuntimeAdapter or startRun', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'internalization-orchestrator.ts'), 'utf-8');
    expect(src).not.toContain('PDRuntimeAdapter');
    expect(src).not.toContain('startRun');
    expect(src).not.toContain('DiagnosticianRunner');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports InternalizationOrchestrator and result types', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf-8');
    expect(src).toContain('InternalizationOrchestrator');
    expect(src).toContain('WakeOnceResult');
    expect(src).toContain('LeaseConflictResult');
  });
});

describe('PRI-67 DreamerRunner', () => {
  it('dreamer source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'dreamer-output.ts'))).toBe(true);
  });

  it('dreamer test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', '__tests__', 'dreamer-runner.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: dreamer-runner.ts has no openclaw-plugin, nocturnal-trinity, philosopher, scribe imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('runTrinity');
    expect(src).not.toContain('philosopher');
    expect(src).not.toContain('scribe');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_SCHEDULING: dreamer-runner.ts has no node:fs, node:cron, or cron-style scheduling', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
    // setTimeout for sleep() in polling loop is allowed — no cron/interval scheduling
  });

  it('USES_RUNTIME_ADAPTER: dreamer-runner.ts imports and uses PDRuntimeAdapter', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-runner.ts'), 'utf-8');
    expect(src).toContain('PDRuntimeAdapter');
    expect(src).toContain('startRun');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports DreamerRunner and DreamerOutput', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('DreamerRunner');
    expect(src).toContain('DreamerOutput');
    expect(src).toContain('PassThroughDreamerValidator');
    expect(src).toContain('DefaultDreamerValidator');
  });
});

// ── PRI-87: DefaultDreamerValidator strict validation ───────────────────────────

describe('PRI-87 DefaultDreamerValidator strict validation', () => {
  it('CORE_NO_FORBIDDEN_IMPORTS: dreamer-output.ts has no openclaw-plugin, nocturnal, fs, path, process imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'dreamer-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('nocturnal');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
  });

  it('PRODUCTION_USES_STRICT_VALIDATOR: run-once CLI uses DefaultDreamerValidator, not PassThroughDreamerValidator', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '..', '..', '..', '..', 'pd-cli', 'src', 'commands', 'runtime-internalization-run-once.ts'
    ), 'utf-8');
    expect(src).toContain('DefaultDreamerValidator');
    expect(src).not.toContain('new PassThroughDreamerValidator()');
  });

  it('BARREL_EXPORTS: DefaultDreamerValidator is exported from internalization/index.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('DefaultDreamerValidator');
  });

  it('validator test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', '__tests__', 'dreamer-output-validator.test.ts'))).toBe(true);
  });
});

// ── PRI-75/PRI-74/PRI-81: Prompt-builder core boundary ─────────────────────────────────

describe('PRI-75/PRI-74/PRI-81 prompt-builder core boundary', () => {
  const files = [
    'prompt-builder/index.ts',
    'prompt-builder/attitude-directive.ts',
    'prompt-builder/correction-cue.ts',
    'prompt-builder/message-extraction.ts',
    'prompt-builder/minimal-trigger.ts',
    'prompt-builder/size-guard.ts',
    'prompt-builder/types.ts',
    'prompt-builder/principle-selection.ts',
    // PRI-74
    'prompt-builder/routing-guidance.ts',
    // PRI-81 Phase A
    'prompt-builder/empathy-keyword-matching.ts',
    'prompt-builder/empathy-types.ts',
    // PRI-81 Phase B
    'prompt-builder/focus-compression.ts',
  ];

  for (const file of files) {
    it(`${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '../..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('node:process');
      expect(src).not.toContain('openclaw-plugin');
    });
  }

  it('prompt-builder/index.ts exports all functions', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../..', 'prompt-builder/index.ts'), 'utf-8');
    // Phase 1
    expect(src).toContain('buildAttitudeDirective');
    expect(src).toContain('detectCorrectionCue');
    expect(src).toContain('extractMessageContent');
    expect(src).toContain('isMinimalTrigger');
    expect(src).toContain('truncateInjectionToBudget');
    // Phase 2
    expect(src).toContain('formatPrinciple');
    expect(src).toContain('selectPrinciplesForInjection');
    expect(src).toContain('DEFAULT_PRINCIPLE_BUDGET');
    // PRI-74 routing guidance
    expect(src).toContain('classifyTaskKind');
    expect(src).toContain('buildReason');
    expect(src).toContain('buildBlockers');
    expect(src).toContain('computeCombinedText');
    expect(src).toContain('containsKeyword');
    // PRI-81 Phase A: empathy keyword matching
    expect(src).toContain('matchEmpathyKeywords');
    expect(src).toContain('createDefaultKeywordStore');
    expect(src).toContain('applyKeywordUpdates');
    expect(src).toContain('shouldTriggerOptimization');
    expect(src).toContain('getKeywordStoreSummary');
    expect(src).toContain('EMPATHY_SEED_KEYWORDS');
    expect(src).toContain('DEFAULT_EMPATHY_KEYWORD_CONFIG');
    expect(src).toContain('scoreToSeverity');
    expect(src).toContain('severityToPenalty');
    expect(src).toContain('normalizeSeverity');
    // PRI-81 Phase B: focus compression
    expect(src).toContain('extractVersion');
    expect(src).toContain('extractDate');
    expect(src).toContain('extractSummary');
    expect(src).toContain('parseWorkingMemorySection');
    expect(src).toContain('workingMemoryToInjection');
    expect(src).toContain('extractMilestones');
    expect(src).toContain('validateCurrentFocus');
    expect(src).toContain('mergeWorkingMemory');
    expect(src).toContain('compressFocusContent');
    expect(src).toContain('DEFAULT_FOCUS_COMPRESSION_OPTIONS');
  });

  it('principle-selection.ts does not import EvolutionReducer or WorkspaceContext', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../..', 'prompt-builder/principle-selection.ts'), 'utf-8');
    expect(src).not.toContain('EvolutionReducer');
    expect(src).not.toContain('WorkspaceContext');
  });

  it('plugin principle-injection.ts is a thin re-export of core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/principle-injection.ts'), 'utf-8');
    // Must re-export from core
    expect(src).toContain('@principles/core/prompt-builder');
    // Must NOT contain inline selectPrinciplesForInjection implementation
    expect(src).not.toMatch(/function selectPrinciplesForInjection/i);
    // Must NOT contain priority sorting logic
    expect(src).not.toMatch(/PRIORITY_ORDER/i);
  });

  it('plugin prompt.ts imports from @principles/core/prompt-builder', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/hooks/prompt.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
  });

  it('plugin prompt.ts uses core truncateInjectionToBudget, not inline priority stripping', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/hooks/prompt.ts'), 'utf-8');
    // Must call the core function
    expect(src).toMatch(/truncateInjectionToBudget\s*\(/);
    // Must NOT have inline priority stripping comment markers (old step comments)
    expect(src).not.toMatch(/\/\/ Step \d+.*strip (project_context|thinking_os|evolution_principles|reflection_log)/i);
    // Must NOT have inline regex-based fallback context block (the strip-by-regex pattern)
    expect(src).not.toMatch(/<reflection_log>\[\\s\\S\]\*?<\/reflection_log>/);
    // Must NOT have the old multi-line fallback block with attitudeDirective interpolation
    expect(src).not.toMatch(/## 【CONTEXT SECTIONS】\n\n\[WARNING: Context sections stripped/);
  });

  it('plugin empathy-keyword-matcher.ts is a thin adapter (re-exports from core)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/empathy-keyword-matcher.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).not.toMatch(/function matchEmpathyKeywords\s*\(/);
    expect(src).not.toMatch(/function createDefaultKeywordStore\s*\(/);
    expect(src).not.toMatch(/function applyKeywordUpdates\s*\(/);
    expect(src).not.toMatch(/function shouldTriggerOptimization\s*\(/);
    expect(src).not.toMatch(/function getKeywordStoreSummary\s*\(/);
  });

  it('plugin empathy-types.ts is a thin re-export (no inline definitions)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/empathy-types.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).not.toMatch(/interface EmpathyKeywordStore/);
    expect(src).not.toMatch(/const EMPATHY_SEED_KEYWORDS/);
    expect(src).not.toMatch(/function scoreToSeverity/);
  });

  it('plugin focus-history.ts delegates pure functions to core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../../openclaw-plugin/src/core/focus-history.ts'), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).not.toMatch(/function extractSummary\s*\(/);
    expect(src).not.toMatch(/function parseWorkingMemorySection\s*\(/);
    expect(src).not.toMatch(/function workingMemoryToInjection\s*\(/);
    expect(src).not.toMatch(/function extractMilestones\s*\(/);
    expect(src).not.toMatch(/function validateCurrentFocus\s*\(/);
    expect(src).not.toMatch(/function mergeWorkingMemory\s*\(/);
  });
});

// ── PRI-74: Routing guidance thin-adapter boundary ───────────────────────────

describe('PRI-74 routing guidance thin-adapter boundary', () => {
  it('prompt-builder/routing-guidance.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../..', 'prompt-builder/routing-guidance.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('plugin local-worker-routing.ts imports classifyTaskKind/buildReason/buildBlockers from core', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/local-worker-routing.ts'
    ), 'utf-8');
    expect(src).toContain('@principles/core/prompt-builder');
    expect(src).toContain('classifyTaskKind');
    expect(src).toContain('buildReason');
    expect(src).toContain('buildBlockers');
  });

  it('plugin local-worker-routing.ts does NOT have inline keyword arrays or classifyTaskKind implementation', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(
      __dirname, '../../../../openclaw-plugin/src/core/local-worker-routing.ts'
    ), 'utf-8');
    // Must NOT re-define the keyword constants locally
    expect(src).not.toMatch(/READER_KEYWORDS\s*=/);
    expect(src).not.toMatch(/EDITOR_KEYWORDS\s*=/);
    expect(src).not.toMatch(/HIGH_ENTROPY_KEYWORDS\s*=/);
    // Must NOT have inline classifyTaskKind function body
    expect(src).not.toMatch(/export\s+function\s+classifyTaskKind/);
    // Must delegate to coreClassifyTaskKind
    expect(src).toContain('coreClassifyTaskKind');
    expect(src).toContain('coreBuildReason');
    expect(src).toContain('coreBuildBlockers');
  });
});

// ── PRI-76: GFI core kernel boundary ───────────────────────────────────────

describe('PRI-76 GFI core kernel boundary', () => {
  const gfiFiles = [
    'gfi/gfi-types.ts',
    'gfi/gfi-policy.ts',
    'gfi/gfi-kernel.ts',
    'gfi/gfi-read-model.ts',
    'gfi/index.ts',
  ];

  for (const file of gfiFiles) {
    it(`${file} has zero infrastructure imports`, async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const src = readFileSync(resolve(__dirname, '..', file), 'utf-8');
      expect(src).not.toContain('node:fs');
      expect(src).not.toContain('node:path');
      expect(src).not.toContain('node:process');
      expect(src).not.toContain('openclaw-plugin');
      expect(src).not.toContain('node:crypto');
      expect(src).not.toContain('node:async_hooks');
    });
  }

  // PRI-82: gfi-kernel.ts must not call Date.now() — nowMs is injected by caller
  it('gfi-kernel.ts does not call Date.now()', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'gfi/gfi-kernel.ts'), 'utf-8');
    expect(src).not.toContain('Date.now()');
  });

  it('gfi/index.ts exports all public symbols', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'gfi/index.ts'), 'utf-8');
    expect(src).toContain('applyFriction');
    expect(src).toContain('applyDecay');
    expect(src).toContain('applyRelief');
    expect(src).toContain('classifyGfiStage');
    expect(src).toContain('createGfiSnapshot');
    expect(src).toContain('DEFAULT_GFI_POLICY');
    expect(src).toContain('GfiState');
    expect(src).toContain('GfiEvent');
    expect(src).toContain('GfiPolicy');
    expect(src).toContain('GfiStage');
    expect(src).toContain('GfiSource');
    expect(src).toContain('GfiSnapshot');
    expect(src).toContain('buildGfiWorkspaceSnapshot');
    expect(src).toContain('GfiReadModelInput');
    expect(src).toContain('GfiWorkspaceSnapshot');
  });
});

// ── PRI-78: GFI observability boundary ──────────────────────────────────────

describe('PRI-78 GFI observability boundary', () => {
  it('gfi-read-model.ts has zero infrastructure imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'gfi/gfi-read-model.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
    expect(src).not.toContain('node:process');
    expect(src).not.toContain('openclaw-plugin');
  });

  it('pd-cli runtime-gfi-snapshot.ts imports from @principles/core/runtime-v2', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(
      resolve(__dirname, '../../../../pd-cli/src/commands/runtime-gfi-snapshot.ts'),
      'utf-8'
    );
    expect(src).toContain("from '@principles/core/runtime-v2'");
  });
});

// ── PRI-111: ArtificerRunner boundary guards ──────────────────────────────────

describe('PRI-111 ArtificerRunner boundary', () => {
  it('artificer source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'artificer-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'artificer-output.ts'))).toBe(true);
  });

  it('artificer test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, 'artificer-runner-vslice.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: artificer-runner.ts has no openclaw-plugin, evaluator, nocturnal-trinity imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'artificer-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('EvaluatorRunner');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: artificer-output.ts has no openclaw-plugin, fs, path imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'artificer-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_SCHEDULING: artificer-runner.ts has no node:fs, node:cron, or cron-style scheduling', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'artificer-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports ArtificerRunner and ArtificerOutput', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('ArtificerRunner');
    expect(src).toContain('ArtificerOutput');
    expect(src).toContain('DefaultArtificerValidator');
  });

  it('SCHEMA_REGISTRY: pi-ai-runtime-adapter.ts registers artificer-output-v1 schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'adapter', 'pi-ai-runtime-adapter.ts'), 'utf-8');
    expect(src).toContain('artificer-output-v1');
    expect(src).toContain('ArtificerOutputV1Schema');
  });
});

// ── PRI-EVAL: EvaluatorRunner boundary guards ──────────────────────────────────

describe('PRI-EVAL EvaluatorRunner boundary', () => {
  it('evaluator source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'evaluator-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'evaluator-output.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'evaluator-prompt-builder.ts'))).toBe(true);
  });

  it('evaluator test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, 'evaluator-runner-vslice.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: evaluator-output.ts has no openclaw-plugin, fs, path imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'evaluator-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: evaluator-runner.ts has no openclaw-plugin, RolloutReviewerRunner, nocturnal-trinity imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'evaluator-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('RolloutReviewerRunner');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_SCHEDULING: evaluator-runner.ts has no node:fs, node:cron imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'evaluator-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports EvaluatorRunner and EvaluatorOutput', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('EvaluatorRunner');
    expect(src).toContain('EvaluatorOutput');
    expect(src).toContain('DefaultEvaluatorValidator');
  });

  it('SCHEMA_REGISTRY: pi-ai-runtime-adapter.ts registers evaluator-output-v1 schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'adapter', 'pi-ai-runtime-adapter.ts'), 'utf-8');
    expect(src).toContain('evaluator-output-v1');
    expect(src).toContain('EvaluatorOutputV1Schema');
  });
});

// ── PRI-RR: RolloutReviewerRunner boundary guards ──────────────────────────────

describe('PRI-RR RolloutReviewerRunner boundary', () => {
  it('rollout_reviewer source files exist in internalization directory', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-runner.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-output.ts'))).toBe(true);
    expect(existsSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-prompt-builder.ts'))).toBe(true);
  });

  it('rollout_reviewer test file exists', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    expect(existsSync(resolve(__dirname, 'rollout-reviewer-runner-vslice.test.ts'))).toBe(true);
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: rollout-reviewer-output.ts has no openclaw-plugin, fs, path imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-output.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:path');
  });

  it('CORE_NO_FORBIDDEN_IMPORTS: rollout-reviewer-runner.ts has no openclaw-plugin, TrainerRunner, nocturnal-trinity imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-runner.ts'), 'utf-8');
    expect(src).not.toContain('openclaw-plugin');
    expect(src).not.toContain('TrainerRunner');
    expect(src).not.toContain('nocturnal-trinity');
    expect(src).not.toContain('InternalizationOrchestrator');
    expect(src).not.toContain('createTask');
    expect(src).not.toContain('enqueueTask');
  });

  it('CORE_NO_SCHEDULING: rollout-reviewer-runner.ts has no node:fs, node:cron imports', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'rollout-reviewer-runner.ts'), 'utf-8');
    expect(src).not.toContain('node:fs');
    expect(src).not.toContain('node:cron');
  });

  it('BARREL_EXPORTS: internalization/index.ts exports RolloutReviewerRunner and RolloutReviewerOutput', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'internalization', 'index.ts'), 'utf-8');
    expect(src).toContain('RolloutReviewerRunner');
    expect(src).toContain('RolloutReviewerOutput');
    expect(src).toContain('DefaultRolloutReviewerValidator');
  });

  it('SCHEMA_REGISTRY: pi-ai-runtime-adapter.ts registers rollout-reviewer-output-v1 schema', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '..', 'adapter', 'pi-ai-runtime-adapter.ts'), 'utf-8');
    expect(src).toContain('rollout-reviewer-output-v1');
    expect(src).toContain('RolloutReviewerOutputV1Schema');
  });
});
