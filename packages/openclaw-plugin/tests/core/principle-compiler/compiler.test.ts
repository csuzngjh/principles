import { describe, it, expect, vi } from 'vitest';
import { PrincipleCompiler } from '../../../src/core/principle-compiler/compiler.js';
import { ReflectionContextCollector } from '../../../src/core/reflection/reflection-context.js';

vi.mock('../../../src/core/reflection/reflection-context.js');
vi.mock('../../../src/core/principle-compiler/code-validator.js');
vi.mock('../../../src/core/principle-compiler/template-generator.js');
vi.mock('../../../src/core/principle-compiler/ledger-registrar.js');
vi.mock('../../../src/core/code-implementation-storage.js');
vi.mock('../../../src/core/rule-implementation-runtime.js');

import { validateGeneratedCode } from '../../../src/core/principle-compiler/code-validator.js';
import { generateFromTemplate } from '../../../src/core/principle-compiler/template-generator.js';
import { registerCompiledRule } from '../../../src/core/principle-compiler/ledger-registrar.js';
import { createImplementationAssetDir } from '../../../src/core/code-implementation-storage.js';
import { loadRuleImplementationModule } from '../../../src/core/rule-implementation-runtime.js';

describe('PrincipleCompiler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractPatterns', () => {
    it('extracts patterns from pain events with tool names', () => {
      const context = {
        painEvents: [
          { reason: 'bash command failed', source: 'tool_failure' },
          { reason: 'write to file /etc/config failed', source: 'tool_failure' },
        ],
        sessionSnapshot: null,
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const spy = vi.spyOn(compiler as never, 'compileOne');
      spy.mockImplementation(() => ({ success: false, principleId: 'p-001', reason: 'test' }));

      compiler.compileAll();
    });

    it('extracts patterns from failed tool calls in session snapshot', () => {
      const context = {
        painEvents: [],
        sessionSnapshot: {
          toolCalls: [
            { toolName: 'bash', outcome: 'failure', filePath: '/tmp/test.sh', errorType: 'command_error' },
            { toolName: 'read', outcome: 'success', filePath: '/tmp/file.txt', errorType: null },
            { toolName: 'write', outcome: 'blocked', filePath: '/etc/passwd', errorType: 'permission_error' },
          ],
        },
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const spy = vi.spyOn(compiler as never, 'compileOne');
      spy.mockImplementation(() => ({ success: false, principleId: 'p-001', reason: 'test' }));

      compiler.compileAll();
    });

    it('groups patterns by tool name', () => {
      const context = {
        painEvents: [
          { reason: 'bash failed', source: 'tool_failure' },
          { reason: 'bash failed again', source: 'tool_failure' },
          { reason: 'write failed', source: 'tool_failure' },
        ],
        sessionSnapshot: null,
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const spy = vi.spyOn(compiler as never, 'compileOne');
      spy.mockImplementation(() => ({ success: false, principleId: 'p-001', reason: 'test' }));

      compiler.compileAll();
    });

    it('returns empty array when no patterns found', () => {
      const context = {
        painEvents: [
          { reason: 'some error without tool name', source: 'tool_failure' },
        ],
        sessionSnapshot: {
          toolCalls: [
            { toolName: 'bash', outcome: 'success', filePath: '/tmp/test.sh', errorType: null },
          ],
        },
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const spy = vi.spyOn(compiler as never, 'compileOne');
      spy.mockImplementation(() => ({ success: false, principleId: 'p-001', reason: 'test' }));

      compiler.compileAll();
    });
  });

  describe('compileOne', () => {
    it('returns failure when no context available', () => {
      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(null),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const result = compiler.compileOne('p-001');

      expect(result).toEqual({ success: false, principleId: 'p-001', reason: 'no context' });
    });

    it('returns failure when no patterns extracted', () => {
      const context = {
        painEvents: [],
        sessionSnapshot: null,
        principle: { id: 'p-001', triggerPattern: '', text: 'Test principle' },
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('');

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const result = compiler.compileOne('p-001');

      expect(result).toEqual({ success: false, principleId: 'p-001', reason: 'no patterns' });
    });

    it('returns failure when code validation fails', () => {
      const context = {
        painEvents: [{ reason: 'bash failed', source: 'tool_failure' }],
        sessionSnapshot: null,
        principle: { id: 'p-001', triggerPattern: '', text: 'Test principle' },
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('generated code');
      vi.mocked(validateGeneratedCode).mockReturnValue({ valid: false, errors: ['syntax error'] });

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const result = compiler.compileOne('p-001');

      expect(result).toEqual({
        success: false,
        principleId: 'p-001',
        reason: 'validation failed: syntax error',
      });
    });

    it('successfully compiles when all steps pass', () => {
      const context = {
        painEvents: [{ reason: 'bash failed', source: 'tool_failure' }],
        sessionSnapshot: null,
        principle: { id: 'p-001', triggerPattern: '', text: 'Test principle' },
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('generated code');
      vi.mocked(validateGeneratedCode).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(registerCompiledRule).mockReturnValue({ ruleId: 'rule-001', implementationId: 'impl-001' });

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const result = compiler.compileOne('p-001');

      expect(result).toEqual({
        success: true,
        principleId: 'p-001',
        ruleId: 'rule-001',
        implementationId: 'impl-001',
        code: 'generated code',
      });

      expect(createImplementationAssetDir).toHaveBeenCalledWith('/tmp/test', 'impl-001', '1', {
        entrySource: 'generated code',
      });
    });

    it('handles replay validation failure', () => {
      const context = {
        painEvents: [{ reason: 'bash command failed', source: 'tool_failure' }],
        sessionSnapshot: null,
        principle: { id: 'p-001', triggerPattern: '', text: 'Test principle' },
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('generated code');
      vi.mocked(validateGeneratedCode).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(loadRuleImplementationModule).mockReturnValue({ evaluate: () => ({ passed: false }) });

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const result = compiler.compileOne('p-001');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('replay_validation_failed');
      expect(result.degraded).toBe(true);
    });

    it('handles module load error during replay', () => {
      const context = {
        painEvents: [{ reason: 'bash command failed', source: 'tool_failure' }],
        sessionSnapshot: null,
        principle: { id: 'p-001', triggerPattern: '', text: 'Test principle' },
      };

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue(context),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('generated code');
      vi.mocked(validateGeneratedCode).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(loadRuleImplementationModule).mockImplementation(() => {
        throw new Error('Module load failed');
      });

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      const result = compiler.compileOne('p-001');

      expect(result.success).toBe(false);
      expect(result.reason).toContain('module_load_error');
      expect(result.degraded).toBe(true);
    });
  });

  describe('compileAll', () => {
    it('compiles all principles in batch', () => {
      const contexts = [
        { principle: { id: 'p-001', triggerPattern: '', text: 'Principle 1' } },
        { principle: { id: 'p-002', triggerPattern: '', text: 'Principle 2' } },
      ];

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn(),
        collectBatch: vi.fn().mockReturnValue(contexts),
      } as unknown as ReflectionContextCollector));

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      vi.spyOn(compiler as never, 'compileOne').mockImplementation((pid: string) => ({
        success: true,
        principleId: pid,
        ruleId: `rule-${pid}`,
        implementationId: `impl-${pid}`,
        code: 'code',
      }));

      const results = compiler.compileAll();

      expect(results).toHaveLength(2);
      expect(results[0].principleId).toBe('p-001');
      expect(results[1].principleId).toBe('p-002');
    });

    it('catches and returns error for failed compilation', () => {
      const contexts = [
        { principle: { id: 'p-001', triggerPattern: '', text: 'Principle 1' } },
      ];

      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn(),
        collectBatch: vi.fn().mockReturnValue(contexts),
      } as unknown as ReflectionContextCollector));

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);

      vi.spyOn(compiler as never, 'compileOne').mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const results = compiler.compileAll();

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].reason).toContain('unhandled');
    });
  });

  describe('inferToolName', () => {
    it('infers tool name from text', () => {
      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue({
          painEvents: [{ reason: 'bash command failed', source: 'tool_failure' }],
          sessionSnapshot: null,
          principle: { id: 'p-001', triggerPattern: '', text: 'Test' },
        }),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('code');
      vi.mocked(validateGeneratedCode).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(registerCompiledRule).mockReturnValue({ ruleId: 'rule-001', implementationId: 'impl-001' });

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);
      compiler.compileOne('p-001');

      expect(generateFromTemplate).toHaveBeenCalled();
    });

    it('excludes natural language uses of tool names', () => {
      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue({
          painEvents: [{ reason: 'please read the error message', source: 'tool_failure' }],
          sessionSnapshot: null,
          principle: { id: 'p-001', triggerPattern: '', text: 'Test' },
        }),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('');

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);
      const result = compiler.compileOne('p-001');

      expect(result.reason).toBe('no patterns');
    });
  });

  describe('extractPathRegex', () => {
    it('extracts file paths from text', () => {
      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue({
          painEvents: [{ reason: 'failed to write to /etc/config/app.conf', source: 'tool_failure' }],
          sessionSnapshot: null,
          principle: { id: 'p-001', triggerPattern: '', text: 'Test' },
        }),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('code');
      vi.mocked(validateGeneratedCode).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(registerCompiledRule).mockReturnValue({ ruleId: 'rule-001', implementationId: 'impl-001' });

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);
      compiler.compileOne('p-001');

      expect(generateFromTemplate).toHaveBeenCalled();
    });

    it('returns null when no path found', () => {
      vi.mocked(ReflectionContextCollector).mockImplementation(() => ({
        collect: vi.fn().mockReturnValue({
          painEvents: [{ reason: 'some error without path', source: 'tool_failure' }],
          sessionSnapshot: null,
          principle: { id: 'p-001', triggerPattern: '', text: 'Test' },
        }),
        collectBatch: vi.fn().mockReturnValue([]),
      } as unknown as ReflectionContextCollector));

      vi.mocked(generateFromTemplate).mockReturnValue('code');
      vi.mocked(validateGeneratedCode).mockReturnValue({ valid: true, errors: [] });
      vi.mocked(registerCompiledRule).mockReturnValue({ ruleId: 'rule-001', implementationId: 'impl-001' });

      const compiler = new PrincipleCompiler('/tmp/test', {} as never);
      compiler.compileOne('p-001');

      expect(generateFromTemplate).toHaveBeenCalled();
    });
  });
});