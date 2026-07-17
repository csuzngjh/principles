import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runConsumerCycle,
  InternalizationAutoConsumerService,
} from '../../src/service/internalization-auto-consumer-service.js';
import { loadFeatureFlagFromConfig, loadPdConfigForPlugin } from '../../src/core/pd-config-loader.js';
import { SystemLogger } from '../../src/core/system-logger.js';

vi.mock('../../src/core/pd-config-loader.js');
vi.mock('../../src/core/system-logger.js');

describe('InternalizationAutoConsumerService', () => {
  const workspaceDir = '/mock/workspace';
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runConsumerCycle', () => {
    it('should skip when feature flag is disabled', async () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: false, source: 'default' });
      await runConsumerCycle(workspaceDir, logger);
      expect(SystemLogger.log).toHaveBeenCalledWith(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', expect.stringContaining('internalization_auto_consumer_disabled'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Cycle skipped: auto-consumer disabled'));
    });

    it('should skip when config is malformed', async () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'default' });
      vi.mocked(loadPdConfigForPlugin).mockReturnValue({ ok: false, errors: [{ reason: 'invalid yaml', nextAction: 'Fix config' }] });
      await runConsumerCycle(workspaceDir, logger);
      expect(SystemLogger.log).toHaveBeenCalledWith(workspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', expect.stringContaining('config_malformed'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Config malformed, skipping cycle'));
    });
  });

  describe('InternalizationAutoConsumerService', () => {
    it('should log warning when workspaceDir is missing', () => {
      const ctx = { logger } as any;
      InternalizationAutoConsumerService.start(ctx);
      expect(logger.warn).toHaveBeenCalledWith('[PD:AutoConsumer] No workspace directory, not starting.');
    });

    it('should skip start when feature flag is disabled', () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: false, source: 'default' });
      const ctx = { workspaceDir, logger } as any;
      InternalizationAutoConsumerService.start(ctx);
      expect(SystemLogger.log).toHaveBeenCalledWith(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', expect.any(String));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('NOT started for workspace'));
    });

    it('should stop gracefully without workspaceDir', () => {
      const ctx = {} as any;
      InternalizationAutoConsumerService.stop(ctx);
    });

    it('should stop gracefully with workspaceDir', () => {
      const ctx = { workspaceDir, logger } as any;
      InternalizationAutoConsumerService.stop(ctx);
    });
  });
});