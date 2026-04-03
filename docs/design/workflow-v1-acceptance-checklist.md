# Workflow v1 验收清单

> **目标**: 明确 workflow 什么时候算"足够可用，可以继续打磨 PR2"

---

## 一、最小验证 Run 设计

### Run 1: workflow-validation-minimal
- **目的**: 验证 workflow 基础设施，不绑定产品逻辑
- **Stage**: 单一 `validate` stage
- **Producer 任务**: 列出 orchestrator 目录下 3 个文件并描述用途（刻意简单）
- **验证点**:
  - Producer report 包含所有 required sections
  - Reviewers 生成有效 VERDICT + DIMENSIONS
  - outputQuality 被计算并落盘

### Run 2: workflow-validation-minimal-verify
- **目的**: 验证 Run 1 的产物
- **Stage**: 单一 `verify` stage
- **验证点**:
  - decision.md 包含 outputQuality
  - scorecard.json 包含 outputQuality + qualityReasons
  - nextRunRecommendation 被计算

---

## 二、Workflow 可用验收门槛

### [PASS] 门槛 1: 连续成功
- [ ] 连续 2 个 run 以 `advance` 或 `revise` 结束（不是 `halt`）
- [ ] `halt` 仅因外部原因（agent 超时、网络问题），非 workflow 自身 bug

### [PASS] 门槛 2: 错误处理
- [ ] invalid report 被结构化拒绝，产生 `errorSummary`
- [ ] missing schema 返回 `validation.valid = false`
- [ ] artifact mismatch 记录到 `qualityReasons`

### [PASS] 门槛 3: 状态流转
- [ ] `outputQuality` 被正确计算：
  - `needs_work`: validation 失败或 approval 不足
  - `shadow_complete`: 基本通过但 dimension 不达标
  - `production_ready`: 全部达标
- [ ] `outputQuality` 落盘到 `decision.md` 和 `scorecard.json`
- [ ] `nextRunRecommendation` 根据 `outputQuality` 生成：
  - `needs_work` → `CONTINUATION`
  - `shadow_complete` → `VERIFY` 或 `CONTINUATION`
  - `production_ready` → `NONE`

---

## 三、什么时候可以回头继续打磨 PR2

**条件**: 以上 3 个门槛全部 [PASS]

具体来说：
1. 运行 `workflow-validation-minimal` → 产生有效 outputQuality
2. 运行 `workflow-validation-minimal-verify` → 验证产物正确
3. 两次 run 都不以 workflow bug 导致的 `halt` 结束

满足后，可以：
- 删除测试 spec 文件
- 用真实 PR2 spec 运行 sprint
- workflow 负责流程，PR2 负责产品

---

## 四、最高风险点 (Top 2)

### [HIGH] 风险 1: Agent 行为不确定性
- **问题**: Producer/Reviewer 是真实 AI agent，可能产生格式不合规的报告
- **缓解**: 
  - 已有 schema validation
  - `errorSummary` 提供明确反馈
  - `revise` 允许重试

### [MED] 风险 2: 超时处理边界
- **问题**: `consecutiveTimeouts` 逻辑可能导致误判 halt
- **缓解**:
  - 已有 dynamic timeout extension
  - 超时不惩罚，仅记录
  - 可手动 `--resume`

---

## 五、快速验证命令

```bash
# Run 1
node scripts/ai-sprint-orchestrator/run.mjs --spec ops/ai-sprints/specs/workflow-validation-minimal.json

# Run 2 (手动提供 run-id)
node scripts/ai-sprint-orchestrator/run.mjs --spec ops/ai-sprints/specs/workflow-validation-minimal-verify.json

# 检查产物
cat ops/ai-sprints/<run-id>/stages/01-validate/decision.md | grep outputQuality
cat ops/ai-sprints/<run-id>/stages/01-validate/scorecard.json | grep outputQuality
```

---

## 六、不算 workflow 问题的情况

以下问题属于 **agent 行为**，不算 workflow bug：

| 问题 | 归因 | 处理 |
|------|------|------|
| Agent 产生格式错误的报告 | Agent 质量 | Schema validation 拒绝 |
| Agent 超时未响应 | Agent 速度/网络 | Dynamic timeout extension |
| Agent 理解任务错误 | Agent 能力 | Reviewer 拒绝，revise |

以下问题属于 **workflow bug**：

| 问题 | 归因 | 处理 |
|------|------|------|
| 文件写入失败 | Workflow I/O | 修复 run.mjs |
| Schema 检查逻辑错误 | Workflow validation | 修复 contract-enforcement.mjs |
| outputQuality 未落盘 | Workflow persistence | 修复 decision.mjs |
| nextRunRecommendation 空指针 | Workflow logic | 已修复（Phase 3）|