/**
 * PRI-797 — signalCollector 默认启用后的显性提醒契约。
 *
 * 语义确认链（Stage2/批量确认/TP 记录）依赖 signalCollector 的 runtime profile；
 * 默认启用后，"未配置 API 端点"绝不允许静默失败——必须以 WARN 级（每 workspace
 * 一次）+ 结构化 nextAction 呈现（ERR-101 静默失败家族的反向加固）。
 * Owner 刻意关闭（flag/agent enabled:false）保持低噪声 debug，不算告警。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: { log: vi.fn() },
}));

import { createSignalLlmClassifierFromConfig, _resetSignalClassifierWarnState } from '../../src/core/signal-collector-host.js';
import { SystemLogger } from '../../src/core/system-logger.js';

const tempDirs: string[] = [];

afterEach(() => {
  _resetSignalClassifierWarnState();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function makeWorkspace(config: Record<string, unknown>): { workspaceDir: string; logger: Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.fn>> } {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-classifier-warn-'));
  tempDirs.push(workspaceDir);
  const pdDir = path.join(workspaceDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), yaml.dump(config));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { workspaceDir, logger };
}

function configWithAgent(agentEnabled: boolean): Record<string, unknown> {
  return {
    version: 1,
    features: {
      signal_collector: { category: 'quiet', enabled: agentEnabled },
    },
    runtimeProfiles: {
      'pi-ai.unused': { type: 'pi-ai', provider: 'openai', model: 'test-model', apiKeyEnv: 'PD_TEST_KEY_NOT_SET' },
    },
    internalAgents: {
      defaultRuntime: 'pi-ai.unused',
      agents: {
        diagnostician: { enabled: true, runtimeProfile: 'pi-ai.unused' },
        dreamer: { enabled: true, runtimeProfile: 'pi-ai.unused' },
        philosopher: { enabled: true, runtimeProfile: 'pi-ai.unused' },
        scribe: { enabled: true, runtimeProfile: 'pi-ai.unused' },
        artificer: { enabled: true, runtimeProfile: 'pi-ai.unused' },
        evaluator: { enabled: true, runtimeProfile: 'pi-ai.unused' },
        rolloutReviewer: { enabled: true, runtimeProfile: 'pi-ai.unused' },
        signalCollector: { enabled: agentEnabled, runtimeProfile: 'pi-ai.unused' },
      },
    },
  };
}

describe('signalCollector needs_setup 显性提醒 (PRI-797)', () => {
  beforeEach(() => {
    _resetSignalClassifierWarnState();
    process.env.PD_TEST_KEY_NOT_SET = undefined as unknown as string;
    delete process.env.PD_TEST_KEY_NOT_SET;
  });

  it('agent 默认启用 + API 端点未配置 → WARN 显性提醒（含 nextAction），返回 null 降级', () => {
    const { workspaceDir, logger } = makeWorkspace(configWithAgent(true));

    const classifier = createSignalLlmClassifierFromConfig(
      { workspaceDir } as unknown as Parameters<typeof createSignalLlmClassifierFromConfig>[0],
      logger,
    );

    expect(classifier).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const warnText = String(logger.warn.mock.calls[0][0]);
    expect(warnText).toContain('降级为关键词-only');
    expect(warnText).toContain('needs_setup');
    // nextAction 必须告诉 Owner 怎么修（配置端点/probe）
    expect(SystemLogger.log).toHaveBeenCalledWith(
      workspaceDir, 'SIGNAL_CLASSIFIER_NEEDS_SETUP', expect.stringContaining('needs_setup'),
    );
  });

  it('同 workspace 重复构建只 WARN 一次（去重防刷屏）', () => {
    const { workspaceDir, logger } = makeWorkspace(configWithAgent(true));
    const args = [
      { workspaceDir } as unknown as Parameters<typeof createSignalLlmClassifierFromConfig>[0],
      logger,
    ];

    createSignalLlmClassifierFromConfig(...args);
    createSignalLlmClassifierFromConfig(...args);
    createSignalLlmClassifierFromConfig(...args);

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('Owner 刻意关闭（enabled:false）→ 仅 debug，不算告警', () => {
    const { workspaceDir, logger } = makeWorkspace(configWithAgent(false));

    const classifier = createSignalLlmClassifierFromConfig(
      { workspaceDir } as unknown as Parameters<typeof createSignalLlmClassifierFromConfig>[0],
      logger,
    );

    expect(classifier).toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });
});
