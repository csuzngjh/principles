import { describe, it, expect, vi } from 'vitest';
import {
  isValidModelFormat,
  resolveModelFromConfig,
  type CoreLogger,
  type ModelConfigObject,
} from '../model-config.js';

describe('isValidModelFormat', () => {
  it('accepts valid provider/model format', () => {
    expect(isValidModelFormat('openai/gpt-4')).toBe(true);
    expect(isValidModelFormat('anthropic/claude-3-opus')).toBe(true);
  });

  it('accepts model with dots and hyphens', () => {
    expect(isValidModelFormat('openai/gpt-4-turbo')).toBe(true);
    expect(isValidModelFormat('anthropic/claude-3.5-sonnet')).toBe(true);
  });

  it('accepts two-char provider and single-char model', () => {
    expect(isValidModelFormat('ab/c')).toBe(true);
  });

  it('rejects single-char provider (pattern requires first + last char)', () => {
    expect(isValidModelFormat('a/b')).toBe(false);
  });

  it('rejects missing slash', () => {
    expect(isValidModelFormat('gpt-4')).toBe(false);
    expect(isValidModelFormat('openai')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidModelFormat('')).toBe(false);
  });

  it('rejects provider starting or ending with hyphen', () => {
    expect(isValidModelFormat('-openai/gpt-4')).toBe(false);
    expect(isValidModelFormat('openai-/gpt-4')).toBe(false);
  });

  it('rejects provider with special characters', () => {
    expect(isValidModelFormat('open_ai/gpt-4')).toBe(false);
    expect(isValidModelFormat('open.ai/gpt-4')).toBe(false);
  });

  it('rejects multiple slashes', () => {
    expect(isValidModelFormat('openai/gpt/4')).toBe(false);
  });
});

describe('resolveModelFromConfig', () => {
  describe('string input', () => {
    it('returns trimmed string for valid format', () => {
      expect(resolveModelFromConfig('openai/gpt-4')).toBe('openai/gpt-4');
    });

    it('trims whitespace', () => {
      expect(resolveModelFromConfig('  openai/gpt-4  ')).toBe('openai/gpt-4');
    });

    it('returns null for empty string', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      expect(resolveModelFromConfig('', logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Empty model string'));
    });

    it('returns null for whitespace-only string', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      expect(resolveModelFromConfig('   ', logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Empty model string'));
    });

    it('returns null and warns for invalid format', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      const result = resolveModelFromConfig('invalid-model', logger);
      expect(result).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid model format: "invalid-model"'),
      );
    });

    it('does not call warn when logger is undefined', () => {
      // Should not throw
      const result = resolveModelFromConfig('invalid-model');
      expect(result).toBe(null);
    });
  });

  describe('object input', () => {
    it('returns primary model for valid object', () => {
      const cfg: ModelConfigObject = { primary: 'openai/gpt-4' };
      expect(resolveModelFromConfig(cfg)).toBe('openai/gpt-4');
    });

    it('trims primary model whitespace', () => {
      const cfg: ModelConfigObject = { primary: '  openai/gpt-4  ' };
      expect(resolveModelFromConfig(cfg)).toBe('openai/gpt-4');
    });

    it('returns null when primary is missing', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      const cfg: ModelConfigObject = { fallbacks: ['openai/gpt-4'] };
      expect(resolveModelFromConfig(cfg, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing primary model'));
    });

    it('returns null when primary is empty string', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      const cfg: ModelConfigObject = { primary: '' };
      expect(resolveModelFromConfig(cfg, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Empty primary model string'));
    });

    it('returns null and warns for invalid primary format', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      const cfg: ModelConfigObject = { primary: 'invalid' };
      const result = resolveModelFromConfig(cfg, logger);
      expect(result).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid primary model format: "invalid"'),
      );
    });

    it('ignores fallbacks array', () => {
      const cfg: ModelConfigObject = {
        primary: 'openai/gpt-4',
        fallbacks: ['anthropic/claude-3'],
      };
      expect(resolveModelFromConfig(cfg)).toBe('openai/gpt-4');
    });
  });

  describe('array input', () => {
    it('returns null and warns for array', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      const result = resolveModelFromConfig(['openai/gpt-4'], logger);
      expect(result).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Array model config not supported'),
      );
    });
  });

  describe('other inputs', () => {
    it('returns null for null', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      expect(resolveModelFromConfig(null, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing model config'));
    });

    it('returns null for undefined', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      expect(resolveModelFromConfig(undefined, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing model config'));
    });

    it('returns null for number', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      expect(resolveModelFromConfig(42, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Unsupported model config type: number'));
    });

    it('returns null for empty object', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      expect(resolveModelFromConfig({}, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing primary model'));
    });

    it('returns null for object with non-string primary', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      expect(resolveModelFromConfig({ primary: 123 }, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid primary model type: number'));
    });

    it('ignores inherited primary property on object input', () => {
      const logger: CoreLogger = { warn: vi.fn() };
      const inheritedConfig = Object.create({ primary: 'openai/gpt-4' });
      expect(resolveModelFromConfig(inheritedConfig, logger)).toBe(null);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing primary model'));
    });
  });

  describe('logger compatibility', () => {
    it('accepts logger with (...args: unknown[]) => void signature (PluginLogger shape)', () => {
      // This simulates PluginLogger's method signature
      const pluginLikeLogger: CoreLogger = {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
      };
      // Should not throw and should satisfy CoreLogger
      const result = resolveModelFromConfig('invalid', pluginLikeLogger);
      expect(result).toBe(null);
    });
  });
});
