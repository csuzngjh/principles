import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runConsumerCycle,
  InternalizationAutoConsumerService,
} from '../../src/service/internalization-auto-consumer-service.js';
import { loadFeatureFlagFromConfig } from '../../src/core/pd-config-loader.js';
import { SystemLogger } from '../../src/core/system-logger.js';
import type { OpenClawPluginServiceContext } from '../../src/openclaw-sdk.js';

vi.mock('../../src/core/pd-config-loader.js');
vi.mock('../../src/core/system-logger.js');

// PRI-624: the cycle body now lives in the shared host-runtime
// runInternalizationConsumerCycle, which reads the REAL workspace config —
// plugin-local loader mocks can no longer steer it. The cycle contract tests
// below therefore drive real .pd/config.yaml files (better than mocks: they
// exercise the production flag/config read path end to end).
describe('InternalizationAutoConsumerService', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const workspaceDir = '/mock/workspace';
  let realWorkspaceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    realWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auto-consumer-cycle-'));
  });

  afterEach(() => {
    fs.rmSync(realWorkspaceDir, { recursive: true, force: true });
  });

  describe('runConsumerCycle', () => {
    it('should skip when feature flag is disabled', async () => {
      fs.mkdirSync(path.join(realWorkspaceDir, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(realWorkspaceDir, '.pd', 'config.yaml'), [
        'version: 1',
        'features:',
        '  internalization_auto_consumer:',
        '    category: quiet',
        '    enabled: false',
        'runtimeProfiles:',
        '  openclaw.default:',
        '    type: openclaw',
        '    source: default',
        'internalAgents:',
        '  defaultRuntime: openclaw.default',
        '  agents:',
        '    dreamer:',
        '      enabled: true',
        '',
      ].join('\n'));
      await runConsumerCycle(realWorkspaceDir, logger);
      expect(SystemLogger.log).toHaveBeenCalledWith(realWorkspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', expect.stringContaining('internalization_auto_consumer_disabled'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Cycle skipped: auto-consumer disabled'));
    });

    it('should skip when config is malformed', async () => {
      fs.mkdirSync(path.join(realWorkspaceDir, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(realWorkspaceDir, '.pd', 'config.yaml'), 'features: [broken\n');
      await runConsumerCycle(realWorkspaceDir, logger);
      expect(SystemLogger.log).toHaveBeenCalledWith(realWorkspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', expect.stringContaining('config_malformed'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Config malformed, skipping cycle'));
    });
  });

  describe('start / stop', () => {
    it('should log warning when workspaceDir is missing', () => {
      const ctx = { logger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);
      expect(logger.warn).toHaveBeenCalledWith('[PD:AutoConsumer] No workspace directory, not starting.');
    });

    it('should skip start when feature flag is disabled', () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: false, source: 'default' });
      const ctx = { workspaceDir, logger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);
      expect(SystemLogger.log).toHaveBeenCalledWith(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', expect.any(String));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('NOT started for workspace'));
    });

    it('should stop gracefully without workspaceDir', () => {
      const ctx = {} as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.stop(ctx);
    });

    it('should stop gracefully with workspaceDir', () => {
      const ctx = { workspaceDir, logger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.stop(ctx);
    });
  });
});
