/**
 * Journey 12 — Fresh Install 默认面验证 (P0-C Outcome B 的可执行证据)。
 *
 * 此前 PARTIAL 原因: 网络受限无法 npx 走完整 installer。本测试调用
 * installer 真正写入 workspace/.pd/config.yaml 的生成函数
 * (generateConfigYamlContent, mvp-config.ts — 非 mock),断言 fresh
 * install 的默认行为面。
 *
 * 证据链说明 (两层拆分, 因包依赖边界):
 *   层 1 (本文件): installer 产物 YAML 的确切默认值
 *   层 2 (已由 packages/principles-core feature-flag-contract.test.ts 覆盖):
 *     registry 默认 evaluator_artificer_repair_loop=ON、
 *     internalization_auto_consumer=ON、internalization_full_chain=ON。
 *   installer 不显式覆盖这些 flag (层 1 断言) × registry 默认 (层 2 已测)
 *   ⟹ fresh install 上修复后语义生效。
 *   注: 本包不依赖 @principles/core (打包边界), 不在此 import —
 *   本机 node_modules 链接可解析不代表 CI 独立安装可解析 (ERR-083)。
 */
import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { generateConfigYamlContent } from '../src/mvp-config.js';

describe('Journey 12 — fresh install 默认面 (Outcome B)', () => {
  it('默认安装 (无 provider): signalCollector 默认启用（未配端点则 WARN 降级）+ 确定性路径工作 + 修复后 flag 生效', () => {
    // ── 层 1: installer 生成的 config (fresh install 的确切产物) ──
    const yamlContent = generateConfigYamlContent(); // 无 runtimeProfile = 默认用户
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;

    // PRI-797: signalCollector agent 默认启用——语义确认链不再依赖手工开闸；
    // 未配置 API 端点时降级为关键词-only 并以 WARN + doctor needs_setup 显性提醒。
    const agents = (parsed.internalAgents as { agents: Record<string, { enabled: boolean; runtimeProfile: string }> }).agents;
    expect(agents.signalCollector.enabled).toBe(true);
    // 默认 profile 是 pi-ai 型且 provider 为空 → 该状态下 classifier needs_setup（WARN 可见）
    const profiles = parsed.runtimeProfiles as Record<string, { type: string; provider?: string }>;
    expect(profiles['pd.default'].type).toBe('pi-ai');
    expect(profiles['pd.default'].provider ?? '').toBe('');

    // installer 不显式禁用修复相关 flag → registry 默认生效 (层 2 证据:
    // principles-core feature-flag-contract.test.ts 断言三者默认 ON)
    const features = parsed.features as Record<string, { enabled: boolean }>;
    expect(features['evaluator_artificer_repair_loop']).toBeUndefined();
    expect(features['internalization_auto_consumer']).toBeUndefined();
    expect(features['internalization_full_chain']).toBeUndefined();
    // PRI-797: signal_collector registry 默认已翻为 ON——fresh config 不物化该
    // 条目，registry 默认由 effective resolver 提供（同 correction_observer 的
    // sparse-bootstrap 模式）。
    expect(features['signal_collector']).toBeUndefined();
    // PRI-645: fresh config 携带零 feature 条目 — correction_observer 同样
    // 不再物化,registry 默认 false 由 effective resolver 提供 (core 侧
    // pd-config-sparse-bootstrap.test.ts 锁定该默认值)。
    expect(features['correction_observer']).toBeUndefined();
    expect(features).toEqual({});
  });

  it('带 provider 的安装: signalCollector 默认启用——配好端点即语义确认自动生效', () => {
    const yamlContent = generateConfigYamlContent({ provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' });
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;
    const agents = (parsed.internalAgents as { agents: Record<string, { enabled: boolean }> }).agents;
    // PRI-797: 默认启用——provider 就绪时语义确认链开箱即用，无需手工开闸
    expect(agents.signalCollector.enabled).toBe(true);
  });
});
