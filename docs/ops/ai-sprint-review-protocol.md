# AI Sprint Review Protocol

**日期**: 2026-04-01
**适用范围**: `D:/Code/principles` 所有 ai sprint orchestrator 任务
**目标读者**: 任务维护者、评审者、sprint 介入决策者

---

## 1. 背景

ai sprint orchestrator 的评审机制存在一个结构性风险：**reviewer 容易只盯局部 patch 细节，而忽略宏观目标、业务流、数据流和架构收敛性**。

这是因为：
- `reviewer_a` 默认被引导去检查"代码是否修了对"
- `reviewer_b` 默认被引导去检查"运行时和兼容性"
- 两者都没有被强制要求评估"这次改动是否真的在服务最终目标"

结果：
- PR 可能技术上正确，但引入了新的隐式协议
- 业务流没有形成闭环
- OpenClaw 兼容性假设从未被核验
- "统一 PD 子代理工作流"这个目标被遗忘

本协议定义三类评审视角，明确每类视角的职责边界和介入时机，确保没有人只盯树木。

---

## 2. 三类评审视角

### A. Reviewer A — 代码与局部正确性

**关注**：patch 是否真修了问题，测试是否覆盖回归，局部逻辑是否正确。

**评审维度**：

| 维度 | 问句 |
|------|------|
| 正确性 | 这个 patch 是否真的因果相连地修了根因？ |
| 测试覆盖 | 是否有测试验证这次修复有效？是否有回归测试？ |
| 边界条件 | 异常、超时、幂等性、边界输入是否被处理？ |
| 范围控制 | 是否在 patch-plan 的范围内，没有范围膨胀？ |
| CODE_EVIDENCE | producer 的 CODE_EVIDENCE 是否引用了真实 SHA 和文件？ |

**禁止行为**：
- 评估 OpenClaw 兼容性（那是 reviewer_b 的职责）
- 评估宏观目标（那是 global_reviewer 的职责）
- 凭"代码风格不喜欢"要求 REVISE

**介入时机**：每个 stage 的 Phase 2，固定参与。

---

### B. Reviewer B — 运行时与兼容性

**关注**：OpenClaw 运行时语义是否成立，git/worktree/merge gate 等外部系统语义是否正确，跨仓库依赖和环境兼容性。

**评审维度**：

| 维度 | 问句 |
|------|------|
| OpenClaw 兼容性 | 对 OpenClaw hook 触发时机、`subagent_ended` 语义、`sessionKey/runId` 归因的假设是否经过源码核验？ |
| git 语义 | worktree 创建参数是否合法？merge gate 比较对象是否正确（`spec.branch`，不是 `origin/HEAD` 或 worktree 分支）？ |
| 子代理生命周期 | timeout / error / fallback / cleanup 的状态机是否完整？ |
| 跨仓库依赖 | 是否引入了新的 `D:/Code/openclaw` 依赖未声明？ |
| 回归风险 | 是否有可能破坏其他使用相同 transport 的模块？ |

**禁止行为**：
- 评估"是否服务最终目标"（那是 global_reviewer 的职责）
- 凭"我觉得应该这样设计"要求 REVISE（要有具体兼容性风险做锚点）

**介入时机**：每个 stage 的 Phase 2，固定参与。

---

### C. Global Reviewer — 全局目标、业务流、数据流、架构闭环

**关注**：这次改动是否真的在服务最终目标，业务流和数据流是否形成闭环，架构是否更收敛。

**评审维度**：

| 维度 | 问句 |
|------|------|
| 宏观目标 | 这个 PR / sprint 是否在推进"统一 PD 子代理工作流"的目标？ |
| 业务流闭环 | 子代理的输出是否被正确路由和持久化？有没有丢失窗口？ |
| 数据流闭环 | `sessionKey / runId / parentSessionId` 链是否在 helper 层被正确归因？ |
| 架构收敛 | 这次改动是更统一了，还是引入了新的隐式协议？ |
| OpenClaw 兼容性（宏观） | OpenClaw 假设在跨仓库层面是否成立？有没有升级后会失效的风险？ |
| 扩展性 | 接口设计是否保留了对其他 transport 类型的扩展能力？ |

**强制介入时机**：
- **`architecture-cut`** 阶段 — 必须评估"要不要从架构层修"这个决策是否正确
- **`verify`** 阶段 — 必须评估"改动是否真的服务最终目标"

**可选介入时机**：
- `investigate` 阶段 — 如果 reviewer_a/b 在根因分析上出现重大分歧
- `implement-pass-2` — 如果 scope creep 风险显著

**禁止行为**：
- 替代 reviewer_a/b 的局部评审职责
- 凭"我不喜欢这个设计"要求 REVISE（要有具体架构风险做锚点）

---

## 3. 评审视角与阶段对应关系

| 阶段 | Reviewer A | Reviewer B | Global Reviewer |
|------|-----------|-----------|----------------|
| `investigate` | 必须 | 必须 | 可选（仅分歧时） |
| `architecture-cut` | 必须 | 必须 | **必须强制** |
| `patch-plan` | 必须 | 必须 | 可选 |
| `implement-pass-1` | 必须 | 必须 | 可选 |
| `implement-pass-2` | 必须 | 必须 | 可选（仅scope creep风险时） |
| `verify` | 必须 | 必须 | **必须强制** |

---

## 4. 宏观问题清单（architecture-cut / verify 必答）

Global Reviewer 在 `architecture-cut` 和 `verify` 阶段，必须在报告中包含以下五个问题的明确答案：

### Q1. OpenClaw 兼容性
> 当前对 OpenClaw 运行时 hook 的假设（如 `subagent_ended` 触发时机）是否经过跨仓库源码核验？是否有可能在 OpenClaw 升级后失效？

### Q2. 业务流闭环
> 子代理结果在 helper 接管后，是否有明确的持久化路径？是否存在结果丢失窗口？

### Q3. 架构收敛性
> 这次改动是让 PD 子代理调用更统一了，还是引入了新的隐式协议或双写风险？

### Q4. 数据流闭环
> `sessionKey / runId / parentSessionId` 链在 helper 层是否被正确归因？是否存在双重 finalize 风险？

### Q5. 与长期目标的距离
> 这次 sprint 是否真的更接近"统一 PD 子代理工作流"这个最终目标？下一 sprint 最应该聚焦什么？

---

## 5. 冲突升级规则

### 5.1 reviewer_a vs reviewer_b 在局部正确性上有分歧

→ 由 global_reviewer 在同一阶段内裁决（不阻断进度）

### 5.2 reviewer_b 提出 OpenClaw 兼容性风险，producer 不同意

→ global_reviewer 强制介入（architecture-cut / verify 除外）
→ 如果 global_reviewer 确认兼容性风险存在：**必须解决才能进入下一阶段**

### 5.3 global_reviewer 提出架构问题，reviewer_a/b 均认为"技术正确"

→ 架构问题优先级高于局部正确性
→ **必须解决或显式记录为已知 trade-off，才能进入 verify**

### 5.4 三个视角全通过，但 global_reviewer 在 verify 阶段仍认为"不服务最终目标"

→ sprint 不能标记为 completed
→ 进入额外 `revise` round，专门处理宏观目标对齐问题

---

## 6. 评审质量锚定

### 6.1 APPROVE 的最低要求

每个 reviewer 在 APPROVE 之前，必须确认：

- [ ] 所有 required sections 已填写
- [ ] 关键问题有 EVIDENCE 支撑，不是推测
- [ ] 没有未解决的 BLOCKER 级别的发现
- [ ] dimension scores（如果有）全部达到 threshold

### 6.2 REVISE 的最低要求

REVISE 之前，必须提供：
- 具体 change request（不是泛泛的"需要更多测试"）
- change request 必须在 producer 的控制范围内
- 上一 round 的 change request 是否已被解决，必须被显式确认

### 6.3 不得 APPROVE 的情形

| 情形 | 原因 |
|------|------|
| 有 BLOCKER 级别的发现但没有记录 | 事实与报告不符 |
| CODE_EVIDENCE 引用了不存在的 SHA | 证据链断裂 |
| 子代理 lifecycle 未被验证但报告说"工作正常" | OpenClaw 兼容性未核验 |
| 全局目标未对齐但报告说 APPROVE | 评审视角缺失 |

---

## 7. 附：各评审视角对应的 spec 配置

在任务 spec 的 `stageCriteria` 中，对需要 global_reviewer 强制介入的阶段：

```json
{
  "architecture-cut": {
    "requiredApprovals": 2,
    "requiredGlobalReviewerSections": ["VERDICT", "MACRO_ANSWERS", "BLOCKERS", "NEXT_FOCUS"],
    "requiredMacroAnswers": ["Q1", "Q2", "Q3", "Q4", "Q5"]
  },
  "verify": {
    "requiredApprovals": 2,
    "requiredGlobalReviewerSections": ["VERDICT", "MACRO_ANSWERS", "BLOCKERS", "FINAL_GOAL_ASSESSMENT"],
    "requiredMacroAnswers": ["Q1", "Q2", "Q3", "Q4", "Q5"]
  }
}
```

`MACRO_ANSWERS` section 格式：

```
MACRO_ANSWERS:
Q1: <answer> — <evidence or cross-repo ref>
Q2: <answer> — <evidence>
Q3: <answer> — <architectural rationale or trade-off>
Q4: <answer> — <dedupe/finalize risk assessment>
Q5: <answer> — <remaining gap and next priority>
```
