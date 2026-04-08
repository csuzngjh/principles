/**
 * Rule Host Tests
 *
 * PURPOSE: Verify that the RuleHost class:
 *   - Returns undefined when no active implementations exist
 *   - Returns block when an implementation returns block (with short-circuit)
 *   - Returns requireApproval when an implementation returns requireApproval
 *   - Returns undefined when all implementations return allow or matched=false
 *   - Degrades conservatively on vm load or execution errors
 *   - Merges multiple implementation decisions correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuleHost } from '../../src/core/rule-host.js';
import type { RuleHostInput, RuleHostResult } from '../../src/core/rule-host-types.js';

// Mock the ledger module
vi.mock('../../src/core/principle-tree-ledger.js', () => ({
  loadLedger: vi.fn(),
  listImplementationsByLifecycleState: vi.fn(() => []),
  findActiveImplementation: vi.fn(() => null),
}));

vi.mock('../../src/core/code-implementation-storage.js', () => ({
  loadEntrySource: vi.fn(() => null),
}));

// Mock fs to avoid actual file reads
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

vi.mock('../../src/core/rule-implementation-runtime.js', () => ({
  loadRuleImplementationModule: vi.fn(),
}));

import { listImplementationsByLifecycleState } from '../../src/core/principle-tree-ledger.js';
import { loadEntrySource } from '../../src/core/code-implementation-storage.js';
import { loadRuleImplementationModule } from '../../src/core/rule-implementation-runtime.js';
import * as fs from 'fs';

const mockedListImplementations = vi.mocked(listImplementationsByLifecycleState);
const mockedLoadEntrySource = vi.mocked(loadEntrySource);
const mockedLoadRuleImplementationModule = vi.mocked(loadRuleImplementationModule);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

function makeInput(overrides?: Partial<RuleHostInput>): RuleHostInput {
  return {
    action: {
      toolName: 'write',
      normalizedPath: 'src/test.ts',
      paramsSummary: {},
    },
    workspace: {
      isRiskPath: false,
      planStatus: 'READY',
      hasPlanFile: true,
    },
    session: {
      sessionId: 'test-session',
      currentGfi: 10,
      recentThinking: false,
    },
    evolution: {
      epTier: 3,
    },
    derived: {
      estimatedLineChanges: 50,
      bashRisk: 'normal',
    },
    ...overrides,
  };
}

function makeMockImpl(id: string, type: string = 'code', lifecycleState: string = 'active') {
  return {
    id,
    ruleId: `RULE_${id}`,
    type,
    path: `/impls/${id}.js`,
    version: '1.0.0',
    coversCondition: 'test',
    coveragePercentage: 100,
    lifecycleState,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('RuleHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedLoadEntrySource.mockReturnValue(null);
  });

  it('should return undefined when no active implementations exist (empty ledger)', () => {
    mockedListImplementations.mockReturnValue([]);
    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });

  it('should return undefined when implementations exist but none are type=code', () => {
    mockedListImplementations.mockReturnValue([
      makeMockImpl('IMPL_01', 'skill', 'active'),
      makeMockImpl('IMPL_02', 'lora', 'active'),
    ] as any);
    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });

  it('should return undefined when implementations exist but none are lifecycleState=active', () => {
    // listImplementationsByLifecycleState('active') only returns active ones
    mockedListImplementations.mockReturnValue([]);
    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });

  it('should return block when a loaded implementation returns decision=block', () => {
    const blockResult: RuleHostResult = {
      decision: 'block',
      matched: true,
      reason: 'Dangerous operation',
    };
    const mockImpl = makeMockImpl('IMPL_BLOCK');

    mockedListImplementations.mockReturnValue([mockImpl] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('module.exports = {}');
    mockedLoadRuleImplementationModule.mockReturnValue({
      meta: { name: 'block-test', version: '1.0.0', ruleId: 'RULE_BLOCK', coversCondition: 'test' },
      evaluate: (_input: any, _helpers: any) => blockResult,
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeDefined();
    expect(result?.decision).toBe('block');
    expect(result?.matched).toBe(true);
    expect(result?.reason).toBe('Dangerous operation');
  });

  it('should return block (short-circuit) when first of two implementations returns block', () => {
    const blockResult: RuleHostResult = {
      decision: 'block',
      matched: true,
      reason: 'First impl blocks',
    };
    const allowResult: RuleHostResult = {
      decision: 'allow',
      matched: true,
      reason: 'Second impl allows',
    };

    const impl1 = makeMockImpl('IMPL_01');
    const impl2 = makeMockImpl('IMPL_02');

    mockedListImplementations.mockReturnValue([impl1, impl2] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('module.exports = {}');

    let callCount = 0;
    mockedLoadRuleImplementationModule.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          meta: { name: 'block-first', version: '1.0.0', ruleId: 'RULE_01', coversCondition: 'test' },
          evaluate: () => blockResult,
        };
      }
      return {
        meta: { name: 'allow-second', version: '1.0.0', ruleId: 'RULE_02', coversCondition: 'test' },
        evaluate: () => allowResult,
      };
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());

    expect(result?.decision).toBe('block');
    expect(result?.reason).toBe('First impl blocks');
  });

  it('should return requireApproval when a loaded implementation returns decision=requireApproval', () => {
    const approvalResult: RuleHostResult = {
      decision: 'requireApproval',
      matched: true,
      reason: 'High-risk path modification',
    };
    const mockImpl = makeMockImpl('IMPL_APPROVAL');

    mockedListImplementations.mockReturnValue([mockImpl] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('module.exports = {}');
    mockedLoadRuleImplementationModule.mockReturnValue({
      meta: { name: 'approval-test', version: '1.0.0', ruleId: 'RULE_APPROVAL', coversCondition: 'test' },
      evaluate: () => approvalResult,
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result?.decision).toBe('requireApproval');
    expect(result?.matched).toBe(true);
    expect(result?.reason).toBe('High-risk path modification');
  });

  it('should return undefined when all implementations return allow or matched=false', () => {
    const allowResult: RuleHostResult = {
      decision: 'allow',
      matched: true,
      reason: 'OK',
    };
    const unmatchedResult: RuleHostResult = {
      decision: 'allow',
      matched: false,
      reason: 'Not applicable',
    };

    const impl1 = makeMockImpl('IMPL_01');
    const impl2 = makeMockImpl('IMPL_02');

    mockedListImplementations.mockReturnValue([impl1, impl2] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('module.exports = {}');

    let callCount = 0;
    mockedLoadRuleImplementationModule.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          meta: { name: 'allow-1', version: '1.0.0', ruleId: 'RULE_01', coversCondition: 'test' },
          evaluate: () => allowResult,
        };
      }
      return {
        meta: { name: 'unmatched-2', version: '1.0.0', ruleId: 'RULE_02', coversCondition: 'test' },
        evaluate: () => unmatchedResult,
      };
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });

  it('should return undefined on vm load error (conservative degradation)', () => {
    const mockImpl = makeMockImpl('IMPL_BAD');
    mockedListImplementations.mockReturnValue([mockImpl] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('bad syntax {{{');
    mockedLoadRuleImplementationModule.mockImplementation(() => {
      throw new Error('Compilation failed: unexpected token');
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });

  it('should use injected logger for degradation warnings instead of direct console writes', () => {
    const warn = vi.fn();
    const mockImpl = makeMockImpl('IMPL_BAD');
    mockedListImplementations.mockReturnValue([mockImpl] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('bad syntax {{{');
    mockedLoadRuleImplementationModule.mockImplementation(() => {
      throw new Error('Compilation failed: unexpected token');
    });

    const host = new RuleHost('/mock/state', { warn });
    const result = host.evaluate(makeInput());

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to compile implementation IMPL_BAD')
    );
  });

  it('should return undefined on vm execution error (conservative degradation)', () => {
    const mockImpl = makeMockImpl('IMPL_EXEC_ERR');
    mockedListImplementations.mockReturnValue([mockImpl] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('module.exports = {}');
    mockedLoadRuleImplementationModule.mockReturnValue({
      meta: { name: 'exec-err', version: '1.0.0', ruleId: 'RULE_ERR', coversCondition: 'test' },
      evaluate: () => {
        throw new Error('Runtime error during evaluation');
      },
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });

  it('should return undefined when implementation asset path does not exist', () => {
    const mockImpl = makeMockImpl('IMPL_NOFILE');
    mockedListImplementations.mockReturnValue([mockImpl] as any);
    mockedExistsSync.mockReturnValue(false);

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });

  it('loads code implementations from storage assets before falling back to impl.path', () => {
    const blockResult: RuleHostResult = {
      decision: 'block',
      matched: true,
      reason: 'Loaded from storage asset',
    };
    const mockImpl = makeMockImpl('IMPL_STORAGE');

    mockedListImplementations.mockReturnValue([mockImpl] as any);
    mockedLoadEntrySource.mockReturnValue('export const meta = {}; export function evaluate() {}');
    mockedExistsSync.mockReturnValue(false);
    mockedLoadRuleImplementationModule.mockReturnValue({
      meta: { name: 'storage-test', version: '1.0.0', ruleId: 'RULE_STORAGE', coversCondition: 'test' },
      evaluate: () => blockResult,
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());

    expect(mockedLoadEntrySource).toHaveBeenCalledWith('/mock/state', 'IMPL_STORAGE');
    expect(mockedReadFileSync).not.toHaveBeenCalled();
    expect(result?.decision).toBe('block');
    expect(result?.reason).toBe('Loaded from storage asset');
  });

  it('should merge multiple requireApproval results', () => {
    const approval1: RuleHostResult = {
      decision: 'requireApproval',
      matched: true,
      reason: 'Risk path',
      diagnostics: { riskLevel: 'high' },
    };
    const approval2: RuleHostResult = {
      decision: 'requireApproval',
      matched: true,
      reason: 'Large change',
      diagnostics: { lineCount: 500 },
    };

    const impl1 = makeMockImpl('IMPL_01');
    const impl2 = makeMockImpl('IMPL_02');

    mockedListImplementations.mockReturnValue([impl1, impl2] as any);
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue('module.exports = {}');

    let callCount = 0;
    mockedLoadRuleImplementationModule.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return {
          meta: { name: 'approval-1', version: '1.0.0', ruleId: 'RULE_01', coversCondition: 'test' },
          evaluate: () => approval1,
        };
      }
      return {
        meta: { name: 'approval-2', version: '1.0.0', ruleId: 'RULE_02', coversCondition: 'test' },
        evaluate: () => approval2,
      };
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());

    expect(result?.decision).toBe('requireApproval');
    expect(result?.reason).toContain('Risk path');
    expect(result?.reason).toContain('Large change');
    expect(result?.diagnostics).toEqual({ riskLevel: 'high', lineCount: 500 });
  });

  it('should return undefined when ledger access fails', () => {
    mockedListImplementations.mockImplementation(() => {
      throw new Error('Ledger file not found');
    });

    const host = new RuleHost('/mock/state');
    const result = host.evaluate(makeInput());
    expect(result).toBeUndefined();
  });
});
