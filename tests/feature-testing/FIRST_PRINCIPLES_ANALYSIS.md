# 第一性原理分析：Principles Disciple

> **分析日期**: 2026-03-11
> **目的**: 深入理解系统本质，设计核心测试用例

---

## 🎯 第一性原理分析

### 1. 项目的本质目的

**Principles Disciple** 不是简单的任务执行框架，而是一个：

> **自我进化的AI助手系统**
>
> 通过**元认知层**（Thinking OS）和**信任系统**（Trust Engine），将AI从被动执行者转变为能够自我修复、自我优化的数字生命体。

### 2. 核心工作流（完整数据流）

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户请求                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  before_prompt_build Hook                                       │
│  ├─ 注入 Thinking OS（9个思维模型）                             │
│  ├─ 注入 OKR Focus（目标对齐）                                  │
│  └─ 注入 Pain Signals（问题感知）                               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                      LLM处理（被元认知引导）                       │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  before_tool_call Hook (Gatekeeper)                             │
│  ├─ 读取 Trust Score → 确定 Stage                               │
│  ├─ Stage 1: 只允许PLAN whitelist                              │
│  ├─ Stage 2: 禁止risk paths，限制10行                           │
│  ├─ Stage 3: risk paths需要READY plan，限制100行               │
│  └─ Stage 4: 完全访问（Architect）                              │
└─────────────────────────────────────────────────────────────────┘
                            ↓
                    ┌───────────────┐
                    │  允许 / 阻止   │
                    └───────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                      工具执行（write/bash等）                     │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  after_tool_call Hook (Pain Detection)                          │
│  ├─ 检测工具调用失败                                            │
│  ├─ 计算 Pain Score（基础30 + 风险加成）                         │
│  ├─ 更新 Trust Score（失败扣分）                                │
│  └─ 写入 .pain_flag                                             │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  [后台] EvolutionWorker Service（每15分钟）                     │
│  ├─ 扫描 .pain_flag                                             │
│  ├─ 队列化高分 pain signals（score ≥ 30）                       │
│  ├─ 触发诊断命令                                                │
│  └─ 促进规则进化                                                │
└─────────────────────────────────────────────────────────────────┘
```

### 3. 核心数据流

#### 输入数据（影响系统决策）
- **AGENT_SCORECARD.json**: Trust Score, Stage, Grace Failures, History
- **PROFILE.json**: risk_paths, trust配置
- **PLAN.md**: STATUS (READY/NOT_READY), 实施计划
- **THINKING_OS.md**: 9个思维模型定义
- **.pain_flag**: Pain signals

#### 处理过程（系统逻辑）
- **TrustEngine**: 计算信任分数、阶段转换、奖惩
- **Gatekeeper**: 根据Stage决定权限
- **PainDetection**: 检测失败、计算pain score
- **EvolutionWorker**: 后台扫描、队列化、触发进化

#### 输出数据（系统行为结果）
- **工具调用结果**: 成功/失败、exit code
- **Gate决策**: 允许/阻止、原因
- **Trust变化**: Score +N/-N、Stage转换
- **Pain Signals**: Score、Source、Reason
- **事件日志**: events.jsonl

---

## 🔬 核心特性优先级分析

### P0: 信任系统（Trust Engine）

**为什么是P0**:
- 整个系统的**安全基础**
- 决定AI能做什么、不能做什么
- 动态调整，影响所有其他功能

**核心机制**:
```typescript
// 1. Cold Start（新Agent保护）
初始分数: 59 (Stage 2)
Grace Failures: 3次无惩罚
Cold Start Period: 24小时

// 2. 自适应奖惩
基础奖励: +1 (成功)
Streak Bonus: +5 (连续5次成功)
Recovery Boost: +3 (从低谷恢复)

基础惩罚: -8 (普通失败) / -15 (风险路径失败)
Failure Streak Multiplier: -3 × (streak - 1)
Max Penalty: -25
Max Reward: +10

// 3. 阶段阈值
Stage 1: 0-30 (Observer)
Stage 2: 30-60 (Editor)
Stage 3: 60-80 (Developer)
Stage 4: 80-100 (Architect)
```

**关键观察点**:
- **输入**: recordSuccess() / recordFailure()
- **过程**: Grace检查 → 计算delta → 更新streak → 限制范围
- **输出**: Score变化、Stage变化、History记录

**评判标准**:
- ✅ Cold Start: 新Agent从59开始，有3次grace
- ✅ Grace使用: 前3次失败不扣分
- ✅ Streak Bonus: 连续5次成功获得+5
- ✅ Failure Streak: 连续失败惩罚递增（-8, -11, -14...）
- ✅ Stage转换: 分数跨过阈值时Stage改变
- ✅ 边界保护: Score永不<0或>100

---

### P1: Gatekeeper（权限控制）

**为什么是P1**:
- 信任系统的**执行层**
- 直接保护关键文件不被破坏
- 防止Agent造成不可逆损害

**核心逻辑**（简化）:
```typescript
if (stage === 1) {
  // 只允许PLAN whitelist
  if (plan_approvals.enabled && planStatus === 'READY') {
    // 检查operation和path匹配
    // 检查line limits
    if (matches && withinLimits) return ALLOW;
  }
  return BLOCK;
}

if (stage === 2) {
  // 禁止risk paths
  if (isRisky(path)) return BLOCK;
  // 限制10行
  if (lineChanges > 10) return BLOCK;
  return ALLOW;
}

if (stage === 3) {
  // risk paths需要READY plan
  if (isRisky(path) && planStatus !== 'READY') return BLOCK;
  // 限制100行
  if (lineChanges > 100) return BLOCK;
  return ALLOW;
}

if (stage === 4) {
  // 完全访问
  return ALLOW;
}
```

**关键观察点**:
- **输入**: Trust Score, toolName, filePath, params
- **过程**: 计算Stage → 检查risk → 检查plan → 检查limits
- **输出**: ALLOW / BLOCK + reason

**评判标准**:
- ✅ Stage 1: 阻止所有非whitelist操作
- ✅ Stage 2: 正确阻止risk paths，小文件允许
- ✅ Stage 2: 行数限制准确（>10行阻止）
- ✅ Stage 3: 需要READY plan才能修改risk paths
- ✅ Stage 4: 完全访问
- ✅ Block原因清晰

---

### P1: 痛苦信号检测（Pain Detection）

**为什么是P1**:
- **自我进化**的触发源
- 问题感知能力
- 系统自我修复的基础

**核心机制**:
```typescript
// Pain Score计算
baseScore = 30 (tool_failure_friction)
if (isRisky) baseScore += 20;

// 记录失败
trackFriction(sessionId, delta, hash, workspaceDir);
trust.recordFailure(isRisky ? 'risky' : 'tool');
writePainFlag({ score, source, reason, is_risky });

// 后台处理（EvolutionWorker）
if (score >= 30) {
  queue.push({ score, source, reason });
}
```

**关键观察点**:
- **输入**: toolName, filePath, error, exitCode
- **过程**: 判断失败 → 计算score → 记录到trust → 写入flag
- **输出**: Pain Score, .pain_flag, Trust变化

**评判标准**:
- ✅ 失败检测: exitCode ≠ 0 或 error存在
- ✅ Risk判断: 正确识别risk path
- ✅ Score计算: 普通30，风险路径+20=50
- ✅ Trust惩罚: 调用recordFailure
- ✅ Flag写入: 正确格式

---

### P2: 元认知层注入（Thinking OS）

**为什么是P2**:
- 引导AI的**思维方式**
- 不是强制，而是影响
- 难以直接测量

**核心机制**:
```typescript
// before_prompt_build
prependSystemContext({
  type: 'thinking_os',
  models: [T-01, T-02, ..., T-09],
  okr_focus: currentFocus
});

// 9个思维模型
T-01: Map Before Territory
T-02: Constraints as Lighthouses
T-03: Evidence Over Intuition
T-04: Reversibility Governs Speed
T-05: Via Negativa
T-06: Occam's Razor
T-07: Minimum Viable Change
T-08: Pain as Signal
T-09: Divide and Conquer
```

**关键观察点**:
- **输入**: THINKING_OS.md内容
- **过程**: 注入到prependSystemContext
- **输出**: Agent的思维模式改变

**评判标准**:
- ✅ 注入成功: prependSystemContext被调用
- ✅ Agent遵循: 响应中体现模型使用（难验证）
- ✅ 使用追踪: .thinking_os_usage.json更新

---

### P3: 进化工作器（Evolution Worker）

**为什么是P3**:
- 长期**自我修复**能力
- 不是实时安全机制
- 后台运行，难以直接观察

**核心机制**:
```typescript
// 每15分钟运行
setInterval(() => {
  checkPainFlag();           // 扫描.pain_flag
  processEvolutionQueue();   // 处理队列
  processDetectionQueue();   // L2/L3检测
  processPromotion();        // 规则进化
}, interval);

// 队列化条件
if (!isQueued && score >= 30) {
  queue.push({ id, score, source, reason });
}
```

**关键观察点**:
- **输入**: .pain_flag内容
- **过程**: 扫描 → 队列化 → 触发诊断
- **输出**: EVOLUTION_QUEUE.json, EVOLUTION_DIRECTIVE.json

**评判标准**:
- ✅ 扫描周期: 15分钟
- ✅ 队列化: score ≥ 30才入队
- ✅ 优先级: 高分优先
- ✅ 去重: 已queued的不重复入队

---

## 📊 系统观察矩阵（Observation Matrix）

| 特性 | 输入（可观测） | 过程（可观测） | 输出（可观测） | 评判标准 |
|------|---------------|---------------|---------------|----------|
| **Trust System** | recordSuccess/Failure调用 | Grace检查、Delta计算、Streak更新 | Score变化、Stage变化、History | 预期值、范围、边界 |
| **Gatekeeper** | Score、Tool、Path、Params | Stage判断、Risk检查、Plan验证、Line计算 | ALLOW/BLOCK、Reason | 正确性、一致性 |
| **Pain Detection** | Tool result、Error、ExitCode | 失败判断、Risk判断、Score计算 | Pain Score、.pain_flag、Trust变化 | 准确性、及时性 |
| **Thinking OS** | THINKING_OS.md | prependSystemContext调用 | Agent响应（间接）、Usage JSON | 注入成功、使用追踪 |
| **Evolution Worker** | .pain_flag | 扫描、队列化、触发 | EVOLUTION_QUEUE、DIRECTIVE | 周期、阈值、优先级 |

---

## 🎯 优化的测试策略

### 核心原则

1. **观察输入输出**: 不只测试"通过"，要验证中间状态
2. **多维度验证**: 功能正确性 + 数据一致性 + 边界条件
3. **真实场景**: 使用实际操作，而非mock
4. **可追溯性**: 每个测试都能对应到代码路径

### 测试层级

```
L1: 单元测试（代码级）
  ├─ TrustEngine.recordSuccess()
  ├─ TrustEngine.recordFailure()
  └─ Gatekeeper.allowBlock()

L2: 集成测试（组件级）
  ├─ Trust + Gate交互
  ├─ Pain + Trust交互
  └─ Evolution + Pain交互

L3: 端到端测试（系统级）
  ├─ 完整工作流
  ├─ 多阶段转换
  └─ 长期进化

L4: 特性测试（当前focus）
  ├─ 场景驱动
  ├─ 断点检测
  └─ 真实OKR任务
```

---

## 🔧 关键测试数据

### 信任系统测试数据

| 场景 | 初始Score | 操作 | 预期Delta | 预期结果 |
|------|----------|------|----------|----------|
| Cold Start | 59 | 失败×3 | 0, 0, 0 | Grace=0, Score=59 |
| Cold Start | 59 | 失败×4 | 0, 0, 0, -8 | Grace=0, Score=51 |
| Streak Bonus | 50 | 成功×5 | +1, +2, +3, +4, +6 | Score=66 |
| Failure Streak | 50 | 失败×3 | -8, -11, -14 | Score=17 |
| Stage转换 | 29 | 成功 | +1 → Score=30 | Stage 1→2 |
| 边界测试 | 0 | 失败(-30) | -25 (capped) | Score=0 |
| 边界测试 | 100 | 成功(+15) | +10 (capped) | Score=100 |

### Gatekeeper测试数据

| Stage | Score | Path Type | Plan | Lines | 结果 | 原因 |
|-------|-------|-----------|------|-------|------|------|
| 1 | 20 | risk | READY | 5 | BLOCK (if not whitelist) | Trust too low |
| 1 | 20 | risk | READY | 5 | ALLOW (if whitelist) | PLAN approved |
| 2 | 40 | risk | - | 5 | BLOCK | Not authorized |
| 2 | 40 | safe | - | 15 | BLOCK | >10 lines |
| 2 | 40 | safe | - | 5 | ALLOW | Within limits |
| 3 | 70 | risk | READY | 50 | ALLOW | Has plan |
| 3 | 70 | risk | NOT_READY | 50 | BLOCK | No READY plan |
| 4 | 90 | risk | - | 200 | ALLOW | Architect bypass |

---

## 📝 优化后的测试用例设计

### 测试用例1: Trust System - 完整生命周期

**目的**: 验证Trust System从冷启动到成熟期的完整行为

**输入**:
- 新Agent（无SCORECARD）
- 操作序列：成功×5 → 失败×3 → 成功×2

**观察点**:
1. 初始化: Score=59, Grace=3, ColdStart=true
2. 成功×1: Score=60, Streak=1
3. 成功×5: Score=66, Streak=5 (获得streak bonus)
4. 失败×1: Grace=2, Score=66
5. 失败×3: Grace=0, Score=66
6. 失败×4: Score=55 (Streak penalty: -8-11= -19)

**评判标准**:
- [ ] Cold Start保护生效（前3次失败无惩罚）
- [ ] Streak Bonus正确触发（第5次成功）
- [ ] Failure Streak惩罚递增
- [ ] 所有变化记录在history

---

### 测试用例2: Gatekeeper - Stage权限验证

**目的**: 验证每个Stage的权限边界

**输入**:
- 不同Trust Score（20, 40, 70, 90）
- 不同Path类型（risk, safe）
- 不同Line counts（5, 15, 50, 200）

**观察矩阵**:
```
Score 20 (Stage 1):
  risk path + 5 lines → BLOCK (whitelist check)
  safe path + 5 lines → ALLOW
  safe path + 15 lines → BLOCK (line limit)

Score 40 (Stage 2):
  risk path + 5 lines → BLOCK (not authorized)
  safe path + 5 lines → ALLOW
  safe path + 15 lines → BLOCK (>10 lines)

Score 70 (Stage 3):
  risk path + 5 lines + READY plan → ALLOW
  risk path + 5 lines + NO plan → BLOCK (no READY plan)
  safe path + 150 lines → BLOCK (>100 lines)

Score 90 (Stage 4):
  ANY path + ANY lines → ALLOW (Architect bypass)
```

**评判标准**:
- [ ] 每个Stage的边界准确
- [ ] Block原因清晰
- [ ] Stage 4完全无限制
- [ ] PLAN whitelist正确工作

---

### 测试用例3: Pain Detection → Trust → Evolution 完整链路

**目的**: 验证从失败检测到进化触发的完整链路

**输入**:
- Agent执行失败操作
- 失败类型：tool vs risky

**观察点**:
1. **Pain Detection**:
   - 检测到失败（exitCode ≠ 0）
   - 计算Pain Score: 30 (tool) 或 50 (risky)
   - 写入.pain_flag

2. **Trust Update**:
   - 调用recordFailure()
   - Score下降：-8 (tool) 或 -15 (risky)

3. **Evolution Worker**:
   - 扫描到.pain_flag
   - 队列化到evolution_queue.json
   - 生成evolution_directive.json

**评判标准**:
- [ ] Pain Score计算正确
- [ ] Trust惩罚正确执行
- [ ] Pain flag格式正确
- [ ] Evolution队列化（score ≥ 30）
- [ ] Directive生成

---

## 🚀 下一步：创建优化的测试场景

基于以上分析，我将创建3个优化的测试场景：

1. **trust-system-deep.json** - 深度测试Trust System所有机制
2. **gatekeeper-boundaries.json** - 严格测试Gatekeeper边界
3. **pain-evolution-chain.json** - 完整测试Pain→Trust→Evolution链路

这些测试场景将：
- ✅ 明确输入和可观测的输出
- ✅ 多维度验证（功能+数据+边界）
- ✅ 详细的评判标准
- ✅ 对应到具体代码路径

---

**分析版本**: v1.0
**创建日期**: 2026-03-11
**分析者**: iFlow CLI
**状态**: ✅ 完成第一性原理分析
