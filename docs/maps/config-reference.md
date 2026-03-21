# 配置参考 (Configuration Reference)

> **用途**: 完整的配置选项参考，帮助AI编程助手理解和修改系统行为
> **目标用户**: AI 编程智能体、开发者
> **最后更新**: 2026-03-21
> **⚠️ 验证状态**: ✅ 已验证 - 与 src/core/config.ts PainSettings 接口一致

---

## 📋 概述

Principles Disciple 使用分层配置系统：

1. **默认配置** - 硬编码在 `src/core/config.ts` DEFAULT_SETTINGS
2. **用户配置** - 存储在 `.state/pain_settings.json`
3. **运行时覆盖** - 通过环境变量或插件配置

**配置加载顺序**: 默认配置 → 用户配置 → 运行时覆盖

---

## 🔧 配置访问方式

```typescript
import { ConfigService } from '../core/config-service.js';

// 获取配置实例（单例工厂）
const config = ConfigService.get(stateDir);

// 使用点号路径访问
const painThreshold = config.get<number>('thresholds.pain_trigger');
const trustStages = config.get('trust.stages');

// 获取完整配置
const allSettings = config.getAll();
```

---

## 📝 完整配置选项

### 顶层配置

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `language` | string | 'zh' | UI语言 ('en' 或 'zh') |

---

### thresholds - 阈值配置

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `thresholds.pain_trigger` | number | 40 | 痛苦触发阈值，达到此分数写入 .pain_flag |
| `thresholds.cognitive_paralysis_input` | number | 4000 | 认知瘫痪输入阈值 |
| `thresholds.stuck_loops_trigger` | number | 4 | 卡住循环触发阈值 |
| `thresholds.semantic_min_score` | number | 0.7 | 语义最小分数 |
| `thresholds.promotion_count_threshold` | number | 3 | 晋升计数阈值 |
| `thresholds.promotion_similarity_threshold` | number | 0.8 | 晋升相似度阈值 |

---

### trust - 信任系统配置

#### trust.stages - 阶段阈值

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `trust.stages.stage_1_observer` | number | 30 | Observer阶段的上限分数 |
| `trust.stages.stage_2_editor` | number | 60 | Editor阶段的上限分数 |
| `trust.stages.stage_3_developer` | number | 80 | Developer阶段的上限分数 |

**阶段划分**:
| 阶段 | 分数范围 | 最大行数 | 最大文件数 |
|------|----------|----------|------------|
| Observer | 0-29 | 20 | 1 |
| Editor | 30-59 | 50 | 2 |
| Developer | 60-79 | 300 | 5 |
| Architect | 80-100 | 500 | 10 |

#### trust.cold_start - 冷启动配置

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `trust.cold_start.initial_trust` | number | 85 | 初始信任分数 |
| `trust.cold_start.grace_failures` | number | 5 | 冷启动容错次数 |
| `trust.cold_start.cold_start_period_ms` | number | 86400000 | 冷启动周期（24小时） |

#### trust.penalties - 惩罚配置

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `trust.penalties.tool_failure_base` | number | -2 | 工具失败基础惩罚 |
| `trust.penalties.risky_failure_base` | number | -10 | 风险失败基础惩罚 |
| `trust.penalties.gate_bypass_attempt` | number | -5 | 门禁绕过尝试惩罚 |
| `trust.penalties.failure_streak_multiplier` | number | -2 | 连续失败乘数 |
| `trust.penalties.max_penalty` | number | -20 | 最大惩罚值 |

#### trust.rewards - 奖励配置

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `trust.rewards.success_base` | number | 2 | 成功基础奖励 |
| `trust.rewards.subagent_success` | number | 5 | 子智能体成功奖励 |
| `trust.rewards.tool_success_reward` | number | 0.2 | 工具成功奖励 |
| `trust.rewards.streak_bonus_threshold` | number | 3 | 连续成功阈值 |
| `trust.rewards.streak_bonus` | number | 5 | 连续成功奖励 |
| `trust.rewards.recovery_boost` | number | 5 | 恢复提升奖励 |
| `trust.rewards.max_reward` | number | 15 | 最大奖励值 |

---

### gfi_gate - GFI门禁配置

#### gfi_gate.thresholds - 阈值

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `gfi_gate.thresholds.low_risk_block` | number | 70 | 低风险工具阻塞阈值 |
| `gfi_gate.thresholds.high_risk_block` | number | 40 | 高风险工具阻塞阈值 |
| `gfi_gate.thresholds.large_change_block` | number | 50 | 大规模变更阻塞阈值 |

#### gfi_gate.trust_stage_multipliers - 信任阶段乘数

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `gfi_gate.trust_stage_multipliers.1` | number | 0.5 | Observer阶段乘数 |
| `gfi_gate.trust_stage_multipliers.2` | number | 0.75 | Editor阶段乘数 |
| `gfi_gate.trust_stage_multipliers.3` | number | 1.0 | Developer阶段乘数 |
| `gfi_gate.trust_stage_multipliers.4` | number | 1.5 | Architect阶段乘数 |

#### gfi_gate.bash_patterns - Bash模式

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `gfi_gate.bash_safe_patterns` | string[] | ["npm test", ...] | 安全命令模式 |
| `gfi_gate.bash_dangerous_patterns` | string[] | ["rm -rf", ...] | 危险命令模式 |

**⚠️ 重要**: 配置键名是 `bash_safe_patterns`/`bash_dangerous_patterns`，不是 `bash_patterns.safe`/`bash_patterns.dangerous`

---

### empathy_engine - 共情引擎配置

| 路径 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `empathy_engine.enabled` | boolean | true | 是否启用共情引擎 |
| `empathy_engine.dedupe_window_ms` | number | 60000 | 去重窗口（毫秒） |
| `empathy_engine.penalties.mild` | number | 10 | 轻度挫败惩罚 |
| `empathy_engine.penalties.moderate` | number | 25 | 中度挫败惩罚 |
| `empathy_engine.penalties.severe` | number | 40 | 重度挫败惩罚 |
| `empathy_engine.rate_limit.max_per_turn` | number | 40 | 每轮最大检测次数 |
| `empathy_engine.rate_limit.max_per_hour` | number | 120 | 每小时最大检测次数 |
| `empathy_engine.model_calibration` | object | {} | 模型校准配置 |

**⚠️ 重要**: 
- 惩罚值是**正数** (10, 25, 40)，不是负数
- `rate_limit` 是**对象**，不是数字

---

## 🔗 相关源码文件

| 文件 | 关键内容 | 行数 |
|------|----------|------|
| `src/core/config.ts` | PainSettings 接口, DEFAULT_SETTINGS | 全文件 |
| `src/core/config-service.ts` | ConfigService 单例工厂 | 全文件 |

---

**文档版本**: v2.0
**最后更新**: 2026-03-21
**验证状态**: ✅ 已与 src/core/config.ts 验证一致
