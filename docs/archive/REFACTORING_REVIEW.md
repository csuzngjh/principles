# Principles Disciple 进化闭环重构方案 - 技术评审报告

> **评审时间**：2026-03-17
> **评审范围**：`packages/openclaw-plugin` 完整代码库
> **评审目标**：评估"最小可运行闭环（MVP Loop）"重构方案的可行性与风险

---

## 执行摘要

### 总体评估：✅ 方向正确，但需要分阶段实施

**核心主张**：
> "把 Pain + Reflection = Progress 从复杂流程还原为最小可运行闭环"

**评审结论**：
- ✅ 第一性原理分析正确：当前系统确实存在过度复杂化
- ✅ 单环架构（One-Loop Architecture）设计合理
- ⚠️ 实施方案过于激进，建议分为 3 个阶段
- ⚠️ 部分技术假设与实际代码不符

---

## 一、当前架构事实核查

### 1.1 现有核心组件（已验证）

```
src/
├── hooks/
│   ├── pain.ts              ✅ Pain 捕获（after_tool_call）
│   ├── subagent.ts          ✅ 子智能体生命周期处理
│   └── prompt.ts            ✅ Prompt 注入（before_prompt_build）
├── service/
│   └── evolution-worker.ts  ✅ 后台轮询服务（90s 间隔）
├── core/
│   ├── evolution-engine.ts  ✅ 成长驱动积分系统（V2.0）
│   ├── trust-engine-v2.ts   ✅ 信任引擎
│   ├── path-resolver.ts     ✅ 路径解析器
│   └── event-log.ts         ✅ 事件日志系统
└── tools/
    └── agent-spawn.ts       ✅ 子智能体工具（已修复 Bug #67）
```

### 1.2 数据流现状（代码级别确认）

```
┌─────────────────────────────────────────────────────────────┐
│ 当前闭环（自动部分）                                          │
├─────────────────────────────────────────────────────────────┤
│ 1. Pain 捕获: after_tool_call → writePainFlag() ✅         │
│ 2. 队列化: Evolution Worker (90s) → evolution_queue.json ✅ │
│ 3. Prompt 注入: before_prompt_build → <evolution_task> ✅  │
│ 4. 子智能体: pd_spawn_agent → outcome ✅                   │
│ 5. 队列清理: subagent_ended → status=completed ✅          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 断点部分（需要手动或缺失）                                    │
├─────────────────────────────────────────────────────────────┤
│ 6. 诊断结果消费: subagent_ended 只改队列状态 ❌             │
│ 7. ISSUE_LOG/DECISIONS: 代码中未定义路径 ❌                │
│ 8. 原则提炼器: 完全缺失 ❌                                  │
│ 9. PRINCIPLES.md 注入: 代码存在但依赖文件内容 ⚠️            │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 代码事实核查表

| 方案假设 | 实际代码状态 | 验证结果 |
|---------|-------------|---------|
| "SKILL 有落盘指令但无消费者" | ❌ 代码中未定义 `ISSUE_LOG`、`DECISIONS` 路径 | ✅ 方案正确 |
| "subagent_ended 只做队列清理" | ✅ `hooks/subagent.ts:46-103` 确实如此 | ✅ 方案正确 |
| "依赖模型调用 pd_spawn_agent" | ✅ `evolution_worker.ts:177` 通过 prompt 注入 | ✅ 方案正确 |
| "事件日志停更是 bug" | ⚠️ 是事件驱动设计，非心跳模式 | ⚠️ 方案误解 |
| "Trust Engine 是惩罚驱动" | ❌ 已有 Evolution Engine（成长驱动）| ❌ 方案过时 |

---

## 二、技术可行性评审

### 2.1 核心假设验证

#### ✅ 假设 1：需要 Evolution Reducer

**方案主张**：
> 新增统一服务 `evolution-reducer.ts`，消费 pain/subagent 事件，输出原则

**技术评审**：
```typescript
// 当前架构缺失的部分
interface EvolutionReducerInput {
    painEvent?: PainSignal;
    subagentOutput?: string;
    diagnosticReport?: string;
}

interface EvolutionReducerOutput {
    issueLogEntry: IssueLogEntry;
    principleCandidate: PrincipleCandidate;
    autoAdopt?: boolean;  // 达阈值自动入库
}
```

**可行性**：✅ 高
- `pain.ts` 已有完整事件捕获
- `subagent.ts` 可获取 outcome
- 只需在 `subagent_ended` success 分支增加处理逻辑

**实施建议**：
```typescript
// hooks/subagent.ts 修改示例
if (outcome === 'ok') {
    // ... 现有队列清理逻辑 ...

    // ✅ 新增：调用 reducer
    const output = await getSessionMessages({ sessionKey });
    await evolutionReducer.process({
        subagentOutput: extractAssistantText(output),
        source: 'subagent_diagnostician'
    });
}
```

#### ⚠️ 假设 2：单一事件流（evolution.jsonl）

**方案主张**：
> 所有进化中间态只进一个文件 `memory/evolution.jsonl`

**技术评审**：

**优点**：
- ✅ 简化消费者逻辑（只读一个文件）
- ✅ 支持 tail -f 实时监控
- ✅ 易于备份和分析

**缺点**：
- ⚠️ 与现有 `events.jsonl` 功能重复
- ⚠️ 失去现有 `PD_FILES` 路径统一管理
- ⚠️ 需要处理大文件性能问题

**替代方案**：
```typescript
// 复用现有 events.jsonl，增加进化事件类型
interface EvolutionEvent {
    type: 'pain_captured' | 'principle_candidate' | 'principle_adopted';
    timestamp: string;
    data: any;
}

// event-log.ts 已支持 append-only
eventLog.recordEvolutionEvent({
    type: 'principle_candidate',
    principle: {...}
});
```

**评审结论**：建议复用现有 `events.jsonl`，而非新建 `evolution.jsonl`

#### ✅ 假设 3：数据模型收敛（1 主 3 从）

**方案主张**：
```
主：memory/evolution.jsonl
从：PRINCIPLES.md, ISSUE_LOG.md, DECISIONS.md
```

**技术评审**：

**当前路径结构**（`src/core/paths.ts`）：
```typescript
// 已定义
PRINCIPLES: path.join('.principles', 'PRINCIPLES.md'),
REFLECTION_LOG: path.join('memory', 'reflection-log.md'),

// 缺失
ISSUE_LOG: undefined  ❌
DECISIONS: undefined  ❌
EVOLUTION_STREAM: undefined  ❌
```

**需要补充的路径**：
```typescript
// src/core/paths.ts 建议增加
export const PD_FILES = {
    // ... 现有路径 ...

    // Evolution System (新增)
    ISSUE_LOG: path.join('memory', 'ISSUE_LOG.md'),
    DECISIONS: path.join('memory', 'DECISIONS.md'),
    PRINCIPLE_CANDIDATES: path.join('.state', 'principle_candidates.jsonl'),
    EVOLUTION_STREAM: path.join('.state', 'logs', 'evolution.jsonl'),
};
```

**评审结论**：✅ 需要实施，但建议使用 `.state` 而非 `memory` 存储候选原则

---

### 2.2 架构风险评估

#### 🔴 高风险项

**1. 自动入库 PRINCIPLES.md**

**方案**：
> reducer 满足条件即写入 PRINCIPLES.md

**风险**：
- 可能写入低质量原则
- 难以回滚
- 可能污染核心原则库

**缓解措施**：
```typescript
// 建议增加三道防线
interface PrincipleAdoptionGuard {
    // 1. 质量阈值
    minConfidence: number;  // 默认 0.7

    // 2. 去重检查
    isDuplicate(principle: string): boolean;

    // 3. 冲突检测
    hasConflict(principle: string): boolean;

    // 4. 人工审核（可选）
    requireManualReview: boolean;  // 高风险原则
}
```

**实施建议**：
- P0 阶段：只写入 `PRINCIPLE_CANDIDATES.jsonl`，人工审核后入库
- P1 阶段：增加自动去重和冲突检测
- P2 阶段：低风险原则自动入库

**2. 事件日志并发写入**

**当前代码**（`event-log.ts`）：
```typescript
append(type: string, data: any) {
    const line = JSON.stringify({ type, timestamp: new Date().toISOString(), data });
    fs.appendFileSync(this.logPath, line + '\n', 'utf8');
}
```

**问题**：
- 多个 hook 同时写入 → 可能损坏文件
- 没有文件锁机制

**缓解措施**：
```typescript
// 建议增加文件锁
import * as lockfile from 'proper-lockfile';

async append(type: string, data: any) {
    const release = await lockfile.lock(this.logPath);
    try {
        fs.appendFileSync(this.logPath, line + '\n', 'utf8');
    } finally {
        await release();
    }
}
```

#### 🟡 中风险项

**3. 去重与冲突检测算法**

**方案主张**：
> 同 Trigger 合并、冲突标注

**技术挑战**：
- 原则语义相似度计算（NLP）
- 冲突定义（互相矛盾？覆盖关系？）
- 性能影响

**建议**：
- P0 阶段：基于字符串相似度（简单快速）
- P1 阶段：引入轻量级嵌入模型（如 `sentence-transformers`）
- P2 阶段：人工审核层处理边界情况

#### 🟢 低风险项

**4. prompt 注入增强**

**方案主张**：
> 增加最近新增原则摘要

**实施难度**：低
**当前代码**（`hooks/prompt.ts`）已有 PRINCIPLES 读取逻辑

**建议实现**：
```typescript
// 读取最近 7 天新增原则
const recentPrinciples = getPrinciplesAddedSince(daysAgo=7);
if (recentPrinciples.length > 0) {
    principlesSection += '\n\n## 最近新增原则\n' +
        recentPrinciples.map(p => `- ${p.title}`).join('\n');
}
```

---

## 三、实施计划评审

### 3.1 方案原定优先级

```
P0（本周）：
  1. 补 ISSUE_LOG/DECISIONS 路径
  2. subagent_ended 自动写 ISSUE_LOG
  3. principle-candidates 文件

P1（两周）：
  4. 候选审核→入库
  5. Prompt 注入增强
  6. 事件流增加 worker_tick

P2（中期）：
  7. OpenClaw 扩展提案
  8. 闭环健康面板
```

**评审意见**：⚠️ 过于激进，建议调整

### 3.2 建议调整后的分阶段计划

#### 🎯 Phase 0：验证期（1 周）

**目标**：验证最小闭环可行性，不修改生产代码

```typescript
// 新建 sandbox/evolution-reducer.ts
export class EvolutionReducer {
    async processPain(pain: PainSignal): Promise<PrincipleCandidate[]> {
        // 1. 从 pain 提取候选原则（LLM 或规则）
        // 2. 去重
        // 3. 写入测试文件
    }

    async processSubagentOutput(output: string): Promise<IssueLogEntry> {
        // 1. 解析诊断输出
        // 2. 提取结构化信息
        // 3. 写入测试文件
    }
}

// 测试用例
tests/evolution-reducer.test.ts
  ✅ pain → candidate
  ✅ subagent output → issue log
  ✅ 去重逻辑
  ✅ PRINCIPLES.md 并发写入保护
```

**交付物**：
- ✅ `sandbox/evolution-reducer.ts`
- ✅ 单元测试覆盖率 > 80%
- ✅ 性能基准测试

#### 🎯 Phase 1：保守上线（2 周）

**目标**：接入现有流程，只写不自动入库

```typescript
// 1. 补齐路径定义
src/core/paths.ts:
  export const PD_FILES = {
      // ... 现有 ...
      ISSUE_LOG: 'memory/ISSUE_LOG.md',
      DECISIONS: 'memory/DECISIONS.md',
      PRINCIPLE_CANDIDATES: '.state/principle_candidates.jsonl',
  };

// 2. 修改 subagent hook
src/hooks/subagent.ts:
  if (outcome === 'ok') {
      // ... 现有逻辑 ...

      // ✅ 新增：写 ISSUE_LOG（自动）
      await writeIssueLog({
          pain: originalPain,
          diagnosis: extractDiagnosis(output),
          timestamp: new Date().toISOString(),
      });
  }

// 3. 新增命令
src/commands/principle-review.ts:
  - /pd-review-candidates  # 查看候选原则
  - /pd-adopt <id>         # 手动入库
```

**不变更**：
- ❌ 不自动写 PRINCIPLES.md
- ❌ 不修改 Evolution Worker 逻辑
- ❌ 不改变现有事件日志格式

**交付物**：
- ✅ ISSUE_LOG 自动生成
- ✅ 候选原则自动提取
- ✅ 人工审核命令

#### 🎯 Phase 2：自动化增强（3-4 周）

**前提**：Phase 1 稳定运行 2 周

```typescript
// 1. 自动去重与冲突检测
src/core/principle-validator.ts:
  export class PrincipleValidator {
      isDuplicate(candidate: string, existing: string[]): boolean
      hasConflict(candidate: string, existing: string[]): Conflict[]
  }

// 2. 低风险自动入库
src/hooks/subagent.ts:
  if (candidate.confidence > 0.8 && !validator.isDuplicate(candidate)) {
      await appendToPrinciples(candidate);
  }

// 3. 增强可观测性
src/commands/evolution-status.ts:
  - 最近 pain 事件数
  - 候选原则数
  - 自动入库数
  - 最后更新时间
```

**交付物**：
- ✅ 自动去重系统
- ✅ 低风险原则自动入库
- ✅ 健康监控命令

#### 🎯 Phase 3：优化与集成（按需）

**前提**：Phase 2 数据显示价值（原则质量提升、错误减少）

```typescript
// 1. 高级分析
src/service/principle-analytics.ts:
  - 原则生效统计
  - 错误复现率分析
  - ROI 计算

// 2. OpenClaw 集成
openclaw/src/hooks/subagent_artifact_ready.ts:
  - 提供子智能体输出元数据
  - 减少 getSessionMessages 开销

// 3. Dashboard
packages/dashboard/src/
  - 闭环可视化
  - 原则增长曲线
  - 实时事件流
```

---

## 四、关键问题逐条回答

### Q1: 哪些环节应全自动？哪些允许手动？

**代码级别答案**：

```typescript
// 应全自动（P0）
1. Pain → pain_flag ✅ 已实现
2. pain_flag → evolution_queue ✅ 已实现
3. subagent_ended → ISSUE_LOG ⚠️ 需新增
4. subagent output → principle_candidates ⚠️ 需新增

// 半自动（需审核）
5. principle_candidates → PRINCIPLES.md ❌ 需新增
   - 低风险（confidence > 0.8）：自动入库
   - 高风险：等待审核

// 允许手动（辅助手段）
6. 深度反思 /reflection ✅ 已有命令
7. 复杂审计 /pd-audit ✅ 已有工具
```

### Q2: 是否需要改 OpenClaw？

**评审结论**：❌ 短期不需要

**理由**：
1. `subagent_ended` 已提供足够信息
2. `api.runtime.subagent.getSessionMessages()` 可获取输出
3. 当前的 prompt 注入机制已有效

**长期建议**：
- 增加 `subagent_artifact_ready` hook（减少 transcript 解析复杂度）
- 增加 skill checkpoint 协议（机器可验证步骤完成）

### Q3: 事件日志"停更"是 bug 吗？

**事实核查**：❌ 不是 bug

**证据**：
```typescript
// event-log.ts
append(type: string, data: any) {
    // 只在事件发生时写入，不是心跳模式
}

// 写入触发点
pain.ts:  eventLog.recordPainSignal(...)
trust-engine-v2.ts:  eventLog.record(...)
```

**正确理解**：
- 事件日志是**事件驱动**，不是**时间驱动**
- "停更" = 没有事件触发（插件未加载或无活动）
- 建议增加 `worker_tick` 事件（可观测性）

---

## 五、具体技术改进建议

### 5.1 数据模型优化

**当前问题**：
- 多个独立文件（queue, directive, pain_flag, pain_candidates）
- 缺乏统一消费契约

**建议架构**：
```typescript
// .state/evolution.jsonl（统一事件流）
interface EvolutionEvent {
    id: string;
    type: 'pain' | 'diagnosis' | 'candidate' | 'adopted';
    timestamp: string;
    data: any;
}

// memory/ISSUE_LOG.md（人类可读）
## Issue #2026-03-17-001
**Pain**: Tool 'write' failed on /path/to/file
**Root Cause**: Permission denied
**Principle**: Always check file permissions before write
**Status**: Adopted
**Adopted At**: 2026-03-17T10:30:00Z
```

### 5.2 文件锁机制

**当前风险**：
- 多个 hook 同时写入 → 文件损坏
- `PRINCIPLES.md` 尤其危险

**建议实现**：
```typescript
// utils/file-lock.ts
export async function withFileLock<T>(
    filePath: string,
    fn: () => Promise<T>
): Promise<T> {
    const release = await lockfile.lock(filePath, {
        retries: 50,
        stale: 30000,
    });
    try {
        return await fn();
    } finally {
        await release();
    }
}

// 使用
await withFileLock(principlesPath, async () => {
    fs.appendFileSync(principlesPath, principle + '\n');
});
```

### 5.3 性能优化

**问题**：
- `evolution.jsonl` 可能快速增长
- 原则去重需要全文扫描

**建议**：
```typescript
// 1. 分区（按月）
.state/logs/evolution/2026-03.jsonl
                 /2026-04.jsonl

// 2. 索引（只存哈希）
.state/principle_index.json
{
  "hash1": {id: "p1", adoptedAt: "..."},
  "hash2": {id: "p2", rejectedAt: "..."},
}

// 3. 增量去重
function isDuplicate(principle: string): boolean {
    const hash = computeHash(principle);
    return index[hash] !== undefined;
}
```

---

## 六、风险评估与缓解

### 6.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|-----|------|------|---------|
| PRINCIPLES.md 污染 | 中 | 高 | 三道防线：质量阈值、去重、人工审核 |
| 并发写入冲突 | 高 | 中 | 文件锁机制 |
| 性能退化（jsonl 太大） | 中 | 中 | 分区 + 索引 |
| 原则质量低 | 高 | 高 | LLM 提炼 + 人工审核 |
| 事件流损坏 | 低 | 高 | 定期备份 + 校验和 |

### 6.2 业务风险

| 风险 | 概率 | 影响 | 缓解措施 |
|-----|------|------|---------|
| 用户不信任自动原则 | 高 | 高 | 渐进式：先人工审核，后自动入库 |
| 系统过于复杂 | 中 | 中 | Phase 0 验证 + 文档 |
| 违反第一性原理 | 低 | 高 | 定期审查：每个模块必须服务 4 个核心事实 |

---

## 七、最终建议

### ✅ 强烈推荐

1. **分阶段实施**：不要一次性重构
2. **Phase 0 验证**：先在 sandbox 验证可行性
3. **保守上线**：Phase 1 只写不自动入库
4. **补齐路径**：增加 ISSUE_LOG、DECISIONS 等路径定义

### ⚠️ 需要调整

1. **复用现有 events.jsonl**：不要新建 evolution.jsonl
2. **保持 Evolution Worker**：不要完全重写，逐步增强
3. **三道防线**：自动入库前必须经过质量、去重、冲突检查

### ❌ 不建议

1. **一次性自动入库**：风险太高
2. **完全重写 Worker**：现有逻辑有效，逐步演进
3. **依赖 OpenClaw 改动**：短期不需要

### 📋 立即可做（本周）

```bash
# 1. 创建 sandbox
mkdir -p packages/openclaw-plugin/sandbox/evolution

# 2. 编写单元测试
touch tests/evolution-reducer.test.ts

# 3. 补齐路径定义
# src/core/paths.ts 增加：
#   ISSUE_LOG, DECISIONS, PRINCIPLE_CANDIDATES

# 4. 运行现有测试
npm test
```

---

## 八、成功指标

**定量指标**：
- [ ] Phase 0：单元测试覆盖率 > 80%
- [ ] Phase 1：ISSUE_LOG 自动生成率 > 90%
- [ ] Phase 2：候选原则去重准确率 > 95%
- [ ] Phase 2：低风险原则自动入库率 > 70%

**定性指标**：
- [ ] 用户能看到"今天系统学会了什么"
- [ ] 同类错误复发率下降
- [ ] 用户干预次数下降
- [ ] PRINCIPLES.md 持续高质量增长

---

## 附录

### A. 关键代码位置

| 功能 | 文件 | 行号 |
|-----|------|------|
| Pain 捕获 | `hooks/pain.ts` | 29-192 |
| 子智能体处理 | `hooks/subagent.ts` | 14-104 |
| 队列管理 | `service/evolution-worker.ts` | 26-200 |
| Prompt 注入 | `hooks/prompt.ts` | 全文 |
| 事件日志 | `core/event-log.ts` | 全文 |
| 路径定义 | `core/paths.ts` | 1-81 |

### B. 相关 Issue

- #67: Bug - agent-spawn.js 重复声明（已修复）
- #66: Subagent collaboration flow（待测试）

### C. 参考文档

- `/home/csuzngjh/code/principles/tests/E2E_TEST_COVERAGE_ANALYSIS.md`
- `/home/csuzngjh/code/principles/DIAGNOSTIC_REPORT-20260312.md`

---

**评审人**：Claude Code (Sonnet 4.6)
**评审日期**：2026-03-17
**下次评审**：Phase 0 完成后（预计 1 周）
