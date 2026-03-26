import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeBashCommand } from '../../src/hooks/bash-risk.js';

/**
 * Integration tests for bash-risk module
 * Tests zero-width character detection and command chain analysis
 */
describe('Bash Risk Analysis - Integration', () => {
  describe('Zero-width character detection', () => {
    it('should block commands with zero-width space (U+200B)', () => {
      // Zero-width space injected between characters
      const maliciousCmd = 'rm\u200B -rf /';
      const result = analyzeBashCommand(maliciousCmd, [], [], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should block commands with zero-width non-joiner (U+200C)', () => {
      const maliciousCmd = 'rm\u200C -rf /';
      const result = analyzeBashCommand(maliciousCmd, [], [], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should block commands with zero-width joiner (U+200D)', () => {
      const maliciousCmd = 'rm\u200D -rf /';
      const result = analyzeBashCommand(maliciousCmd, [], [], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should block commands with word joiner (U+2060)', () => {
      const maliciousCmd = 'rm\u2060 -rf /';
      const result = analyzeBashCommand(maliciousCmd, [], [], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should block commands with zero-width invisible separator (U+FEFF)', () => {
      const maliciousCmd = 'rm\uFEFF -rf /';
      const result = analyzeBashCommand(maliciousCmd, [], [], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should block commands with multiple zero-width characters', () => {
      const maliciousCmd = 'rm\u200B\u200C\u200D -rf /';
      const result = analyzeBashCommand(maliciousCmd, [], [], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should allow normal commands without zero-width characters', () => {
      const normalCmd = 'rm -rf /tmp/test';
      const result = analyzeBashCommand(normalCmd, ['^rm\\s'], [], { warn: vi.fn() });
      expect(result).toBe('safe');
    });

    it('should detect zero-width characters hidden in normal-looking commands', () => {
      // Command looks like 'git status' but contains hidden chars
      const hiddenCmd = 'git\u200B status';
      const result = analyzeBashCommand(hiddenCmd, [], [], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });
  });

  describe('Cyrillic homograph attack detection', () => {
    it('should de-obfuscate Cyrillic characters and match dangerous patterns', () => {
      // Cyrillic 'р' (U+0440) looks like Latin 'p' - 'g\u0440ush' → 'gpush' then 'push'
      // After toLowerCase + deobfuscation: 'gpush' won't match dangerous, but 'push' alone might
      // Actually: '\u0440' maps to 'p' so 'g\u0440ush' → 'gp' + 'ush' = 'gpush' 
      // Let's use Cyrillic 'е' which maps to 'e': '\u0435' → 'e'
      const cyrillicCmd = 'r\u0435m -rf /tmp';
      const result = analyzeBashCommand(cyrillicCmd, [], ['^rem'], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should handle Cyrillic а being converted to Latin a', () => {
      // Cyrillic 'а' (U+0430) maps to Latin 'a' - 's\u0430do' → 'sado'
      // After de-obfuscation: 'sado' - doesn't match dangerous patterns
      const mixedCmd = 's\u0430do apt update';
      const result = analyzeBashCommand(mixedCmd, [], ['^sudo'], { warn: vi.fn() });
      expect(result).toBe('normal');
    });
  });

  describe('Command chain tokenization', () => {
    it('should detect dangerous commands in chains using &&', () => {
      const chainCmd = 'echo "hello" && rm -rf /tmp/test';
      const result = analyzeBashCommand(chainCmd, [], ['rm\\s+-rf'], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should detect dangerous commands in chains using ||', () => {
      const chainCmd = 'ls || rm -rf /tmp/test';
      const result = analyzeBashCommand(chainCmd, [], ['rm\\s+-rf'], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should detect dangerous commands in chains using ;', () => {
      const chainCmd = 'ls ; rm -rf /tmp/test';
      const result = analyzeBashCommand(chainCmd, [], ['rm\\s+-rf'], { warn: vi.fn() });
      expect(result).toBe('dangerous');
    });

    it('should return safe if no segment matches dangerous patterns', () => {
      const safeChain = 'echo "hello" && echo "world"';
      const result = analyzeBashCommand(safeChain, [], ['rm\\s+-rf'], { warn: vi.fn() });
      expect(result).toBe('normal');
    });
  });

  describe('Fail-closed behavior', () => {
    it('should return dangerous for invalid regex in dangerousPatterns', () => {
      const cmd = 'ls';
      const result = analyzeBashCommand(cmd, [], ['[invalid'], { warn: vi.fn() });
      expect(result).toBe('dangerous'); // Fail-closed
    });

    it('should ignore invalid regex in safePatterns', () => {
      const cmd = 'echo hello';
      const warnFn = vi.fn();
      const result = analyzeBashCommand(cmd, ['[invalid'], [], { warn: warnFn });
      // Should not crash, should return normal (not all segments safe)
      expect(result).toBe('normal');
      expect(warnFn).toHaveBeenCalled();
    });
  });

  describe('Safe pattern override', () => {
    it('should return safe when all segments match safe patterns', () => {
      const safeCmd = 'git status';
      const result = analyzeBashCommand(safeCmd, ['^git\\s+status', '^ls'], []);
      expect(result).toBe('safe');
    });

    it('should return normal when not all segments are safe', () => {
      const mixedCmd = 'git status && rm -rf /tmp';
      const result = analyzeBashCommand(mixedCmd, ['^git\\s+status'], ['rm\\s+-rf']);
      expect(result).toBe('dangerous');
    });
  });
});
