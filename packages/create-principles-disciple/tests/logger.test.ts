import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger, setQuietMode, banner } from '../src/utils/logger.js';

describe('logger utilities', () => {
  const originalLog = console.log;
  const mockLog = vi.fn();

  beforeEach(() => {
    console.log = mockLog;
    setQuietMode(false);
  });

  afterEach(() => {
    console.log = originalLog;
    vi.clearAllMocks();
  });

  describe('setQuietMode', () => {
    it('disables logging when quiet mode is enabled', () => {
      setQuietMode(true);
      
      logger.info('test message');
      
      expect(mockLog).not.toHaveBeenCalled();
    });

    it('enables logging when quiet mode is disabled', () => {
      setQuietMode(false);
      
      logger.info('test message');
      
      expect(mockLog).toHaveBeenCalled();
    });
  });

  describe('logger methods', () => {
    it('info logs message with blue info icon', () => {
      logger.info('test info');
      
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('ℹ'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('test info'));
    });

    it('success logs message with green check icon', () => {
      logger.success('test success');
      
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('✔'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('test success'));
    });

    it('warn logs message with yellow warning icon', () => {
      logger.warn('test warning');
      
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('⚠'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('test warning'));
    });

    it('error logs message with red error icon', () => {
      logger.error('test error');
      
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('✖'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('test error'));
    });

    it('step logs message with package icon and newlines', () => {
      logger.step('test step');
      
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('📦'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('test step'));
    });

    it('list logs title and entries', () => {
      logger.list('Test Title', [
        { name: 'Name1', value: 'Value1' },
        { name: 'Name2', value: 'Value2' },
      ]);
      
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Test Title'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Name1'));
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Value1'));
    });
  });

  describe('banner', () => {
    it('contains Principles Disciple text', () => {
      expect(banner).toContain('Principles Disciple');
    });

    it('contains OpenClaw Plugin Installer text', () => {
      expect(banner).toContain('OpenClaw Plugin Installer');
    });
  });
});