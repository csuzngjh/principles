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

// ── pd-cli command boundary guards ─────────────────────────────────────────

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
