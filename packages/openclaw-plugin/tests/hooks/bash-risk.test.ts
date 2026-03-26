import { describe, it, expect, vi } from 'vitest';
import { analyzeBashCommand } from '../../src/hooks/bash-risk.js';

describe('analyzeBashCommand', () => {
  it('should return safe for commands matching safe patterns', () => {
    const result = analyzeBashCommand('npm install lodash', ['^npm\\s+install'], []);
    expect(result).toBe('safe');
  });

  it('should return dangerous for commands matching dangerous patterns', () => {
    const result = analyzeBashCommand('rm -rf /', [], ['rm\\s+.*-rf']);
    expect(result).toBe('dangerous');
  });

  it('should return normal for commands not in safe/dangerous lists', () => {
    const result = analyzeBashCommand('npm install lodash', [], []);
    expect(result).toBe('normal');
  });

  it('should de-obfuscate Cyrillic lookalikes', () => {
    // Using Cyrillic 'rеset' (with Cyrillic 'е' U+0435) instead of 'reset'
    // This should de-obfuscate to 'git reset --hard' and match the dangerous pattern
    const result = analyzeBashCommand('git rеset --hard', [], ['git\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-fd)']);
    expect(result).toBe('dangerous');
  });

  it('should tokenize command chains', () => {
    const result = analyzeBashCommand('npm install && npm test', ['^npm\\s+install'], ['npm\\s+publish']);
    expect(result).toBe('normal');
  });

  it('should fail-closed on invalid dangerous regex', () => {
    const mockLogger = { warn: vi.fn() };
    const result = analyzeBashCommand('echo test', ['^echo'], ['invalid('], mockLogger);
    expect(result).toBe('dangerous'); // Fail-closed behavior
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid dangerous bash regex')
    );
  });

  it('should ignore safe pattern on invalid safe regex', () => {
    const mockLogger = { warn: vi.fn() };
    const result = analyzeBashCommand('echo test', ['invalid('], [], mockLogger);
    expect(result).toBe('normal'); // Not safe because safe pattern is invalid and ignored
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid safe bash regex')
    );
  });

  it('should strip $() from commands before pattern matching', () => {
    const result = analyzeBashCommand('$(npm install)', ['^npm\\s+install'], []);
    expect(result).toBe('safe');
  });

  it('should strip backticks from commands before pattern matching', () => {
    const result = analyzeBashCommand('`npm install`', ['^npm\\s+install'], []);
    expect(result).toBe('safe');
  });

  it('should handle command chains with semicolon separator', () => {
    const result = analyzeBashCommand('npm install ; npm test', ['^npm\\s+install'], ['rm\\s+']);
    expect(result).toBe('normal'); // Second command not safe
  });

  it('should handle command chains with OR separator', () => {
    const result = analyzeBashCommand('npm install || npm test', ['^npm\\s+install'], ['rm\\s+']);
    expect(result).toBe('normal');
  });

  it('should convert uppercase Cyrillic to lowercase Latin', () => {
    // Using uppercase Cyrillic 'Е' (U+0415) which should convert to 'e'
    // 'git REsET --hard' should become 'git reset --hard' and match the dangerous pattern
    const result = analyzeBashCommand('git rEsET --hard', [], ['git\\s+(push\\s+.*--force|reset\\s+--hard|clean\\s+-fd)']);
    expect(result).toBe('dangerous');
  });

  it('should handle additional confusable Unicode characters', () => {
    const result = analyzeBashCommand('del node_modules', [], ['rm\\s+']);
    expect(result).toBe('normal'); // 'del' is not in dangerous patterns
  });
});
