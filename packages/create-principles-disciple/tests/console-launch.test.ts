import { describe, it, expect } from 'vitest';
import {
  buildSuccessOutput,
  type ComponentStatus,
  type VerificationResult,
  type MvpChannel,
} from '../src/mvp-config.js';

/**
 * Task 8: installer 末尾复用 pd console open 自动启动 console + 浏览器
 *
 * 这些测试覆盖纯函数 buildSuccessOutput 的 consoleUrl 字段。
 * install() 主函数因副作用（spawn / 网络监听）难以单元测试，
 * 因此通过测试 buildSuccessOutput 验证输出契约 (EP-09: 测试真实输出字段)。
 */
describe('Console auto-launch output (Task 8)', () => {
  const completeComponents: ComponentStatus = {
    plugin: 'verified',
    cli: 'verified',
    console: 'configured',
  };
  const passedVerification: VerificationResult = {
    features: 'passed',
    storyA: 'passed',
  };
  const channels: MvpChannel[] = ['prompt', 'defer_archive'];

  it('Given successful install with consoleUrl, When buildSuccessOutput runs, Then output includes consoleUrl and nextAction references it', () => {
    // HashRouter: real URL is /#/welcome (client-side route under hash),
    // not /welcome (which the server would treat as an API path → 404).
    const consoleUrl = 'http://127.0.0.1:3100/#/welcome';
    const result = buildSuccessOutput({
      workspace: '/test/ws',
      components: completeComponents,
      channels,
      verification: passedVerification,
      consoleUrl,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.consoleUrl).toBe(consoleUrl);
      expect(result.nextAction).toContain(consoleUrl);
    }
  });

  it('Given successful install without consoleUrl, When buildSuccessOutput runs, Then consoleUrl is undefined and nextAction keeps manual start instruction', () => {
    const result = buildSuccessOutput({
      workspace: '/test/ws',
      components: completeComponents,
      channels,
      verification: passedVerification,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.consoleUrl).toBeUndefined();
      // EP-03: 未自动启动时必须保留手动启动指引 (不静默吞掉)
      expect(result.nextAction).toContain('pd console');
    }
  });

  it('Given failed install with consoleUrl provided, When buildSuccessOutput runs, Then output is failure and does not carry consoleUrl', () => {
    const result = buildSuccessOutput({
      workspace: '/test/ws',
      components: { plugin: 'failed', cli: 'skipped', console: 'skipped' },
      channels,
      verification: { features: 'skipped', storyA: 'skipped' },
      consoleUrl: 'http://127.0.0.1:3100/#/welcome',
    });
    // 安装失败时不应该宣称 console 已就绪 (EP-03: fail loud, 不伪装成功)
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('consoleUrl');
  });
});
