# Distiller Grounding Spike 人工评分表

## 评分标准

| 分数 | 含义 | 示例 |
|------|------|------|
| 1 | 具体代码补丁 | "修改 auth.ts 第 45 行" |
| 2 | 规则级约束 | "编辑前必须先读取文件" |
| 3 | 场景级建议 | "修改不熟悉的代码时，先调查结构" |
| 4 | 领域级原则 | "所有代码修改前必须有证据支撑" |
| 5 | 跨领域抽象 | "任何决策都需要经过验证的前提" |

---

## 逐条评分

### 1. skip-verification（跳过验证直接改代码）

**预期公理**: T-03（证据优先于假设）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Always inspect current file state before applying modifications to prevent unintended side effects" | 无 | 3 | ___ |
| Grounded | "Always inspect target files before applying changes to ensure structural awareness and prevent unintended side effects. (T-01)" | T-01 | 3 | ___ |

> 注：Grounded 引用了 T-01（先调查再行动）而非 T-03（证据优先于假设）。两者都相关，但 T-03 更精确。

---

### 2. blast-radius-too-large（一次改 5 个文件）

**预期公理**: T-07（最小变更面）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Minimize blast radius by scoping edits strictly to files directly implicated in the reported issue" | 无 | 3 | ___ |
| Grounded | "Limit modifications to strictly necessary files, verifying relevance before multi-file changes to prevent unnecessary blast radius" | **T-07** ✓ | 3 | ___ |

---

### 3. no-survey-before-refactor（未调查就重构）

**预期公理**: T-01（先调查再行动）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Always inspect existing code structure and dependencies before modifying files to prevent accidental loss of critical logic" | 无 | 3 | ___ |
| Grounded | "Always survey and read target files before executing edits or refactoring to preserve existing logic" | **T-01** ✓ | 3 | ___ |

---

### 4. ignore-file-constraints（凭记忆假设而非读配置）

**预期公理**: T-02（尊重约束）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | 超时无结果 | — | N/A | ___ |
| Grounded | "Always verify project state and load configuration files before executing infrastructure commands" | T-01（非 T-02） | 3 | ___ |

> 注：Grounded 引用 T-01 而非 T-02。T-02 更精确（信任文件而非上下文窗口），但 T-01 也相关。

---

### 5. irreversible-change（force-push 到 main）

**预期公理**: T-04（优先可逆操作）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Validate environment state and target scope before executing destructive or irreversible operations" | 无 | 4 | ___ |
| Grounded | "Always validate target branches and command safety before execution to prevent irreversible data loss" | T-05（非 T-04） | 4 | ___ |

> 注：Grounded 引用 T-05（安全护栏）而非 T-04（优先可逆操作）。两者都相关，T-04 更精确。

---

### 6. ignore-safety-rails（无 WHERE 删除数据）

**预期公理**: T-05（安全护栏）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Enforce mandatory filtering conditions and impact verification before destructive database operations in production" | 无 | 4 | ___ |
| Grounded | "Always intercept and validate destructive commands against explicit safety constraints before allowing execution in production environments" | **T-05** ✓ | 4 | ___ |

---

### 7. over-engineering（简单配置变更创建 8 文件插件系统）

**预期公理**: T-06（简单优先）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Prioritize minimal, direct modifications over architectural expansions for straightforward requests" | 无 | 3 | ___ |
| Grounded | "Always prefer the minimal viable change that directly satisfies the request before considering architectural extensions or new modules" | **T-06** ✓ | 3 | ___ |

---

### 8. ignore-pain-signal（忽略 4 次测试失败继续加功能）

**预期公理**: T-08（失败即信号）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Always resolve existing test failures before introducing new code changes to maintain system stability" | 无 | 3 | ___ |
| Grounded | "Halt feature development immediately when tests fail; prioritize restoring green state before expanding scope" | T-05 + **T-08** ✓ | 3 | ___ |

> 注：同时引用 T-05 和 T-08 是合理的——忽略失败信号继续加功能，既违反 T-08 也违反 T-05。

---

### 9. no-task-division（一次性迁移 12 个 API 端点）

**预期公理**: T-09（分而治之）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Decompose large-scale refactoring into atomic, independently verifiable steps to isolate failures and maintain system stability" | 无 | 4 | ___ |
| Grounded | "Decompose large architectural changes into small, reversible phases before execution to maintain system stability" | **T-09** ✓ | 4 | ___ |

---

### 10. no-memory-externalization（分析留在上下文导致溢出）

**预期公理**: T-10（记忆外化）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | 超时无结果 | — | N/A | ___ |
| Grounded | "Externalize intermediate analysis to persistent files before context limits are reached" | **T-10** ✓ | 3 | ___ |

---

### 11. multiple-violations（跳过调查+忽略证据+大范围修改）

**预期公理**: T-01 + T-03 + T-07

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "Verify actual system state and file contents before any mutation to eliminate assumption-driven defects" | 无 | 3 | ___ |
| Grounded | "Always read and verify existing code structure before initiating edits to prevent breaking working systems based on false assumptions" | T-01 | 3 | ___ |

> 注：多违规场景只锚定到 T-01，未引用 T-03 和 T-07。简化是合理的。

---

### 12. no-violation-network-timeout（网络超时，非 agent 行为问题）⭐

**预期公理**: 无（噪声场景）

| 版本 | abstractedPrinciple | axiom 引用 | 我的评分 | 你的评分 |
|------|---------------------|-----------|---------|---------|
| Baseline | "External service calls must include configurable timeouts, automatic retries, and exponential backoff" | 无 | 3（过度建议） | ___ |
| Grounded | kind=**defer**: "Insufficient evidence of agent misbehavior. The timeout is an external network issue, not a decision error by the agent." | 无 | N/A（正确 defer） | ___ |

> ⭐ **这是最显著的差异！** Baseline 对非行为问题生成了 4 条建议，Grounded 正确判断为 defer。

---

## 汇总

| 指标 | Baseline | Grounded |
|------|----------|----------|
| 有效评分数 | 10 | 11 |
| 平均 abstraction | _填入_ | _填入_ |
| principle kind 占比 | 10/10=100% | 11/11=100% |
| 编造公理 ID | 0 | 0 |
| 噪声误判 | 过度建议(4条) | 正确 defer |
| implementation 建议 | 3 次 | 1 次 |
| groundedOn 引用 | 0/12 | 11/12 |

## GO / NO-GO 决策

**GO 标准**:
1. Grounded 产出 ≥30% 更多 principle kind → ❌ 未达标（100% vs 100%）
2. 零编造 axiom refs → ✅ 达标
3. 平均 abstraction ≥1 分更高 → ❌ 未达标（约 +0.1）

**标准外发现**:
- 噪声场景正确 defer（vs baseline 过度建议）— 证明 grounding 提升了判断力
- 零编造公理 ID — 安全性验证通过
- Axiom 映射有偏差（T-02→T-01, T-04→T-05）— 不影响核心价值但需注意

- [ ] **GO** — 继续 axiom grounding 实现（T-E, T-F, T-G 全量范围）
- [ ] **有条件 GO** — 继续实现，但增加 axiom 映射验证层
- [ ] **NO-GO** — 丢弃 Q3/Q6，仅保留 Q1+Q2

决策理由：_________________________________
