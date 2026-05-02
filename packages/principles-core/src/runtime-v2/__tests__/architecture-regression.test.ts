/**
 * Architecture regression guard — verifies critical PRI-12/13/14/15/16
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
] as const;

const REQUIRED_TEST_FILES = [
  'pain-to-principle-service.test.ts',
  'pain-chain-read-model.test.ts',
  'pruning-read-model.test.ts',
  'pruning-review-log.test.ts',
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
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const painHookPath = resolve(
      __dirname,
      '../../../openclaw-plugin/src/hooks/pain.ts',
    );
    if (!existsSync(painHookPath)) {
      return;
    }
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(painHookPath, 'utf-8');
    expect(src).toContain('PainToPrincipleService');
    expect(src).not.toContain('createPainSignalBridge');
  });
});

// ── pd-cli command boundary guards ─────────────────────────────────────────

describe('pd-cli command boundaries', () => {
  it('pain-record.ts does not import createPainSignalBridge or recordPainSignalObservability', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const cmdPath = resolve(
      __dirname,
      '../../../pd-cli/src/commands/pain-record.ts',
    );
    if (!existsSync(cmdPath)) {
      return;
    }
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(cmdPath, 'utf-8');
    expect(src).toContain('PainToPrincipleService');
    expect(src).not.toContain('createPainSignalBridge');
    expect(src).not.toContain('recordPainSignalObservability');
  });

  it.skip('trace.ts does not import RuntimeStateManager or loadLedger', async () => {
    // TODO: Enable this guard once trace.ts is migrated to PainChainReadModel.
  });
});
