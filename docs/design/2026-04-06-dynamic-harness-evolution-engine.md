# 动态边界与自我进化引擎 (Dynamic Harness & Self-Evolution Engine) 架构设计

> **日期**: 2026-04-06  
> **状态**: 提议 (Proposed)  
> **关联文档**: [原则树架构 (PRINCIPLE-TREE-ARCHITECTURE.md)](../architecture-governance/PRINCIPLE-TREE-ARCHITECTURE.md)  
> **核心理念**: 将模糊的自然语言原则“降级”为绝对理性的执行脚本，构建智能体的“物理反射神经”。

---

## 1. 设计背景与痛点 (The Problem)

在 PD 项目中，我们通过 `PRINCIPLES.md` 约束智能体。但随着项目复杂度增加，我们面临以下挑战：
1. **指令脱落 (Instruction Dropping)**: 随着上下文变长，智能体会“忽略”写在 Prompt 里的原则。
2. **边界模糊**: “修改核心文件需谨慎”是主观的。多少行算谨慎？哪些文件算核心？
3. **演化滞后**: 发现错误到修改 LoRA 或 System Prompt 的链路太长，无法实现“分钟级”的错误纠偏。

**解决方案**: 引入 **Harness (硬化拦截器)**。将原则树的“树叶（实现层）”通过动态 JS 脚本固化，在工具执行前进行“硬拦截”。借助 OpenClaw 最新的 Heartbeat 任务批处理特性，实现无缝后台验证。

---

## 2. 核心架构：原则树的物理化

DHSE 引擎将原则树的逻辑链路闭环化：

```
[树根: Principle] -> [树干: Rule] -> [树叶: Harness Implementation]
      抽象价值            具体逻辑           可执行的 JS 脚本
```

### 2.1 运行空间 (Runtime Space - 日间模式)
- **HarnessGate**: 集成在 `packages/openclaw-plugin/src/hooks/gate.ts`。在任何写操作/高危操作前触发。
- **VMSandbox**: 使用 Node.js `vm` 模块，在隔离环境中运行 `./.principles/harness/*.js`。
- **一票否决制**: 只要有一个 P0 级别的规则脚本返回 `blocked`，动作立即停止，并向智能体返回极其具体的报错（含建议）。

### 2.2 进化空间 (Evolution Space - 依托 HEARTBEAT 批处理调度)
不再依赖外部操作系统的 Cron 或独立的后台进程，直接深度融合 OpenClaw 原生的 `HEARTBEAT.md` 任务批处理管线。
- **PainAnalyzer**: 扫描 `EvolutionReducer` 记录的 `pain_detected` 事件。
- **ScriptSynthesizer**: LLM 分析痛苦原因，自动编写、修改相关的 Harness 脚本。
- **ShadowSandbox (并行化)**: 影子测试网。借助 Heartbeat 任务分发并发跑测。新脚本必须通过：
    - **正样本回归**: 历史上成功的动作不被误杀。
    - **负样本拦截**: 必须成功拦截导致本次痛苦的原始动作。
- **GitTrajectory**: 所有的脚本变更必须 `git commit`，利用 Git Log 记录原则的演化轨迹，防止逻辑回摆。

---

## 3. 技术实现细节

### 3.1 目录结构
```bash
.principles/
├── harness/                # 硬化脚本存放区 (独立 Git 仓库)
│   ├── .git/               # 演化轨迹追踪
│   ├── registry.json       # 规则 ID 与脚本路径的映射
│   ├── rule_pkg_001.js     # 具体拦截逻辑
│   └── rule_test_002.js
└── tests/                  # 影子测试用例 (JSONL)
    ├── positive_cases.jsonl
    └── negative_cases.jsonl
```

### 3.2 数据契约 (Data Contract)
拦截脚本必须符合以下签名：
```typescript
/**
 * @param {Action} action - 准备执行的工具名与参数
 * @param {Context} context - 工作区状态 (files, lastDiff, currentPlan)
 * @returns {Decision} 拦截决策
 */
function validate(action, context) {
  // 示例逻辑
  if (action.toolName === 'replace' && action.params.file_path === 'package.json') {
    if (!context.files.includes('PLAN.md')) {
      return { 
        blocked: true, 
        reason: "根据原则 P_102，修改核心配置必须先创建 PLAN.md。" 
      };
    }
  }
  return { blocked: false };
}
```

### 3.3 单调性提升保证 (Monotonic Improvement)
利用 Heartbeat 管线运行影子沙盒，新进化的脚本必须满足：
1. **PassRate(Current_Positive_Dataset) == 100%**
2. **InterceptRate(Related_Negative_Pain) == 100%**
3. **Complexity(New_Script) < Threshold** (防止 LLM 写出过于复杂的逻辑导致沙盒崩溃)

---

## 4. 进化工作流 (The "Internalization" Loop 结合 Heartbeat)

1. **触发与登记**: 用户输入 `/pain` 或系统检测到 `GFI > 80`。痛苦日志被写入。
2. **调度排队**: 系统自动在工作区 `HEARTBEAT.md` 中注入/更新待处理的硬化任务，例如 `- [ ] @HarnessSynthesizer: 分析并硬化 P_102 (every 10m)`。
3. **合成与验证**:
    - 当系统空闲时，OpenClaw 的 `heartbeat-runner.ts` 唤醒智能体执行待办任务。
    - LLM 根据 `pain_detected` 记录编写拦截脚本。
    - LLM 触发影子沙盒测试（可将海量测试用例拆分为多个并行的 Heartbeat Task 加速验证）。
4. **部署**: 测试通过后，自动 `git commit`，热重载进入 `HarnessGate`。任务从 `HEARTBEAT.md` 剔除。
5. **清理**: 当脚本稳定运行 7 天无冲突后，原本在 `SKILL.md` 中的对应自然语言描述将被标记为 `deprecated`，释放 LLM 的上下文带宽。

---

## 5. 落地优先级 (Roadmap)

### Phase 1: 基建 (1-2 days)
- 实现 `HarnessEngine` 核心类（基于 `vm` 模块）。
- 修改 `gate.ts` 接入 `HarnessEngine`。
- 手动编写第一个拦截器（如 `package.json` 保护）。

### Phase 2: HEARTBEAT 调度与自动化合成 (3-5 days)
- 适配 OpenClaw 最新的 Heartbeat Task Batching 机制，将硬化流程注册为后台任务。
- 实现 `HarnessSynthesizer` 的 Prompt 模板。
- 对接 `EvolutionReducer` 获取痛苦信号。
- 建立 `harness/.git` 轨迹管理。

### Phase 3: 影子测试与闭环 (1 week)
- 自动生成正负样本测试集。
- 利用 Heartbeat 实现“单调性校验”并发跑测逻辑。
- 开启全自动演化模式。

---

## 6. 设计决策记录 (ADR)

| 决策点 | 方案 | 原因 |
|---|---|---|
| **执行环境** | Node.js `vm` 模块 | 安全隔离，防止演化出的脚本搞崩主进程。 |
| **规则粒度** | 一文件一原则 (Rule-per-File) | 方便热重载，避免 LLM 一次性修改超大规则文件导致的语法错误。 |
| **任务调度** | OpenClaw `HEARTBEAT.md` 原生批处理 | 极其优雅地解决了任务状态追踪问题，避免了引入外部 cron 和进程冲突，充分利用了系统空闲期。 |
| **冲突解决** | Git Log 轨迹分析 | LLM 通过查看脚本的历史 git log 了解过去的权衡，避免逻辑反复。 |
| **拦截反馈** | 结构化 Reason | 拦截信息必须包含原则 ID，方便智能体在单次转念中快速学习。 |