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
  it('默认安装 (无 provider): semantic 检测不可用 + 确定性路径工作 + 修复后 flag 生效', () => {
    // ── 层 1: installer 生成的 config (fresh install 的确切产物) ──
    const yamlContent = generateConfigYamlContent(); // 无 runtimeProfile = 默认用户
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;

    // Outcome B 证据 1: signalCollector agent 默认禁用
    const agents = (parsed.internalAgents as { agents: Record<string, { enabled: boolean; runtimeProfile: string }> }).agents;
    expect(agents.signalCollector.enabled).toBe(false);
    // Outcome B 证据 2: 默认 profile 是 pi-ai 型且 provider 为空 → 无 semantic runtime
    const profiles = parsed.runtimeProfiles as Record<string, { type: string; provider?: string }>;
    expect(profiles['pd.default'].type).toBe('pi-ai');
    expect(profiles['pd.default'].provider ?? '').toBe('');

    // installer 不显式禁用修复相关 flag → registry 默认生效 (层 2 证据:
    // principles-core feature-flag-contract.test.ts 断言三者默认 ON)
    const features = parsed.features as Record<string, { enabled: boolean }>;
    expect(features['evaluator_artificer_repair_loop']).toBeUndefined();
    expect(features['internalization_auto_consumer']).toBeUndefined();
    expect(features['internalization_full_chain']).toBeUndefined();
    // signal LLM 检测面默认关闭 (Outcome B — 确定性路径仍由 keyword Stage1 常开承担):
    // signal_collector 未列出 → registry 默认 false;correction_observer 显式 false
    expect(features['signal_collector']).toBeUndefined();
    // PRI-637: installer 条目带 source: 'system' (origin hint — 非 Owner 选择证据,
    // 也非"可无条件自动删除"许可; 见 packages/principles-core pd-config-types.ts)。
    expect(features['correction_observer']).toEqual({ category: 'quiet', enabled: false, source: 'system' });
  });

  it('带 provider 的安装: signalCollector 仍需用户显式启用 (不自动宣称 semantic 可用)', () => {
    const yamlContent = generateConfigYamlContent({ provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'OPENAI_API_KEY' });
    const parsed = yaml.load(yamlContent) as Record<string, unknown>;
    const agents = (parsed.internalAgents as { agents: Record<string, { enabled: boolean }> }).agents;
    // 即使配了 LLM provider, signalCollector 也不自动开 — 语义检测是显式 opt-in
    expect(agents.signalCollector.enabled).toBe(false);
  });
});
