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

## 五、运行命令

### 前置检查
```bash
# Confirm spec files exist
ls ops/ai-sprints/specs/workflow-validation-minimal.json
ls ops/ai-sprints/specs/workflow-validation-minimal-verify.json

# Confirm acpx is available
which acpx
```

### Run 1: 最小验证
```bash
cd /home/csuzngjh/code/principles
npm run ai-sprint -- --task workflow-validation-minimal
```

### Run 2: 验证产物
```bash
cd /home/csuzngjh/code/principles
npm run ai-sprint -- --task workflow-validation-minimal-verify
```

### 检查产物
```bash
# 替换 <run-id> 为实际 run ID
cat ops/ai-sprints/<run-id>/stages/01-validate/decision.md
cat ops/ai-sprints/<run-id>/stages/01-validate/scorecard.json | python3 -m json.tool
```

关键字段：
- `decision.md` → `Output Quality:` 行
- `scorecard.json` → `.outputQuality`, `.qualityReasons`, `.validation.errorSummary`, `.nextRunRecommendation.type`

---

## 六、Run Result 记录

每次运行后填写下表。

### Run 1: workflow-validation-minimal

| 字段 | 值 |
|------|-----|
| run-id | _(填写)_ |
| status | `completed` / `halted` / `error` |
| outcome | `advance` / `revise` / `halt` |
| outputQuality | `shadow_complete` / `production_ready` / `needs_work` |
| validation.valid | `true` / `false` |
| nextRunRecommendation.type | `none` / `continuation` / `verify` / `handoff` |
| failure classification | _(见下方分类)_ |
| 备注 | _(自由文本)_ |

### Run 2: workflow-validation-minimal-verify

| 字段 | 值 |
|------|-----|
| run-id | _(填写)_ |
| status | `completed` / `halted` / `error` |
| outcome | `advance` / `revise` / `halt` |
| 验证 Run 1 outputQuality | `是` / `否` |
| 验证 Run 1 nextRunRecommendation | `是` / `否` |
| failure classification | _(见下方分类)_ |
| 备注 | _(自由文本)_ |

---

## 七、Failure Classification

每次运行失败时，必须归入以下四类之一。**只有 workflow bug 需要立即修复。**

| 类别 | 描述 | 示例 | 处理 |
|------|------|------|------|
| **workflow bug** | 编排器逻辑错误 | 文件写入失败、outputQuality 未落盘、merge gate 逻辑错误、nextRunRecommendation 空指针 | 立即修复 run.mjs / decision.mjs / contract-enforcement.mjs |
| **agent behavior issue** | AI agent 产生不合规输出 | 缺少 required sections、VERDICT 格式错误、无 DIMENSIONS 行 | Schema validation 拦截 → revise。不修改 workflow 代码 |
| **environment issue** | 本地机器或网络条件 | agent 超时、acpx 不可用、git 网络失败、磁盘满 | 重试或修复环境。不修改 workflow 代码 |
| **sample-spec issue** | 验证 spec 配置错误 | required sections 引用了不存在的章节名、超时太短、requiredDeliverables 与 prompt 不匹配 | 修复 spec 文件。不修改 workflow 代码 |

### 快速判断表

| 现象 | 类别 |
|------|------|
| `validation.valid = false` + `missing sections` | agent behavior issue |
| `outputQuality` 字段在 scorecard.json 中不存在 | **workflow bug** |
| `nextRunRecommendation` 为 null 或 undefined | **workflow bug** |
| agent 超时（如 600s 后超时） | environment issue |
| spec 要求了不存在的 section `NONEXISTENT` | sample-spec issue |
| `errorSummary` 存在且描述清晰 | 正常工作（不是 bug） |
| `halt` with `repeated_timeout` 连续 2 次超时 | 正常工作（熔断机制触发） |