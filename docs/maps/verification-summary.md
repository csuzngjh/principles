# 文档修正要点汇总

> **创建时间**: 2026-03-21
> **验证状态**: 8个文档全部验证完成
> **总体结论**: 所有文档都有严重错误，需要基于实际代码重写

---

## 🔴 严重错误汇总

### 1. file-format-spec.md - ✅ 已修复

**已修正问题**:
- ✅ AGENT_SCORECARD.json: 修正字段名和默认值
- ✅ evolution-scorecard.json: 修正统计字段结构
- ✅ EVOLUTION_QUEUE.json: 修正为扁平数组结构
- ✅ EVOLUTION_DIRECTIVE.json: 修正为 `{active, taskId, task, timestamp}`
- ✅ pain_settings.json: 修正所有配置路径和默认值
- ✅ evolution.jsonl: 修正事件类型和字段名

---

### 2. config-reference.md - ❌ 需要修复

**关键错误**:
- ❌ `trust.cold_start.grace_failures`: 文档说3，实际是5
- ❌ `trust.rewards.success_base`: 文档说3，实际是2
- ❌ `trust.rewards.streak_bonus`: 文档说2，实际是5
- ❌ `gfi_gate.thresholds.high_risk_block`: 文档说85，实际是40
- ❌ `empathy_engine.penalties.*`: 文档说负数，实际是正数 (10, 25, 40)
- ❌ `empathy_engine.rate_limit`: 文档说是数字，实际是对象 `{max_per_turn, max_per_hour}`
- ❌ 配置路径 `gfi_gate.bash_patterns.*` 实际是 `bash_safe_patterns`/`bash_dangerous_patterns`

---

### 3. state-machines.md - ❌ 需要修复

**关键错误**:
- ❌ Stage 3 最大行数: 文档说200，实际是300
- ❌ 奖励公式: 文档说 `success_base + streak_bonus × streak`，实际是简单加法
- ❌ 失败惩罚公式: 文档说指数增长，实际是线性增长
- ❌ 冷启动容错: 文档说3，实际是5
- ❌ GFI衰减: 文档说每分钟衰减1-5点，实际没有衰减机制
- ❌ GFI阈值: 高风险工具40阻塞，不是85

---

### 4. data-flow-panorama.md - ❌ 需要修复

**关键错误**:
- ❌ 痛苦触发阈值: 文档说30，实际是40
- ❌ 痛苦标志路径: 文档说 `.state/.pain_flag`，实际是 `.state/pain_flag`
- ❌ 原则生成: 文档说Agent执行 `/pd-evolve`，实际是自动创建
- ❌ 信任 `recordSuccess()`: 文档说增加奖励，实际只重置streak
- ❌ 配置路径: `evolution.worker_interval` 实际是 `intervals.worker_poll_ms`
- ❌ 初始信任: 文档说90，实际是85

---

### 5. code-patterns.md - ❌ 需要修复

**关键错误**:
- ❌ `_forceReset()` 不存在
- ❌ `LockContext` 接口完全不同
- ❌ `acquireLock()` 实现完全不同
- ❌ `EventLog` 构造函数签名错误
- ❌ `EvolutionReducerImpl` 事件字段名错误
- ❌ `EvolutionWorkerService` 实现完全不同

---

### 6. testing-patterns.md - ❌ 需要修复

**关键错误**:
- ❌ `createTestContext()` 返回类型错误
- ❌ Mock 文件不存在
- ❌ 事件结构使用 `params` 不是 `parameters`
- ❌ 服务测试使用静态方法

---

### 7. error-handling-patterns.md - ❌ 需要修复

**关键错误**:
- ❌ 锁实现完全不同
- ❌ 空catch块是允许的（某些场景）
- ❌ 同步文件I/O在钩子中是允许的

---

### 8. debugging-guide.md - ❌ 需要修复

**关键错误**:
- ❌ 文件路径错误
- ❌ 配置键名错误
- ❌ 日志模式错误

---

## 📋 修复优先级

| 优先级 | 文档 | 状态 | 说明 |
|--------|------|------|------|
| P0 | file-format-spec.md | ✅ 已完成 | 基础数据格式 |
| P0 | config-reference.md | ❌ 待修复 | 配置影响所有系统 |
| P0 | state-machines.md | ❌ 待修复 | 状态转换影响所有系统 |
| P1 | data-flow-panorama.md | ❌ 待修复 | 数据流理解 |
| P1 | debugging-guide.md | ❌ 待修复 | 问题排查 |
| P2 | code-patterns.md | ❌ 待修复 | 代码模式 |
| P2 | testing-patterns.md | ❌ 待修复 | 测试模式 |
| P2 | error-handling-patterns.md | ❌ 待修复 | 错误处理 |

---

## 🔗 相关源码文件

| 文件 | 关键内容 | 验证状态 |
|------|----------|----------|
| `src/core/trust-engine.ts` | TrustScorecard, 阶段阈值 | ✅ 已验证 |
| `src/core/evolution-types.ts` | EvolutionScorecard, EvolutionLoopEvent | ✅ 已验证 |
| `src/service/evolution-worker.ts` | EvolutionQueueItem, 指令格式 | ✅ 已验证 |
| `src/core/config.ts` | PainSettings, 默认值 | ✅ 已验证 |
| `src/core/trajectory.ts` | SQLite Schema | ✅ 已验证 |
| `src/hooks/gate.ts` | 门禁逻辑, Bash安全 | ✅ 已验证 |
| `src/core/evolution-reducer.ts` | 原则生命周期 | ✅ 已验证 |

---

**文档版本**: v1.0
**最后更新**: 2026-03-21
