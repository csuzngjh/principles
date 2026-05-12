import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks (hoisted for vi.mock compatibility) ---

const {
  mockCollect, mockRegister, mockCreateAssetDir,
  mockLoadModule, mockValidate, mockGenerate,
} = vi.hoisted(() => ({
  mockCollect: vi.fn(),
  mockRegister: vi.fn(),
  mockCreateAssetDir: vi.fn(),
  mockLoadModule: vi.fn(),
  mockValidate: vi.fn(),
  mockGenerate: vi.fn(),
}));

vi.mock('../code-validator.js', () => ({
  validateGeneratedCode: mockValidate,
}));

vi.mock('../template-generator.js', () => ({
  generateFromTemplate: mockGenerate,
}));

vi.mock('../ledger-registrar.js', () => ({
  registerCompiledRule: mockRegister,
}));

vi.mock('../../code-implementation-storage.js', () => ({
  createImplementationAssetDir: mockCreateAssetDir,
}));

vi.mock('../../rule-implementation-runtime.js', () => ({
  loadRuleImplementationModule: mockLoadModule,
}));

import { PrincipleCompiler } from '../compiler.js';

// --- Fixtures ---

const PRINCIPLE_ID = 'P_test_001';

function makeContext(overrides?: { reason?: string }) {
  return {
    principle: {
      id: PRINCIPLE_ID,
      version: 1,
      text: 'Never delete system files via bash',
      triggerPattern: 'bash rm',
      action: 'block dangerous bash commands',
      status: 'active' as const,
      priority: 'high' as const,
      scope: 'global' as const,
      evaluability: 'deterministic' as const,
      valueScore: 0.9,
      adherenceRate: 0.8,
      painPreventedCount: 5,
      derivedFromPainIds: ['pain_001'],
      ruleIds: [] as string[],
      conflictsWithPrincipleIds: [] as string[],
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    },
    painEvents: [
      {
        reason: overrides?.reason ?? 'bash command failed on /etc/important.conf',
        source: 'tool_failure',
      },
    ],
    sessionSnapshot: null,
    lineage: { sourcePainIds: ['pain_001'], sessionId: null as string | null },
  };
}

// --- Tests ---

describe('PrincipleCompiler replay gate (PRI-115)', () => {
  let compiler: PrincipleCompiler;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock collector.collect directly on the instance
    mockCollect.mockReturnValue(makeContext());

    mockValidate.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mockGenerate.mockReturnValue(
      'export function evaluate() { return { decision: "block", matched: true, reason: "test", confidence: 0.95 }; }',
    );
    mockRegister.mockReturnValue({ ruleId: 'R_test_auto', implementationId: 'IMPL_test_auto' });

    compiler = new PrincipleCompiler('/tmp/test-state', {} as any);
    // Override collector after construction to avoid module resolution issues
    (compiler as any).collector = { collect: mockCollect, collectBatch: vi.fn() };
  });

  it('failing replay returns degraded=true and blocks registration', () => {
    mockCollect.mockReturnValue(makeContext());

    mockLoadModule.mockReturnValue({
      evaluate: () => ({ decision: 'allow', matched: false, reason: 'pass', confidence: 1.0 }),
    });

    const result = compiler.compileOne(PRINCIPLE_ID);

    expect(result.success).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toBe('replay_validation_failed');
    expect(result.replayResult).toBeDefined();
    expect(result.replayResult!.passed).toBe(false);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('no asset dir created on replay failure', () => {
    mockCollect.mockReturnValue(makeContext());

    mockLoadModule.mockReturnValue({
      evaluate: () => ({ decision: 'allow', matched: false, reason: 'pass', confidence: 1.0 }),
    });

    compiler.compileOne(PRINCIPLE_ID);

    expect(mockCreateAssetDir).not.toHaveBeenCalled();
  });

  it('passing replay registers normally', () => {
    mockCollect.mockReturnValue(makeContext());

    mockLoadModule.mockReturnValue({
      evaluate: (input: any) => {
        const path = input?.action?.paramsSummary?.path;
        if (path && path.includes('passwd')) {
          return { decision: 'block', matched: true, reason: 'dangerous', confidence: 0.95 };
        }
        return { decision: 'allow', matched: false, reason: 'safe', confidence: 1.0 };
      },
    });

    const result = compiler.compileOne(PRINCIPLE_ID);

    expect(result.success).toBe(true);
    expect(result.degraded).toBeUndefined();
    expect(mockRegister).toHaveBeenCalledOnce();
    expect(mockCreateAssetDir).toHaveBeenCalledOnce();
  });

  it('no cases (no regex qualifier) skips replay gate and registers', () => {
    mockCollect.mockReturnValue(makeContext({ reason: 'bash failed unexpectedly' }));

    mockLoadModule.mockReturnValue({
      evaluate: () => ({ decision: 'block', matched: true, reason: 'test', confidence: 0.95 }),
    });

    const result = compiler.compileOne(PRINCIPLE_ID);

    expect(result.success).toBe(true);
    expect(result.degraded).toBeUndefined();
    expect(mockRegister).toHaveBeenCalledOnce();
    expect(mockLoadModule).not.toHaveBeenCalled();
  });

  it('no evaluate export returns degraded', () => {
    mockCollect.mockReturnValue(makeContext());

    mockLoadModule.mockReturnValue({});

    const result = compiler.compileOne(PRINCIPLE_ID);

    expect(result.success).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toContain('no evaluate export');
    expect(mockRegister).not.toHaveBeenCalled();
  });
});
